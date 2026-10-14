import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, expectedMatches, loadFixture } from '../../fixtures/load';
import { buildSnapshot, canBookConfirmedInterest, canOfferNewTopic, computeOpportunities, entryIsCurrent, evaluateGroup, getMetrics, getSnapshot, selectCohort, storyEligible } from '../../src/domain/index';
import { type Database, type Row, clone, plusDays, str } from '../../src/shared/types';
import { readConfig } from '../../src/shared/config';

function grant(db: Database, entry: Row, now = FIXTURE_NOW): void {
  db.ConsentLog.push({ consent_event_id: `test-${db.ConsentLog.length}`, founder_id: entry.founder_id, entry_id: entry.entry_id,
    scope: 'ENTRY_USE', action: 'GRANTED', permission_value: entry.visibility, recorded_at_utc: now });
}
function withdraw(db: Database, entry: Row, now = FIXTURE_NOW): void {
  db.ConsentLog.push({ consent_event_id: `test-${db.ConsentLog.length}`, founder_id: entry.founder_id, entry_id: entry.entry_id,
    scope: 'ENTRY_USE', action: 'REVOKED', permission_value: entry.visibility, recorded_at_utc: now });
}
function newPeer(db: Database, companyId: string, founderId: string, topicId = 'T01', type = 'WORKING_THROUGH'): void {
  db.Companies.push({ company_id: companyId, company_name: 'Synthetic test company', status: 'ACTIVE', profile_display_consent: false, is_synthetic: true });
  db.Founders.push({ founder_id: founderId, company_id: companyId, status: 'ACTIVE', email_opt_in: true, email_mode: 'ACTIVE', is_synthetic: true });
  const entry: Row = { entry_id: `test-${founderId}`, founder_id: founderId, topic_id: topicId, entry_type: type, status: 'ACTIVE',
    visibility: 'PRIVATE_MATCH_ONLY', created_at_utc: FIXTURE_NOW, confirmed_at_utc: FIXTURE_NOW, updated_at_utc: FIXTURE_NOW,
    expires_at_utc: plusDays(FIXTURE_NOW, 30), revision: 1, is_synthetic: true };
  db.PulseEntries.push(entry); grant(db, entry);
  db.ConsentLog.push({ consent_event_id: `email-${founderId}`, founder_id: founderId, scope: 'MATCH_EMAILS', permission_value: 'TRUE', action: 'GRANTED', recorded_at_utc: FIXTURE_NOW });
}
const cards = (db: Database, founderId = 'F001', now = FIXTURE_NOW) => computeOpportunities(db, now).filter(o => o.founder_id === founderId);

