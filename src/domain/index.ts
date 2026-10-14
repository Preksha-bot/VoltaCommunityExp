import { type Database, type Environment, type GroupEvaluation, type Opportunity, type ParticipationRole, type PulseConfig, type Row, type SnapshotDTO, bool, iso, list, num, plusDays, str } from '../shared/types';
import { readConfig } from '../shared/config';
import { matchingWeekKey } from '../shared/time';

const DAY = 86400000;
const ACTIVE_GROUPS = new Set(['SCHEDULING', 'BOOKING_PENDING', 'BOOKING_RETRYABLE', 'BOOKING_UNKNOWN', 'NEEDS_TECH_REVIEW', 'CONFIRMED']);
const OUTSTANDING = new Set(['QUEUED', 'OFFERED', 'SENT', 'OPEN']);
const VISIBILITY = new Set(['PRIVATE_MATCH_ONLY', 'ANONYMOUS_SNAPSHOT', 'NAMED_SNAPSHOT']);
const ownCompany = (db: Database, founderId: string): string => str(db.Founders.find(r => str(r, 'founder_id') === founderId) ?? {}, 'company_id');
const latest = (rows: Row[], fields: string[]): Row | undefined => rows.map((row, index) => ({ row, index })).sort((a, b) => {
  // Opaque IDs do not encode chronology. At the same timestamp, later durable
  // append order wins, including a revoke written in the same second as grant.
  for (const field of fields.filter(field => field.endsWith('_at_utc'))) {
    const order = str(b.row, field).localeCompare(str(a.row, field)); if (order) return order;
  }
  return num(b.row, 'event_sequence') - num(a.row, 'event_sequence') || b.index - a.index;
})[0]?.row;
const at = (row: Row, key: string): number => iso(str(row, key));
const before = (row: Row, key: string, now: string): boolean => Number.isFinite(at(row, key)) && at(row, key) <= iso(now);
const future = (row: Row, key: string, now: string): boolean => Number.isFinite(at(row, key)) && at(row, key) > iso(now);
const stableHash = (value: string): string => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };

export function latestConsent(db: Database, founderId: string, scope: string, entryId?: string, now?: string): Row | undefined {
  return latest(db.ConsentLog.filter(r => str(r, 'founder_id') === founderId && str(r, 'scope') === scope &&
    (scope !== 'ENTRY_USE' || str(r, 'entry_id') === entryId) && (!now || before(r, 'recorded_at_utc', now))), ['recorded_at_utc', 'consent_event_id']);
}

export function founderIsActive(db: Database, founderId: string): boolean {
  const founder = db.Founders.find(r => str(r, 'founder_id') === founderId);
  const company = db.Companies.find(r => str(r, 'company_id') === str(founder ?? {}, 'company_id'));
  const accounts = db.Accounts.filter(r => str(r, 'founder_id') === founderId);
  return !!founder && !!company && str(founder, 'status') === 'ACTIVE' && str(company, 'status') === 'ACTIVE' &&
    !bool(founder, 'deletion_requested') && !bool(founder, 'suppressed') && !bool(company, 'suppressed') &&
    (accounts.length === 0 || accounts.some(r => str(r, 'status') === 'ACTIVE'));
}

export function entryIsCurrent(db: Database, entry: Row, now: string): boolean {
  if (!founderIsActive(db, str(entry, 'founder_id')) || str(entry, 'status') !== 'ACTIVE' || !future(entry, 'expires_at_utc', now) ||
    !VISIBILITY.has(str(entry, 'visibility')) || bool(entry, 'suppressed') || bool(entry, 'deleted')) return false;
  const consent = latestConsent(db, str(entry, 'founder_id'), 'ENTRY_USE', str(entry, 'entry_id'), now);
  return !!consent && str(consent, 'action') === 'GRANTED' && str(consent, 'permission_value') === str(entry, 'visibility');
}

export function currentEntries(db: Database, founderId: string, topicId: string, now: string): Row[] {
  return db.PulseEntries.filter(e => str(e, 'founder_id') === founderId && str(e, 'topic_id') === topicId && entryIsCurrent(db, e, now));
}

export function canReceiveMatchEmails(db: Database, founderId: string, now: string): boolean {
  const founder = db.Founders.find(r => str(r, 'founder_id') === founderId);
  const consent = latestConsent(db, founderId, 'MATCH_EMAILS', undefined, now);
  if (!founder || !founderIsActive(db, founderId) || !bool(founder, 'email_opt_in') || !consent || str(consent, 'action') !== 'GRANTED' || !bool(consent, 'permission_value')) return false;
  return !future(founder, 'pause_until_utc', now) && !(str(founder, 'email_mode') === 'PAUSED' && !str(founder, 'pause_until_utc'));
}

