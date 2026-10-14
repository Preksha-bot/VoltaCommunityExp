import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import seed from '../fixtures/seed.json';
import { expectedMatches, fixtureManifest, fixtureTestCases, FIXTURE_NOW, loadFixture } from '../fixtures/load';
import { computeOpportunities } from '../src/domain/index';
import { type Row, list, str } from '../src/shared/types';

const source = fileURLToPath(new URL('../fixtures/source/Volta_Pulse_V1_Fictional_Founders.xlsx', import.meta.url));
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), fixtureManifest.source_sha256);
assert.equal(fixtureManifest.fixture_now_utc, FIXTURE_NOW);
assert.equal(fixtureTestCases.length, 38);
assert(fixtureTestCases.every(t => t.result === 'NOT_RUN'), 'Source test claims must stay NOT_RUN');

const tables = seed as unknown as Record<string, Row[]>;
const keys: Record<string, string> = { Companies: 'company_id', Founders: 'founder_id', Topics: 'topic_id', PulseEntries: 'entry_id', ConsentLog: 'consent_event_id', OutreachHistory: 'history_id', Conversations: 'conversation_id', InterestResponses: 'response_id', TimeSlots: 'slot_id', Availability: 'availability_id', Feedback: 'feedback_id', Stories: 'story_id', StoryApprovals: 'approval_id', Settings: 'setting_key' };
const ids: Record<string, Set<string>> = {};
for (const [name, rows] of Object.entries(tables)) {
  assert.equal(rows.length, fixtureManifest.counts[name as keyof typeof fixtureManifest.counts], `${name} count`);
  ids[name] = new Set(rows.map(r => str(r, keys[name])));
  assert.equal(ids[name].size, rows.length, `${name} duplicate key`);
  assert(!ids[name].has(''), `${name} missing key`);
  for (const row of rows) {
    for (const field of fixtureManifest.source_fields[name as keyof typeof fixtureManifest.source_fields]) assert(field in row, `${name}.${field} missing`);
    for (const [field, value] of Object.entries(row)) {
      if (field.endsWith('_utc') && value !== null) assert(typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value)), `${name}.${field} timestamp`);
      if (field === 'is_synthetic') assert.equal(value, true, `${name} lost synthetic marker`);
      if (['email_opt_in','can_publish_company','profile_display_consent','active','auto_match_enabled','available','booking_consent','identity_disclosure_consent','story_requested'].includes(field)) assert.equal(typeof value, 'boolean', `${name}.${field} boolean`);
    }
    assert(!('demo_password' in row), 'Credential escaped its isolated bundle');
  }
}
const foreign: Record<string, string> = { company_id: 'Companies', founder_id: 'Founders', topic_id: 'Topics', entry_id: 'PulseEntries', primary_founder_id: 'Founders', conversation_id: 'Conversations', slot_id: 'TimeSlots', selected_slot_id: 'TimeSlots', source_feedback_id: 'Feedback', story_id: 'Stories', required_approver_ids: 'Founders', candidate_company_ids: 'Companies' };
for (const [table, rows] of Object.entries(tables)) for (const row of rows) for (const [field, target] of Object.entries(foreign)) {
  if (!(field in row) || row[field] === null || row[field] === '') continue;
  const values = field.endsWith('_ids') ? list(row, field) : [str(row, field)];
  for (const id of values) assert(ids[target].has(id), `${table}.${field} unresolved ${id}`);
}
for (const company of tables.Companies) assert.equal(tables.Founders.find(f => f.founder_id === company.primary_founder_id)?.company_id, company.company_id);
assert(tables.Founders.every(f => str(f, 'email').endsWith('@example.com')), 'Fixture address safety');
const db = loadFixture();
assert.equal(db.Settings.find(r => r.setting_key === 'fixture_now_utc')?.setting_value, FIXTURE_NOW);
assert.equal(db.Accounts.length, 29);
assert(!JSON.stringify(db).includes('demo_password'), 'Plaintext password in operational database');