describe('deterministic exact-topic opportunities', () => {
  it('derives the complete BASE oracle from domain inputs', () => {
    const db = loadFixture(), actual = computeOpportunities(db, FIXTURE_NOW);
    expect(actual).toHaveLength(32);
    expect(new Set(actual.map(o => o.founder_id)).size).toBe(21);
    for (const expected of expectedMatches) {
      const opportunity = actual.find(o => o.founder_id === expected.founder_id && o.topic_id === expected.topic_id)!;
      expect(opportunity.participation_role).toBe(expected.participation_role);
      expect(opportunity.candidate_company_ids).toEqual(expected.potential_company_ids);
      expect(opportunity.score).toBe(expected.score);
      expect(opportunity.own_confirmed_at_utc).toBe(expected.own_confirmed_at_utc);
    }
  });
  it('counts five founders as three independent companies', () => {
    const matched = computeOpportunities(loadFixture(), FIXTURE_NOW).filter(o => o.topic_id === 'T01');
    expect(matched).toHaveLength(5);
    expect(matched.every(o => o.candidate_company_ids.length === 3)).toBe(true);
  });
  it('allows private matching without leaking notes into cards', () => {
    const db = loadFixture(), entry = db.PulseEntries.find(e => e.entry_id === 'E052')!;
    entry.private_context = 'Secret narrow topic content never inferred';
    expect(cards(db).some(o => o.topic_id === 'T03')).toBe(true);
    expect(JSON.stringify(cards(db))).not.toContain('Secret narrow');
  });
  it('rejects expired, withdrawn, paused, opted-out, inactive and OTHER items', () => {
    const db = loadFixture(), matches = computeOpportunities(db, FIXTURE_NOW);
    for (const id of ['F018', 'F019', 'F020', 'F021', 'F022', 'F024']) expect(matches.some(o => o.founder_id === id)).toBe(false);
    expect(matches.some(o => o.topic_id === 'OTHER')).toBe(false);
    expect(matches.some(o => o.founder_id === 'F023' && o.topic_id === 'T11')).toBe(true);
  });
  it('honors a future pause timestamp even if an old email_mode value remains ACTIVE', () => {
    const db = loadFixture(); db.Founders.find(f => f.founder_id === 'F001')!.pause_until_utc = plusDays(FIXTURE_NOW, 30);
    expect(cards(db)).toHaveLength(0);
  });
  it('treats exact expiry as expired and enforces the latest revocation immediately', () => {
    const db = loadFixture(), entry = db.PulseEntries.find(e => e.entry_id === 'E001')!;
    entry.expires_at_utc = FIXTURE_NOW; expect(entryIsCurrent(db, entry, FIXTURE_NOW)).toBe(false);
    entry.expires_at_utc = plusDays(FIXTURE_NOW, 30); withdraw(db, entry);
    expect(entryIsCurrent(db, entry, FIXTURE_NOW)).toBe(false);
  });
  it('uses durable append order for consent changes sharing the same second', () => {
    const db = loadFixture(), entry = db.PulseEntries.find(e => e.entry_id === 'E001')!;
    grant(db, entry); withdraw(db, entry);
    db.ConsentLog[db.ConsentLog.length - 1].consent_event_id = 'a-random-opaque-id';
    expect(entryIsCurrent(db, entry, FIXTURE_NOW)).toBe(false);
    grant(db, entry); expect(entryIsCurrent(db, entry, FIXTURE_NOW)).toBe(true);
  });
  it('canOffer refuses an insufficient two-company topic pool', () => {
    expect(canOfferNewTopic(loadFixture(), 'F015', 'T10', FIXTURE_NOW)).toBe(false);
  });
  it('does not renew explicit confirmation on an ordinary update', () => {
    const db = loadFixture(), entry = db.PulseEntries.find(e => e.entry_id === 'E001')!;
    entry.updated_at_utc = FIXTURE_NOW;
    expect(cards(db).find(o => o.topic_id === 'T01')!.own_confirmed_at_utc).toBe('2026-10-05T12:00:00Z');
  });
  it('merges current and experience into one BOTH card', () => {
    const db = loadFixture(), source = clone(db.PulseEntries.find(e => e.entry_id === 'E001')!);
    source.entry_id = 'test-both'; source.entry_type = 'LIVED_THROUGH'; db.PulseEntries.push(source); grant(db, source);
    const matching = cards(db).filter(o => o.topic_id === 'T01');
    expect(matching).toHaveLength(1); expect(matching[0].participation_role).toBe('BOTH');
  });
  it('permits peer-only comparison but refuses experience-only supply', () => {
    const db = loadFixture();
    db.PulseEntries.find(e => e.entry_id === 'E020')!.entry_type = 'WORKING_THROUGH';
    const peerCards = computeOpportunities(db, FIXTURE_NOW).filter(o => o.topic_id === 'T08');
    expect(peerCards).toHaveLength(3); expect(peerCards.every(o => o.score === 85 && o.reason_codes.includes('PEER_COMPARISON'))).toBe(true);
    for (const entry of db.PulseEntries.filter(e => e.topic_id === 'T08')) entry.entry_type = 'LIVED_THROUGH';
    expect(computeOpportunities(db, FIXTURE_NOW).some(o => o.topic_id === 'T08')).toBe(false);
  });
  it('returns four MAIL02 eligible cards before recipient cap with deterministic order', () => {
    const db = loadFixture(); db.OutreachHistory.find(h => h.history_id === 'H002')!.cooldown_until_utc = '2026-10-12T12:00:00Z';
    expect(cards(db).map(o => o.topic_id)).toEqual(['T03', 'T01', 'T04', 'T02']);
    expect(cards(db).slice(0, 3).map(o => o.topic_id)).toEqual(['T03', 'T01', 'T04']);
    expect(cards(db, 'F009').some(o => o.topic_id === 'T02')).toBe(false);
  });
  it('suppresses same-week retries and enforces a full seven-day gap', () => {
    expect(cards(loadFixture('RETRY_SENT'))).toHaveLength(0);
    const db = loadFixture(); db.WeeklyEmails.push({ email_id: 'last', founder_id: 'F001', type: 'DIGEST', status: 'SENT', sent_at_utc: '2026-10-07T12:00:01Z' });
    expect(canOfferNewTopic(db, 'F001', 'T01', '2026-10-14T12:00:00Z')).toBe(false);
    expect(canOfferNewTopic(db, 'F001', 'T01', '2026-10-14T12:00:01Z')).toBe(true);
  });
  it('requires a genuinely new edge; reorder, deletion and renewal are quiet', () => {
    const db = loadFixture(), offered = cards(db).find(o => o.topic_id === 'T01')!;
    db.OutreachHistory.push({ history_id: 'offered', founder_id: 'F001', topic_id: 'T01', participation_role: offered.participation_role, candidate_edges: offered.candidate_edges, candidate_company_ids: offered.candidate_company_ids, sent_at_utc: FIXTURE_NOW });
    expect(cards(db).some(o => o.topic_id === 'T01')).toBe(false);
    db.PulseEntries.reverse(); db.Topics.find(t => t.topic_id === 'T01')!.topic_label = 'Renamed label';
    db.PulseEntries.find(e => e.entry_id === 'E001')!.expires_at_utc = plusDays(FIXTURE_NOW, 90);
    expect(cards(db).some(o => o.topic_id === 'T01')).toBe(false);
    newPeer(db, 'C099', 'F099'); expect(cards(db).some(o => o.topic_id === 'T01')).toBe(true);
  });
  it('does not clear decline/no-response cooldown when a new peer appears', () => {
    const db = loadFixture(); newPeer(db, 'C099', 'F099', 'T06');
    expect(cards(db, 'F008').some(o => o.topic_id === 'T06')).toBe(false);
  });
  it('protects against repeating completed same-topic peer pairs', () => {
    const db = loadFixture('STORY_CASES');
    expect(cards(db).some(o => o.topic_id === 'T01')).toBe(false);
    db.PulseEntries.find(e => e.entry_id === 'E001')!.fresh_request_at_utc = FIXTURE_NOW;
    expect(cards(db).some(o => o.topic_id === 'T01')).toBe(true);
  });
});

