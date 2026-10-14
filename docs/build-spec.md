# Volta Pulse V1 — Agent Build Specification

**Version:** 1.0  
**Decision freeze:** 13 October 2026  
**Audience:** the coding agent, builder, Volta technical owner, and Laura  
**Companion data:** `Volta_Pulse_V1_Fictional_Founders.xlsx`, `volta_pulse_fixture.json`, and `seed_csv/`  
**Default execution:** DEMO environment, DRAFT_ONLY outreach, no live email or Calendar side effects.

> Build the system described here, not every idea discussed earlier. The current user decisions override old prototype PDFs and earlier proposals. This document is a build specification, not a claim that the application has already been implemented, security-reviewed, or deployed.

## 1. Product in two sentences

After their private monthly review, founders can optionally tell Volta what they are working through and what they have experienced, then see a brief consent-based community snapshot. Pulse checks weekly for genuinely new topic overlaps, sends at most one personalized opportunity email per founder in that run, and arranges a 30-minute online group conversation only after at least three founders from different companies opt in and can attend the same time.

### 1.1 Decision labels

- **CONFIRMED:** explicitly requested/accepted in the latest conversation. Implement without reopening the product direction.
- **DEFAULT:** a concrete engineering or product choice proposed here to resolve an otherwise unspecified detail. Implement in DEMO and expose relevant settings; obtain owner sign-off before live use.
- **GATE:** information, resource approval, or verification needed before live deployment. Continue independent DEMO work rather than inventing the missing fact.

### 1.2 Frozen scope

| Area | Decision | Status |
|---|---|---|
| Name | Volta Pulse is the only product name founders learn. Use “founder conversation” for the group meeting; “Room” can be an internal label, not another branded product. | CONFIRMED |
| Private review | Never read, import, summarize, prefill, classify, or republish private monthly-review contents. | CONFIRMED |
| Portal integration | A redirect from the review-complete screen to the Pulse app. No portal embed or SSO handoff required for this version. | CONFIRMED |
| Authentication | Company ID or individual username, plus a password. The redirect does not authenticate the user. | CONFIRMED |
| Input | Two optional community questions, with per-item visibility and a separate email preference. | CONFIRMED |
| Awareness | A one-time post-submit/post-skip snapshot; no persistent founder Explore/Radar dashboard. | CONFIRMED |
| Matching | Rules over explicit, current topic selections; no LLM API, embeddings, AI agent, or MCP runtime. | CONFIRMED |
| Weekly outreach | A single combined personalized email per eligible founder per weekly run, only when there are new relevant opportunities. It may include both experience-sharing and working-through sections. | CONFIRMED |
| Email sequence | No separate helper/experience-check email followed by another match email. Scheduling, native Calendar invitation, and post-meeting feedback can be separate. | CONFIRMED |
| Event integration | No Happier Hour, CEO Breakfast, lunch, registration platform, or breakout-room integration. | CONFIRMED |
| Connection format | Group conversation only in V1. Do not implement automatic one-to-one introductions. | CURRENT V1 SCOPE |
| Group threshold | At least three interested founders from at least three distinct companies, on one specific topic. A common accepted slot is also required before booking. | CONFIRMED |
| Tools | Google Apps Script, a restricted Google Sheet, Gmail, Google Calendar, and Google Meet. | CONFIRMED |
| Appearance | Polished responsive interfaces based on the current Volta website, not automatically the old prototype's teal/orange palette. | CONFIRMED |
| Operations | Laura manages exceptions and outcomes, not manual matching or scheduling. | CONFIRMED |
| Data | Begin with invented founders; no actual founder data or real credential is supplied in this package. | CONFIRMED |

### 1.3 Explicitly excluded

Do not build a news feed, searchable founder directory, profile maintenance area, permanent community dashboard, Slack integration, recurring newsletter, automatic repeated two-meeting series, founder-calendar scraping, attendee recording, advice generator, social scoring, payment system, or third-party marketing analytics. Do not reinstall earlier named concepts such as Loop, Radar, Explore, or Volta Rooms as separate navigation items. No speculative success story may appear as real community proof.

## 2. What the agent must deliver

Deliver a working responsive web app, a testable deterministic matching engine, a Sheet repository adapter, email templates and a safe outbox, group scheduling with a Calendar adapter, feedback/story approval, and a small staff-only operational view. Include source code, dependency/version lock files, migration/import tools, automated tests, a deployment guide, a short Laura runbook, a technical recovery guide, and a report of remaining live-launch gates.

Develop with replaceable `AuthProvider`, `Repository`, `EmailTransport`, `CalendarTransport`, and `Clock` interfaces. Tests must use the same domain rules as production, with fake external transports and an injected clock. Do not equate a polished static prototype with a functioning integration.

No live messaging, event creation, account provisioning, billing activation, public deployment, or use of real founder data is authorized merely by this specification. Live activation is a separate explicit approval.

## 3. Architecture and deployment boundaries

```text
Existing private review completes
    -> fixed redirect to Pulse app
    -> company ID / username + password sign-in
    -> optional questions and per-item permissions
    -> brief authenticated community snapshot

Apps Script backend -> restricted Sheet (server access only)
    weekly matching -> per-founder consolidated outbox
    authenticated responses -> group interest -> scheduling poll
    common accepted slot -> one Calendar event + Meet link
    meeting follow-up -> private feedback -> exact-text story approvals
    daily housekeeping -> expiry, permission checks, exceptions, status

Laura -> separate restricted admin view + one weekly status summary
```

**Google implementation:** use an Apps Script HTML-service web app executing under an authorized Volta-controlled deployment account. Serve public shell/login HTML only before authentication. An owner-executed web app has privileged backend access; every callable method still needs application-level authentication and authorization. Google documents the execution-identity distinction and HTML-service communication; it is not a substitute for founder-level permissions. [E1, E8]

Use `google.script.run` or an equivalent reviewed app boundary for the HTML-service frontend. Keep domain logic in small pure JavaScript/TypeScript modules; compile or bundle only what the Apps Script runtime supports. Use the Apps Script Advanced Calendar service/Calendar API where conference-data creation is required. Do not assume a basic calendar helper creates a Meet conference. [E4]

The Google Sheet is a small-pilot persistence store, not an access-control layer and not a transactional production database. It is shared with authorized staff only, never with founder accounts. Hidden tabs are not a security boundary. Use stable IDs, schema validation, short locked writes, optimistic versions and a durable outbox to work around concurrent actions; do not rely on sheet row numbers. [E7]

**Ownership:** deployment, triggers, Sheet, sending mailbox, Calendar, and any approved auth service belong to Volta. Installable triggers execute under their creator's identity; recreate and authorize them under the correct Volta account during handover. Their scheduled time may fall within an approximate window, not an exact second. [E2]

## 4. Authentication: company ID or username plus password

### 4.1 What is now confirmed

Use an independent Pulse login. No identity-bearing signed redirect, Google-account login requirement for founders, or matching by an editable `email` URL parameter is needed. The portal redirects to a fixed app URL such as the deployed app's `?view=pulse`; all private data remains inaccessible until login.

**Login screen copy**

- Heading: **Sign in to Volta Pulse**
- Description: **Use the company ID or username and password provided for Pulse. Your private monthly review stays in the founder portal.**
- Field 1: **Company ID or username**
- Field 2: **Password**, with an accessible show/hide control.
- Primary action: **Sign in**
- Secondary action: **Forgot password?**
- Footer: **Back to the founder portal** — fixed allowlisted destination only.
- Generic failure: **We couldn't sign you in. Check your details and try again.**
- Throttled state: **Too many attempts. Please wait before trying again.**

Do not show whether a supplied company or username exists. Trim/case-normalize the identifier, but do not trim or silently transform the password. Keep all credentials out of URLs, logs, analytics, browser storage, CSV exports, and error reports.

### 4.2 Company alias versus individual identity

**DEFAULT:** one company ID is an alias for that company's primary founder account, not a shared company password. Every founder has an individual `founder_id`, username, and credential identity. Cofounders use their usernames; they do not acquire access to the primary founder's private entries by belonging to the same company.

Example from the fixture:

- `C001` and `maya.chen` both resolve to `F001`.
- `jules.hart` resolves to `F025`, another founder in `C001`.
- `F025` can edit only `F025`'s entries; it cannot edit or read `F001`'s private text.
- Both count as **one company** for a group quorum.

The primary-founder assignment can change only through an audited staff action. Staff authorization is separate from company membership. A client-supplied `role=ADMIN` must have no effect.

### 4.3 Demo and live credential boundaries

The workbook's `DemoLogins` tab contains intentionally public **fictional test passwords**. The local DEMO auth adapter can use these to exercise the UI. It must be impossible to load this adapter in LIVE, publicly deploy it as production authentication, or copy its credentials into a real identity store.

For live founders, **never store plaintext passwords, reversible password encryption, or a single fast digest such as SHA-256 as the password verifier**. Proper password storage requires a reviewed password-hashing or managed credential service. This is a security requirement, not a change to the requested username/password interface. [E5]

