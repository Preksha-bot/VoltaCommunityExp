# Volta Pulse V1 — implementation evidence

Final verification ran on 13 October 2026. The workspace contains the completed fictional demo, shared deterministic domain rules, Google adapter source, Apps Script package, repository hooks, and operational handover. Launch state is **DEMO / DRAFT_ONLY**. No Google resource was provisioned and no real message, invitation or deployment was performed.

| Check | Observed result |
|---|---|
| `npm run verify` | PASS |
| TypeScript, schemas, fixture/secret boundaries | PASS |
| Independent workbook calculation | 32 match rows and 21 eligible first-digest founders reproduced |
| Unit, integration and acceptance suite | 150 / 150 passed across 9 files after the UI/feedback revision |
| Supplied workbook scenarios | 38 / 38 passed; UI01 uses the observed browser result |
| Chromium browser suite | Historical baseline 9 / 9; full revised matrix not rerun by user request; focused revised-flow smoke PASS |
| Founder and staff views | 320, 360, 390, 768, 1024 and 1440px; long/error content; expanded staff catalogue; 200% zoom; keyboard focus |
| Basic computed text contrast | Minimum 9.12:1 against a 4.5:1 threshold |
| Web and Apps Script packaging | PASS; no fictional credentials or founder fixtures in deployed artifacts |
| Repository hook | `.githooks/pre-commit` installed through repository-local `core.hooksPath` |
| `release:check` | Artifact boundaries PASS; live activation false |
| `release-check.mjs --live` | Expected refusal, exit 1: eight unverified gates and absent activation approval |

The clean BASE journey test uses authenticated RPC for capture, snapshot, simulated digest delivery, three-company interest, two-slot polling, one fake Calendar event and invitation operation, one feedback sharing choice, a generated story draft, Laura's review and outcomes. It does not start from a prebooked group overlay. Supplied historical sent records remain intact. Response deadlines and cooldowns are anchored to delivery and explicit responses, including MAIL02's historical exception.

Additional tests cover ownership/cofounder isolation, forged roles, session revocation, repeated provider tokens with independent application sessions, scanner reads, stale revisions, immediate consent loss, concurrent reservations, uncertain provider writes, pending Meet creation, pinned booking slots, withdrawal below quorum, staff privacy cancellation while paused, story version invalidation and withdrawn-note retention boundaries. TEST/LIVE browser metadata variants verify that simulation controls are absent; they are not tests against a live identity provider or Google deployment.

See [scenario results](acceptance-results.json), [focused revised UI smoke evidence](ui-revision-smoke.json), [contrast measurements](accessibility-results.json), [release checks](release-check.json), and [fixture provenance](../fixtures/fixture-manifest.json). Earlier responsive screenshots remain in `test-results`; they predate this revision and are not presented as a fresh full-matrix run. The original workbook and its NOT_RUN claims were preserved; execution results are separate evidence.

The owner-upload package is `dist/Volta-Pulse-V1-AppsScript.zip` (three deployment files). SHA-256 values for its contents and archive are recorded in [package hashes](package-hashes.json). Packaging does not authorize upload or deployment.

UI follow-up on 13 October: removed operational time recording from the staff view and moved the sharing explanation to one location above the two topic questions on capture/preferences pages. Typecheck and both builds passed. A separate read-only browser check confirmed exactly one shared explanation on each founder page, none inside individual topic cards, and no time section/form on the staff page. The earlier full-suite results above describe the preceding V1 verification; that suite was not rerun for this display-only follow-up. The deployment archive and hashes were refreshed.

Revised UI/feedback follow-up on 14 October: topic capture now accepts founder wording with autocomplete while preserving the original text. The structured DEMO classifier maps clear wording and sends only ambiguous/new wording to Laura's exception queue. The snapshot shows frozen exact counts at the revised two-company topic threshold, adds personal/current-experience cards, one-click contributions, chart filters, named-sharing handshakes and new-this-month items. Feedback uses one explicit permission choice and creates a Laura-reviewed story draft without a second founder approval request. The clean demo therefore shows two transactional email drafts—scheduling and feedback—and one story draft in **Stories to review**.

Focused verification after the revision: TypeScript/schema/boundary checks passed, both packages built, and all 150 unit/integration/domain acceptance tests across 9 files passed. At the user's request, the long full-browser matrix was stopped and was not rerun. A short read-only browser smoke check confirmed the revised founder capture/snapshot, exact counts, scheduling and feedback drafts, the Feedback/Stories tabs, the pending story draft, the topic-exception empty state, the six revised metrics, and the absence of an operational-time section. No real message, invitation or deployment was performed.

Basic contrast checks cover visible top-level text, labels, links, buttons, input/placeholder text and opaque/composited backgrounds. Disabled controls, native menus, decorative borders, images and third-party Gmail/Calendar rendering are excluded. This evidence is not a comprehensive accessibility certification. Three representative responsive screenshots were also visually inspected.

Google authentication, a live structured model gateway, actual Sheet/Gmail/Calendar/Meet behavior, approved TEST destinations, ownership, policies, portal URLs, monitoring/quotas, backup restoration and brand sign-off remain **NOT_CONFIGURED / NOT_VERIFIED** in [live gates](../docs/live-gates.json). The local server keeps disposable state in memory and resets to fictional fixtures on restart. All Google adapter verification used injected contract fakes.

Use [README](../README.md) for local startup, [deployment instructions](../docs/deployment.md) for owner-controlled configuration, [Laura's runbook](../docs/laura-runbook.md) for staff operations and [recovery procedures](../docs/recovery.md) for uncertainty and restoration. The observed implementation window was approximately 07:44–10:58 UTC, based on workspace and report timestamps; it includes dependency setup and approval waits and is not a measured person-hour estimate.
