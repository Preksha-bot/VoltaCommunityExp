import seedInput from './seed.json';
import demoInput from './demo-logins.json';
import oracleInput from './expected-matches.json';
import casesInput from './test-cases.json';
import manifestInput from './fixture-manifest.json';
import { type Database, type Row, type TableName, bool, clone, emptyDatabase, list, str } from '../src/shared/types';
import { candidateEdges } from '../src/domain/index';
import { matchingWeekKey } from '../src/shared/time';

export const FIXTURE_NOW = '2026-10-13T12:00:00Z';
export const fixtureManifest = manifestInput;
export const demoLogins = demoInput as Row[];
export const expectedMatches = oracleInput as Row[];
export const fixtureTestCases = casesInput as Row[];
const PROFILES = new Set(['BASE', 'RETRY_SENT', 'GROUP_READY', 'SAME_COMPANY_GUARD', 'NO_COMMON_SLOT', 'STORY_CASES']);

/** A fresh database for each test. Reference outputs and passwords are excluded. */
export function loadFixture(profile = 'BASE'): Database {
  profile = profile.replace(/_MUTATION$/, '');
  if (!PROFILES.has(profile)) throw new Error(`Unknown fixture profile: ${profile}`);
  const db = emptyDatabase(), seed = seedInput as unknown as Record<string, Row[]>;
  for (const [name, rows] of Object.entries(seed)) {
    db[name as TableName] = clone(rows.filter(row => !str(row, 'fixture_profile') || str(row, 'fixture_profile') === 'BASE' || str(row, 'fixture_profile') === profile));
  }
  for (const login of demoLogins) {
    const founder = db.Founders.find(f => str(f, 'founder_id') === str(login, 'account_id'));
    const admin = str(login, 'account_role') === 'ADMIN';
    if (!founder && !admin) throw new Error('Fixture demo association does not resolve');
    db.Accounts.push({ account_id: str(login, 'account_id'), founder_id: founder ? str(founder, 'founder_id') : null,
      company_id: founder ? str(founder, 'company_id') : null, role: admin ? 'ADMIN' : 'FOUNDER',
      username: str(login, 'username'), username_normalized: str(login, 'username').trim().toLowerCase(),
      company_alias: str(login, 'company_login_alias').trim().toLowerCase() || null,
      provider_subject_id: founder ? str(founder, 'auth_subject_id') : `demo:${str(login, 'account_id')}`,
      ...(admin ? { contact_email: 'laura.demo@example.com', full_name: 'Laura Demo' } : {}),
      status: founder ? str(founder, 'status') : 'ACTIVE', created_at: FIXTURE_NOW, revision: 1, is_synthetic: true });
  }
  for (const history of db.OutreachHistory) {
    const ownEntries = db.PulseEntries.filter(e => str(e, 'founder_id') === str(history, 'founder_id') && str(e, 'topic_id') === str(history, 'topic_id'));
    const roles = new Set(ownEntries.map(e => str(e, 'entry_type')));
    const role = roles.size > 1 ? 'BOTH' : roles.has('WORKING_THROUGH') ? 'WORKING_THROUGH' : 'LIVED_THROUGH';
    history.participation_role = role;
    const companies = new Set(list(history, 'candidate_company_ids'));
    const peers = db.PulseEntries.filter(e => companies.has(str(db.Founders.find(f => str(f, 'founder_id') === str(e, 'founder_id')) ?? {}, 'company_id')));
    history.candidate_edges = candidateEdges(db, str(history, 'founder_id'), str(history, 'topic_id'), role, peers);
    const emailId = str(history, 'email_id'), week = matchingWeekKey(str(history, 'sent_at_utc'));
    if (!db.WeeklyEmails.some(e => str(e, 'email_id') === emailId)) db.WeeklyEmails.push({ email_id: emailId,
      founder_id: str(history, 'founder_id'), matching_week_key: week, unique_key: `DIGEST:${str(history, 'founder_id')}:${week}`,
      type: 'DIGEST', status: 'SENT', mode: 'DRAFT_ONLY', sent_at_utc: str(history, 'sent_at_utc'),
      provider_id: `FAKE_RECEIPT_${emailId}`, simulated: true, is_synthetic: bool(history, 'is_synthetic') });
  }
  // Scenario membership is explicit; a bare interest response never grants disclosure.
  for (const group of db.Conversations.filter(g => str(g, 'status') !== 'COLLECTING_INTEREST')) {
    for (const interest of db.InterestResponses.filter(r => str(r, 'conversation_id') === str(group, 'conversation_id'))) {
      const founder = db.Founders.find(f => str(f, 'founder_id') === str(interest, 'founder_id'))!;
      db.ConversationMembers.push({ conversation_id: str(group, 'conversation_id'), founder_id: str(interest, 'founder_id'),
        company_id: str(founder, 'company_id'), participation_role: str(interest, 'participation_role'),
        status: str(group, 'status'), booking_state: str(group, 'status'), selected_at_utc: str(group, 'created_at_utc'),
        identity_disclosure_consent: bool(interest, 'identity_disclosure_consent'), is_synthetic: true });
    }
  }
  return db;
}