describe('privacy-safe frozen snapshots', () => {
  it('returns exact privacy-threshold counts without private founder fields', () => {
    const db = loadFixture(), snapshot = buildSnapshot(db, FIXTURE_NOW);
    db.SnapshotBatches.push(snapshot.batch); db.SnapshotCells.push(...snapshot.cells);
    const dto = getSnapshot(db, FIXTURE_NOW), serialized = JSON.stringify(dto);
    expect(dto.generated_at_utc).toBe(FIXTURE_NOW); expect(dto.named_items.length).toBeLessThanOrEqual(3);
    for (const key of ['private_context', 'source_entry_ids', 'founder_id', 'email']) expect(serialized).not.toContain(`"${key}"`);
    expect(dto.cells.every(c => Number.isInteger(c.count) && c.band === String(c.count))).toBe(true);
    expect(dto.cells.some(c => c.count === 2)).toBe(true);
  });
  it('does not add new contributors between batches and suppresses revoked named items', () => {
    const db = loadFixture(), built = buildSnapshot(db, FIXTURE_NOW);
    db.SnapshotBatches.push(built.batch); db.SnapshotCells.push(...built.cells);
    const before = getSnapshot(db, FIXTURE_NOW);
    newPeer(db, 'C099', 'F099'); expect(getSnapshot(db, FIXTURE_NOW)).toEqual(before);
    const namedEntry = db.PulseEntries.find(e => e.entry_id === 'E002')!; withdraw(db, namedEntry);
    expect(getSnapshot(db, FIXTURE_NOW).named_items.length).toBe(before.named_items.length - 1);
  });
  it('suppresses a cell when revocation drops the distinct-company threshold', () => {
    const db = loadFixture();
    for (const id of ['E001', 'E005']) { const e = db.PulseEntries.find(e => e.entry_id === id)!; e.visibility = 'ANONYMOUS_SNAPSHOT'; grant(db, e); }
    const lived = db.PulseEntries.find(e => e.entry_id === 'E004')!; lived.visibility = 'PRIVATE_MATCH_ONLY'; grant(db, lived);
    const optedOutSnapshotEntry = db.PulseEntries.find(e => e.entry_id === 'E037')!;
    optedOutSnapshotEntry.visibility = 'PRIVATE_MATCH_ONLY'; grant(db, optedOutSnapshotEntry);
    const built = buildSnapshot(db, FIXTURE_NOW); db.SnapshotBatches.push(built.batch); db.SnapshotCells.push(...built.cells);
    expect(getSnapshot(db, FIXTURE_NOW).cells.some(c => c.topic_id === 'T01' && c.entry_type === 'WORKING_THROUGH')).toBe(true);
    withdraw(db, db.PulseEntries.find(e => e.entry_id === 'E005')!, plusDays(FIXTURE_NOW, 1));
    expect(getSnapshot(db, plusDays(FIXTURE_NOW, 1)).cells.some(c => c.topic_id === 'T01' && c.entry_type === 'WORKING_THROUGH')).toBe(false);
  });
});