**Proposed live implementation — GATE, not an already-approved extra service:** use Google Identity Platform/Firebase Authentication email/password behind the username/company-ID alias resolver. The user still types the requested identifier and password; the server privately maps the identifier to the authorized identity account. This additional Google service requires resource/ownership approval before provisioning. Do not silently add it to the agreed Google Workspace stack. The documented API supports email/password sign-in and identity account operations. [E9]

Implement the `AuthProvider` contract now:

```ts
interface AuthProvider {
  signIn(identifier: string, password: string): Promise<VerifiedSession>;
  verify(sessionCredential: string): Promise<VerifiedPrincipal>;
  signOut(sessionCredential: string): Promise<void>;
  startPasswordReset(identifier: string): Promise<void>;
}
```

For the managed adapter, verify the credential through the provider or its officially supported token-verification process; decoding a token is not verification. Bind the verified provider subject to a server-owned account record and recheck active status/role on each protected request. Keep bearer credentials in memory, not persistent localStorage. Use the provider's reset process addressed to the already-registered contact. Reset responses remain generic. No password reset message reveals the existing password.

**DEFAULT session policy:** at most one hour without reauthentication, expire after 30 minutes of inactivity, terminate on logout/reset/account disable, and protect against replay after revocation. Add per-identifier and global attempt throttles, initially five failed attempts in 15 minutes before a temporary block. Review practical abuse controls for the actual deployment before launch. These are initial controls, not a claim of a complete security assessment. [E6]

If an additional auth service is not approved, keep the demo operational and report the live credential-verifier gate. Do not invent homemade cryptography to conceal that gap. The founder-facing username/password decision remains settled.

### 4.4 Authorization and request safety

Every read/write resolves `founder_id` from a verified session. Reject mismatched owner IDs, unknown IDs, disabled accounts, invalid versions, unexpected fields, and unauthorized company publication. All state changes require an explicit authenticated submit, not a GET. Email scanners opening links must never register interest, book a meeting, revoke consent, or approve a story.

Use opaque resource IDs in links, not raw founder descriptions or email addresses. Opening a forwarded link does not grant access to the original recipient's opportunity. Reauthenticate and check recipient ownership. Expired opportunities display a neutral unavailable state and a preferences link.

## 5. Founder screens and exact interaction rules

### 5.1 Post-review entry point

Keep the existing private-review submission untouched. Its completion page can contain a redirect button or continue into the separate Pulse app, but provide a way back. Inside Pulse, do not assert that the private review was submitted based only on URL text; the app receives no review contents or trustworthy review-completion proof in this version.

After login show:

> **Connect with other Volta founders**  
> Share a topic you'd like to compare notes on, or an experience another founder might find useful. This is optional and separate from your private monthly review. Nothing from that review is copied here.

### 5.2 Two questions

**Question 1:** **What are you working through right now that you'd like to compare notes on?**  
Example: **Hiring our first salesperson.**

**Question 2:** **What have you lived through that you'd be comfortable sharing your experience about?**  
Example: **Selling to enterprise customers.**

Both optional; select up to two topics under each. Use a searchable controlled topic picker with short readable labels. Do not use a long grid of mandatory answers. A founder can contribute experience only, a current topic only, both, or neither. Avoid “expert,” “ask for advice,” or language implying a deficit.

Each selected topic has an optional **Add a private detail** field, maximum 200 characters. Label it: **Only you and authorized Pulse staff can see this note. It is not included in emails or the snapshot.** No file uploads. Store text as text, escape HTML, and prevent spreadsheet-formula execution when writing user strings.

`Other / Something else` permits a private note and goes to review. It cannot automatically match or appear in snapshots. Mapping it to a materially different topic requires founder confirmation; staff cannot silently convert an ambiguous note into public consent.

### 5.3 Per-topic visibility

Use three plain-language choices with brief help text. Default every new item to **Private matching only**. Do not label combined private-plus-aggregate sharing as simply private.

| UI option | Stored value | Permitted use |
|---|---|---|
| Private matching only | `PRIVATE_MATCH_ONLY` | Use the topic privately to propose conversations. Exclude it from all public/community counts and named rows. |
| Include anonymously in the snapshot | `ANONYMOUS_SNAPSHOT` | Same matching use; topic may contribute to a privacy-filtered aggregate. No name attached. |
| Show with my company | `NAMED_SNAPSHOT` | Same matching use; show only the approved topic/type and company identity to authenticated community members. |

The optional private detail remains private under all three choices. “Show with my company” is enabled only for a founder whose server-side account permits company publication and whose company has authorized its display name/introduction. Do not auto-enable this permission for cofounders.

Snapshot permission, email permission, participation, disclosure to a booked group, and story publication are separate decisions. None should be silently inferred from another.

### 5.4 Email preference and submit

Separate checkbox, unchecked for a new founder:

> **Email me when Pulse finds a new relevant founder conversation. At most one match email in a week; no email when there is nothing new.**

Supporting line:

> Scheduling and a short follow-up are separate messages after you choose to participate. You can pause or unsubscribe at any time.

Buttons: **Save and see the snapshot** / **Skip and see the snapshot**. Empty submissions are valid. Skipping does not opt in, delete existing answers, renew expiry, or revoke a previous choice. It should not hide the community snapshot behind compulsory sharing.

After save: **Saved. We'll only contact you about new relevant opportunities if you enabled Pulse emails.**

**DEFAULT expiry:** working-through items expire 30 days after explicit reconfirmation; lived-through experience expires 90 days after reconfirmation. Previous items may be presented for confirmation at the next visit. Never silently renew expiry because a job ran, an email was opened, or a founder skipped the form.

### 5.5 One-time snapshot

Heading: **What's happening around Volta this month**. Subheading: **A brief view of what founders chose to share. Private monthly reviews are never included.**

Show at most five topic rows and three company-named items. No search bar, filters, profile drill-down, or new persistent community navigation. This is a brief step in the monthly flow, not a separate discovery product.

Generate aggregates from current, consented items, deduplicated by `(company_id, topic_id, entry_type)`. For each displayed cell require at least three distinct consenting companies. Suppress small cells, including the complement of a visible breakdown when subtraction would expose a small group. Use bands **3–5**, **6–10**, **11+**, rather than real-time exact counters. Do not publish a denominator that lets people recover suppressed counts.

Use a frozen snapshot batch generated by the weekly job, with a visible generated date; a founder's new answer need not change a count instantly. At render time, still suppress withdrawn/expired/offboarded records or hide the affected cell. Avoid retaining a public cached item after permission is revoked. These precautions reduce disclosure risks but do not guarantee anonymity in a small community; the consent help text must not promise impossibility of identification.

Named rows contain company name, already-approved short introduction, and explicitly approved topic/type only. Do not pair a named row with other private challenges through internal IDs or hidden JSON payloads.

Optional row action: **I'd like to compare notes** opens a confirmation to add that topic to the founder's own private interests. It is not an immediate introduction or email opt-in. Respect the two-topic limit; offer to replace an item rather than bypassing it.

Empty state: **Not enough founders have opted to share a snapshot yet. You can still receive relevant matches privately.**

Finish: **You're all set** and **Return to the founder portal**. There is no persistent Explore page in V1.

### 5.6 Preferences between monthly visits

Every Pulse message links to **Update topics or pause emails**. The authenticated preferences view edits only the founder's own entries, visibility, and email preference. It is not a community dashboard.

Actions: edit/remove topic, change visibility, resume/reconfirm expired item, **Pause new match emails for 30 days**, **Unsubscribe from match emails**, and **Delete my Pulse data**. Explain that deleting data cannot recall emails or Calendar information already delivered. A data-deletion request immediately stops new matching and removes future snapshot/story use; staff follows the approved retention procedure for audit records/backups.

Pausing unsolicited matches does not silently cancel a conversation the founder already booked. Provide an explicit **Withdraw from this conversation** action. Any privacy/account-disable revocation must be rechecked before an unbooked group proceeds.

## 6. Combined weekly opportunity email

### 6.1 Delivery contract

At most **one personalized opportunity email per founder per local matching week**, containing at most **three new topic cards across both roles**. Empty section headings are omitted. No generic weekly newsletter and no separate helper-first email.

The weekly cadence replaces the older suggestion of one unsolicited opportunity per month. Also enforce a seven-day gap between unsolicited digests to avoid two nearly adjacent emails around a calendar-week boundary. Queue otherwise-eligible new topics for a later run while they remain current.

Scheduling, one poll reminder, Calendar notifications, feedback and requested story approval are transactional stages of an opted-in group, not extra weekly-match messages. Do not disguise generic outreach as a transaction to evade the digest cap.

### 6.2 Subject and template

Use **Volta Pulse | A new founder conversation to consider** or **Volta Pulse | New conversations to consider**. Do not include a sensitive topic in the subject by default; topics belong in the body for the recipient.