function activeConversationIds(db: Database, founderId: string, exceptId = ''): Set<string> {
  const candidates = new Set([...db.ConversationMembers.filter(r => str(r, 'founder_id') === founderId && !['WITHDRAWN', 'CANCELLED', 'RELEASED'].includes(str(r, 'status')) && !['WITHDRAWN', 'CANCELLED', 'RELEASED'].includes(str(r, 'booking_state'))).map(r => str(r, 'conversation_id')),
    ...db.InterestResponses.filter(r => str(r, 'founder_id') === founderId && str(r, 'response') === 'INTERESTED' && !db.ConversationMembers.some(m => str(m, 'conversation_id') === str(r, 'conversation_id'))).map(r => str(r, 'conversation_id'))]);
  return new Set(db.Conversations.filter(g => str(g, 'conversation_id') !== exceptId && candidates.has(str(g, 'conversation_id')) && ACTIVE_GROUPS.has(str(g, 'status'))).map(g => str(g, 'conversation_id')));
}

function topicPotentialEligible(db: Database, founderId: string, topicId: string, now: string, config: PulseConfig): boolean {
  const topic = db.Topics.find(r => str(r, 'topic_id') === topicId);
  if (!topic || topicId === 'OTHER' || !bool(topic, 'active') || !bool(topic, 'auto_match_enabled') || !canReceiveMatchEmails(db, founderId, now)) return false;
  if (!currentEntries(db, founderId, topicId, now).some(e => ['WORKING_THROUGH', 'LIVED_THROUGH'].includes(str(e, 'entry_type')))) return false;
  if (activeConversationIds(db, founderId).size >= config.max_active_groups_per_founder) return false;
  if (db.OutreachHistory.some(h => str(h, 'founder_id') === founderId && str(h, 'topic_id') === topicId && future(h, 'cooldown_until_utc', now))) return false;
  return !db.Opportunities.some(o => str(o, 'founder_id') === founderId && str(o, 'topic_id') === topicId && OUTSTANDING.has(str(o, 'status')) && future(o, 'expires_at_utc', now));
}

function lastSuccessfulDigest(db: Database, founderId: string, now: string): Row | undefined {
  return latest(db.WeeklyEmails.filter(e => str(e, 'founder_id') === founderId && str(e, 'status') === 'SENT' && ['DIGEST', 'WEEKLY_DIGEST', ''].includes(str(e, 'type')) && before(e, 'sent_at_utc', now)), ['sent_at_utc', 'email_id']);
}

export function canOfferNewTopic(db: Database, founderId: string, topicId: string, now: string, config = readConfig(db)): boolean {
  if (config.outreach_mode === 'PAUSED' || !topicPotentialEligible(db, founderId, topicId, now, config)) return false;
  const pool = db.PulseEntries.filter(e => str(e, 'topic_id') === topicId && entryIsCurrent(db, e, now) && topicPotentialEligible(db, str(e, 'founder_id'), topicId, now, config));
  if (new Set(pool.map(e => ownCompany(db, str(e, 'founder_id')))).size < config.min_potential_companies || !pool.some(e => str(e, 'entry_type') === 'WORKING_THROUGH')) return false;
  const sent = lastSuccessfulDigest(db, founderId, now);
  return !sent || (matchingWeekKey(str(sent, 'sent_at_utc'), config.matching_timezone) !== matchingWeekKey(now, config.matching_timezone) && iso(now) - at(sent, 'sent_at_utc') >= 7 * DAY);
}

const mergedRole = (entries: Row[]): ParticipationRole => {
  const roles = new Set(entries.map(e => str(e, 'entry_type')));
  return roles.size > 1 ? 'BOTH' : roles.has('WORKING_THROUGH') ? 'WORKING_THROUGH' : 'LIVED_THROUGH';
};
export const entryConfirmedAt = (entry: Row): string => str(entry, 'confirmed_at_utc') || str(entry, 'created_at_utc');

export function candidateEdges(db: Database, founderId: string, topicId: string, role: string, entries: Row[]): string[] {
  const company = ownCompany(db, founderId);
  return [...new Set(entries.filter(e => str(e, 'topic_id') === topicId && ownCompany(db, str(e, 'founder_id')) !== company &&
    (role !== 'LIVED_THROUGH' || str(e, 'entry_type') === 'WORKING_THROUGH')).map(e => `${ownCompany(db, str(e, 'founder_id'))}:${str(e, 'entry_type')}`))].sort();
}

