import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../../src/adapters/memory';
import { FakeCalendarTransport, FakeEmailTransport } from '../../src/adapters/fakes';
import { PulseJobs, stableHash } from '../../src/jobs';
import { readConfig } from '../../src/shared/config';
import { FixedClock } from '../../src/shared/time';
import { TransportError, type CalendarAttendee, type CalendarPrivacyAuthorization, type Database, plusDays, str } from '../../src/shared/types';
import { FIXTURE_NOW, loadFixture } from '../../fixtures/load';

/** Emulates a second authorized request committing just after a worker claim. */
class CommitHookRepository extends MemoryRepository {
  when: ((db: Database) => boolean) | null = null;
  mutate: ((db: Database) => void) | null = null;
  override transaction<T>(operation: (db: Database) => T): T {
    const result = super.transaction(operation);
    if (this.when?.(super.read()) && this.mutate) {
      const mutate = this.mutate; this.when = null; this.mutate = null;
      super.transaction(mutate);
    }
    return result;
  }
}
function setup(profile = 'BASE') {
  const repo = new CommitHookRepository(loadFixture(profile)), clock = new FixedClock(), config = readConfig(repo.read());
  const email = new FakeEmailTransport(clock), calendar = new FakeCalendarTransport(), jobs = new PulseJobs(repo, email, calendar, clock, config);
  return { repo, clock, email, calendar, jobs };
}