```text
Hi {first_name},

Pulse found {new_topic_count} new opportunity/opportunities based on what you shared.

[Optional: one genuinely related, approved, permitted story, up to 45 words.
 Never use a fictional fixture story in real mail. Omit the block if none fits.]

SOMETHING YOU'RE WORKING THROUGH
{topic_label}
Other founders have compatible interest or experience in this topic.
Would you like to compare notes in a short group conversation?
[I'm interested] [Not now]

SOMETHING YOU'VE EXPERIENCED
{topic_label}
Other founders are currently working through this topic.
Would you be open to sharing what you lived through?
[Happy to share] [Not now]

Your name and contact details are only shared with the confirmed group
if you later agree to a meeting time and its disclosure terms.

Volta Pulse
[Update topics or pause emails] [Unsubscribe from match emails]
```

A saved lived-through topic means potential experience, not that its owner has already accepted this particular group. Do not write “a founder has agreed to help” unless current explicit interest exists. Avoid exposing exact private candidate counts, private notes, or identities in this email. Public snapshot permission does not permit revealing the rest of a founder's match graph.

Send from a real, authorized Volta-controlled mailbox with display name **Volta Pulse**. The exact sender address is a launch gate; `pulse@voltaeffect.com` in older mockups is not proof that such a mailbox exists. Do not impersonate a personal email written by Laura. Provide a monitored reply path, but responses are processed using authenticated buttons; no LLM reads arbitrary email replies in V1.

### 6.3 Response screen

The email button opens an authenticated confirmation page for that specific opportunity. Show the topic and either **Join a conversation about this topic** or **Share my experience**. Explain: **This records interest only. We'll ask about times before booking anything.**

Buttons: **Confirm interest** / **Not now**. `Not now` suppresses this topic opportunity for 30 days by default; it does not revoke unrelated entries or announce rejection to peers. Interest is time-limited to 14 days and bound to the opportunity/topic, not blanket permission for all future meetings.

After interest: **Interest saved. We'll be in touch if at least three companies are ready to compare notes.** If no group forms, do not fabricate a meeting or chase the founder with repeated weekly requests.

## 7. Matching engine: deterministic, consent-first, group-first

### 7.1 Catalogue

Use the companion `Topics` table as the initial seed: 13 specific approved labels plus `OTHER`. Topic IDs are stable; labels and synonyms are editable through a reviewed catalogue change. Initial automatic matching uses **exact topic IDs only**. Do not match broad related categories such as all sales or all hiring, and do not treat an optional private note as authority to create additional inferred interests.

The topic catalogue is a pilot default, not a claim about actual founder demand. Laura may approve additions. The `OTHER` queue should not turn into a weekly obligation to interpret every submission.

### 7.2 Hard eligibility gates

For a founder-topic role to enter the automatic opportunity pool, all of these must hold at evaluation time:

1. Founder and company are active; the account is not blocked/offboarded.
2. A mapped active topic exists, with an ACTIVE entry whose exclusive expiry time is after `now`.
3. The entry's consent has not been withdrawn; no parent deletion/suppression applies.
4. The founder explicitly opted into match emails and is not paused.
5. There is no active `Not now`, no-response topic cooldown, unexpired outstanding offer, or conflicting active group participation.
6. Candidate peers are from other companies. One founder with multiple rows is one person, and multiple founders in one company still represent one company.
7. There are at least three eligible distinct companies on this exact topic and at least one eligible working-through entry. Three experience-only entries do not justify an automatic meeting offer.

Visibility does **not** determine matching eligibility: all three consented visibility modes can support private matching. Visibility controls only what appears in the snapshot. Conversely, allowing snapshot display does not authorize emails when `email_opt_in` is false.

The email-group pool threshold is a DEFAULT to avoid promising group opportunities when only one or two companies exist. The booking threshold of three explicitly interested companies is user-confirmed and non-negotiable.

### 7.3 Recipient cards and roles

Build one opportunity per `(founder_id, topic_id)` from the eligible pool. If a founder has both entry types on the same topic, merge them into one card with `BOTH`; never double-count them. Mark the card as current interest, experience to share, or both, and use the appropriate wording.

Prefer need-to-experience connections, but peer-only conversations are valid when three companies are working through the same issue. Clearly describe the latter as a peer comparison, not access to an experienced adviser. Do not call founders experts or promise advice quality.

Cofounders may each receive a relevant opportunity, but the eventual group permits at most one representative of each company. The server performs this deduplication again at interest, polling and booking—not just once during matching.

### 7.4 Ranking defaults

Apply hard gates first. Rank eligible topic cards using this transparent priority score:

| Component | Points |
|---|---:|
| Exact controlled-topic fit | 50 |
| At least one complementary other-company role | 25 |
| Otherwise a working-through peer match | 15 |
| At least one relevant peer entry explicitly confirmed in the last 14 days | 10 |
| Recipient had no successful Pulse digest in the last 30 days | 5 |
| Compatible peer supply is not already at the configured outreach/group limit | 5 |

These numbers are ranking defaults, not probabilities or a claim of matching accuracy. They cannot override consent, expiry, capacity or company independence. Tie-break by working-through/BOTH before experience-only, then the recipient's latest explicit topic confirmation, then stable topic ID. Keep at most three cards total per email. Record a machine-readable `reason_code` so staff can explain the decision.

### 7.5 What counts as “new”

Persist an offered peer-edge history, not merely a last-run timestamp. An opportunity is new when the recipient has not been offered this topic/role with these eligible other companies before, or at least one genuinely new compatible company/role edge has appeared since the last offer.

Keep both a current candidate-pool fingerprint and the historical set of offered edges. A peer disappearing, a reordered list, a renamed label, a new weekly run ID, an expiry extension or a no-op edit does not by itself create novelty. A decline/no-response cooldown remains authoritative even if a new peer appears during it. Renewing a topic does not silently clear that cooldown.

DEFAULTS: 30-day cooldown after an unanswered/declined opportunity; avoid repeating a completed same-topic peer pairing for 60 days without a fresh request. Do not recycle the same old opportunity just because the cooldown ended: it must still pass the newness rule.

Skip founders already waiting in a viable group for that topic. Cap concurrent active group membership at one per founder. A new need with no useful group is simply quiet; do not send “nothing this week” messages.

### 7.6 Weekly flow

```text
runWeeklyMatching(clock):
  acquire short run lock; create/load run ID for local matching week
  load schema-validated founders, companies, entries, consent, offer and group history
  evaluate current eligibility using clock (do not trust stored ACTIVE alone)
  build exact-topic pools; deduplicate companies for thresholds
  derive recipient opportunities and novelty edges
  apply cooldowns, capacity, seven-day gap, and same-week sent guard
  rank; keep at most three opportunities per founder
  queue one combined draft per founder with any new cards
  queue nothing for every other founder
  update privacy-filtered snapshot batch
  persist checkpoint and run summary
  release lock

processOutbox():
  recheck global mode, environment, active consent and pending message validity
  claim one item under lock
  use FakeEmailTransport in DEMO / store previews in DRAFT_ONLY
  use authorized Gmail transport only after live gates and explicit activation
  persist provider receipt or uncertainty, with safe retry/reconciliation policy
```

DEFAULT matching window: Monday around 09:00 in `America/Halifax`; the exact Apps Script firing minute is not promised. Use the local Monday date as `matching_week_key`, not UTC calendar week or an arbitrary server timezone. A manual test run uses the same weekly deduplication rules. [E2]

## 8. Group interest, scheduling and invitation

### 8.1 State machine

```text
COLLECTING_INTEREST
  -> SCHEDULING          (3+ interested distinct companies)
  -> BOOKING_PENDING    (3+ companies authorize a common offered time)
  -> CONFIRMED          (one event exists, conference ready, invitations issued)
  -> COMPLETED          (scheduled end passed; attendance still unknown)

Alternative terminal states: EXPIRED, CANCELLED, NO_COMMON_SLOT
Failure states: BOOKING_RETRYABLE, BOOKING_UNKNOWN, NEEDS_TECH_REVIEW
```

A time selection is not an attendance record. An interested response is not booking consent. Completion of the scheduled time is not proof anybody attended.

### 8.2 Selecting the group

At least three interested active founders from three distinct companies are required. DEFAULT maximum five participants; one representative per company. Prefer a mixed experience/current-interest group when available, but do not repeatedly burden the same experienced founder. Use stable order: interest timestamp, then account ID; choose the earliest valid representative per company. People not selected are not named or put on a CC list.

Do not automatically create multiple overlapping cohorts from the same response. Reserve selected participants atomically. A founder cannot be allocated to two simultaneous groups because two requests crossed.

### 8.3 Scheduling email and page

Subject: **Volta Pulse | Choose a time for your founder conversation**.

```text
Hi {first_name},

At least three founders from different companies are interested in
comparing notes on {topic_label}.

Choose every time you could attend a 30-minute online conversation.
[Choose times]

There are no slides or preparation. Bring one real question and
share your experience rather than instructions.
```