function offeredEdges(db: Database, founderId: string, topicId: string, role: string): Set<string> {
  const edges = new Set<string>();
  for (const history of db.OutreachHistory.filter(h => str(h, 'founder_id') === founderId && str(h, 'topic_id') === topicId && (!str(h, 'participation_role') || str(h, 'participation_role') === role))) {
    if (list(history, 'candidate_edges').length) list(history, 'candidate_edges').forEach(edge => edges.add(edge));
    else {
      const companies = new Set(list(history, 'candidate_company_ids'));
      candidateEdges(db, founderId, topicId, role, db.PulseEntries.filter(e => companies.has(ownCompany(db, str(e, 'founder_id'))))).forEach(edge => edges.add(edge));
    }
  }
  return edges;
}

function recentCompletedPeerCompanies(db: Database, founderId: string, topicId: string, now: string, config: PulseConfig): Set<string> {
  const companies = new Set<string>();
  for (const group of db.Conversations.filter(g => str(g, 'status') === 'COMPLETED' && str(g, 'topic_id') === topicId)) {
    const id = str(group, 'conversation_id');
    const members = [...db.ConversationMembers, ...db.InterestResponses].filter(r => str(r, 'conversation_id') === id && !['WITHDRAWN', 'CANCELLED'].includes(str(r, 'status')));
    if (!members.some(r => str(r, 'founder_id') === founderId)) continue;
    const slot = db.TimeSlots.find(s => str(s, 'slot_id') === str(group, 'selected_slot_id'));
    const ended = str(group, 'completed_at_utc') || str(slot ?? {}, 'end_at_utc');
    if (!ended || iso(now) - iso(ended) >= config.repeat_peer_cooldown_days * DAY) continue;
    const freshRequest = currentEntries(db, founderId, topicId, now).some(e => str(e, 'fresh_request_at_utc') && at(e, 'fresh_request_at_utc') > iso(ended));
    if (!freshRequest) members.forEach(r => { const company = ownCompany(db, str(r, 'founder_id')); if (company !== ownCompany(db, founderId)) companies.add(company); });
  }
  return companies;
}

export function computeOpportunities(db: Database, now: string, config = readConfig(db)): Opportunity[] {
  if (config.outreach_mode === 'PAUSED') return [];
  const opportunities: Opportunity[] = [];
  for (const topic of db.Topics) {
    const topicId = str(topic, 'topic_id');
    const pool = db.PulseEntries.filter(e => str(e, 'topic_id') === topicId && entryIsCurrent(db, e, now) && topicPotentialEligible(db, str(e, 'founder_id'), topicId, now, config));
    const companies = [...new Set(pool.map(e => ownCompany(db, str(e, 'founder_id'))))].sort();
    if (companies.length < config.min_potential_companies || !pool.some(e => str(e, 'entry_type') === 'WORKING_THROUGH')) continue;
    for (const founderId of [...new Set(pool.map(e => str(e, 'founder_id')))].sort()) {
      if (!canOfferNewTopic(db, founderId, topicId, now, config)) continue;
      const entries = pool.filter(e => str(e, 'founder_id') === founderId), role = mergedRole(entries);
      const blockedPeers = recentCompletedPeerCompanies(db, founderId, topicId, now, config);
      const peers = pool.filter(e => ownCompany(db, str(e, 'founder_id')) !== ownCompany(db, founderId) && !blockedPeers.has(ownCompany(db, str(e, 'founder_id'))));
      const effectiveCompanies = [...new Set([ownCompany(db, founderId), ...peers.map(e => ownCompany(db, str(e, 'founder_id')))])].sort();
      if (effectiveCompanies.length < config.min_potential_companies) continue;
      const edges = candidateEdges(db, founderId, topicId, role, peers);
      if (!edges.length || edges.every(edge => offeredEdges(db, founderId, topicId, role).has(edge))) continue;
      const complementary = peers.some(e => entries.some(own => str(e, 'entry_type') !== str(own, 'entry_type')));
      if (!complementary && role === 'LIVED_THROUGH') continue;
      const sent = lastSuccessfulDigest(db, founderId, now);
      const components = { exact_topic: 50, complementary_role: complementary ? 25 : 15,
        recent_peer_confirmation: peers.some(e => iso(entryConfirmedAt(e)) <= iso(now) && iso(now) - iso(entryConfirmedAt(e)) <= 14 * DAY) ? 10 : 0,
        no_recent_digest: !sent || iso(now) - at(sent, 'sent_at_utc') >= 30 * DAY ? 5 : 0, peer_capacity: 5 };
      const fingerprint = `${role}|${edges.join('|')}`;
      opportunities.push({ opportunity_id: `opp-${founderId}-${topicId}-${matchingWeekKey(now, config.matching_timezone)}-${stableHash(fingerprint)}`,
        founder_id: founderId, topic_id: topicId, participation_role: role, candidate_company_ids: effectiveCompanies,
        candidate_edges: edges, fingerprint, score: Object.values(components).reduce((total, points) => total + points, 0),
        score_components: components, reason_codes: ['EXACT_TOPIC', complementary ? 'COMPLEMENTARY_ROLE' : 'PEER_COMPARISON', 'DISTINCT_COMPANY_THRESHOLD', 'NEW_PEER_EDGE'],
        own_confirmed_at_utc: entries.map(entryConfirmedAt).sort().reverse()[0], source_entry_ids: pool.map(e => str(e, 'entry_id')).sort(),
        source_entry_versions: pool.map(e => `${str(e, 'entry_id')}:${num(e, 'revision', 1)}`).sort(), created_at_utc: now,
        expires_at_utc: plusDays(now, config.opportunity_response_days), status: 'AVAILABLE', is_synthetic: entries.some(e => bool(e, 'is_synthetic')) });
    }
  }
  return opportunities.sort((a, b) => a.founder_id.localeCompare(b.founder_id) || b.score - a.score ||
    Number(a.participation_role === 'LIVED_THROUGH') - Number(b.participation_role === 'LIVED_THROUGH') ||
    b.own_confirmed_at_utc.localeCompare(a.own_confirmed_at_utc) || a.topic_id.localeCompare(b.topic_id));
}