// Independent BASE calculation deliberately does not call domain eligibility or matching helpers.
const founders = new Map(db.Founders.map(f => [str(f, 'founder_id'), f]));
const companies = new Map(db.Companies.map(c => [str(c, 'company_id'), c]));
const latestConsent = (founder: string, entry: string | null): Row | undefined => db.ConsentLog.filter(c => c.founder_id === founder && (entry ? c.scope === 'ENTRY_USE' && c.entry_id === entry : c.scope === 'MATCH_EMAILS')).sort((a, b) => str(b, 'recorded_at_utc').localeCompare(str(a, 'recorded_at_utc')) || str(b, 'consent_event_id').localeCompare(str(a, 'consent_event_id')))[0];
const fresh = db.PulseEntries.filter(e => {
  const founder = founders.get(str(e, 'founder_id'))!, company = companies.get(str(founder, 'company_id'))!;
  const topic = db.Topics.find(t => t.topic_id === e.topic_id);
  return founder.status === 'ACTIVE' && company.status === 'ACTIVE' && founder.email_opt_in === true && !(founder.email_mode === 'PAUSED' && (!founder.pause_until_utc || Date.parse(str(founder, 'pause_until_utc')) > Date.parse(FIXTURE_NOW))) &&
    e.status === 'ACTIVE' && Date.parse(str(e, 'expires_at_utc')) > Date.parse(FIXTURE_NOW) && topic?.active === true && topic?.auto_match_enabled === true &&
    latestConsent(str(e, 'founder_id'), str(e, 'entry_id'))?.action === 'GRANTED' && latestConsent(str(e, 'founder_id'), null)?.permission_value === 'TRUE' &&
    !db.OutreachHistory.some(h => h.founder_id === e.founder_id && h.topic_id === e.topic_id && Date.parse(str(h, 'cooldown_until_utc')) > Date.parse(FIXTURE_NOW));
});
const independent: Row[] = [];
for (const topic of db.Topics) {
  const pool = fresh.filter(e => e.topic_id === topic.topic_id), companyIds = [...new Set(pool.map(e => str(founders.get(str(e, 'founder_id'))!, 'company_id')))].sort();
  if (companyIds.length < 3 || !pool.some(e => e.entry_type === 'WORKING_THROUGH')) continue;
  for (const founderId of [...new Set(pool.map(e => str(e, 'founder_id')))]) {
    const own = pool.filter(e => e.founder_id === founderId), companyId = founders.get(founderId)!.company_id;
    const peers = pool.filter(e => founders.get(str(e, 'founder_id'))!.company_id !== companyId);
    const roles = new Set(own.map(e => str(e, 'entry_type'))), complementary = peers.some(p => own.some(o => o.entry_type !== p.entry_type));
    const prior = db.WeeklyEmails.some(e => e.founder_id === founderId && Date.parse(FIXTURE_NOW) - Date.parse(str(e, 'sent_at_utc')) < 30 * 86400000);
    const recent = peers.some(e => Date.parse(FIXTURE_NOW) - Date.parse(str(e, 'confirmed_at_utc')) <= 14 * 86400000);
    independent.push({ founder_id: founderId, topic_id: str(topic, 'topic_id'), participation_role: roles.size > 1 ? 'BOTH' : [...roles][0],
      potential_company_count: companyIds.length, potential_company_ids: companyIds, score: 50 + (complementary ? 25 : 15) + (recent ? 10 : 0) + (prior ? 0 : 5) + 5,
      own_confirmed_at_utc: own.map(e => str(e, 'confirmed_at_utc')).sort().reverse()[0], in_first_digest: true, expected_action: 'OFFER_INTEREST' });
  }
}
const order = (rows: Row[]) => rows.slice().sort((a, b) => `${a.founder_id}:${a.topic_id}`.localeCompare(`${b.founder_id}:${b.topic_id}`));
const reference = expectedMatches.map(({ explanation: _explanation, ...row }) => row);
assert.deepEqual(order(independent), order(reference));
const actual = computeOpportunities(db, FIXTURE_NOW).map(o => ({ founder_id: o.founder_id, topic_id: o.topic_id, participation_role: o.participation_role,
  potential_company_count: o.candidate_company_ids.length, potential_company_ids: o.candidate_company_ids, score: o.score,
  own_confirmed_at_utc: o.own_confirmed_at_utc, in_first_digest: true, expected_action: 'OFFER_INTEREST' }));
assert.deepEqual(order(actual), order(independent));
assert.equal(new Set(actual.map(o => o.founder_id)).size, 21);
console.log('Fixture validation passed: source hash, 14 table schemas/FKs, 29 isolated accounts, independent 32-card / 21-founder BASE oracle. Source application tests remain NOT_RUN.');