describe('independent-company scheduling and permission checks', () => {
  it('books only S001 for GROUP_READY and retains separate booking/disclosure evidence', () => {
    const db = loadFixture('GROUP_READY'), evaluation = evaluateGroup(db, 'G001', FIXTURE_NOW);
    expect(evaluation.reason_code).toBe('READY'); expect(evaluation.selected_slot?.slot_id).toBe('S001');
    expect(evaluation.eligible_company_count).toBe(3);
    expect(db.InterestResponses.every(r => r.identity_disclosure_consent === false)).toBe(true);
  });
  it('denies three people representing only two companies', () => {
    const db = loadFixture('SAME_COMPANY_GUARD');
    expect(selectCohort(db, 'T01', FIXTURE_NOW)).toHaveLength(2);
    expect(evaluateGroup(db, 'G003', FIXTURE_NOW).reason_code).toBe('INSUFFICIENT_COMPANIES');
  });
  it('uses account-ID tie-breaks for company representatives and prefers a mixed cohort', () => {
    const ties = loadFixture('SAME_COMPANY_GUARD');
    ties.Accounts.find(a => a.founder_id === 'F001')!.account_id = 'zz-primary-account';
    ties.Accounts.find(a => a.founder_id === 'F025')!.account_id = 'aa-cofounder-account';
    expect(selectCohort(ties, 'T01', FIXTURE_NOW).find(r => r.company_id === 'C001')!.founder_id).toBe('F025');
    const db = loadFixture(); newPeer(db, 'C099', 'F099'); newPeer(db, 'C098', 'F098');
    const ids = ['F001', 'F003', 'F099', 'F098', 'F002'];
    db.InterestResponses = ids.map((founderId, index) => ({ response_id: `mixed-${founderId}`, founder_id: founderId, conversation_id: null,
      topic_id: 'T01', participation_role: founderId === 'F002' ? 'LIVED_THROUGH' : 'WORKING_THROUGH', response: 'INTERESTED',
      responded_at_utc: plusDays(FIXTURE_NOW, index / 86400), identity_disclosure_consent: false }));
    const selected = selectCohort(db, 'T01', plusDays(FIXTURE_NOW, 10 / 86400), readConfig(db, { max_group_participants: 3 }));
    expect(selected.map(r => r.founder_id)).toEqual(['F001', 'F003', 'F002']);
    expect(new Set(selected.map(r => r.company_id)).size).toBe(3);
  });
  it('keeps no-common-slot pending and detects its explicit deadline', () => {
    const db = loadFixture('NO_COMMON_SLOT');
    expect(evaluateGroup(db, 'G002', FIXTURE_NOW).reason_code).toBe('NO_COMMON_SLOT');
    expect(evaluateGroup(db, 'G002', '2026-10-16T12:00:00Z').reason_code).toBe('POLL_EXPIRED');
  });
  it('rechecks withdrawals and latest availability denial immediately', () => {
    const db = loadFixture('GROUP_READY');
    withdraw(db, db.PulseEntries.find(e => e.entry_id === 'E005')!);
    expect(evaluateGroup(db, 'G001', FIXTURE_NOW).selected_slot).toBeNull();
    const fresh = loadFixture('GROUP_READY');
    fresh.Availability.push({ ...fresh.Availability[2], availability_id: 'newest', booking_consent: false, confirmed_at_utc: plusDays(FIXTURE_NOW, 1) });
    expect(evaluateGroup(fresh, 'G001', plusDays(FIXTURE_NOW, 1)).selected_slot).toBeNull();
  });
  it('email unsubscribe blocks new offers without revoking already-authorized booking', () => {
    const db = loadFixture('GROUP_READY'), founder = db.Founders.find(f => f.founder_id === 'F001')!;
    founder.email_opt_in = false;
    db.ConsentLog.push({ consent_event_id: 'unsubscribe', founder_id: 'F001', scope: 'MATCH_EMAILS', action: 'DECLINED', permission_value: 'FALSE', recorded_at_utc: FIXTURE_NOW });
    expect(canOfferNewTopic(db, 'F001', 'T01', FIXTURE_NOW)).toBe(false);
    expect(evaluateGroup(db, 'G001', FIXTURE_NOW).reason_code).toBe('READY');
  });
  it('uses exclusive fourteen-day interest expiry and a global booking pause', () => {
    const db = loadFixture('GROUP_READY'), interest = db.InterestResponses[0];
    interest.expires_at_utc = FIXTURE_NOW; expect(canBookConfirmedInterest(db, interest, FIXTURE_NOW)).toBe(false);
    expect(evaluateGroup(loadFixture('GROUP_READY'), 'G001', FIXTURE_NOW, readConfig(db, { outreach_mode: 'PAUSED' })).reason_code).toBe('GLOBAL_PAUSED');
  });
});