const band = (count: number): string => String(count);
const SUBTOPICS: Record<string,string[]> = {
  T01:['When to hire','Role definition','Compensation structure'],T02:['Security reviews','Pricing a paid pilot','Finding an internal champion'],
  T03:['Setting the first price','Moving from free to paid','Pilot pricing'],T04:['Investor readiness','Fundraising narrative','Timing the round'],
  T05:['US entity setup','First US customers','Cross-border hiring'],T06:['Procurement timelines','Finding a public-sector champion','Pilot requirements'],
  T07:['Founder-led sales','Choosing an early segment','Turning pilots into paid work'],T08:['Role scope','Hiring process','Technical leadership'],
  T09:['When to start','Evidence collection','Keeping product work moving'],T10:['Partner incentives','Choosing a channel','Early enablement'],
};
function snapshotSources(db: Database, now: string): Row[] {
  return db.PulseEntries.filter(e => entryIsCurrent(db, e, now) && ['ANONYMOUS_SNAPSHOT', 'NAMED_SNAPSHOT'].includes(str(e, 'visibility')) &&
    bool(db.Topics.find(t => str(t, 'topic_id') === str(e, 'topic_id')) ?? {}, 'active') && str(e, 'topic_id') !== 'OTHER');
}
export function buildSnapshot(db: Database, now: string, config = readConfig(db)): { batch: Row; cells: Row[] } {
  const sources = snapshotSources(db, now), snapshotId = `snapshot-${now.replace(/[^0-9]/g, '')}`;
  const cells: Row[] = [];
  for (const topicId of [...new Set(sources.map(e => str(e, 'topic_id')))].sort()) {
    const topicEntries=sources.filter(e=>str(e,'topic_id')===topicId),topicCompanies=new Set(topicEntries.map(e=>ownCompany(db,str(e,'founder_id'))));
    if(topicCompanies.size<config.snapshot_cell_min_companies)continue;
    for (const type of ['WORKING_THROUGH', 'LIVED_THROUGH']) {
      const entries = topicEntries.filter(e => str(e, 'entry_type') === type);
      const companies = [...new Set(entries.map(e => ownCompany(db, str(e, 'founder_id'))))].sort();
      if (companies.length) cells.push({ snapshot_cell_id: `${snapshotId}-${topicId}-${type}`, snapshot_id: snapshotId, kind: 'AGGREGATE', topic_id: topicId, entry_type: type, count:companies.length, band: band(companies.length), source_entry_ids: entries.map(e => str(e, 'entry_id')), company_ids: companies });
    }
  }
  // No total/denominator is published, so a suppressed complementary cell cannot be recovered by subtraction.
  const namedCompanies = new Set<string>();
  for (const entry of sources.filter(e => str(e, 'visibility') === 'NAMED_SNAPSHOT').sort((a, b) => str(a, 'topic_id').localeCompare(str(b, 'topic_id')) || str(a, 'entry_id').localeCompare(str(b, 'entry_id')))) {
    const founder = db.Founders.find(f => str(f, 'founder_id') === str(entry, 'founder_id')) ?? {};
    const companyId = ownCompany(db, str(entry, 'founder_id')), company = db.Companies.find(c => str(c, 'company_id') === companyId) ?? {};
    if (namedCompanies.size >= 3 || namedCompanies.has(companyId) || !bool(founder, 'can_publish_company') || !bool(company, 'profile_display_consent')) continue;
    namedCompanies.add(companyId);
    cells.push({ snapshot_cell_id: `${snapshotId}-named-${str(entry, 'entry_id')}`, snapshot_id: snapshotId, kind: 'NAMED', topic_id: str(entry, 'topic_id'), entry_type: str(entry, 'entry_type'), company_id: companyId, source_entry_ids: [str(entry, 'entry_id')] });
  }
  const topics = [...new Set(cells.map(c => str(c, 'topic_id')))].sort();
  return { batch: { snapshot_id: snapshotId, generated_at_utc: now, rule_version: '1.0', status: 'ACTIVE' }, cells: cells.filter(c => topics.includes(str(c, 'topic_id'))) };
}