The authenticated scheduling page shows topic, duration, two actual future slot options, timezone, poll deadline, and no unconfirmed identities. Options are multi-select: A, B, both, or **Neither works**. Never preselect availability or disclosure consent.

Required confirmation text before submit:

> **You may book one 30-minute meeting at a selected time if at least three companies can attend. My name, company and email will be visible to the confirmed group and to Volta's organizer account.**

Buttons: **Submit availability** / **Neither works** / **Withdraw interest**.

DEFAULT slots: choose two different future dates from Volta-approved reusable time windows, at least 48 hours away and within the next 14 days. Configure windows in Halifax time but display each founder's actual IANA timezone. Store UTC instants; compute daylight-saving offsets for each date. Do not read founders' private calendars. Check the dedicated organizer calendar and internal reservations for conflicts, not the founder's calendar.

DEFAULT poll window: five days. One scheduling reminder after 48 hours, only if still useful and not already responded. A second set of automatic polls and manual scheduling chase are out of scope. If no slot obtains three companies by the deadline, close as `NO_COMMON_SLOT`; send one brief outcome notice only to those who opted in, with no blame or identities. Keep the underlying topic until its normal expiry, but do not immediately re-offer the same group.

### 8.4 Booking

On each valid availability submit, re-evaluate under a short lock. A common accepted slot can be booked once three companies qualify; choose the slot with the largest eligible unique-company count at that moment, then the earliest time for a tie. Recheck all entries, participation/disclosure consents, account status, reservation conflicts and capacity immediately before booking.

Use a deterministic booking key derived from the conversation and selected slot, and one corresponding provider event ID/reference. Retry must refer to the same event rather than creating a new one. Create the conference and verify it is ready before publishing a usable Meet link; conference creation may be asynchronous. Google Calendar documents event insertion, attendee notifications and conference-data creation. [E4, E13]

Calendar invitation title: **Volta founder conversation: {topic_label}**. Description:

```text
A 30-minute conversation with founders who chose to compare notes on this topic.
No slides. Bring one question. Share what you experienced, not instructions.

Suggested start: What are you working through, or what did you learn?

Your confirmed group's names and emails are visible in this invitation.
You may decline or withdraw. No recording or transcript is created by Pulse.
```

The native Google Calendar invitation is the confirmation email; do not automatically send a duplicate polished Gmail confirmation for the same event. The prior scheduling email/page carries the full branded UI. Calendar's native rendering is not fully controlled by our CSS.

Do not create a recurring series or a second meeting automatically. Founders can independently continue their relationship. A future repeat-meeting feature requires a new decision.

### 8.5 Changes and failures

A withdrawal before booking reduces quorum; hold if fewer than three companies remain. A withdrawal after booking removes the attendee and updates the event. If the confirmed group falls below three before its start, cancel or return to pending with a clear transactional notification rather than silently changing V1 to a one-to-one call. Do not add replacement guests without their own consent.

If Meet generation, permissions, or Calendar creation fails, do not send a fake confirmation. Retry definite transient failures with bounded backoff. A timeout after an uncertain provider write must be reconciled against the deterministic event ID before retrying. Escalate a persistent infrastructure failure to the technical owner, not Laura's manual scheduling queue.

## 9. Feedback, stories and impact

### 9.1 Follow-up

DEFAULT send one follow-up approximately 24 hours after the scheduled end, to the invited participants who have not already opted out of that interaction. No repeated feedback reminders in V1.

Subject: **Did your founder conversation move anything forward?**

Prompt: **Did the conversation help you make a decision or take a next step?**  
Actions: **Yes** / **Somewhat** / **Not yet** / **I didn't attend**.

After authenticated confirmation, optionally ask **What changed or what will you do next?** (maximum 280 characters) and **Have you connected with anyone from the group again?** with **Yes**, **Planned**, **Not yet**. Record those separately: planned contact is not an actual follow-on relationship, and useful intention is not a verified milestone.

### 9.2 Story capture without an LLM

Default feedback is private. Do not automatically rewrite feedback, infer a success outcome, or produce an unattributed quotation. If the founder wants to share a story, show:

> **Would you like to share one sentence about what came from the conversation?**

Provide a blank editable field or the founder's own submitted outcome text, clearly identified as their text. Controls: **Keep private** (default), **Share anonymously**, **Share with my company**. The founder reviews the exact text and presses **Approve this wording**.

A named story mentioning or identifying another company needs approval from each relevant authorized representative for the same exact text/version. An allegedly anonymous story can still identify another party through details; hold such cases for review rather than assuming removal of names is sufficient. Laura may withhold a story but cannot approve it on another founder's behalf. An edit invalidates existing publication approvals.

No story is required to complete feedback. An unanswered story request remains private; do not keep chasing approvals. DEFAULT story use expires after 180 days unless renewed. Revocation stops future use immediately but cannot recall delivered emails.

### 9.3 Selection for future email

Eligible story = approved exact version + required approvals complete + not withdrawn/expired + permitted audience + nonsynthetic in LIVE. Prefer an exact topic match to an opportunity in that founder's digest, then most recent approved story not recently shown to that founder. One story maximum. No relevant approved story means no story block—not an unrelated filler story.

### 9.4 Metrics

Track useful completed cross-company conversations, attendee-reported actions, actual follow-on contact, relevance declines, distribution across companies, and Laura's actual operational minutes. Keep scheduled, confirmed, attended, useful and followed-up counts separate.

The earlier proposal's six-week targets (three useful conversations, two follow-on connections, low staff time) are **pilot targets**, not measured results or guarantees. Do not claim causal acceleration in paying customers or milestones from a few feedback clicks. Comparing milestones with private coaching data, if ever requested, would require a separate approved internal evaluation; it is not a Pulse data import.

## 10. Reliable email and job execution

### 10.1 Durable outbox

Use durable `WeeklyEmails`, `WeeklyEmailItems` and `ActivityLog` records. A stable unique key such as `DIGEST:{founder_id}:{matching_week_key}` prevents ordinary same-week duplicates. Store recipient, item IDs, content hash, approval version, candidate-edge fingerprints, render revision, lifecycle status, provider receipt and attempt timestamps.

States: `PLANNED -> READY -> SENDING -> SENT`; definite retryable failure can enter `RETRYABLE`; ambiguous network delivery enters `UNKNOWN`, not immediate retry. A successful send followed by a failed database write is a real failure mode. A Sheet and Gmail do not form one transaction; do not claim mathematical exactly-once email delivery from a unique ID alone.

Prefer the Gmail API transport with MIME HTML/plain-text parts and a stable message marker; Gmail documents sending an encoded MIME message and returning a message resource. Use the narrowest approved scopes needed for sending and any authorized reconciliation. [E12]

Record/claim the intent under lock, release before slow network calls, then record the outcome. An uncertain delivery is quarantined for provider lookup or technical review; do not blindly resend. Permit only one active send attempt per intent. No retry path can bypass opt-out, environment, weekly limits, or a global pause.

### 10.2 Job schedule and resilience

- Weekly: matching, snapshot build, Laura summary.
- Periodic lightweight worker: due outbox items, poll expiry, pending conference reconciliation, opted-in feedback.
- Daily: expiry, permission cleanup, stuck-state checks, bounded retention.

Checkpoint small batches and resume within actual account quotas. Do not hardcode a presumed unlimited Apps Script runtime or email allowance. Validate current quotas under the account used for launch. [E3]

If a trigger stops running, monitoring must flag stale `last_success_at` even when the failed job never writes an error. Google may also notify the trigger owner of execution failures, but the technical owner must know where those notifications go. [E2]

### 10.3 Environment and side-effect safety

Separate `environment` from `outreach_mode`.

| Environment | Allowed behavior |
|---|---|
| DEMO | Fake auth/repository/transport permitted; no real Gmail or Calendar calls. |
| TEST | Real integrations only to an explicit developer-owned allowlist after approval. No synthetic person is a real recipient. |
| LIVE | Approved identity verifier, Volta accounts, real consented nonsynthetic records, and completed gates. |

Modes: **DRAFT_ONLY**, **LIVE**, **PAUSED**. DRAFT_ONLY means store/render previews; do not send, create real events or treat draft interest as real responses. PAUSED stops automatic outbound messages and new bookings while allowing login, updates, revocation and internal reconciliation. Staff can issue necessary cancellation/privacy notifications as explicit audited actions; a pause must not silently leak new identities.

The transport must reject `is_synthetic=true`, `demo:` identities, fixture event IDs, and reserved example addresses in LIVE. TEST remapping requires explicit approved destination addresses; the provided allowlist is empty. Do not strip safety markers to make a fixture pass live checks.

## 11. Laura's management surface and handover

This is a **staff-only** view, not the founder dashboard removed from scope. Use one concise operational page with:

- Health: current mode, last successful job, queue/error state, upcoming groups.
- Exceptions: unmapped topics, failed transports, incomplete named-story approvals, and privacy requests.
- Outcomes: confirmed/attended/useful groups and reported follow-on contact, clearly separated.
- Actions: preview run, approve a pending draft during the pilot, pause/resume automation, manage topic catalogue, approve reusable slot windows, suppress a problematic topic, and inspect a decision explanation.

Do not require Laura to edit formulas, write SQL, read Apps Script logs, choose every match, chase unavailable founders, or manually add conference links. Founders' account onboarding and access resets should be designed for low-touch staff handling, using the approved auth backend rather than visible spreadsheet passwords.

**DEFAULT time target:** 10–15 minutes per normal week after stabilization. This is a target, not a zero-maintenance claim. The builder/technical owner—not Laura—handles expired authorization, broken deployments, security incidents and provider changes. Maintain a named support owner, backup owner and a short recovery guide.

Pilot begins in DRAFT_ONLY. Review representative matches and all privacy-failure tests; switch to LIVE only after explicit sign-off. If routine exceptions repeatedly exceed the staff-time target, simplify or pause rather than hiring hidden manual labor to prop up the workflow.

Handover must include: where the Sheet and deployment live; account/trigger ownership; how to pause; how to resolve or suppress an unknown topic; how to remove an account; how to handle a withdrawn story; backup/restore procedure; how to redeploy without duplicate jobs; and the technical support contact.

## 12. Database, schemas and import contract

### 12.1 Common rules

Use immutable opaque IDs, explicit enumerations, UTC timestamps, and `revision` on mutable production records. CSV timestamps are ISO-8601 strings ending in `Z`; XLSX date cells are real dates formatted explicitly as UTC. CSV booleans are `TRUE`/`FALSE`; JSON booleans are native. An empty field is null/absent, not a zero date, a false consent, or a wildcard authorization.

Enforce referential integrity in the repository layer. All owned writes check the verified founder. Unique current entry: `(founder_id, topic_id, entry_type)`; an edit versions the entry rather than creating accidental duplicates. A company ID is not a secret. Password verification material and session credentials are excluded from the founder-data workbook.

For user-entered strings, preserve text without evaluating formulas on import. Reject or safely escape formula-leading text in the Sheet adapter. Validate length and enums server-side. Do not put company private details into exception/error strings returned to other users.

The workbook contains domain seed fields and explicit test overlays, not every empty operational table. The agent creates the runtime-only tables below and migrates optional runtime fields with documented defaults. Do not require the user to hand-edit dozens of blank tabs before running the demo.

### 12.2 Seed tables and purpose

| Table | Primary key | Purpose and constraints |
|---|---|---|
| Companies | `company_id` | Company identity, authorized short intro, parent status, primary founder alias. |
| Founders | `founder_id` | Individual identity/contact, company FK, timezone, active/email status; no password. |
| Topics | `topic_id` | Controlled exact-match catalogue; OTHER never auto-matches. |
| PulseEntries | `entry_id` | Founder/topic/type, private context, visibility, lifecycle, expiry, consent version. |
| ConsentLog | `consent_event_id` | Append-only grant/revoke evidence; fixture evidence is explicitly simulated. |
| OutreachHistory | `history_id` | Previously offered recipient/topic/peer pool and cooldown. Runtime additionally stores offered edges and provider outcome. |
| Conversations | `conversation_id` | Group topic, poll/booking lifecycle, capacity, duration, selected slot and provider event reference. |
| InterestResponses | `response_id` | Individual interest for a topic; `conversation_id` can be null until cohort creation. Runtime links to the original opportunity. |
| TimeSlots | `slot_id` | UTC start/end, intended display zone, offered group and notice requirement. |
| Availability | `availability_id` | Founder/group/slot selection with separate booking and disclosure consents. |
| Feedback | `feedback_id` | Attendance, usefulness, private outcome, follow-on contact; one current response per attendee/group. |
| Stories | `story_id` | Exact publication text/version, topic, status, sharing scope and expiry. |
| StoryApprovals | `approval_id` | Approver + story + version + decision; all required approvals must agree. |
| Settings | `setting_key` | Typed configuration, no API keys or live credentials. |

`DemoLogins`, `ExpectedMatches` and `TestCases` are **fixture-only**. `Start_Here`, `DataDictionary` and `Sources` are documentation/inspection sheets. Never import them as production founder data. The full field inventory appears in Appendix A.

### 12.3 Additional runtime tables

| Runtime table | Required fields |
|---|---|
| Accounts | `account_id`, `founder_id` (nullable for staff), `provider_subject_id`, `username_normalized`, `company_alias` (nullable/unique), `role`, `status`, `created_at`, `revision`. No plaintext password. |
| AuthSessions | Nonsecret session reference, account FK, verifier/token digest as appropriate to the reviewed adapter, issued/last-active/expiry/revocation timestamps. Not included in exports, logs or founder payloads. |
| MatchRuns | `run_id`, `matching_week_key`, `clock_at`, `started_at`, `checkpoint`, `status`, `finished_at`, counts and sanitized error code. |
| Opportunities | `opportunity_id`, `founder_id`, `topic_id`, merged role, candidate company/role edges, fingerprint, score components, reason codes, created/expiry/status and source entry versions. |
| WeeklyEmails | `email_id`, unique founder/week key, type, recipient account, mode, status, content hash, rendered preview reference, attempt/provider receipt, uncertainty/error and timestamps. |
| WeeklyEmailItems | `email_item_id`, `email_id`, opportunity or transaction reference, item order, sent consent/version references. |
| ConversationMembers | `conversation_id`, `founder_id`, `company_id`, role, selection/interest/poll/booking/withdrawal state, current disclosure evidence. Enforce one active company representative per group. |
| SnapshotBatches | `snapshot_id`, generated time, validity time, aggregation rule version, status. |
| SnapshotCells | Snapshot/topic/type, safe band, consenting contributing IDs held server-side, named-item references where authorized. Founder payload contains safe bands/approved public items only. |
| ActivityLog | Event ID, actor, action, object IDs, prior/new status, request/idempotency key, UTC time, safe reason code. Avoid unnecessary private text. |
| Exceptions | Exception ID, type, target IDs, severity, owner, created/resolved times, safe summary and resolution. |

The exact physical partition into Sheet tabs can be consolidated by the builder if field isolation, auditing and tests remain equivalent. Do not merge consent or lifecycle distinctions merely to make a smaller-looking spreadsheet.

### 12.4 Retention defaults and revocation

DEFAULT runtime diagnostic retention is 90 days. Expired private topic text should be purged or irreversibly minimized after the agreed grace period; propose 30 days after expiry unless the founder reconfirms. Publication stories have their own approval expiry. Keep only minimal necessary consent/audit evidence under a Volta-approved retention policy. The policy, backups, deletion schedule and processor approvals are live-launch gates, not a legal compliance claim.

A revocation takes effect at authorization/render/send time, not only during the next weekly cleanup. Remove it from queued digests, unbooked groups, snapshots and future story use. Stop further processing before deleting supporting rows. Preserve referentially safe tombstones where an audit/event reference must remain under the approved policy.

## 13. Frontend/API contracts and code organization

### 13.1 Routes

`signin`, `pulse`, `snapshot`, `preferences`, `opportunity/{id}`, `schedule/{conversation_id}`, `feedback/{conversation_id}`, `story/{story_id}`, and `admin`.

No Explore/Radar route or founder feed. A local demo review-complete page is allowed as a test harness and must be labelled a simulation. Email deep links return to the requested authorized screen after sign-in; they are not bearer authorization themselves.

### 13.2 Backend functions

| Function | Contract |
|---|---|
| `signIn(identifier, password)` | Verify credentials; return a scoped session or generic error. Never return a password/verifier. |
| `getMyPulse(session)` | Only the authenticated founder's entries, catalogue labels, and preferences. |
| `saveMyPulse(session, payload, expectedRevision)` | Validate topic limits, ownership, fields and explicit permission. Atomically record meaningful changes and consent events. |
| `getMonthlySnapshot(session)` | Safe output DTO only; no underlying private rows in JSON. |
| `updatePreferences(session, payload)` | Apply pause/unsubscribe/revoke with immediate outbound suppression. |
| `getOpportunity(session, opportunityId)` | Recipient-authorized display; no peer identity before booking. |
| `recordInterest(session, opportunityId, decision)` | Idempotent response, scoped interest expiry; trigger cohort evaluation. |
| `getScheduling(session, conversationId)` | Selected group members only; dates in user's timezone. |
| `saveAvailability(session, conversationId, slots, consent, requestId)` | Explicit booking/disclosure consent, current group/slot validation, idempotent request, quorum recheck. |
| `submitFeedback(session, conversationId, payload)` | Invited user's own response only; no fabricated attendance. |
| `approveStory(session, storyId, version, decision)` | Required authorized approver, exact version; edit invalidates prior approvals. |
| `adminAction(session, action, payload)` | Server-verified staff role, confirmation on impactful actions, audit event. |
| `runWeeklyMatching(clock)` | Scheduled/operator invocation only; no client privilege escalation. |
| `processOutbox(clock)` | Backend-only safe transport and reconciliation. |

