export type Environment = 'DEMO' | 'TEST' | 'LIVE';
export type OutreachMode = 'DRAFT_ONLY' | 'LIVE' | 'PAUSED';
export type Role = 'FOUNDER' | 'ADMIN';
export type ParticipationRole = 'WORKING_THROUGH' | 'LIVED_THROUGH' | 'BOTH';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Row = { [key: string]: JsonValue };
export const TABLES = ['Companies', 'Founders', 'Topics', 'PulseEntries', 'ConsentLog', 'OutreachHistory', 'Conversations', 'InterestResponses', 'TimeSlots', 'Availability', 'Feedback', 'Stories', 'StoryApprovals', 'Settings', 'Accounts', 'AuthSessions', 'MatchRuns', 'Opportunities', 'WeeklyEmails', 'WeeklyEmailItems', 'ConversationMembers', 'SnapshotBatches', 'SnapshotCells', 'ActivityLog', 'Exceptions', 'AuthAttempts', 'RequestResults'] as const;
export type TableName = typeof TABLES[number];
export type Database = Record<TableName, Row[]>;
export interface Principal { account_id: string; founder_id: string | null; company_id: string | null; role: Role; }
export interface VerifiedSession { credential: string; principal: Principal; expires_at_utc: string; }
export interface RpcResult<T = unknown> { ok: boolean; data?: T; errorCode?: string; fieldErrors?: Record<string, string>; requestId: string; }
export interface Opportunity extends Row {
  opportunity_id: string; founder_id: string; topic_id: string; participation_role: ParticipationRole;
  candidate_company_ids: string[]; candidate_edges: string[]; fingerprint: string;
  score: number; score_components: { [key: string]: number }; reason_codes: string[];
  own_confirmed_at_utc: string; source_entry_ids: string[]; source_entry_versions: string[];
  created_at_utc: string; expires_at_utc: string; status: string; is_synthetic: boolean;
}
export interface SnapshotTopicDTO { topic_id: string; topic_label: string; working_count: number; experience_count: number; open_count: number; subtopics: string[]; is_mine: boolean; my_entry_ids: string[]; my_entry_types: string[]; }
export interface SnapshotDTO {
  generated_at_utc: string | null;
  cells: { topic_id: string; topic_label: string; entry_type: string; count: number; band: string }[];
  topics: SnapshotTopicDTO[];
  my_topics: SnapshotTopicDTO[];
  needs_experience: SnapshotTopicDTO[];
  named_items: { company_id: string; company_name: string; approved_intro: string; topic_id: string; topic_label: string; entry_type: string }[];
  new_items: string[];
}
export interface TopicClassification {
  original_text: string; normalized_label: string; recommended_existing_topic_id: string | null;
  recommended_existing_topic_label: string | null; match_confidence: number;
  decision: 'map_existing' | 'propose_new' | 'needs_review'; aliases: string[]; reason_short: string;
}
export interface StoryDraftResult { draft_story: string; detail_level: 'HIGH' | 'MEDIUM' | 'LOW'; source_facts_used: string[]; }
export interface GroupEvaluation { eligible_members: Row[]; selected_slot: Row | null; eligible_company_count: number; reason_code: string; }
export interface PulseConfig {
  environment: Environment; outreach_mode: OutreachMode; matching_timezone: string;
  max_cards_per_digest: number; min_potential_companies: number; min_confirmed_companies: number;
  max_group_participants: number; meeting_duration_minutes: number; max_active_groups_per_founder: number;
  current_topic_ttl_days: number; experience_topic_ttl_days: number; interest_ttl_days: number;
  opportunity_response_days: number; opportunity_cooldown_days: number; repeat_peer_cooldown_days: number;
  snapshot_cell_min_companies: number; poll_window_days: number; poll_reminder_after_hours: number;
  feedback_delay_hours: number; runtime_logging_retention_days: number; story_ttl_days: number;
  private_note_grace_days: number; test_recipient_allowlist: string[]; live_sender_address: string;
  live_calendar_id: string; authenticated_return_url: string; auth_backend: string;
  auth_api_key: string; app_url: string; gates_approved: boolean; reconciliation_approved: boolean;
  slot_windows: { weekday: number; hour: number; minute: number }[];
}
export interface EmailMessage { intent_id: string; to: string; subject: string; html: string; text: string; message_id: string; is_synthetic: boolean; recipient_subject?: string; }
export interface EmailReceipt { provider_id: string; sent_at_utc: string; simulated: boolean; }
export interface CalendarRequest { event_id: string; conversation_id: string; topic_label: string; start_at_utc: string; end_at_utc: string; conference_request_id: string; is_synthetic: boolean; }
export interface CalendarReceipt { event_id: string; conference_status: 'PENDING' | 'READY' | 'FAILED'; meet_url: string | null; attendee_emails: string[]; cancelled: boolean; simulated: boolean; start_at_utc?: string; end_at_utc?: string; }
export interface CalendarAttendee { founder_id: string; email: string; name: string; company_name: string; is_synthetic: boolean; auth_subject_id?: string; }
export interface CalendarPrivacyAuthorization { actor_account_id: string; audit_id: string; }
export class PulseError extends Error { constructor(public code: string, message = code, public fields?: Record<string, string>) { super(message); } }
export class TransportError extends Error { constructor(public certainty: 'DEFINITE' | 'UNKNOWN', public code: string, message = code) { super(message); } }
export const str = (row: Row, key: string): string => typeof row[key] === 'string' ? row[key] as string : '';
export const num = (row: Row, key: string, fallback = 0): number => typeof row[key] === 'number' ? row[key] as number : fallback;
export const bool = (row: Row, key: string): boolean => row[key] === true || row[key] === 'TRUE';
export const list = (row: Row, key: string): string[] => Array.isArray(row[key]) ? (row[key] as JsonValue[]).filter((v): v is string => typeof v === 'string') : typeof row[key] === 'string' ? (row[key] as string).split('|').filter(Boolean) : [];
export const iso = (value: string): number => Date.parse(value);
export const plusDays = (now: string, days: number): string => new Date(iso(now) + days * 86400000).toISOString().replace('.000Z', 'Z');
export const emptyDatabase = (): Database => Object.fromEntries(TABLES.map(table => [table, []])) as unknown as Database;
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