export function getSnapshot(db: Database, now: string, config = readConfig(db),founderId=''): SnapshotDTO {
  const batch = latest(db.SnapshotBatches.filter(b => str(b, 'status') === 'ACTIVE' && before(b, 'generated_at_utc', now)), ['generated_at_utc', 'snapshot_id']);
  const result: SnapshotDTO = { generated_at_utc: batch ? str(batch, 'generated_at_utc') : null, cells: [], topics:[],my_topics:[],needs_experience:[],named_items: [],new_items:[] };
  if (!batch) return result;
  const currentSources=snapshotSources(db,now);
  const batchCells=db.SnapshotCells.filter(c=>str(c,'snapshot_id')===str(batch,'snapshot_id'));
  const frozenSourceIds=new Set(batchCells.flatMap(cell=>list(cell,'source_entry_ids')));
  const frozenSources=currentSources.filter(entry=>frozenSourceIds.has(str(entry,'entry_id')));
  for (const cell of batchCells) {
    const entries = currentSources.filter(e => list(cell, 'source_entry_ids').includes(str(e, 'entry_id')) && str(e, 'topic_id') === str(cell, 'topic_id') && str(e, 'entry_type') === str(cell, 'entry_type'));
    const topic = db.Topics.find(t => str(t, 'topic_id') === str(cell, 'topic_id')) ?? {};
    if (str(cell, 'kind') === 'NAMED') {
      const entry = entries.find(e => str(e, 'visibility') === 'NAMED_SNAPSHOT');
      if (!entry) continue;
      const founder = db.Founders.find(f => str(f, 'founder_id') === str(entry, 'founder_id')) ?? {};
      const company = db.Companies.find(c => str(c, 'company_id') === str(cell, 'company_id')) ?? {};
      if (!bool(founder, 'can_publish_company') || !bool(company, 'profile_display_consent')) continue;
      result.named_items.push({ company_id:str(company,'company_id'),company_name: str(company, 'company_name'), approved_intro: str(company, 'approved_intro'),topic_id:str(topic,'topic_id'), topic_label: str(topic, 'topic_label'), entry_type: str(cell, 'entry_type') });
    } else {
      const count = new Set(entries.map(e => ownCompany(db, str(e, 'founder_id')))).size;
      const allForTopic=currentSources.filter(e=>str(e,'topic_id')===str(cell,'topic_id')),topicCompanyCount=new Set(allForTopic.map(e=>ownCompany(db,str(e,'founder_id')))).size;
      if (count>0&&topicCompanyCount>=config.snapshot_cell_min_companies) result.cells.push({ topic_id: str(cell, 'topic_id'), topic_label: str(topic, 'topic_label'), entry_type: str(cell, 'entry_type'), count,band:band(count) });
    }
  }
  result.named_items = result.named_items.slice(0, 3);
  const myEntries=db.PulseEntries.filter(e=>str(e,'founder_id')===founderId&&entryIsCurrent(db,e,now));
  const topicIds=[...new Set([...result.cells.map(c=>c.topic_id),...myEntries.map(e=>str(e,'topic_id'))])];
  result.topics=topicIds.map(topicId=>{
    const topic=db.Topics.find(t=>str(t,'topic_id')===topicId)??{},working=result.cells.find(c=>c.topic_id===topicId&&c.entry_type==='WORKING_THROUGH')?.count??0,experience=result.cells.find(c=>c.topic_id===topicId&&c.entry_type==='LIVED_THROUGH')?.count??0;
    const openCompanies=new Set(frozenSources.filter(e=>str(e,'topic_id')===topicId&&bool(db.Founders.find(f=>f.founder_id===e.founder_id)??{},'email_opt_in')).map(e=>ownCompany(db,str(e,'founder_id'))));
    const mine=myEntries.filter(e=>str(e,'topic_id')===topicId);
    const aliases=Array.isArray(topic.synonyms)?topic.synonyms.map(String):str(topic,'synonyms').split(/[;|]/).filter(Boolean);
    return{topic_id:topicId,topic_label:str(topic,'topic_label'),working_count:working,experience_count:experience,open_count:openCompanies.size,subtopics:(SUBTOPICS[topicId]||aliases.slice(0,3)).slice(0,3),is_mine:mine.length>0,my_entry_ids:mine.map(e=>str(e,'entry_id')),my_entry_types:mine.map(e=>str(e,'entry_type'))};
  }).filter(topic=>topic.topic_label&&((topic.working_count+topic.experience_count)>=config.snapshot_cell_min_companies||topic.is_mine));
  result.my_topics=result.topics.filter(topic=>topic.is_mine);
  result.needs_experience=result.topics.filter(topic=>topic.working_count>=2&&topic.working_count>topic.experience_count).sort((a,b)=>(b.working_count/Math.max(b.experience_count,1))-(a.working_count/Math.max(a.experience_count,1))).slice(0,3);
  const recent=frozenSources.filter(e=>iso(now)-iso(str(e,'confirmed_at_utc'))<=30*DAY),recentTopics=[...new Set(recent.map(e=>str(e,'topic_id')))];
  result.new_items=recentTopics.slice(0,3).map(topicId=>{const label=str(db.Topics.find(t=>t.topic_id===topicId)??{},'topic_label'),count=new Set(recent.filter(e=>e.topic_id===topicId).map(e=>ownCompany(db,str(e,'founder_id')))).size;return `+${count} ${count===1?'founder':'founders'} sharing ${label.toLowerCase()}`;});
  return result;
}