Use stable result envelopes `{ok, data, errorCode, fieldErrors, requestId}`. Never send stack traces, secrets or arbitrary database objects to the browser. Appropriate errors include `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `STALE_REVISION`, `OPPORTUNITY_EXPIRED`, `NO_QUORUM`, `ALREADY_PROCESSED`, `RETRY_LATER`. Show human wording, not these raw codes, in the interface.

### 13.3 Suggested source layout

```text
/src/domain/        consent, expiry, matching, novelty, groups, stories, validation
/src/adapters/      sheets, fake repository, Gmail, fake email, Calendar, fake calendar
/src/auth/          adapter contract, local fixture adapter, approved managed adapter
/src/jobs/          weekly run, outbox worker, housekeeping, monitoring
/src/ui/            login, Pulse, snapshot, preference, response and staff views
/src/email/         digest, scheduling, poll outcome, feedback, story approval
/src/styles/        verified brand tokens and responsive component styles
/tests/unit/        pure rules with injected clock
/tests/integration/ repository locks, transport failure, provider contracts
/tests/e2e/         founder and staff journeys with fake transports
/fixtures/          approved seed subset, profiles, importer, safety manifest
/docs/              deployment, live gates, Laura runbook, technical recovery
```

Framework choice is not a requirement: prefer a small maintainable frontend over dependencies introduced for fashion. Apps Script HTML runs within its sandbox constraints; verify script loading, redirect targets, and top-level navigation in the actual hosting environment. [E14]

## 14. Visual design and responsive quality

### 14.1 Brand source and limitation

The requested visual reference is **https://voltaeffect.com/**. The public page was checked on 13 October 2026, but this package does **not** contain a verified extraction of its computed colors, font family, button radius or CSS spacing tokens. Do not claim the old prototype's teal/orange colors are official current brand values. The site is a visual reference, not authority to change the product scope. [E10]

Before design sign-off, the implementing agent must inspect the live page in a browser/stylesheet-capable environment and record the actual heading/body fonts, primary/background/text/accent colors, button states, borders/radii and spacing in `brand-tokens.json`, with source URL and checked date. Confirm use of any logo or font assets. Do not distribute font files without permission. If the site cannot be inspected, ship a clearly provisional neutral demo theme and leave brand sign-off open; never present guessed hex values as verified.

Use a single token system for the web app and the compatible subset of email styling:

```css
/* Assign values only after verification; these names are not official Volta tokens. */
--pulse-brand-primary;
--pulse-brand-accent;
--pulse-page-background;
--pulse-surface;
--pulse-text;
--pulse-text-muted;
--pulse-border;
--pulse-font-heading;
--pulse-font-body;
--pulse-control-radius;
```

### 14.2 Layout defaults

Use a centered, calm single-column founder flow, roughly 680–760px maximum reading width on desktop, generous vertical spacing, persistent field labels, and one primary action per step. Company/topic information is subordinate to the action. Distinct role/visibility controls must not resemble a dashboard or a marketing navigation system.

Use content-sized cards, wrapping button rows, a consistent minimum 44px touch target as a product usability default, and disabled/loading states that preserve layout. Avoid absolute positioning for action buttons or fixed card heights that clip text. Required containment patterns:

```css
*, *::before, *::after { box-sizing: border-box; }
.pulse-shell { width: min(100% - 2rem, 46rem); margin-inline: auto; }
.pulse-card, .pulse-field, .pulse-actions > * { min-width: 0; }
.pulse-card { overflow-wrap: anywhere; }
.pulse-actions { display: flex; flex-wrap: wrap; gap: .75rem; }
.pulse-actions button, .pulse-actions a { max-width: 100%; }
@media (max-width: 480px) {
  .pulse-actions { flex-direction: column; }
  .pulse-actions > * { width: 100%; }
}
```

These are implementation defaults, not extracted site CSS. Verify all views at 360, 390, 768, 1024 and 1440px; additionally check 320px reflow and 200% zoom. Buttons, permission labels, long company names, errors, empty states and translated browser date strings must stay inside their containers. Do not fix overflow by hiding important content or shrinking all typography.

Use readable text contrast, keyboard navigation, visible focus, semantic labels, understandable validation, and non-color-only statuses. Check the WCAG minimum contrast target (4.5:1 for normal text; 3:1 for qualifying large text) and reflow guidance. [E15, E16]

### 14.3 Email rendering

Create HTML emails with a conservative approximately 600px maximum body width, inline critical styles, responsive blocks, real text, plain-text alternatives, and safe fallback fonts. Do not assume Gmail executes JavaScript, app CSS grids or arbitrary web fonts. Use genuine links to authenticated response pages; this is not an AMP email project.

Render/test the combined digest with one card, three cards, only experience cards, both role sections, a story, no story and long labels. Test desktop and mobile Gmail. The invite after booking is native Calendar output; do not promise exact CSS control of that client UI.

The old clipping problem is an explicit regression test: no screen is accepted until every button and consent control is visibly inside its screen/card at the tested widths.

## 15. Fictional dataset and agent import instructions

### 15.1 What is provided

The workbook contains 24 fictional companies, 28 founder accounts (including four cofounders), 54 Pulse entries, 13 controlled topics plus Other, simulated consent, outreach history, scheduling fixtures, story fixtures, 29 public demo logins including one fictional staff account, 38 test scenarios, and a complete field dictionary.

Every identity, company, permission and outcome is invented. Coincidental resemblance does not make it real Volta data. Founder addresses use the reserved example.com domain; nevertheless the application must explicitly block fixture sends rather than rely on the domain as a safety mechanism. [E11]

The fixture clock is **2026-10-13T12:00:00Z**. Inject it in tests. Do not replace it with the real current date, because deliberate expired entries, poll dates and cooldowns would change meaning.

### 15.2 File formats

- XLSX: human-friendly workbook with filters, frozen headers, data validation and a formula-based record summary.
- JSON: exact IDs, booleans, UTC timestamp strings and table arrays for a coding agent.
- CSV directory: one flat file per table, UTF-8 with BOM and header row 1 (read with `utf-8-sig` or strip the BOM). Cells containing ID lists use `|`; split only fields explicitly defined as lists.
- `fixture_validation.json`: data-integrity/reference-oracle checks run while preparing this package, **not** evidence that the eventual application has passed its tests.

The JSON/CSV rows and this spec are the canonical agent input; workbook presentation is not a hidden business rule. `ExpectedMatches` and score fields are expected outputs, not an input the production algorithm may read to fake matching.

### 15.3 Profiles

Start each test from a clean base: Companies, Founders, Topics, PulseEntries and ConsentLog. Include `OutreachHistory` rows with `fixture_profile=BASE` for the BASE oracle. Where runtime tables have a profile column, select BASE plus **at most one** named scenario. Never load every profile into one shared operational state.

| Profile | Intended behavior |
|---|---|
| BASE | Fresh weekly opportunity generation with opt-out, pause, expiry, withdrawal and topic cooldown cases. |
| RETRY_SENT | A current-week email already exists for F001; retry must not duplicate it. |
| GROUP_READY | F001, F002, F003 represent three companies and accept S001; create one fake event. |
| SAME_COMPANY_GUARD | F001, F025, F003 are three people but only two companies; do not schedule. |
| NO_COMMON_SLOT | A valid three-company group has no common slot; do not confirm an event. |
| STORY_CASES | Completed meeting, attended/not-attended feedback and approved/pending/withdrawn story versions. |
| `*_MUTATION` tests | Start with the named clean base/profile, then apply the exact mutation described in TestCases. |

The historic `OutreachHistory.email_id` is sufficient for fixture suppression. The importer/test harness may expand it into a minimal `WeeklyEmails` SENT row where the runtime deduplication implementation expects that table. Fake Calendar IDs remain fake and are never looked up at Google.

### 15.4 Reference expectations

On BASE at the frozen clock, the provided reference calculation yields 21 founders with at least one eligible first-digest card. This is a test oracle, not an instruction to send 21 real messages.

F001's BASE digest combines T01 and T03 as working-through opportunities and T04 as an experience-sharing opportunity. F001 has another experience topic T02, but its demand-side founder is in cooldown in BASE. The card-cap mutation clears that specific cooldown so four opportunities exist and only three can be selected.

T01 has five eligible individual founders but only three eligible companies. F018 is paused, F019 did not opt into email, F020/company C020 is inactive, F021's entries are expired despite stored ACTIVE status, F022 withdrew consent, F023 has an unmapped OTHER item, and F024 has a unique topic with no viable group. None of these cases may be “fixed” by fabricating demand or ignoring the constraint.

## 16. Build sequence and acceptance criteria

### 16.1 Implementation order

1. Import schemas/fixtures and establish environment guards, fake transports and the injected clock.
2. Build the login/alias adapter and server-side ownership checks; complete the local demo path while preserving the live-auth gate.
3. Build polished Pulse capture, permissions, preferences and privacy-filtered snapshot.
4. Implement pure topic eligibility, distinct-company grouping, ranking, novelty and digest consolidation; compare to the oracle.
5. Build safe outbox, previews, link confirmation and group-interest lifecycle.
6. Build polling, quorum/booking/disclosure checks and fake Calendar; then add the real adapter behind explicit gates.
7. Build attendance/usefulness feedback, exact-text story permissions and selection.
8. Build staff controls, health checks, retention hooks and documentation.
9. Execute unit/integration/end-to-end tests, brand verification and mobile review.
10. Demonstrate a full fake journey, then obtain live resource/security/permission sign-off before activation.

The earlier 18-hour estimate was an optimistic assisted-MVP planning figure, not a guarantee for independent authentication, polished responsive UI, failure-safe provider operations and production security. The agent must record actual work and report scope changes honestly; do not remove security checks or substitute static screens to pretend the estimate was achieved.

### 16.2 Mandatory acceptance conditions

The app is ready for a live-pilot review only when every condition below has evidence:

- The private monthly-review payload is not requested, transmitted, stored or read.
- Independent username/company-ID password login works; company aliases resolve to individuals; cross-founder access tests fail safely.
- The live deployment contains no demo credential, fake identity provider or plain-password sheet.
- All per-topic permissions, opt-outs, pauses, expiry and revocations are enforced at render, match and send time.
- No persistent community dashboard or removed event/LLM feature was built.
- One weekly digest consolidates both roles; no-new-match means silence; retries do not blindly duplicate delivery.
- Three people from two companies cannot start a group; three companies without a common accepted slot cannot create an invite.
- Participants authorize booking and group identity disclosure before Calendar creation.
- Provider errors do not manufacture a confirmation or route routine scheduling labor to Laura.
- Synthetic stories cannot enter LIVE; named stories require all exact-version approvals.
- Attendance and usefulness are not inferred from booking, email opens or elapsed time.
- Laura can preview, pause, see exceptions and understand why an opportunity was selected without touching code.
- Buttons and permission controls remain contained on mobile, desktop, long-content and error states.
- Deployment/account ownership, quotas, monitoring, backup and technical support handover are verified.

The workbook's 38 `TestCases` are deliberately marked **NOT_RUN**. The implementing agent must execute them, add broader technical tests as needed, and supply evidence. Passing the small fixture-integrity check in this package does not substitute for these application tests.

## 17. Live-launch gates and agent stop rules

| Gate | What must be supplied or approved |
|---|---|
| Portal redirect | Actual review-complete page and fixed safe return URL; no private review data is passed. |
| Credential backend | Approved reviewed verifier/managed provider, Volta ownership, provisioning and reset process. The UI choice is already confirmed. |
| Workspace | Authorized deployment account, restricted Sheet, actual sender mailbox, Calendar and Meet permissions. |
| Policies | Consent wording, named-company authorization, retention/deletion procedure, hosting/provider approval. |
| Brand | Verified current website tokens, authorized assets and UI sign-off. |
| Operations | Technical owner, backup contact, error destinations, reusable meeting windows. |
| Live participants | Real invitation/registration and explicit consents collected in the real system. Never relabel fictional rows as real. |
| Activation | Explicit approval to leave DRAFT_ONLY and use real transports. |

When a gate is unavailable, leave its field empty or explicitly `NOT_CONFIGURED`, keep DEMO operational, and report the dependency. Do not guess URLs, credentials, legal authorization, sender addresses, Calendar IDs, official brand colors, API access, or past consent. Do not provision extra services or incur charges silently.

## 18. Sources and decision authority

**Product authority:** the user's decisions in this conversation through 13 October 2026. Laura's supplied transcript is background for consent, low founder effort, experience-sharing, remote accessibility and low staff overhead. Older PDFs/MD notes may contain dashboard, event-integration, authentication-handoff, one-to-one or email-cadence ideas that are superseded here. Do not resurrect them by treating an old attachment as higher priority.

**External implementation references:** primary sources checked on 13 October 2026. They support platform/security facts, not a claim that Volta has already granted access or that this system is deployed.

- [E1] Google Apps Script web apps: https://developers.google.com/apps-script/guides/web
- [E2] Installable triggers: https://developers.google.com/apps-script/guides/triggers/installable
- [E3] Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
- [E4] Google Calendar event creation: https://developers.google.com/workspace/calendar/api/guides/create-events
- [E5] OWASP Password Storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- [E6] OWASP Authentication: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- [E7] Apps Script LockService: https://developers.google.com/apps-script/reference/lock/lock-service
- [E8] HTML-service client/server calls: https://developers.google.com/apps-script/guides/html/communication
- [E9] Firebase Authentication REST API (proposed live adapter, not an approved new dependency): https://firebase.google.com/docs/reference/rest/auth
- [E10] Volta visual reference: https://voltaeffect.com/
- [E11] IANA example domains: https://www.iana.org/help/example-domains
- [E12] Gmail sending: https://developers.google.com/workspace/gmail/api/guides/sending
- [E13] Calendar event insertion/reference: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- [E14] Apps Script HTML restrictions: https://developers.google.com/apps-script/guides/html/restrictions
- [E15] W3C minimum text contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- [E16] W3C reflow: https://www.w3.org/WAI/WCAG22/Understanding/reflow.html

## Appendix A. Complete seed field inventory
These are the actual companion CSV/JSON field names. Fields named `fixture_profile` or `is_synthetic` are test-safety metadata, not founder-facing UI. CSV/JSON is the preferred exact import format. Date columns in the XLSX are formatted as UTC dates for readability.

### Companies (24 rows)
```text
company_id, company_name, sector, approved_intro, city, country, status, profile_display_consent, primary_founder_id, is_synthetic
```

### Founders (28 rows)
```text
founder_id, company_id, full_name, username, email, timezone, role, status, can_publish_company, email_opt_in, email_mode, pause_until_utc, last_monthly_confirmed_at_utc, auth_subject_id, is_synthetic
```

### Topics (14 rows)
```text
topic_id, topic_label, category, synonyms, description, auto_match_enabled, active, is_synthetic
```

### PulseEntries (54 rows)
```text
entry_id, founder_id, topic_id, entry_type, private_context, visibility, status, created_at_utc, updated_at_utc, expires_at_utc, consent_version, revision, is_synthetic
```

### ConsentLog (84 rows)
```text
consent_event_id, founder_id, entry_id, scope, permission_value, action, wording_version, recorded_at_utc, evidence, is_synthetic
```

### OutreachHistory (3 rows)
```text
history_id, fixture_profile, founder_id, topic_id, candidate_company_ids, sent_at_utc, response, cooldown_until_utc, email_id, is_synthetic
```

### Conversations (4 rows)
```text
conversation_id, fixture_profile, topic_id, status, created_at_utc, poll_closes_at_utc, minimum_companies, maximum_participants, meeting_minutes, calendar_event_id, selected_slot_id, is_synthetic
```

### InterestResponses (12 rows)
```text
response_id, fixture_profile, conversation_id, founder_id, topic_id, participation_role, response, responded_at_utc, identity_disclosure_consent, is_synthetic
```

### TimeSlots (5 rows)
```text
slot_id, fixture_profile, conversation_id, option_label, start_at_utc, end_at_utc, display_timezone, minimum_notice_hours, is_synthetic
```

### Availability (10 rows)
```text
availability_id, fixture_profile, conversation_id, founder_id, slot_id, available, booking_consent, identity_disclosure_consent, confirmed_at_utc, is_synthetic
```

### Feedback (3 rows)
```text
feedback_id, fixture_profile, conversation_id, founder_id, attended, usefulness, next_step, follow_on_contact, story_requested, created_at_utc, is_synthetic
```

### Stories (3 rows)
```text
story_id, fixture_profile, topic_id, source_feedback_id, approved_text, sharing_mode, status, version, required_approver_ids, expires_at_utc, is_synthetic
```

### StoryApprovals (4 rows)
```text
approval_id, fixture_profile, story_id, founder_id, approved_version, decision, decided_at_utc, is_synthetic
```

### DemoLogins (29 rows)
```text
account_id, company_id, username, company_login_alias, demo_password, account_role, expected_login, usage, is_synthetic
```
**Excluded from live imports.** The company-ID alias maps to one primary account; the passwords are deliberately public test values.

### Settings (32 rows)
```text
setting_key, setting_value, explanation
```
Default values are listed below; resource identifiers remain blank until explicitly supplied.

### ExpectedMatches (32 rows)
```text
founder_id, topic_id, participation_role, potential_company_count, potential_company_ids, score, own_confirmed_at_utc, in_first_digest, expected_action, explanation
```
Reference outputs only. The implementation must derive these results from the domain inputs; it must not consume this table to manufacture a match.

### TestCases (38 rows)
```text
test_id, fixture_profile, test_name, setup, expected_result, result, notes
```

### Default settings (exact fixture values)

| Key | Value | Meaning |
|---|---|---|
| `schema_version` | 1.0 | Confirmed artifact version |
| `environment` | DEMO | Fixture safety: no network side effects |
| `outreach_mode` | DRAFT_ONLY | Store email previews, not live sends |
| `fixture_now_utc` | 2026-10-13T12:00:00Z | Inject this clock in deterministic tests |
| `matching_timezone` | America/Halifax | Default; use IANA zones, not fixed offsets |
| `matching_day` | MONDAY | Default; weekly run |
| `matching_hour_local` | 09 | Approximate Apps Script trigger window |
| `max_digest_per_founder_per_week` | 1 | User-confirmed consolidated email cadence |
| `max_cards_per_digest` | 3 | Build default, not three separate emails |
| `min_potential_companies` | 3 | Default before offering group interest |
| `min_confirmed_companies` | 3 | User-confirmed scheduling threshold |
| `max_group_participants` | 5 | Default; at most one representative per company |
| `meeting_duration_minutes` | 30 | Default; one meeting, not a recurring series |
| `current_topic_ttl_days` | 30 | Default after explicit confirmation |
| `experience_topic_ttl_days` | 90 | Default after explicit confirmation |
| `interest_ttl_days` | 14 | Default; time-limited willingness |
| `opportunity_cooldown_days` | 30 | Do not repeat ignored/declined opportunities |
| `repeat_peer_cooldown_days` | 60 | Default; avoid repeated same-topic cohorts |
| `max_active_groups_per_founder` | 1 | Protect founder time |
| `snapshot_cell_min_companies` | 3 | Suppress small cells; not an anonymity guarantee |
| `snapshot_buckets` | 3-5\|6-10\|11+ | No exact live counters |
| `poll_window_days` | 5 | One scheduling poll per cohort |
| `poll_reminder_after_hours` | 48 | One scheduling reminder at most |
| `feedback_delay_hours` | 24 | Do not equate elapsed meeting with attendance |
| `automatic_story_reminders` | 0 | No chasing publication consent |
| `runtime_logging_retention_days` | 90 | Proposed; approve before live launch |
| `test_recipient_allowlist` | (empty / not configured) | Empty: no testing mail can leave by default |
| `live_sender_address` | (empty / not configured) | GATE: supply a Volta-owned authorized mailbox |
| `live_calendar_id` | (empty / not configured) | GATE: supply a Volta-owned calendar |
| `auth_backend` | DEMO_ADAPTER | Live verifier must be approved and security-reviewed |
| `brand_reference_url` | https://voltaeffect.com/ | Inspect live computed CSS; do not guess official tokens |
| `authenticated_return_url` | (empty / not configured) | GATE: fixed allowlisted portal-complete URL |

## Appendix B. Test scenarios with expected outcomes

All application tests start as **NOT_RUN**. Each row specifies a scenario, not a result achieved by this handoff package.

| ID | Profile | Test | Expected result |
|---|---|---|---|
| AUTH01 | BASE | Company-ID login | Authenticate as F001; company ID is an alias, not a shared account. |
| AUTH02 | BASE | Cofounder login | Authenticate as F025; do not expose F001 private entries. |
| AUTH03 | BASE | Wrong password | Same generic error; no founder identity or account existence disclosed. |
| AUTH04 | BASE | Disabled login | Deny because the founder/company is inactive. |
| AUTH05 | BASE | Server-side authorization | Forbidden; never trust a supplied founder_id or role. |
| DATA01 | BASE | Private topics | They may be used for matching but never for named rows or aggregate cells. |
| DATA02 | BASE | Expired entries | Exclude from matching and snapshot; expiry evaluated at read time. |
| DATA03 | BASE | Offboarded company | Exclude entirely; stale ACTIVE entry state is not sufficient. |
| DATA04 | BASE | Email opt-out | No weekly outbound opportunities, even when a topic overlaps. |
| DATA05 | BASE | Paused founder | No new matching while paused; keep preferences editable. |
| DATA06 | BASE | Withdrawn entries | Exclude immediately; preserve minimal revocation audit. |
| DATA07 | BASE | Unknown topic | Queue for review; do not auto-match it. Other mapped experience can still qualify. |
| MATCH01 | BASE | One specific group topic | Five eligible founders but only three distinct companies C001/C002/C003. |
| MATCH02 | BASE | Two-company pool | Do not send opportunities; fewer than three eligible companies. |
| MATCH03 | BASE | No new useful match | No digest; do not send a weekly filler newsletter. |
| MAIL01 | BASE | Combined digest | One digest with current-topic cards T01/T03 and experience card T04. |
| MAIL02 | BASE_MUTATION | Maximum three cards | F001 now has four eligible topics; send one digest with at most three. |
| MAIL03 | BASE_MUTATION | Unchanged next week | Do not repeat unchanged opportunities. |
| MAIL04 | RETRY_SENT | Same-week retry | Do not create/send a second F001 digest. |
| MAIL05 | BASE | Declined topic | Respect NOT_NOW cooldown; no peer names or decline reason disclosed. |
| MAIL06 | BASE_MUTATION | Uncertain delivery | Quarantine and reconcile; do not blindly resend. |
| GROUP01 | GROUP_READY | Scheduling success | Three companies can attend; create exactly one simulated event for G001. |
| GROUP02 | SAME_COMPANY_GUARD | Distinct-company guard | Three founders are only two companies; do not open booking. |
| GROUP03 | NO_COMMON_SLOT | Scheduling mismatch | No slot has three companies; keep pending, then close without manual scheduling chase. |
| GROUP04 | GROUP_READY_MUTATION | Withdraw before booking | Recheck; only two companies remain, so no invitation. |
| GROUP05 | GROUP_READY | Timezone rendering | Same instant; Halifax noon and St. John's 12:30 p.m. on 20 October. |
| GROUP06 | BASE_MUTATION | Daylight-saving change | Store 16:00 UTC; do not reuse October's UTC offset. |
| STORY01 | STORY_CASES | Approved fixture story | ST001 is eligible for demo only; never send a fictional story live. |
| STORY02 | STORY_CASES | Partial named approval | Do not publish: F002 has not approved exact version 1. |
| STORY03 | STORY_CASES | Withdrawn story | Never include in future emails. |
| STORY04 | STORY_CASES_MUTATION | Edited approved text | Invalidate earlier approval; request exact new version approval. |
| METRIC01 | STORY_CASES | Attendance is not elapsed time | Did not attend; exclude from usefulness denominator; do not infer attendance. |
| SAFE01 | BASE | Privacy threshold | Suppress cells below three; no exact counts or private entries exposed. |
| SAFE02 | BASE | Email link scanning | Show login/confirmation only; no state mutation. |
| SAFE03 | BASE | Fixture safety | Block email/calendar side effects; empty recipient allowlist stays closed. |
| SAFE04 | BASE_MUTATION | Global pause | Leave queued; no automated outbound email or new event creation. |
| UI01 | BASE | Mobile layout | No horizontal overflow; controls and labels remain inside cards. |
| SCOPE01 | BASE | No removed features | No Happier Hour integration, Explore/Radar dashboard, one-to-one path, LLM or MCP. |

## Appendix C. Final implementation clarifications

1. **New outreach versus an accepted interaction:** use separate checks for `canOfferNewTopic` and `canBookConfirmedInterest`. Unsubscribing from future match emails does not itself revoke a meeting the founder already authorized. A withdrawn topic, withdrawn participation/disclosure, disabled account, or explicit cancellation does affect booking and must be rechecked.
2. **Pause versus safety notifications:** PAUSED blocks automatic founder-facing outreach and new bookings. Operational alerts to authorized staff and a user-requested credential-recovery flow may continue. Privacy-related cancellations are explicit audited staff actions when automatic sends are paused.
3. **Snapshot participation is not a matching promise:** displayed aggregate bands are derived from snapshot consent, while match pools require explicit email permission and current capacity. The two populations can legitimately differ.
4. **Interest cannot invent willingness:** saved experience is potential relevance; a weekly digest may invite willingness, but only a confirmed response creates group interest.
5. **Publishing consent is versioned:** the exact text, audience and named parties matter. Approval for one story or snapshot item is not blanket permission to use other private information.
6. **Demo auth is not production auth:** implementing the requested company-ID/username/password UI does not authorize storing real plaintext passwords in Sheets. Preserve the live verifier gate and do not claim it is solved by the demo adapter.
7. **Expected outputs are checks, not shortcuts:** the fixture oracle is independently calculated from the seed constraints. Tests must inspect actual application state, not just assert that the reference file exists.

## Agent kickoff instruction

Read this entire specification and the fixture manifest before writing code. Restate the frozen scope and live gates briefly, then build the DEMO end-to-end with fake transports, clean imported data and the fixed test clock. Implement the real Google adapters behind the stated safety boundaries; do not enable them or add an unapproved identity service. Deliver the source, tested flows, observed test results, responsive screenshots, deployment guide and Laura runbook, explicitly distinguishing completed work from unverified live dependencies.
