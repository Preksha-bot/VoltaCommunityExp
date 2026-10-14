import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DemoAuthProvider, type DemoLogin } from '../../src/auth';
import { MemoryRepository } from '../../src/adapters/memory';
import { PulseService, safeRoute, type JobsApi } from '../../src/service/pulse';
import { readConfig } from '../../src/shared/config';
import { FixedClock } from '../../src/shared/time';
import { type Row, plusDays, str } from '../../src/shared/types';
import { computeOpportunities, storyEligible } from '../../src/domain';
import { demoLogins, FIXTURE_NOW, loadFixture } from '../../fixtures/load';

function harness(profile = 'BASE') {
  const repo = new MemoryRepository(loadFixture(profile)), clock = new FixedClock(), config = readConfig(repo.read());
  let counter = 0;
  const security = { id: () => `review-${++counter}`, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  const logins = demoLogins as unknown as DemoLogin[];
  const auth = new DemoAuthProvider(repo, clock, security, logins, config);
  const jobs: JobsApi = { runWeeklyMatching: () => null, processOutbox: () => null, evaluateInterest: () => null,
    evaluateBooking: () => null, housekeeping: () => null, monitor: () => null };
  const service = new PulseService({ repo, auth, clock, config, security, jobs, demoLogins: logins });
  const login = (founderId: string, identifier?: string) => {
    const account = logins.find(l => l.account_id === founderId)!;
    return auth.signIn(identifier || account.username, account.demo_password);
  };
  return { repo, clock, auth, service, login, logins, config };
}

describe('independent authorization and replay review', () => {
  it('maps a normalized company alias only to its primary founder', () => {
    const h = harness(), session = h.login('F001', '  c001  ');
    expect(session.principal.founder_id).toBe('F001');
    const cofounder = h.login('F025'); expect(cofounder.principal.founder_id).toBe('F025');
    const result = h.service.rpc({ method: 'getMyPulse', session: cofounder.credential, payload: {} });
    const data = result.data as { entries: Row[] };
    expect(result.ok).toBe(true); expect(data.entries.map(e => e.entry_id)).toEqual(['E048']);
    expect(data.entries.some(e => e.entry_id === 'E001')).toBe(false);
  });
  it('does not normalize passwords and gives the same error for wrong and unknown identifiers', () => {
    const h = harness(), account = h.logins.find(l => l.account_id === 'F001')!;
    for (const identifier of [account.username, 'unknown-does-not-exist']) {
      const response = h.service.rpc({ method: 'signIn', payload: { identifier, password: `${account.demo_password} ` } });
      expect(response.ok).toBe(false); expect(response.errorCode).toBe('INVALID_CREDENTIALS');
    }
  });
  it('rate limits recovery independently of login attempts for known and unknown identifiers', () => {
    const h = harness();
    for (let attempt = 0; attempt < 3; attempt++) expect(h.service.rpc({ method: 'startPasswordReset', payload: { identifier: 'unknown-reset-account' } }).ok).toBe(true);
    expect(h.service.rpc({ method: 'startPasswordReset', payload: { identifier: 'unknown-reset-account' } }).errorCode).toBe('THROTTLED');
    // Recovery attempts for an unknown identifier must not lock out another founder's login.
    expect(h.login('F001').principal.founder_id).toBe('F001');
  });
  it('blocks supplied owner/role fields and cross-founder resources', () => {
    const h = harness(), session = h.login('F001');
    for (const payload of [{ founder_id: 'F002' }, { role: 'ADMIN' }, { private_monthly_review: 'Do not capture this' }]) {
      expect(h.service.rpc({ method: 'getMyPulse', session: session.credential, payload }).errorCode).toBe('VALIDATION_ERROR');
    }
    expect(h.service.rpc({ method: 'updatePreferences', session: session.credential, payload: { action: 'REMOVE_ENTRY', entryId: 'E003' } }).errorCode).toBe('FORBIDDEN');
    expect(h.service.rpc({ method: 'getAdmin', session: session.credential, payload: {} }).errorCode).toBe('FORBIDDEN');
    expect(h.service.rpc({ method: 'adminAction', session: session.credential, payload: { action: 'PAUSE', payload: {} } }).errorCode).toBe('FORBIDDEN');
  });
  it('rejects forged and logged-out bearer credentials and stores only digests', () => {
    const h = harness(), session = h.login('F001');
    expect(h.repo.read().AuthSessions.some(s => JSON.stringify(s).includes(session.credential))).toBe(false);
    expect(h.service.rpc({ method: 'getAdmin', session: JSON.stringify({ role: 'ADMIN', founder_id: 'F001' }), payload: {} }).errorCode).toBe('UNAUTHENTICATED');
    h.auth.signOut(session.credential);
    expect(() => h.auth.verify(session.credential)).toThrow('UNAUTHENTICATED');
  });
  it('enforces idle timeout, one-hour absolute expiry and disabled-account revocation', () => {
    const idle = harness(), idleSession = idle.login('F001'); idle.clock.advance(30 / 1440);
    expect(() => idle.auth.verify(idleSession.credential)).toThrow('UNAUTHENTICATED');
    const absolute = harness(), absoluteSession = absolute.login('F001');
    absolute.clock.advance(29 / 1440); absolute.auth.verify(absoluteSession.credential);
    absolute.clock.advance(29 / 1440); absolute.auth.verify(absoluteSession.credential);
    absolute.clock.advance(2 / 1440); expect(() => absolute.auth.verify(absoluteSession.credential)).toThrow('UNAUTHENTICATED');
    const disabled = harness(), disabledSession = disabled.login('F001');
    disabled.repo.transaction(db => { db.Accounts.find(a => a.account_id === 'F001')!.status = 'DISABLED'; });
    expect(() => disabled.auth.verify(disabledSession.credential)).toThrow('UNAUTHENTICATED');
  });
  it('immediately stops access after deletion and prevents stale session replay', () => {
    const h = harness(), session = h.login('F001');
    expect(h.service.rpc({ method: 'updatePreferences', session: session.credential, payload: { action: 'DELETE' }, requestId: 'delete-once' }).ok).toBe(true);
    expect(h.service.rpc({ method: 'getMyPulse', session: session.credential, payload: {} }).errorCode).toBe('UNAUTHENTICATED');
    expect(computeOpportunities(h.repo.read(), FIXTURE_NOW).some(o => o.founder_id === 'F001')).toBe(false);
  });
  it('does not let an unauthorized cofounder grant company-named visibility', () => {
    const h = harness(), session = h.login('F025');
    const result = h.service.rpc({ method: 'updatePreferences', session: session.credential,
      payload: { action: 'VISIBILITY', entryId: 'E048', visibility: 'NAMED_SNAPSHOT' } });
    expect(result.errorCode).toBe('FORBIDDEN'); expect(h.repo.read().PulseEntries.find(e => e.entry_id === 'E048')!.visibility).toBe('ANONYMOUS_SNAPSHOT');
  });
  it('a same-payload retry changes nothing twice and NO_OP save never renews topic freshness', () => {
    const h = harness(), session = h.login('F001'), original = h.repo.read();
    const entries = original.PulseEntries.filter(e => e.founder_id === 'F001').map(e => ({ entry_id: e.entry_id, topic_id: e.topic_id,
      entry_type: e.entry_type, private_context: e.private_context, visibility: e.visibility, reconfirm: false }));
    const request = { method: 'saveMyPulse', session: session.credential, payload: { entries, email_opt_in: true, expectedRevision: 1 }, requestId: 'same-submit' };
    expect(h.service.rpc(request).ok).toBe(true); const after = h.repo.read();
    expect(h.service.rpc(request).ok).toBe(true);
    expect(h.repo.read().Founders.find(f => f.founder_id === 'F001')!.revision).toBe(after.Founders.find(f => f.founder_id === 'F001')!.revision);
    expect(after.PulseEntries.filter(e => e.founder_id === 'F001')).toEqual(original.PulseEntries.filter(e => e.founder_id === 'F001'));
    expect(after.ConsentLog.length).toBe(original.ConsentLog.length);
  });
  it('a real PAUSE preference suppresses automatic offers for thirty days', () => {
    const h = harness(), session = h.login('F001');
    expect(h.service.rpc({ method: 'updatePreferences', session: session.credential, payload: { action: 'PAUSE' } }).ok).toBe(true);
    expect(computeOpportunities(h.repo.read(), FIXTURE_NOW).some(o => o.founder_id === 'F001')).toBe(false);
    expect(h.repo.read().Founders.find(f => f.founder_id === 'F001')!.pause_until_utc).toBe(plusDays(FIXTURE_NOW, 30));
  });
  it('normalizes a GET link route without consuming interest or recording consent', () => {
    const h = harness(), before = JSON.stringify(h.repo.read());
    expect(safeRoute('opportunity', 'known-id')).toEqual({ view: 'opportunity', id: 'known-id' });
    expect(safeRoute('admin<script>', '"><script>')).toEqual({ view: 'signin', id: '' });
    expect(JSON.stringify(h.repo.read())).toBe(before);
  });
  it('denies a withdrawn selected member even if a stale interest row is still INTERESTED', () => {
    const h = harness('GROUP_READY'), session = h.login('F001');
    h.repo.transaction(db => {
      const group = db.Conversations.find(g => g.conversation_id === 'G001')!; group.status = 'CONFIRMED'; group.meet_url = 'https://meet.google.com/test-link';
      const member = db.ConversationMembers.find(m => m.conversation_id === 'G001' && m.founder_id === 'F001')!; member.status = 'WITHDRAWN'; member.booking_state = 'WITHDRAWN';
    });
    const response = h.service.rpc({ method: 'getScheduling', session: session.credential, payload: { conversationId: 'G001' } });
    expect(response.errorCode).toBe('FORBIDDEN'); expect(JSON.stringify(response)).not.toContain('test-link');
  });
});

describe('independent story privacy review', () => {
  it('holds named text identifying a peer by personal name for review', () => {
    const h = harness('STORY_CASES'), session = h.login('F001'), otherName = str(h.repo.read().Founders.find(f => f.founder_id === 'F002')!, 'full_name');
    const edit = h.service.rpc({ method: 'approveStory', session: session.credential,
      payload: { storyId: 'ST001', version: 1, decision: 'EDIT', approved_text: `I compared hiring notes with ${otherName}.`, sharing_mode: 'NAMED', required_approver_ids: [] } });
    expect(edit.ok).toBe(true);
    expect(h.service.rpc({ method: 'approveStory', session: session.credential, payload: { storyId: 'ST001', version: 2, decision: 'APPROVE' } }).ok).toBe(true);
    const db = h.repo.read(); expect(db.Stories[0].review_required).toBe(true); expect(storyEligible(db, db.Stories[0], FIXTURE_NOW, 'DEMO')).toBe(false);
  });
  it('staff privacy review cannot approve on behalf of a newly required peer', () => {
    const h = harness('STORY_CASES'), owner = h.login('F001'), staff = h.login(h.logins.find(l => l.account_role === 'ADMIN')!.account_id);
    h.service.rpc({ method: 'approveStory', session: owner.credential, payload: { storyId: 'ST001', version: 1, decision: 'EDIT', approved_text: 'Owner-authored exact text about a conversation.', sharing_mode: 'NAMED' } });
    h.service.rpc({ method: 'approveStory', session: owner.credential, payload: { storyId: 'ST001', version: 2, decision: 'APPROVE' } });
    const result = h.service.rpc({ method: 'adminAction', session: staff.credential, payload: { action: 'REVIEW_STORY', payload: { storyId: 'ST001', version: 2, required_approver_ids: ['F002'] } } });
    expect(result.ok).toBe(true);
    const db = h.repo.read(), story = db.Stories[0]; expect(story.version).toBe(3); expect(story.review_required).toBe(false);
    expect(storyEligible(db, story, FIXTURE_NOW, 'DEMO')).toBe(false);
    expect(db.StoryApprovals.some(a => a.founder_id === 'F002' && a.approved_version === 3 && a.decision === 'APPROVED')).toBe(false);
  });
});

describe('revised topic and feedback workflows', () => {
  it('preserves free founder wording and sends only uncertain classifications to Laura', () => {
    const h = harness(), founder = h.login('F001'), staff = h.login('ADMIN_DEMO');
    const pulse = h.service.rpc({ method: 'getMyPulse', session: founder.credential, payload: {} }).data as { entries: Row[]; revision: number };
    const retained = pulse.entries.filter(entry => entry.entry_id !== 'E052').map(entry => ({ entry_id: entry.entry_id, topic_id: entry.topic_id, original_text: entry.original_text, entry_type: entry.entry_type, visibility: entry.visibility, private_context: entry.private_context }));
    const originalText = 'Planning a founder retreat in Iceland';
    const saved = h.service.rpc({ method: 'saveMyPulse', session: founder.credential, payload: { entries: [...retained, { topic_id: '', original_text: originalText, entry_type: 'WORKING_THROUGH', visibility: 'PRIVATE_MATCH_ONLY', private_context: '' }], email_opt_in: true, expectedRevision: pulse.revision } });
    expect(saved.ok).toBe(true);
    const entry = h.repo.read().PulseEntries.find(row => row.original_text === originalText)!;
    expect(entry).toMatchObject({ classification_status: 'needs_review', classification_source: 'demo_structured_llm' });
    expect(h.repo.read().Exceptions.some(row => row.type === 'TOPIC_CLASSIFICATION_REVIEW' && row.target_id === entry.entry_id && !row.resolved_at_utc)).toBe(true);
    const reviewed = h.service.rpc({ method: 'adminAction', session: staff.credential, payload: { action: 'REVIEW_TOPIC', payload: { entryId: entry.entry_id, decision: 'CREATE_NEW', label: 'Founder retreats' } } });
    expect(reviewed.ok).toBe(true);
    expect(h.repo.read().PulseEntries.find(row => row.entry_id === entry.entry_id)?.classification_status).toBe('approved');
  });

  it('treats the feedback sharing choice as permission and leaves publication with Laura', () => {
    const h = harness('STORY_CASES'), founder = h.login('F001'), staff = h.login('ADMIN_DEMO');
    const submitted = h.service.rpc({ method: 'submitFeedback', session: founder.credential, payload: { conversationId: 'G004', attendance_status: 'attended', helped_boolean: true, feedback_text: 'We revised our interview questions.', sharing_permission: 'anonymous_story', no_show_reason: '' } });
    expect(submitted.ok).toBe(true);
    const storyId = String((submitted.data as Row).story_id), story = h.repo.read().Stories.find(row => row.story_id === storyId)!;
    expect(story).toMatchObject({ status: 'DRAFT', review_required: true, sharing_mode: 'ANONYMOUS' });
    expect(h.service.rpc({ method: 'approveStory', session: founder.credential, payload: { storyId, version: story.version, decision: 'APPROVE' } }).errorCode).toBe('FORBIDDEN');
    expect(h.service.rpc({ method: 'adminAction', session: staff.credential, payload: { action: 'APPROVE_STORY', payload: { storyId } } }).ok).toBe(true);
    expect(h.repo.read().Stories.find(row => row.story_id === storyId)).toMatchObject({ status: 'APPROVED', review_required: false });
  });
});