function latestInterestRows(db: Database, topicId: string, conversationId?: string): Row[] {
  const responses = db.InterestResponses.filter(r => str(r, 'topic_id') === topicId && (conversationId === undefined || str(r, 'conversation_id') === conversationId));
  return [...new Set(responses.map(r => str(r, 'founder_id')))].map(id => latest(responses.filter(r => str(r, 'founder_id') === id), ['responded_at_utc', 'response_id'])!);
}
export function canBookConfirmedInterest(db: Database, response: Row, now: string, config = readConfig(db)): boolean {
  if (str(response, 'response') !== 'INTERESTED' || !founderIsActive(db, str(response, 'founder_id'))) return false;
  const expiry = str(response, 'expires_at_utc') || plusDays(str(response, 'responded_at_utc'), config.interest_ttl_days);
  if (!Number.isFinite(iso(expiry)) || iso(expiry) <= iso(now) || !before(response, 'responded_at_utc', now)) return false;
  const topic = db.Topics.find(t => str(t, 'topic_id') === str(response, 'topic_id'));
  if (!topic || !bool(topic, 'active') || !bool(topic, 'auto_match_enabled') || !currentEntries(db, str(response, 'founder_id'), str(response, 'topic_id'), now).length) return false;
  const membership = latest(db.ConversationMembers.filter(m => str(m, 'conversation_id') === str(response, 'conversation_id') && str(m, 'founder_id') === str(response, 'founder_id')), ['updated_at_utc', 'selected_at_utc']);
  if (!membership && str(response, 'conversation_id') && db.ConversationMembers.some(m => str(m, 'conversation_id') === str(response, 'conversation_id'))) return false;
  return !membership || (!['WITHDRAWN', 'CANCELLED', 'RELEASED'].includes(str(membership, 'status')) && !['WITHDRAWN', 'CANCELLED', 'RELEASED'].includes(str(membership, 'booking_state')) && !str(membership, 'disclosure_revoked_at_utc'));
}
function representatives(db: Database, rows: Row[], max: number): Row[] {
  const accountId = (row: Row): string => str(db.Accounts.find(a => str(a, 'founder_id') === str(row, 'founder_id') && str(a, 'status') === 'ACTIVE') ?? {}, 'account_id') || str(row, 'founder_id');
  const compare = (a: Row, b: Row): number => str(a, 'responded_at_utc').localeCompare(str(b, 'responded_at_utc')) || accountId(a).localeCompare(accountId(b));
  const companies = new Set<string>();
  const unique = rows.slice().sort(compare).filter(r => {
    const id = ownCompany(db, str(r, 'founder_id'));
    if (!id || companies.has(id)) return false;
    companies.add(id); return true;
  });
  const selected = unique.slice(0, max);
  // Preserve the earliest valid representative of each company, then favor a
  // mixed group when a later independent company supplies the missing role.
  for (const role of ['WORKING_THROUGH', 'LIVED_THROUGH']) {
    const suppliesRole = (row: Row) => str(row, 'participation_role') === role || str(row, 'participation_role') === 'BOTH';
    if (selected.length > 1 && !selected.some(suppliesRole)) {
      const alternative = unique.find(suppliesRole);
      if (alternative) selected[selected.length - 1] = alternative;
    }
  }
  return selected.sort(compare).map(r => ({ ...r, company_id: ownCompany(db, str(r, 'founder_id')) }));
}
export function selectCohort(db: Database, topicId: string, now: string, config = readConfig(db)): Row[] {
  if (config.outreach_mode === 'PAUSED') return [];
  const candidates = latestInterestRows(db, topicId).filter(r => {
    const group = db.Conversations.find(g => str(g, 'conversation_id') === str(r, 'conversation_id'));
    return (!group || str(group, 'status') === 'COLLECTING_INTEREST') && canBookConfirmedInterest(db, r, now, config) && activeConversationIds(db, str(r, 'founder_id')).size < config.max_active_groups_per_founder;
  });
  return representatives(db, candidates, config.max_group_participants);
}

