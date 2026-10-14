import { type Database, type PulseConfig, PulseError, str } from './types';
export const DEFAULT_CONFIG: PulseConfig = {
  environment: 'DEMO', outreach_mode: 'DRAFT_ONLY', matching_timezone: 'America/Halifax',
  max_cards_per_digest: 3, min_potential_companies: 3, min_confirmed_companies: 3, max_group_participants: 5,
  meeting_duration_minutes: 30, max_active_groups_per_founder: 1, current_topic_ttl_days: 30,
  experience_topic_ttl_days: 90, interest_ttl_days: 14, opportunity_response_days: 7,
  opportunity_cooldown_days: 30, repeat_peer_cooldown_days: 60, snapshot_cell_min_companies: 2,
  poll_window_days: 5, poll_reminder_after_hours: 48, feedback_delay_hours: 24,
  runtime_logging_retention_days: 90, story_ttl_days: 180, private_note_grace_days: 30,
  test_recipient_allowlist: [], live_sender_address: '', live_calendar_id: '', authenticated_return_url: '',
  auth_backend: 'DEMO_ADAPTER', auth_api_key: '', app_url: 'http://127.0.0.1:5173',
  gates_approved: false, reconciliation_approved: false,
  slot_windows: [{ weekday: 2, hour: 12, minute: 0 }, { weekday: 4, hour: 12, minute: 0 }]
};
export function readConfig(db: Database, overrides: Partial<PulseConfig> = {}): PulseConfig {
  const result = { ...DEFAULT_CONFIG, slot_windows: DEFAULT_CONFIG.slot_windows.map(v => ({...v})) };
  for (const row of db.Settings) {
    const key = str(row, 'setting_key');
    if (!(key in result) || ['auth_api_key', 'gates_approved', 'reconciliation_approved'].includes(key)) continue;
    const value = row.setting_value;
    const current = result[key as keyof PulseConfig];
    if (typeof current === 'number') {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (value == null || !Number.isFinite(parsed) || parsed < 0) throw new PulseError('INVALID_CONFIG');
      (result as unknown as Record<string, unknown>)[key] = parsed;
    } else if (typeof current === 'string') (result as unknown as Record<string, unknown>)[key] = value == null ? '' : String(value);
    else if (key === 'test_recipient_allowlist') result.test_recipient_allowlist = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split('|').filter(Boolean) : [];
    else if (key === 'slot_windows') {
      let windows: unknown = value;
      if (typeof value === 'string') { try { windows = JSON.parse(value); } catch { throw new PulseError('INVALID_CONFIG'); } }
      if (!Array.isArray(windows) || windows.some(w => !w || typeof w !== 'object' || !Number.isInteger(w.weekday) || !Number.isInteger(w.hour) || !Number.isInteger(w.minute) || w.weekday < 0 || w.weekday > 6 || w.hour < 0 || w.hour > 23 || w.minute < 0 || w.minute > 59)) throw new PulseError('INVALID_CONFIG');
      result.slot_windows = windows as PulseConfig['slot_windows'];
    }
  }
  Object.assign(result, overrides);
  if (!['DEMO','TEST','LIVE'].includes(result.environment) || !['DRAFT_ONLY','LIVE','PAUSED'].includes(result.outreach_mode)) throw new PulseError('INVALID_CONFIG');
  if (result.authenticated_return_url && !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:[/?#][^\r\n]*)?$/.test(result.authenticated_return_url)) throw new PulseError('INVALID_CONFIG');
  if (result.min_confirmed_companies < 3 || result.min_potential_companies < 3 || result.max_group_participants < 3 || result.max_group_participants > 5 || result.max_cards_per_digest > 3 || result.max_active_groups_per_founder !== 1) throw new PulseError('INVALID_CONFIG');
  return result;
}