describe('exact-version stories and attendee-reported metrics', () => {
  it('permits ST001 only in demo while incomplete and withdrawn stories stay private', () => {
    const db = loadFixture('STORY_CASES');
    expect(storyEligible(db, db.Stories[0], FIXTURE_NOW, 'DEMO')).toBe(true);
    expect(storyEligible(db, db.Stories[0], FIXTURE_NOW, 'LIVE')).toBe(false);
    expect(storyEligible(db, db.Stories[1], FIXTURE_NOW, 'DEMO')).toBe(false);
    expect(storyEligible(db, db.Stories[2], FIXTURE_NOW, 'DEMO')).toBe(false);
  });
  it('requires new approvals after a story version edit and respects exact expiry', () => {
    const db = loadFixture('STORY_CASES'), story = db.Stories[0];
    story.version = 2; story.approved_text = 'Changed exact wording'; expect(storyEligible(db, story, FIXTURE_NOW, 'DEMO')).toBe(false);
    story.version = 1; story.expires_at_utc = FIXTURE_NOW; expect(storyEligible(db, story, FIXTURE_NOW, 'DEMO')).toBe(false);
  });
  it('binds approvals to exact text and audience, rejects holds and deleted source authors', () => {
    const db = loadFixture('STORY_CASES'), story = db.Stories[0];
    story.approved_text = 'Different wording with an unchanged version'; expect(storyEligible(db, story, FIXTURE_NOW, 'DEMO')).toBe(false);
    const fresh = loadFixture('STORY_CASES'), source = fresh.Stories[0];
    source.review_required = true; expect(storyEligible(fresh, source, FIXTURE_NOW, 'DEMO')).toBe(false);
    source.review_required = false; source.status = 'WITHHELD'; expect(storyEligible(fresh, source, FIXTURE_NOW, 'DEMO')).toBe(false);
    source.status = 'APPROVED'; fresh.Founders.find(f => f.founder_id === 'F001')!.status = 'DELETION_PENDING';
    expect(storyEligible(fresh, source, FIXTURE_NOW, 'DEMO')).toBe(false);
  });
  it('omits oversized story text instead of truncating an approved quotation', () => {
    const db = loadFixture('STORY_CASES'), story = db.Stories[0]; story.approved_text = Array(46).fill('word').join(' ');
    db.StoryApprovals.find(a => a.story_id === 'ST001')!.approved_text = story.approved_text;
    expect(storyEligible(db, story, FIXTURE_NOW, 'DEMO')).toBe(false);
  });
  it('rechecks named-company publication authority for every exact-version approver', () => {
    const db = loadFixture('STORY_CASES'), story = db.Stories[1]; story.status = 'APPROVED';
    const approval = db.StoryApprovals.find(a => a.story_id === 'ST002' && a.founder_id === 'F002')!;
    approval.decision = 'APPROVED'; approval.decided_at_utc = FIXTURE_NOW;
    expect(storyEligible(db, story, FIXTURE_NOW, 'DEMO')).toBe(true);
    db.Companies.find(c => c.company_id === 'C002')!.profile_display_consent = false;
    expect(storyEligible(db, story, FIXTURE_NOW, 'DEMO')).toBe(false);
  });
  it('separates completion, attendance, usefulness and planned versus actual follow-on', () => {
    const metrics = getMetrics(loadFixture('STORY_CASES'));
    expect(metrics.completed_conversations).toBe(1); expect(metrics.attended_responses).toBe(2);
    expect(metrics.usefulness_denominator).toBe(2); expect(metrics.useful_responses).toBe(2);
    expect(metrics.planned_follow_on_contacts).toBe(1); expect(metrics.actual_follow_on_contacts).toBe(0);
  });
  it('counts live boolean attendance and negative usefulness without overstating usefulness', () => {
    const db = loadFixture('STORY_CASES'); db.Feedback[0].attended = true; db.Feedback[0].usefulness = 'NOT_YET';
    db.Feedback[2].attended = false;
    const metrics = getMetrics(db); expect(metrics.attended_responses).toBe(2); expect(metrics.usefulness_denominator).toBe(2); expect(metrics.useful_responses).toBe(1);
  });
  it('keeps the clock normalized and plaintext credentials outside every operational profile', () => {
    for (const profile of ['BASE', 'RETRY_SENT', 'GROUP_READY', 'SAME_COMPANY_GUARD', 'NO_COMMON_SLOT', 'STORY_CASES']) {
      const db = loadFixture(profile);
      expect(db.Settings.find(r => r.setting_key === 'fixture_now_utc')!.setting_value).toBe(FIXTURE_NOW);
      expect(JSON.stringify(db)).not.toContain('demo_password');
      expect(new Set(db.Conversations.map(g => str(g, 'fixture_profile'))).size).toBeLessThanOrEqual(1);
    }
  });
});