export function evaluateGroup(db: Database, conversationId: string, now: string, config = readConfig(db)): GroupEvaluation {
  const empty = (reason_code: string, eligible_members: Row[] = []): GroupEvaluation => ({ eligible_members, selected_slot: null, eligible_company_count: eligible_members.length, reason_code });
  if (config.outreach_mode === 'PAUSED') return empty('GLOBAL_PAUSED');
  const group = db.Conversations.find(g => str(g, 'conversation_id') === conversationId);
  if (!group || ['EXPIRED', 'CANCELLED', 'NO_COMMON_SLOT', 'COMPLETED'].includes(str(group, 'status'))) return empty('INACTIVE_CONVERSATION');
  const members = representatives(db, latestInterestRows(db, str(group, 'topic_id'), conversationId).filter(r => canBookConfirmedInterest(db, r, now, config) && activeConversationIds(db, str(r, 'founder_id'), conversationId).size === 0), config.max_group_participants);
  if (members.length < config.min_confirmed_companies) return empty('INSUFFICIENT_COMPANIES', members);
  if (str(group, 'poll_closes_at_utc') && before(group, 'poll_closes_at_utc', now)) return empty('POLL_EXPIRED', members);
  const slots = db.TimeSlots.filter(s => str(s, 'conversation_id') === conversationId && future(s, 'start_at_utc', now) && at(s, 'start_at_utc') - iso(now) >= num(s, 'minimum_notice_hours', 48) * 3600000);
  const options = slots.map(slot => ({ slot, members: members.filter(member => {
    const availability = latest(db.Availability.filter(a => str(a, 'conversation_id') === conversationId && str(a, 'founder_id') === str(member, 'founder_id') && str(a, 'slot_id') === str(slot, 'slot_id') && before(a, 'confirmed_at_utc', now)), ['confirmed_at_utc', 'availability_id']);
    return !!availability && bool(availability, 'available') && bool(availability, 'booking_consent') && bool(availability, 'identity_disclosure_consent');
  }) })).filter(option => option.members.length >= config.min_confirmed_companies).sort((a, b) => b.members.length - a.members.length || str(a.slot, 'start_at_utc').localeCompare(str(b.slot, 'start_at_utc')) || str(a.slot, 'slot_id').localeCompare(str(b.slot, 'slot_id')));
  if (!options.length) return empty('NO_COMMON_SLOT', members);
  return { eligible_members: options[0].members, selected_slot: options[0].slot, eligible_company_count: options[0].members.length, reason_code: 'READY' };
}

