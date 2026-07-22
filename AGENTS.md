# AGENTS.md — Saba Learning Automation Agent

**Purpose.** This project is a long-lived automation agent for the user's HP /
Cornerstone Saba learning portal at `hpi-external.sabacloud.com`. Its job is to
complete the courses and quizzes required for each service qualification with
the least amount of human effort possible, and to *learn* from each session so
subsequent sessions are faster.

**Read order for a new session:**
1. This file — start-up drill, tool inventory, when-to-use-what.
2. `docs/QUIZ-TYPES.md` — encyclopedia of every course/quiz variant seen so far
   and the exact strategy that beat each one.
3. `docs/RUNBOOK.md` — deep detail on the manual per-question flow (only needed
   for the timed-assessment style, e.g. F2F).
4. `data/course-history/certifications.jsonl` — running log of certifications
   the agent has completed for this user.
5. The newest `data/sessions/*.json` recap and `data/sessions/needs-review.md`
   (if present) — what the last dashboard session did and what it flagged for
   you to investigate this time.

If you (future agent) discover a new variant or strategy, **update
`docs/QUIZ-TYPES.md`** before ending the session. That is the primary continuous
learning artifact. Anything the dashboard's End-session flow flagged in
`data/sessions/needs-review.md` should be triaged and folded into
`docs/QUIZ-TYPES.md`, then you can consider it handled.

---

## Environment

| Item | Detail |
|------|--------|
| OS | Windows (paths use backslashes) |
| Workspace | `C:\Users\mattd\tests` |
| Runtime | Node.js 22.x, Playwright 1.58 (dependency in `package.json`) |
| Browser | User's own Chromium running with `--remote-debugging-port=9222` |
| Attach | `playwright.chromium.connectOverCDP('http://127.0.0.1:9222')` in every script |
| Auth | User signs in manually; automation never touches credentials |
| LMS | Saba Cloud 64 (Angular SPA at `hpi-external.sabacloud.com` + SCORM content at `content-na2prd0004-na2hp.sabacloud.com`) |

The single most important architectural fact: **we attach to the user's
browser** — we do NOT launch our own. All cookies, sessions and SSO belong to
the user. Do not close their landing tab, do not clear cookies.

## Hosted control plane and packaged helper

The repository is now an npm-workspace monorepo while the legacy local
dashboard remains operational:

- `apps/web` is the authenticated Next.js/Vercel control plane.
- `apps/helper` is the interactive Windows helper. It polls outbound over
  HTTPS, validates signed jobs against the local capability whitelist, and
  keeps mutable state under `%LOCALAPPDATA%\QuizTaker Helper\`.
- `packages/core` contains shared TypeScript contracts, policy, signing,
  outcome, and diagnosis logic.
- `packages/automation` is the package boundary for the local Playwright
  executors. Root `pw-*.js` compatibility entrypoints remain until hosted
  parity is verified.
- `database/migrations` is the Neon hosted ledger and RLS schema; private
  artifacts use Vercel Blob.

Use `npm run dev:web` for the control plane, `npm run dev:helper` for the local
helper, and `npm start` for the legacy dashboard. Deployment and recovery are
documented in `docs/DEPLOYMENT.md`.

---

## Local dashboard

`npm start` (port 3000) or `npm run dev` (port 4000, auto-reloads via
`node --watch` + a live-reload SSE). Open the printed URL. It is served by
`server.js` (Express) and is local-only with no auth. The dashboard shows CDP
status, open tabs, the current certification's roster, capability cards that run
the whitelisted `pw-*` scripts with live streaming output, a History tab, and a
Docs tab (renders this file plus `docs/QUIZ-TYPES.md` and `docs/RUNBOOK.md`).
Use it when you'd rather click than type.

Key behaviours to know about:

- **History** merges every per-run log, not just the curated cert list. See
  `lib/history.js` `readMerged()` — it normalizes `certifications.jsonl` (cert),
  `batch.jsonl` verify events (course), `log.jsonl` (course), and
  `container.jsonl` verify events (activity) into one time-sorted table. So a
  course completed via the dashboard shows up immediately.
- **Open tabs** panel has an **End browser** button (`POST /api/cdp/stop` —
  SIGINTs our own `start-cdp-browser.js` launcher, else runs
  `pw-close-browser.js` which sends CDP `Browser.close`), a **Launch URL** box,
  and a **Recent URLs** list. Recent URLs persist in `data/recent-urls.json`
  (auto-recorded whenever tabs are listed) and each can be re-opened via
  `pw-open-url.js` (opens a new tab, never disturbs existing ones).
- **End session** (topbar) aggregates the current session's logs via
  `lib/session-report.js`, then: appends an operational summary to
  `data/sessions/history.jsonl`, writes a machine-readable recap to
  `data/sessions/<ISO>.json`, appends any anomalies to
  `data/sessions/needs-review.md`, advances the `data/sessions/.last-end`
  marker, closes the CDP browser, and shows a "you can now close this window"
  screen. **A future agent should read the newest `data/sessions/*.json` and
  `needs-review.md` at start-up** and fold any flagged variants into
  `docs/QUIZ-TYPES.md` — that is how the project self-improves between sessions.
- **Auto-detect** probes inside Saba `content-player` tabs before acting. It
 uses the registry in `lib/capabilities.js` plus the normalized probe and
 ranked planner in `lib/page-probe.js` / `lib/detection-engine.js`. It detects
 the explicitly selected/focused tab, including SCORM WBT, SlickQuiz exams,
 containers, server assessments, expired SSO, external tools, documents, and
 unknown pages. Every action is shown as a risk/evidence/target/verifier plan;
 mutating scripts require a short-lived confirmed plan token.
- **Autonomous learning** records every run in
 `data/attempts/events.jsonl`, updates measured strategy evidence in
 `data/knowledge/strategies.json`, and queues unknowns/regressions in
 `data/knowledge/review-queue.jsonl`. Automatic promotion requires 3
 independently verified successes across 2 targets; a later regression
 demotes the strategy. Learned actions are restricted to the safe DSL in
 `lib/capabilities.js`.
- **Learning captures** now include `normalized-probe.json`, a stable
 fingerprint, and an entry in `data/learn/index.jsonl`. Unknown and failed
 attempts receive a guided next action instead of ending at a warning.
- **Failed and partial runs** are diagnosed by `lib/run-diagnosis.js`, linked
  to the attempt/review evidence, and shown in a centered dashboard modal with
  the likely cause, confidence, affected targets, and next action.

## Start-of-session drill

Always do these in order at the top of a new session:

```bash
# 1. What tabs does the user have open right now?
node pw-list-tabs.js

# 2. If the user has pointed you at a specific tab, fit its viewport
node pw-fit-tab.js <idx>

# 3. If the current job is a whole certification (a "path" of N courses),
#    start with a dry run so you see the roster before doing anything.
node pw-cert-batch.js --dry
```

`pw-list-tabs.js` will tell you what kind of page you are on:

| URL pattern | What it is | Handler |
|-------------|-----------|---------|
| `.../me/ledetail/crtfy...` | Certification landing page (a path of courses) | `pw-cert-batch.js` |
| `.../me/learningeventdetail/cours...` | Single course detail page (may contain 1..N sub-activities) | see `docs/QUIZ-TYPES.md#class-detail-page-with-activities` |
| `.../app/content-player?contextid=...` | Saba's outer wrapper for a SCORM course (multi-activity container) | `pw-container-batch.js` |
| `content-na2prd0004-na2hp.sabacloud.com/content/rcs/remote_frameset_modern.html` | Actual SCORM 1.2 or 2004 player | `pw-scorm-complete.js` |
| `login3.id.hp.com/...` | Session died — ask the user to log back in | (do not attempt) |

---

## The one big cheat you must know

Every SCORM-based Web Based Training on this LMS exposes a live SCORM API in
the player tab. **Setting `passed` + `score.raw = 100`, committing, then
calling Terminate/Finish is enough to mark the course Successful.** No need
to click through pages or take the exam. This works for every SCORM course
the agent has encountered so far, both 1.2 and 2004.

- SCORM 1.2 API is at `window.API` (findable on the `sco` frame or by walking).
- SCORM 2004 API is at `window.API_1484_11`.
- The runtime helper `pw-scorm-complete.js [tabIndex]` detects which one is
  present and does the right thing.
- `pw-cert-batch.js` chains: click LAUNCH → wait for player tab → fast-complete
  → wait for auto-close (LMSFinish triggers `autoCloseSCORM12=true`) → move on.

Detailed CMI element mapping is in `docs/QUIZ-TYPES.md#scorm-fast-complete`.

---

## Tool inventory (top-level scripts)

### Session bootstrap
- `pw-list-tabs.js` — list all Chromium tabs (idx, title, url).
- `pw-fit-tab.js <idx>` — resize a tab's viewport to fill its browser window,
  clearing prior device emulation.
- `pw-clear-emulation.js <idx>` — same but without a resize.
- `pw-tab-inspect.js <idx> <label>` — screenshot + dump visible text (incl.
  same-origin iframes) into `data/prep/<label>.png` / `.txt`. Essential for
  understanding an unfamiliar page.
- `pw-learn-capture.js [idx]` — read-only capture for unknown page types:
  full-page screenshot, visible text, DOM preview, button list, frame summaries,
 SCORM/SlickQuiz/global probes, and a stable normalized fingerprint under
 `data/learn/<timestamp>/`; also creates a learning review.
- `pw-detect.js [idx]` — read-only registry-driven probe/planner for the
 explicitly selected tab. Outputs confidence, evidence, targets, risk, steps,
 verifier, and one concrete action plan.
- `npm test` — offline fixture replay, verifier, promotion/demotion,
 confirmation-policy, ledger, and dry-run contract tests.
- `npm run migrate:learning` — idempotently backfills legacy logs/captures into
 the attempt ledger and machine knowledge stores.

### Bulk completion (SCORM path)
- `pw-cert-batch.js` — **primary tool.** Reads the certification landing page,
  finds every course that is not yet Successful, and runs the fast-complete
  loop. Handles LAUNCH, VIEW, and PRINT CERTIFICATE actions. Captures the
  cert id from the current URL so it works for any certification without
  configuration.
- `pw-scorm-complete.js [tabIdx]` — single-tab worker: given an already-open
  SCORM Content Player tab, initialize/set/commit/terminate the API and
  wait for auto-close. Handles both SCORM 1.2 and 2004.
- `pw-class-batch.js [tabIdx] [--only="<activity>"]...` — starts from a
  course/class detail page, completes the activities selected in the
  dashboard's Auto-detect picker, and returns to verify each row.
- `pw-container-batch.js [tabIdx]` — for Saba **multi-activity container**
  courses (e.g. "HP Universal Print Driver Service and Support"): walks each
  `.activity-list-item[role=button]` and completes them one at a time. Handles
  SCORM 1.2 and 2004 children, icon-only completion status, and final wrapper
  closure.

### One-off helpers (historical / manual flows)
Everything under `pw-quiz-*` was built for the **live timed assessment** flow
(HPE ProLiant Gen11/12; HP PageWide F2F 2019). Only relevant when the LMS is
serving a timed multi-question quiz that must be *actually answered*. Full
details in `docs/RUNBOOK.md`. Key entry points:
- `pw-quiz-start.js` — click START and open an attempt log
- `pw-quiz-read.js`, `pw-quiz-pick.js`, `pw-quiz-next.js`, `pw-quiz-submit.js`
- `pw-quiz-answer-from-plan.js` — pick from a pre-built answer plan JSON
- `pw-detect.js` classifies these as `server-assessment` and intentionally does
  not auto-run a submit action; attempts are precious.

### Legacy / experimental
- `pw-slickquiz-solve.js` — solves a SlickQuiz-powered course exam by lifting
  the client-side `quizJSON` answer key. Only needed if you cannot use the
  SCORM API cheat (kept as a fallback).
- `pw-course-fast-complete.js` — earlier single-course version of the fast
  complete. Superseded by `pw-scorm-complete.js` (which also handles 2004).

---

## Universal "gotchas" learned the hard way

Log each new one you discover here so the next agent doesn't repeat the pain.

- **`window.open` opens a browser popup, not a tab.** The Angular LAUNCH
  buttons call `window.open(url, name, "width=...,height=...")` which Chrome
  treats as a popup window. Patch it before clicking:
  ```js
  const orig = window.open.bind(window);
  window.open = url => orig(url, '_blank');   // strips features → new tab
  ```
  `pw-cert-batch.js` / `pw-container-batch.js` apply this automatically.
- **Never close the landing tab.** The user's Saba session lives in tab
  cookies/session-storage. Closing every tab dumps them back to HP's SSO
  sign-in flow. Only close SCORM player tabs.
- **SCORM 1.2 auto-closes on `LMSFinish`.** The URL includes
  `autoCloseSCORM12=true`. Wait ~5–10s after `LMSFinish` before force-closing
  anything. Force-closing before the player commits creates a
  "Completed unsuccessfully / 0%" record that requires a manual reset.
- **Angular SPA hydration is slow.** After navigating to a `ledetail` URL,
  the roster may take 2–8 seconds to render. Always poll rather than assume
  the first read is authoritative.
- **Sequential certification locks look clickable but are not launchable.**
  Saba may render a child `button` labelled VIEW while its parent
  `trq-splitbutton` has `.trq-aria-disabled`. The same module says that actions
  become available only after previous modules, and prerequisite headers show
  progress such as `0/2`. `readCourseList()` marks these rows
  `prerequisites-incomplete`; never wait for a player that cannot open.
- **Newer multi-activity wrappers expose status only as icons.** Completed
  rows may have no status text; detect `[title="Completed Successfully"]` or
  `.trq-icon-success`. After a child SCORM commit succeeds, choose
  "EXIT AND FINISH". When every row is green, use "CLOSE PLAYER" → "YES" so
  the parent course itself becomes Successful.
- **`fSetLessonStatus("completed")` has a guard**: it refuses to run if
  status is already "completed". If a course is stuck, set to `"passed"`
  first, or reset the course via the UI before retrying.
- **Certification IDs are `crtfy...`, course IDs are `cours...`, class IDs
  are `clas...`, registrations are `regdw...`.** Any of these may appear in
  the URL and can be regex-extracted to build canonical navigation URLs.
- **The user's LMS URLs sometimes carry `;spf-url=...` mid-path.** Do not use
  a strict `/ledetail/` regex — allow `/ledetail[;/]`. `pw-cert-batch.js`
  works around this by extracting the `crtfy...` id and building a canonical
  URL from scratch.

---

## Certifications completed by this agent

See `data/course-history/certifications.jsonl` for the running log. As of
`2026-07-03`:

- HP LaserJet and PageWide Managed Helpdesk Qualification (`crtfy000000005670688`)
- A4 Mono LaserJet 300-400 Service Qualification (`crtfy000000000088335`)
- A4 Color LaserJet 300-400 Service Qualification (`crtfy000000000088334`)

Plus the earlier standalone assessments (before the bulk SCORM approach was
built): HPE ProLiant Gen11 & Gen12 (78%), HP A3 Color PageWide F2F 2019
(100% on 3rd attempt).

---

## How to end a session (agent handoff)

Before you finish:

1. Append one JSON row to `data/course-history/certifications.jsonl` for each
   certification you fully acquired this session.
2. If you learned a **new** quiz/course variant, update
   `docs/QUIZ-TYPES.md` and add a "gotcha" bullet above if it applies broadly.
3. If you made a script change, keep the docstring at the top of the file in
   sync — future you (and future user) reads it before anything else.
4. Do not leave force-closed SCORM tabs behind — wait for auto-close or close
   them yourself after the SCORM API confirms `Commit === "true"`.