describe('consent and provider boundaries under concurrent requests', () => {
  it('preserves the captured mixed-role company quorum independently of complementary novelty edges', () => {
    const h = setup(); h.jobs.runWeeklyMatching();
    const lived = h.repo.read().Opportunities.filter(o => o.participation_role === 'LIVED_THROUGH' && (o.candidate_company_ids as string[]).length > new Set((o.candidate_edges as string[]).map(edge => edge.split(':')[0])).size + 1);
    expect(lived.length).toBeGreaterThan(0);
    const result = h.jobs.processOutbox(true); expect(result.sent).toBe(22); expect(result.cancelled).toBe(0);
    for (const card of lived) expect(h.repo.read().Opportunities.find(o => o.opportunity_id === card.opportunity_id)!.status).toBe('OFFERED');
  });
  it('never sends a captured revoked topic because another captured card remains eligible', () => {
    const h = setup(); h.jobs.runWeeklyMatching();
    h.repo.when = db => db.WeeklyEmails.some(e => e.founder_id === 'F001' && e.status === 'SENDING');
    h.repo.mutate = db => {
      const entry = db.PulseEntries.find(e => e.entry_id === 'E052')!; entry.status = 'WITHDRAWN';
      db.ConsentLog.push({ consent_event_id: 'concurrent-withdrawal', founder_id: 'F001', entry_id: 'E052', scope: 'ENTRY_USE', permission_value: 'PRIVATE_MATCH_ONLY', action: 'REVOKED', recorded_at_utc: FIXTURE_NOW });
    };
    h.jobs.processOutbox(true);
    const recipient = str(h.repo.read().Founders.find(f => f.founder_id === 'F001')!, 'email');
    expect(h.email.messages.filter(m => m.to === recipient).some(m => m.text.includes('Pricing a first paid offer'))).toBe(false);
  });
  it('never sends exact story text revoked between rendering and delivery', () => {
    const h = setup('STORY_CASES'), text = str(h.repo.read().Stories.find(s => s.story_id === 'ST001')!, 'approved_text');
    h.jobs.runWeeklyMatching();
    expect(h.repo.read().WeeklyEmails.some(e => e.story_id === 'ST001')).toBe(true);
    h.repo.when = db => db.WeeklyEmails.some(e => e.story_id === 'ST001' && e.status === 'SENDING');
    h.repo.mutate = db => { db.Stories.find(s => s.story_id === 'ST001')!.status = 'WITHDRAWN'; };
    h.jobs.processOutbox(true);
    expect(h.email.messages.some(message => message.text.includes(text))).toBe(false);
  });
  it('rechecks the quorum before creating any provider event after claim release', () => {
    const h = setup('GROUP_READY');
    h.repo.when = db => db.Conversations.some(g => g.conversation_id === 'G001' && g.status === 'BOOKING_PENDING');
    h.repo.mutate = db => {
      db.InterestResponses.find(i => i.conversation_id === 'G001' && i.founder_id === 'F003')!.response = 'WITHDRAWN';
      db.ConversationMembers.find(m => m.conversation_id === 'G001' && m.founder_id === 'F003')!.status = 'WITHDRAWN';
    };
    h.jobs.evaluateBooking('G001', true);
    expect(h.calendar.trace.some(t => t.action === 'reserve' || t.action === 'invite')).toBe(false);
    expect(h.repo.read().Conversations.find(g => g.conversation_id === 'G001')!.status).not.toBe('CONFIRMED');
  });
  it('refuses to invite people when an existing provider event has another time', () => {
    const h = setup('GROUP_READY');
    const eventId = `pulse${stableHash('G001:S001')}${stableHash('S001:G001')}`;
    h.calendar.seed({ event_id: eventId, conversation_id: 'G001', topic_label: 'Synthetic topic', start_at_utc: '2026-10-21T15:00:00Z', end_at_utc: '2026-10-21T15:30:00Z', conference_request_id: 'synthetic-test', is_synthetic: true });
    const result = h.jobs.evaluateBooking('G001', true);
    expect(result.status).toBe('NEEDS_TECH_REVIEW'); expect(h.calendar.trace.some(t => t.action === 'invite')).toBe(false);
  });
  it('does not cancel an authorized future meeting merely because pre-booking interest expires', () => {
    const h = setup('GROUP_READY');
    h.repo.transaction(db => { const slot = db.TimeSlots.find(s => s.slot_id === 'S001')!; slot.start_at_utc = '2026-10-27T15:00:00Z'; slot.end_at_utc = '2026-10-27T15:30:00Z'; });
    expect(h.jobs.evaluateBooking('G001', true).status).toBe('CONFIRMED');
    h.clock.advance(12); h.jobs.reconcileWithdrawals();
    expect(h.repo.read().Conversations.find(g => g.conversation_id === 'G001')!.status).toBe('CONFIRMED');
    expect(h.calendar.trace.some(t => t.action === 'cancel')).toBe(false);
  });
  it('keeps a pending provider event pinned when another accepted slot later has more companies', () => {
    const h = setup('GROUP_READY'); h.calendar.conferencePending = true;
    h.repo.transaction(db => {
      db.PulseEntries.push({ entry_id: 'fourth-topic', founder_id: 'F004', topic_id: 'T01', entry_type: 'WORKING_THROUGH', visibility: 'PRIVATE_MATCH_ONLY', status: 'ACTIVE', created_at_utc: FIXTURE_NOW, confirmed_at_utc: FIXTURE_NOW, expires_at_utc: '2026-11-12T12:00:00Z', revision: 1, is_synthetic: true });
      db.ConsentLog.push({ consent_event_id: 'fourth-consent', founder_id: 'F004', entry_id: 'fourth-topic', scope: 'ENTRY_USE', permission_value: 'PRIVATE_MATCH_ONLY', action: 'GRANTED', recorded_at_utc: FIXTURE_NOW, is_synthetic: true });
      db.InterestResponses.push({ response_id: 'later-fourth', conversation_id: 'G001', founder_id: 'F004', topic_id: 'T01', participation_role: 'WORKING_THROUGH', response: 'INTERESTED', responded_at_utc: FIXTURE_NOW, is_synthetic: true });
      db.ConversationMembers.push({ conversation_id: 'G001', founder_id: 'F004', company_id: 'C004', participation_role: 'WORKING_THROUGH', status: 'RESERVED', is_synthetic: true });
    });
    expect(h.jobs.evaluateBooking('G001', true).status).toBe('BOOKING_PENDING');
    const first = h.repo.read().Conversations.find(g => g.conversation_id === 'G001')!, eventId = str(first, 'calendar_event_id');
    h.repo.transaction(db => {
      for (const founderId of ['F002', 'F003']) db.Availability.push({ availability_id: `second-${founderId}`, conversation_id: 'G001', founder_id: founderId, slot_id: 'S002', available: true, booking_consent: true, identity_disclosure_consent: true, confirmed_at_utc: FIXTURE_NOW });
      // Make S002 strictly more attractive without changing the previously reserved event.
      db.Availability.push({ availability_id: 'second-fourth', conversation_id: 'G001', founder_id: 'F004', slot_id: 'S002', available: true, booking_consent: true, identity_disclosure_consent: true, confirmed_at_utc: FIXTURE_NOW, is_synthetic: true });
    });
    h.calendar.ready(eventId); expect(h.jobs.evaluateBooking('G001', true).status).toBe('CONFIRMED');
    expect(h.repo.read().Conversations.find(g => g.conversation_id === 'G001')!.selected_slot_id).toBe('S001');
    expect(h.calendar.events.size).toBe(1); expect(h.calendar.events.get(eventId)!.start_at_utc).toBe('2026-10-20T15:00:00Z');
  });
  it('preserves a confirmed meeting across natural topic expiry but cancels explicit withdrawal', () => {
    const h = setup('GROUP_READY'); expect(h.jobs.evaluateBooking('G001', true).status).toBe('CONFIRMED');
    h.repo.transaction(db => { const entry = db.PulseEntries.find(e => e.entry_id === 'E005')!; entry.status = 'EXPIRED'; entry.expires_at_utc = FIXTURE_NOW; });
    h.jobs.reconcileWithdrawals(); expect(h.repo.read().Conversations.find(g => g.conversation_id === 'G001')!.status).toBe('CONFIRMED');
    h.repo.transaction(db => { db.PulseEntries.find(e => e.entry_id === 'E005')!.status = 'WITHDRAWN'; });
    h.jobs.reconcileWithdrawals(); expect(h.repo.read().Conversations.find(g => g.conversation_id === 'G001')!.status).toBe('CANCELLED');
  });
  it('reconciles an already-issued UNKNOWN invitation after an explicit withdrawal', () => {
    class UncertainInvite extends FakeCalendarTransport {
      once = true;
      override invite(eventId: string, attendees: CalendarAttendee[]) {
        const receipt = super.invite(eventId, attendees);
        if (this.once) { this.once = false; throw new TransportError('UNKNOWN', 'SIMULATED_INVITE_TIMEOUT_AFTER_ACCEPTANCE'); }
        return receipt;
      }
    }
    const repo = new MemoryRepository(loadFixture('GROUP_READY')), clock = new FixedClock(), calendar = new UncertainInvite();
    const jobs = new PulseJobs(repo, new FakeEmailTransport(clock), calendar, clock, readConfig(repo.read()));
    expect(jobs.evaluateBooking('G001', true).status).toBe('BOOKING_UNKNOWN');
    expect([...calendar.events.values()][0].attendee_emails).toHaveLength(3);
    repo.transaction(db => { db.InterestResponses.find(r => r.founder_id === 'F003')!.response = 'WITHDRAWN'; db.ConversationMembers.find(m => m.founder_id === 'F003')!.status = 'WITHDRAWN'; });
    expect(jobs.evaluateBooking('G001', true).status).toBe('CANCELLED');
    expect([...calendar.events.values()][0].cancelled).toBe(true); expect(calendar.trace.filter(t => t.action === 'invite')).toHaveLength(1);
  });
  it('only a persisted active administrator can issue an audited privacy cancellation while paused', () => {
    class AuthorizedCalendar extends FakeCalendarTransport {
      authorizations: (CalendarPrivacyAuthorization | undefined)[] = [];
      override cancel(eventId: string, authorization?: CalendarPrivacyAuthorization) { this.authorizations.push(authorization); return super.cancel(eventId); }
    }
    const repo = new MemoryRepository(loadFixture('GROUP_READY')), clock = new FixedClock(), calendar = new AuthorizedCalendar();
    const jobs = new PulseJobs(repo, new FakeEmailTransport(clock), calendar, clock, readConfig(repo.read()));
    jobs.evaluateBooking('G001', true); repo.transaction(db => { db.Settings.find(s => s.setting_key === 'outreach_mode')!.setting_value = 'PAUSED'; });
    expect(() => jobs.privacyCancel('G001', 'F001', 'forged-staff')).toThrow('FORBIDDEN');
    const actor = repo.read().Accounts.find(a => a.role === 'ADMIN')!;
    expect(jobs.privacyCancel('G001', str(actor, 'account_id'), 'explicit-privacy-action').status).toBe('CANCELLED');
    const authorization = calendar.authorizations[0]!; expect(authorization.actor_account_id).toBe(actor.account_id);
    expect(repo.read().ActivityLog.some(a => a.activity_id === authorization.audit_id && a.action === 'STAFF_PRIVACY_CANCEL_INTENT')).toBe(true);
    expect(calendar.trace.filter(t => t.action === 'reserve')).toHaveLength(1); expect(calendar.trace.filter(t => t.action === 'invite')).toHaveLength(1);
  });
  it('queues one separate staff summary without private founder data and reports missing contact configuration', () => {
    const h = setup(); expect(h.jobs.runWeeklyMatching().queued).toBe(21);
    const summaries = h.repo.read().WeeklyEmails.filter(e => e.type === 'STAFF_SUMMARY'); expect(summaries).toHaveLength(1);
    expect(summaries[0].founder_id).toBeNull();
    const content = String(summaries[0].text); expect(content).not.toContain('Hiring the first salesperson'); expect(content).not.toContain('F001');
    h.jobs.runWeeklyMatching(); expect(h.repo.read().WeeklyEmails.filter(e => e.type === 'STAFF_SUMMARY')).toHaveLength(1);
    h.repo.transaction(db => { for (const account of db.Accounts.filter(a => a.role === 'ADMIN')) delete account.contact_email; });
    expect(h.jobs.monitor().staff_summary_gate).toBe('NOT_CONFIGURED');
  });
  it('does not deliver a second founder digest while a prior intent is unresolved', () => {
    const h = setup(); h.jobs.runWeeklyMatching(); h.email.failNext('UNKNOWN_BEFORE'); h.jobs.processOutbox(true);
    expect(h.repo.read().WeeklyEmails.some(e => e.founder_id === 'F001' && e.status === 'UNKNOWN')).toBe(true);
    h.clock.advance(7); h.jobs.runWeeklyMatching(); h.jobs.processOutbox(true);
    const recipient = str(h.repo.read().Founders.find(f => f.founder_id === 'F001')!, 'email');
    expect(h.email.messages.filter(m => m.to === recipient)).toHaveLength(0);
  });
  it('does not send or overwrite an uncertainty when another worker supersedes the claim', () => {
    const h = setup(); h.jobs.runWeeklyMatching();
    h.repo.when = db => db.WeeklyEmails.some(e => e.founder_id === 'F001' && e.status === 'SENDING');
    h.repo.mutate = db => { db.WeeklyEmails.find(e => e.founder_id === 'F001' && e.status === 'SENDING')!.status = 'UNKNOWN'; };
    h.jobs.processOutbox(true);
    expect(h.repo.read().WeeklyEmails.some(e => e.founder_id === 'F001' && e.status === 'UNKNOWN')).toBe(true);
    const recipient = str(h.repo.read().Founders.find(f => f.founder_id === 'F001')!, 'email');
    expect(h.email.messages.filter(m => m.to === recipient)).toHaveLength(0);
  });
  it('does not misclassify an explicit response as unanswered or extend its decline cooldown', () => {
    for (const decision of ['INTERESTED', 'NOT_NOW']) {
      const h = setup(); h.jobs.runWeeklyMatching(); h.jobs.processOutbox(true); h.clock.advance(1);
      const opportunity = h.repo.read().Opportunities.find(o => o.founder_id === 'F001' && o.topic_id === 'T01')!;
      h.repo.transaction(db => {
        db.InterestResponses.push({ response_id: `real-response-${decision}`, opportunity_id: opportunity.opportunity_id, conversation_id: null, founder_id: 'F001', topic_id: 'T01', participation_role: 'WORKING_THROUGH', response: decision, responded_at_utc: h.clock.now(), expires_at_utc: plusDays(h.clock.now(), 14), is_synthetic: true });
        db.Opportunities.find(o => o.opportunity_id === opportunity.opportunity_id)!.status = decision;
      });
      h.clock.advance(7); h.jobs.housekeeping();
      const history = h.repo.read().OutreachHistory.find(r => r.opportunity_id === opportunity.opportunity_id)!;
      expect(history.response).toBe(decision);
      expect(history.cooldown_until_utc).toBe(decision === 'NOT_NOW' ? plusDays(FIXTURE_NOW, 31) : null);
    }
  });
  it('purges withdrawn private notes at their original expiry plus grace while retaining revocation evidence', () => {
    const h = setup();
    h.repo.transaction(db => {
      const entry = db.PulseEntries.find(e => e.entry_id === 'E052')!;
      entry.status = 'WITHDRAWN'; entry.private_context = 'private withdrawn note'; entry.expires_at_utc = FIXTURE_NOW;
      db.ConsentLog.push({ consent_event_id: 'retained-withdrawal', founder_id: 'F001', entry_id: 'E052', scope: 'ENTRY_USE', permission_value: 'PRIVATE_MATCH_ONLY', action: 'REVOKED', recorded_at_utc: FIXTURE_NOW });
    });
    const grace = readConfig(h.repo.read()).private_note_grace_days;
    h.clock.advance(grace - 1); h.jobs.housekeeping();
    expect(h.repo.read().PulseEntries.find(e => e.entry_id === 'E052')!.private_context).toBe('private withdrawn note');
    h.clock.advance(1); h.jobs.housekeeping();
    const entry = h.repo.read().PulseEntries.find(e => e.entry_id === 'E052')!;
    expect(entry.private_context).toBe(''); expect(entry.status).toBe('WITHDRAWN'); expect(entry.private_context_purged_at_utc).toBe(h.clock.now());
    expect(h.repo.read().ConsentLog.some(e => e.consent_event_id === 'retained-withdrawal' && e.action === 'REVOKED')).toBe(true);
  });
});