export function storyEligible(db: Database, story: Row, now: string, environment: Environment): boolean {
  if (str(story, 'status') !== 'APPROVED' || !str(story, 'approved_text').trim() || !future(story, 'expires_at_utc', now) || bool(story, 'review_required') ||
    str(story, 'approved_text').trim().split(/\s+/).length > 45 || (environment === 'LIVE' && bool(story, 'is_synthetic'))) return false;
  if (list(story, 'permitted_audiences').length && !list(story, 'permitted_audiences').includes('PULSE_DIGEST')) return false;
  const feedback = db.Feedback.find(f => str(f, 'feedback_id') === str(story, 'source_feedback_id'));
  if (!feedback || !founderIsActive(db, str(feedback, 'founder_id'))) return false;
  const permission=str(feedback,'sharing_permission');
  if(['anonymous_story','named_story'].includes(permission)){
    const owner=db.Founders.find(f=>str(f,'founder_id')===str(feedback,'founder_id'))??{},company=db.Companies.find(c=>str(c,'company_id')===str(owner,'company_id'))??{};
    const mentioned=db.Companies.filter(c=>str(c,'company_name')&&str(story,'approved_text').toLowerCase().includes(str(c,'company_name').toLowerCase())).map(c=>str(c,'company_name'));
    if(permission==='anonymous_story')return mentioned.length===0;
    return bool(owner,'can_publish_company')&&bool(company,'profile_display_consent')&&mentioned.every(name=>name===str(company,'company_name'));
  }
  const approvers = list(story, 'required_approver_ids');
  if (!approvers.length || !['ANONYMOUS', 'NAMED'].includes(str(story, 'sharing_mode'))) return false;
  return approvers.every(id => {
    if (!founderIsActive(db, id)) return false;
    const founder = db.Founders.find(f => str(f, 'founder_id') === id) ?? {};
    const company = db.Companies.find(c => str(c, 'company_id') === str(founder, 'company_id')) ?? {};
    if (str(story, 'sharing_mode') === 'NAMED' && (!bool(founder, 'can_publish_company') || !bool(company, 'profile_display_consent'))) return false;
    const approval = latest(db.StoryApprovals.filter(a => str(a, 'story_id') === str(story, 'story_id') && str(a, 'founder_id') === id), ['decided_at_utc', 'approval_id']);
    return !!approval && str(approval, 'decision') === 'APPROVED' && num(approval, 'approved_version') === num(story, 'version') && before(approval, 'decided_at_utc', now) &&
      str(approval, 'approved_text') === str(story, 'approved_text') && (!str(approval, 'sharing_mode') || str(approval, 'sharing_mode') === str(story, 'sharing_mode'));
  });
}

export function getMetrics(db: Database): Record<string, number> {
  const feedback = [...new Set(db.Feedback.map(f => `${str(f, 'conversation_id')}|${str(f, 'founder_id')}`))].map(key => latest(db.Feedback.filter(f => `${str(f, 'conversation_id')}|${str(f, 'founder_id')}` === key), ['created_at_utc', 'feedback_id'])!);
  const attended = feedback.filter(f => str(f,'attendance_status')==='attended'||f.attended === true || str(f, 'attended') === 'YES');
  const reportedUseful = attended.filter(f => f.helped_boolean===true||['YES', 'SOMEWHAT'].includes(str(f, 'usefulness')));
  const actualFollowOn = attended.filter(f => ['YES', 'HAPPENED', 'ACTUAL'].includes(str(f, 'follow_on_contact')));
  const confirmed = db.Conversations.filter(g => ['CONFIRMED', 'COMPLETED'].includes(str(g, 'status')));
  return { conversations_completed:db.Conversations.filter(g => str(g, 'status') === 'COMPLETED').length,feedback_responses:feedback.length,reported_useful_percent:attended.length?Math.round(reportedUseful.length/attended.length*100):0,story_permitted_feedback:feedback.filter(f=>['anonymous_story','named_story'].includes(str(f,'sharing_permission'))).length,stories_awaiting_review:db.Stories.filter(s=>str(s,'status')==='DRAFT').length,approved_stories:db.Stories.filter(s=>str(s,'status')==='APPROVED'&&!bool(s,'review_required')).length,scheduled_conversations: confirmed.length, confirmed_conversations: confirmed.length,
    completed_conversations: db.Conversations.filter(g => str(g, 'status') === 'COMPLETED').length,
    attended_responses: attended.length, usefulness_denominator: attended.filter(f => ['YES', 'SOMEWHAT', 'NO', 'NOT_YET'].includes(str(f, 'usefulness'))).length,
    useful_responses: reportedUseful.length, useful_conversations: new Set(reportedUseful.map(f => str(f, 'conversation_id'))).size,
    action_reports: attended.filter(f => str(f, 'next_step').trim()).length, actual_follow_on_contacts: actualFollowOn.length,
    planned_follow_on_contacts: attended.filter(f => str(f, 'follow_on_contact') === 'PLANNED').length,
    participating_companies: new Set(attended.map(f => ownCompany(db, str(f, 'founder_id')))).size,
    relevance_declines: db.InterestResponses.filter(r => str(r, 'response') === 'NOT_NOW').length,
    staff_operational_minutes: db.ActivityLog.reduce((total, row) => total + num(row, 'operational_minutes'), 0) };
}
