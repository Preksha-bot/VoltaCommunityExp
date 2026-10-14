import { PulseError, type CalendarAttendee, type CalendarPrivacyAuthorization, type CalendarRequest, type EmailMessage, type PulseConfig } from '../shared/types';

const exampleAddress = (address: string) => /@(?:[^@]+\.)?(?:example\.(?:com|org|net)|example|invalid|localhost|test)$/i.test(address);
const fixtureEvent = (id: string) => /^(?:fixture|demo|fake|g00[1-9])(?:[:_-]|$)/i.test(id);

export function assertGoogleEnabled(config: PulseConfig, mutating = true): void {
  if (config.environment === 'DEMO') throw new PulseError('DEMO_EXTERNAL_TRANSPORT_BLOCKED');
  if (!config.gates_approved) throw new PulseError('LIVE_GATES_NOT_APPROVED');
  if (mutating && config.outreach_mode !== 'LIVE') throw new PulseError('OUTREACH_MODE_BLOCKED');
  if (config.environment === 'LIVE' && config.auth_backend !== 'FIREBASE') throw new PulseError('LIVE_AUTH_NOT_CONFIGURED');
}

export function assertRecipient(config: PulseConfig, email: string, synthetic: boolean, subject = ''): void {
  if (!/^[^\s@<>;,"\\]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email) || /[\r\n]/.test(email)) throw new PulseError('INVALID_RECIPIENT');
  if (config.environment === 'TEST') {
    if(synthetic || /^demo:/i.test(subject) || exampleAddress(email))throw new PulseError('SYNTHETIC_TEST_RECIPIENT_BLOCKED');
    if (!config.test_recipient_allowlist.some(allowed => allowed.toLowerCase() === email.toLowerCase())) throw new PulseError('TEST_RECIPIENT_NOT_ALLOWLISTED');
  } else if (config.environment === 'LIVE' && (synthetic || /^demo:/i.test(subject) || exampleAddress(email))) throw new PulseError('SYNTHETIC_LIVE_RECIPIENT_BLOCKED');
}

export function assertEmailSafe(config: PulseConfig, message: EmailMessage): void {
  assertGoogleEnabled(config);
  if (!config.live_sender_address) throw new PulseError('SENDER_NOT_CONFIGURED');
  if(!/^[^\s@<>;,"\\]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(config.live_sender_address) || exampleAddress(config.live_sender_address))throw new PulseError('INVALID_SENDER');
  if (/[\r\n]/.test(message.subject + message.message_id + config.live_sender_address)) throw new PulseError('INVALID_EMAIL_HEADER');
  assertRecipient(config, message.to, message.is_synthetic, message.recipient_subject);
}

/** Only cancel/remove methods consume this server-created, audited permit. */
export function assertPrivacyCalendarSafe(config:PulseConfig,eventId:string,authorization?:CalendarPrivacyAuthorization):void {
  if(authorization && (!authorization.actor_account_id?.trim()||!authorization.audit_id?.trim()))throw new PulseError('INVALID_PRIVACY_AUTHORIZATION');
  const explicitPausedCancellation=config.outreach_mode==='PAUSED'&&authorization!==undefined;
  // DRAFT_ONLY continues to forbid real writes, even if a permit was supplied.
  assertCalendarSafe(config,undefined,[],!explicitPausedCancellation,eventId);
}

export function assertCalendarSafe(config: PulseConfig, request?: CalendarRequest, attendees: CalendarAttendee[] = [], mutating = true, eventId = ''): void {
  assertGoogleEnabled(config, mutating);
  if (!config.live_calendar_id) throw new PulseError('CALENDAR_NOT_CONFIGURED');
  if (fixtureEvent(eventId || request?.event_id || '')) throw new PulseError('FIXTURE_CALENDAR_EVENT_BLOCKED');
  if (config.environment !== 'DEMO' && request?.is_synthetic) throw new PulseError(config.environment==='TEST'?'SYNTHETIC_TEST_EVENT_BLOCKED':'SYNTHETIC_LIVE_EVENT_BLOCKED');
  for (const attendee of attendees) assertRecipient(config, attendee.email, attendee.is_synthetic, attendee.auth_subject_id);
}
