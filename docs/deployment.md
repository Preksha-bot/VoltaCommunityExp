# Deployment and owner verification

## Local demo and reproducible artifacts

Use `npm ci`, `npm run verify`, and `npm run release:check`. Keep the lockfile. Re-importing fixture sources needs Python with openpyxl; `npm run fixtures:import` preserves UTC types and source hashes. It never modifies the original workbook. No source fixture may be imported into a live Sheet.

`npm run build` packages Apps Script ES2019/V8 code and HTML with inline JavaScript/CSS. Only `doGet` and `pulseRpc` are public RPC functions. All job/setup functions end in `_`. Client credentials and Date objects never cross the RPC serialization boundary as database records. `doGet` renders a public shell and a validated route only.

## Prepare approved Google resources

Under the approved Volta-owned account, create an Apps Script project and restricted Sheet, authorize the sender mailbox and dedicated organizer Calendar, and enable Advanced Sheets v4, Gmail v1, and Calendar v3. Staff access to operational data goes through the app; founders do not receive Sheet access. Do not provision these resources or incur charges as part of the fictional demo.

Use the Google editor or an owner-configured clasp installation to upload the three packaged Apps Script files. No authenticated clasp configuration is committed. Configure the web app to execute as the owner; confirm whether the tenant allows access for founders without Google accounts. Every privileged request still uses application-level authentication. Deployments are manually authorized; there is no deployment hook.

## Script properties

| Property | Required value |
|---|---|
| `PULSE_ENVIRONMENT` | `TEST` first; `LIVE` only after activation approval |
| `PULSE_SHEET_ID` | Restricted app-owned Sheet ID |
| `PULSE_AUTH_API_KEY` | Approved Firebase/Identity Platform project key; never in founder data or browser |
| `PULSE_SENDER_ADDRESS` | Actual authorized Volta sender mailbox |
| `PULSE_CALENDAR_ID` | Dedicated approved organizer Calendar |
| `PULSE_APP_URL` | Fixed deployed application URL |
| `PULSE_RETURN_URL` | Approved fixed HTTPS founder-portal completion URL |
| `PULSE_TEST_ALLOWLIST` | Explicit developer-owned recipients separated by `\|`; empty blocks testing sends |
| `PULSE_SLOT_WINDOWS` | Approved JSON array of `{weekday,hour,minute}`, Halifax time |
| `PULSE_GATES_APPROVED` | `YES` only after documented resource/security/policy approval |
| `PULSE_RECONCILIATION_APPROVED` | `YES` only if Gmail read access is approved and authorized |

The normal manifest requests Sheet, Gmail send, Calendar event, external-request and trigger-management scopes. Marker-based Gmail reconciliation additionally requires approved `gmail.readonly`; add it to the owner-reviewed manifest and reauthorize before setting its approval flag. Without that approval, UNKNOWN mail remains quarantined for technical review. Never grant broad mailbox access to solve a configuration error silently.

Run `initializeSheet_` as the owner. The idempotent repository creates named tables with columns `record_id`, `revision`, `schema_version`, `record_json`. Domain fields are typed JSON inside the last column; untrusted user text is written as a string cell, never a formula. Related tables update atomically under a script lock. This format is an intentional schema migration from the human workbook and is not intended for manual row editing.

Provision individual nonsynthetic accounts using the approved managed auth provider. Map its subject to Accounts and an approved registered email; company_alias belongs to the primary founder only. Staff need separate ADMIN accounts with contact_email. Real passwords never enter the Sheet. Verify reset, logout, account disable and password-change revocation against the real provider.

For approved initial onboarding data, run `npx tsx scripts/prepare-import.ts approved-data.json validated-import.json` locally. It validates operational records without Google writes. The owner-only `importApprovedData_` accepts that object and performs a create-only atomic import; identical existing records are skipped, changed existing records rejected. Each incoming row must explicitly be nonsynthetic, and password/token/private-review fields are forbidden. Importing does not provision credentials or invent consent. Ownership/account changes and restoration of existing records require the audited recovery process.

## Approved integration checks and activation

Start TEST with DRAFT_ONLY. Use real developer-owned test accounts and the explicit allowlist, never synthetic people remapped into real participants. Check sign-in/reset, restricted Sheet writes, outgoing MIME, marker lookup if approved, organizer-only reservation, pending Meet creation, attendee notifications, duplicate/reconciliation behavior, withdrawal/cancellation, and mobile HTML Service routing. Check actual account quotas, execution windows and tenant permissions.

Record evidence for every gate in live-gates.json. `node scripts/release-check.mjs --live` must fail while any gate is unverified. Obtain explicit activation approval before setting LIVE environment and changing persisted `outreach_mode` from DRAFT_ONLY to LIVE. There is deliberately no founder-facing live activation action.

Run `installTriggers_` under the approved owner. It replaces existing Pulse-owned triggers and installs Monday around 09:00 matching, a 15-minute worker, daily 07:00 housekeeping and daily 11:00 monitoring in America/Halifax. Google trigger times are approximate. Handovers must recreate triggers under the new approved owner. Verify native failure notifications and independent monitoring of complete trigger silence, since an in-project watchdog cannot detect a total project outage by itself.

Complete tested backups/restoration, real sender/reply monitoring, actual meeting windows, technical/backup owner contacts, consent/retention/processor approvals and brand asset/UI sign-off before live use. Current code does not certify security or policy approval.
