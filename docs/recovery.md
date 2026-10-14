# Technical recovery

## Stop side effects first

Set persisted Settings.outreach_mode to PAUSED through the authenticated staff action. If the app is unavailable, the authorized technical owner may set PAUSED through a controlled Sheet/owner recovery action and audit it when service returns. Disable the Pulse worker trigger if mode cannot be verified. Do not delete operational history, recreate event IDs, or blindly retry UNKNOWN delivery.

## Mail uncertainty

SENDING is claimed before the provider call. A timeout or a crash after provider success may leave UNKNOWN/SENDING. With approved read scope, reconcile the stable Message-ID in the dedicated sender's Sent mailbox and persist its receipt. Without scope, the technical owner checks delivery manually. An absent search result is not proof the provider did not send; leave quarantined until safe to resolve. Opt-out, seven-day gap and weekly guards apply to every retry.

## Calendar uncertainty

Look up the deterministic event ID on the dedicated Calendar. Reuse that event and conference request. Pending conference data is not confirmation. Attendees are added only after Meet succeeds and current consent/quorum is rechecked. Remove withdrawn participants and cancel future groups below three companies. When automation is paused, execute required privacy cancellation as an explicitly audited staff/owner recovery action.

## Failed jobs and authorization

Check last_success_at, sanitized exception codes, trigger-owner notifications and actual quotas. Expired authorizations/disabled APIs/tenant policy changes belong to the technical owner. Reauthorize only approved scopes. Run checkpointed small batches; do not clear the weekly uniqueness key or offered-edge history to force a retry. Confirm owner identity and duplicate-trigger prevention after redeployment.

## Backup and restore

The live backup location, encryption/access, cadence and retention are launch gates. Restrict backups to approved owners; exclude passwords, raw bearer credentials and Script Property values from exports. AuthSessions contains only credential digests and references and should be invalidated after restoration.

Pause automation, preserve a recovery snapshot, restore the schema-versioned operational tables, validate IDs/FKs/revisions, clear/revoke all sessions, and reconcile outstanding Gmail/Calendar intents before resuming DRAFT_ONLY. Do not roll back consent revocations: replay all grant/revoke/deletion evidence newer than the backup before any render/send. Verify Sheet consistency and referential tombstones. Test restoration using an approved TEST environment before launch.

Diagnostic logs default to 90 days; expired private notes are minimized 30 days after expiry, unless explicitly reconfirmed. Story publication lasts at most 180 days without renewal. Consent/audit evidence and backups follow the separately approved policy. A deletion request suppresses processing immediately; staff completes retained-record/backups handling using that policy.

The recovery artifact is source code plus the locked dependency set, packaged Apps Script files, fixture provenance, observed test reports, and documented resource ownership. Current technical/backup owners and incident destinations are NOT_CONFIGURED.
