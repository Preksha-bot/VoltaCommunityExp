import type { RpcResult, VerifiedSession } from '../shared/types';

type ScriptRunner = { withSuccessHandler(handler: (result: RpcResult) => void): ScriptRunner; withFailureHandler(handler: () => void): ScriptRunner; pulseRpc(request: unknown): void };
declare global { interface Window { google?: { script?: { run?: ScriptRunner } } } }

let session: VerifiedSession | null = null;
export const getSession = () => session;
export const setSession = (next: VerifiedSession | null) => { session = next; };
export class ApiError extends Error {
  constructor(public code: string, public fields: Record<string, string> = {}) { super(errorMessage(code)); }
}
export function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    AUTH_FAILED: "We couldn't sign you in. Check your details and try again.", INVALID_CREDENTIALS: "We couldn't sign you in. Check your details and try again.",
    THROTTLED: 'Too many attempts. Please wait before trying again.', AUTH_THROTTLED: 'Too many attempts. Please wait before trying again.',
    UNAUTHENTICATED: 'Your session has ended. Sign in again to continue.', SESSION_EXPIRED: 'Your session has ended. Sign in again to continue.',
    FORBIDDEN: 'This item is not available to your account.', NOT_FOUND: 'This item is unavailable.', OPPORTUNITY_EXPIRED: 'This opportunity is no longer available.',
    STALE_REVISION: 'Your topics changed in another request. Reload this page before saving again.', REVISION_CONFLICT: 'Your topics changed in another request. Reload this page before saving again.',
    INVALID_INPUT: 'Check the highlighted information and try again.', VALIDATION: 'Check the information and try again.', VALIDATION_ERROR: 'Check the information and try again.',
    SESSION_REVOKED: 'Your session has ended. Sign in again to continue.', RETRY_LATER: 'Pulse could not complete this request. Try again later.',
    TOPIC_LIMIT: 'Choose up to two topics for each question.', NOTE_TOO_LONG: 'Keep your private detail to 200 characters.',
    POLL_CLOSED: 'This scheduling poll has closed.', BOOKING_CONSENT_REQUIRED: 'Confirm booking and identity disclosure before submitting available times.',
    OPPORTUNITY_RESPONDED: 'Your response to this opportunity is already recorded. Use the scheduling page to withdraw from a conversation.',
    ALREADY_PROCESSED: 'Your response to this opportunity is already recorded. Use the scheduling page to withdraw from a conversation.',
    PRIVACY_CANCELLATION_UNAVAILABLE: 'This meeting is no longer available for privacy cancellation. Reload the operations view to see its current state.',
    NOT_CONFIGURED: 'This connection has not been configured. The fictional demo remains available.', LIVE_GATE_CLOSED: 'Live activation has not been approved.',
    NETWORK: 'We could not reach Pulse. Your changes have not been saved. Try again.', INVALID_RESPONSE: 'Pulse could not complete this request. Try again.',
  };
  return messages[code] || 'Pulse could not complete this request. Try again or contact the authorized Pulse team.';
}
export async function rpc<T>(method: string, payload: Record<string, unknown> = {}, requestId?: string): Promise<T> {
  const request = { method, payload, session: session?.credential, requestId: requestId || crypto.randomUUID() };
  let response: RpcResult<T>;
  if (window.google?.script?.run) {
    response = await new Promise<RpcResult<T>>((resolve, reject) => {
      window.google!.script!.run!.withSuccessHandler(result => resolve(result as RpcResult<T>)).withFailureHandler(() => reject(new ApiError('NETWORK'))).pulseRpc(request);
    });
  } else {
    try {
      const result = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), credentials: 'omit', cache: 'no-store' });
      response = await result.json() as RpcResult<T>;
    } catch { throw new ApiError('NETWORK'); }
  }
  if (!response || typeof response.ok !== 'boolean') throw new ApiError('INVALID_RESPONSE');
  if (!response.ok) {
    if (['UNAUTHENTICATED', 'SESSION_EXPIRED', 'SESSION_REVOKED'].includes(response.errorCode || '')) setSession(null);
    throw new ApiError(response.errorCode || 'INVALID_RESPONSE', response.fieldErrors);
  }
  return response.data as T;
}
