# Quiz & Course Type Encyclopedia

Every course / quiz variant we have seen on `hpi-external.sabacloud.com`,
what identifies it, and the winning strategy. This document is the primary
place to add knowledge from new sessions.

Format for each entry:
- **Fingerprint** — how to tell from the page/URL that this is the variant
- **Strategy** — what to do (and why)
- **Script** — which existing script handles it
- **Notes / gotchas** — anything a future run should remember

Ordering: try the fastest strategy first; only fall through to slower ones
if the fast path fails.

---

## Landing pages (not quizzes; how you get *to* the quiz)

### Certification landing page (`.../me/ledetail/crtfy...`)

- **Fingerprint** — URL contains `/ledetail/crtfy...`. Page title matches
  "Cornerstone Saba: &lt;certification name&gt;". Body shows a
  "% Path Completed" bar and a list of "Recommended courses (Required N of M)"
  rows, each with a LAUNCH / VIEW / PRINT CERTIFICATE split-button.
- **Strategy** — this is the entry point for `pw-cert-batch.js`.
- **Note** — the roster is rendered by Angular; lazy-loads rows below the
  fold, so scroll first (the batch script handles this). Returning from a
  course can also collapse requirement cards and remove their course rows from
  the DOM. Saba may first display an "Evaluate this course?" prompt whose
  overlay blocks those cards. Shared roster reads dismiss that prompt without
  opting into the evaluation, then expand every module toggle with
  `aria-expanded="false"` before collecting or clicking course actions.
- **Sequential prerequisite lock** — a blocked WBT can misleadingly show
  `In Progress` and a VIEW button. The child button itself is not disabled,
  but its parent `trq-splitbutton` has `.trq-aria-disabled`; the requirement
  module says actions are available only after the previous module, and the
  prerequisite modules show incomplete progress such as `0/2`. Treat these as
  `prerequisites-incomplete`, not `no-player-tab`. Auto-detect now excludes
  them from runnable selections, and an attempted batch reports the evidence
  in the centered failure-diagnosis modal.

### Class / course detail page (`.../me/learningeventdetail/cours...`)

- **Fingerprint** — URL contains `/learningeventdetail/cours...`. Body shows
  "Class ID: XXXXX", a `CONTINUE` button, and one or more `Activities` rows
  each with its own `LAUNCH` button (`aria-label="Launch for <activityId>."`)
  or a `VIEW RESULTS` split-button (if the activity is completed).
- **Strategy** — dashboard Auto-detect reads every activity on the current
  detail page and opens the checkbox picker. Select the unfinished activities
  to run; `pw-class-batch.js` launches, fast-completes, exits, and verifies each
  one in turn.
- **Scripts** — `pw-class-batch.js [tabIdx] [--only="<activity>"]...` for the
  selected batch; `pw-scorm-complete.js` remains the single-open-player worker.
- **Notes** — used to fix per-activity issues where `pw-cert-batch.js` cannot
  see the individual sub-activities. If an activity is stuck on
  "Completed unsuccessfully / 0%" you cannot re-launch it — ask the user
  to reset the registration first.

### Multi-activity container (`.../app/content-player?contextid=...`)

- **Fingerprint** — URL contains `/app/content-player?`. Body shows
  "CLOSE PLAYER" top-right and a "Table of contents" / "Activities" list
  with rows like `01081387_20240816_HP_UPD_WBT`. Each row is a
  `div.activity-list-item[role="button"]`. The activity title is on
  `span.activity-cont.activity-title` (its `title=` attribute has the full
  name; the row's `innerText` may include a nested icon title of "Content").
- **Strategy** — patch `window.open`, then click each activity — it opens a
  SCORM player tab. Use `pw-container-batch.js`.
- **Script** — `pw-container-batch.js` handles both SCORM 1.2 and SCORM 2004
  child activities, skips rows with Saba's green "Completed Successfully"
  icon, and closes the wrapper after every child is confirmed.
- **Gotcha** — if you close the container before the player, Saba may show
  "Please choose an exit option (EXIT AND RESUME LATER / EXIT WITHOUT
  SAVING)". Click "EXIT AND RESUME LATER" to preserve any committed state.
- **Newer wrapper behavior (confirmed 2026-07-20)** — master courses such as
  "Imaging and Printing Fundamentals Master Course, Rev. 11.3" expose SCORM
  2004 children and show completion only as a descendant icon with
  `title="Completed Successfully"`; the row text contains no status. After a
  child returns `Commit === "true"`, choose "EXIT AND FINISH". Once every row
  has a green success icon, click "CLOSE PLAYER" and confirm "YES" so the
  parent course changes from In Progress to Successful.

---

## Course / quiz variants

Ordered from fastest / most-common to slowest / rarest.

### Variant A: SCORM 1.2 or 2004 WBT (~95% of everything)

- **Fingerprint** — the LAUNCH tab opens
  `content-na2prd0004-na2hp.sabacloud.com/content/rcs/remote_frameset_modern.html?...`
  with either `scorm_version=1_2` or `scorm_version=1484_11` in the query
  string. The tab contains a `sco` iframe with the course content.
- **Strategy** — **the SCORM fast-complete cheat.** Run
  `pw-scorm-complete.js [tabIdx]` (or let `pw-cert-batch.js` do it for you).
  Time to complete a single course: ~5-10s.
- **Script** — `pw-scorm-complete.js` (also embedded in
  `pw-cert-batch.js`'s `fastComplete()`).
- **What the cheat does** — see `#scorm-fast-complete` below.

### Variant B: Standalone timed assessment (rare, but very high stakes)

- **Fingerprint** — the assessment is opened via a link like
  `.../content-player?contextid=...&assignmentid=cninv...`, but the SCORM
  content is a live, interactive multiple-choice quiz (not a marketing-style
  slide deck). Examples seen: HPE ProLiant Gen11/12 (60Q, 80% pass, 25
  attempts); HP A3 Color PageWide F2F 2019 (20Q, 80% pass, 3 attempts);
  `2.0 HP A3 LaserJet ILT Assessment` (20Q, 80% pass, 3 attempts).
- **Strategy** — do it for real. The SCORM API cheat *cannot* be used because
  the LMS scores the quiz server-side from the answers submitted. See
  `docs/RUNBOOK.md` for the manual per-question flow.
- **Scripts** — the `pw-quiz-*` family. Key ones:
  - `pw-quiz-start.js` (creates attempt log)
  - `pw-quiz-read.js`, `pw-quiz-pick.js`, `pw-quiz-next.js`
  - `pw-quiz-answer-from-plan.js` (once you have a stem→answer plan JSON)
  - `pw-quiz-submit.js` (respects a minimum-answered safety threshold;
    override with `--force` for shorter quizzes)
- **Gotchas learned**:
  - Question order shuffles between attempts — always match by stem text,
    never by index.
  - Multi-select questions on this LMS are often single-select in disguise;
    only one option can actually be chosen.
  - Prior-attempt review of incorrect answers is the highest-value activity
    when a retake is needed — the results page usually reveals which items
    were wrong.
  - Some Saba assessments expose no review button or per-question feedback.
    Treat every attempt as precious: read all questions first, research the
    exact stems, apply answers, verify `answers.jsonl` count, then ask before
    `pw-quiz-submit.js --force`.
  - If the CDP browser closes during an assessment, Saba may resume the
    interrupted attempt from the last question. Dismiss the resume dialog with
    OK, navigate back to Q1, and continue the same attempt; do not assume a
    fresh attempt was created.
  - `pw-detect.js` now classifies this UI as `server-assessment`. Auto-detect
    should guide the user to the existing `pw-quiz-*` workflow, not create a
    new solver or try SCORM completion.

#### Notes: `2.0 HP A3 LaserJet ILT Assessment`

- **Fingerprint** — Saba `content-player` page with `Remaining Attempts
  Confirmation`, then a welcome page showing `Number of questions 20` and
  `Passing score 80%`. No SCORM API and no `quizJSON`; it is server-scored.
- **Important answer-bank corrections from 2026-07-09**:
  - Engine speed configuration on E7/E8 is `Late point differentiation
    configuration (LPDC)`.
  - Gen2 key difference: `Generation 2 utilizes a TPM instead of an MSOK`.
  - Gen2 speed licensing: answer `Generation 2`, not "some Gen1 and all Gen2".
  - E7/E8 toner delivery: `The E8 printer provides toner to the developer from
    a reservoir, the E7 does not`.
  - Physical E7/E8 distinction: use paper exit-path side (`right` vs `left`).
  - E7 imaging-unit visibility: remove `TCU-Toner Collection Unit`.
  - Manual reset counter item: `Fuser`.
  - E877 cartridge removal: `Select Cartridge Access Control (CAC)` plus the
    service manual-drive method.
  - E8 mono maintenance item: `PTB`.
  - Scanner adjustment sheet: built into firmware and printable from the
    engine.
- **Spanish version evidence (2026-07-09)**:
  - Spanish class is the same assessment shell but has **29 questions**.
  - Attempt scores observed: 72.41%, 62.07%, then 79.31% (one question short).
  - Bad changes proven by the 62.07% attempt: do **not** change these from the
    near-pass plan:
    - E7 imaging unit visibility: `Unidad de recogida de tóner (TCU)`.
    - E877 toner cartridge removal: `CAC` + `Sacar manualmente el cartucho
      desde el toner motor drive`.
    - ISA ADF pickup/separation rollers: `Ninguna, no se requieren
      herramientas`.
  - Changes that produced the 79.31% near-pass:
    - Bottom HCI: `Solo desde el lado derecho del equipo`.
    - Maintenance counter reset: `Unidad del revelador`.
  - Most likely remaining correction if reset/re-enrolled: LSU skew should be
    `Todos los modelos E7 a color` rather than `E877`. The saved Spanish plan
    in `data/prep/ilt-a3-assessment-spanish/attempt1-answer-plan.json` has
    already been updated to that likely reset plan.

### Variant C: SlickQuiz-powered course exam

- **Fingerprint** — inside the SCORM player, the `content` frame's window
  has a `quizJSON` global (jQuery SlickQuiz plugin). The player content is a
  slide deck ending in a "Course exam" with a `Begin exam` button. The
  answer key is embedded in the client — `quizJSON.questions[i].a` has the
  `correct: true` field on each right answer.
- **Strategy** — usually **skip this**: Variant A (SCORM fast-complete)
  works and doesn't require passing the exam. If for some reason it doesn't
  (e.g. LMS is configured to require the exam completion event), use
  `pw-slickquiz-solve.js`: it lifts the answer key from `quizJSON`, clicks
  Begin, and picks each correct answer in ~10 seconds.
- **Script** — `pw-slickquiz-solve.js`.
- **Note** — after the exam, the course still needs an LMSFinish for the
  Content Player wrapper to close. This happens automatically in the
  slickquiz-solve script.

### Variant D: Non-SCORM external tools (WISE etc.)

- **Fingerprint** — the LAUNCH click does *not* open a
  `content-na2prd0004-na2hp` tab. Instead a `sabacloud.com/content/socialtenantngx/...`
  URL, an external HP KB URL, or nothing visible happens. Examples: "WISE
  Knowledge Tool 01 Access", "WISE Transformation Overview". `pw-cert-batch.js`
  logs these as `no-player-tab`.
- **Strategy** — mixed. Anecdotally, some of these auto-mark Successful
  simply because the LAUNCH event is recorded server-side (WISE
  Transformation Overview did this in 2026-07-03 session). Others require
  the user to click through actual content on an external tool.
- **Suggested handling**: run the batch, capture the `no-player-tab`
  screenshot for the user's manual review, do not attempt further
  automation unless the same variant becomes recurring.

### Variant E: "View this document / scroll to end" WBT

- **Fingerprint** — an activity presents a PDF, a slide viewer, or a
  scrollable HTML doc; completion requires user interaction (scrolling to
  end, clicking OK) rather than a quiz.
- **Strategy** — if the container hosts SCORM (Variant A fingerprint), the
  fast-complete cheat *still* works. Otherwise, treat as Variant D and
  hand back to the user.

---

## Multi-activity classes

Some classes bundle two related SCORM activities in the same course
(e.g. `HP Universal Print Driver Service and Support` had a WBT + an
instructor guide). The launcher for these is Variant "Class detail page"
above. Each sub-activity is Variant A. Just repeat the SCORM cheat for each.

**Failure mode observed 2026-07-03:** if you force-close a sub-activity's
SCORM player before its `Commit` returns `"true"`, the sub-activity records
as "Completed unsuccessfully / 0%" and cannot be relaunched (Saba shows a
`VIEW RESULTS` button only). The user needed to reset the class registration
before the sub-activity became attemptable again. Mitigation is now in the
batch scripts: they only force-close when `set.commit === 'true'`.

---

## SCORM fast-complete — the exact CMI writes

### SCORM 1.2 (`window.API`)

```js
api.LMSInitialize('');
api.LMSSetValue('cmi.core.lesson_status', 'passed');
api.LMSSetValue('cmi.core.score.raw', '100');
api.LMSSetValue('cmi.core.score.min', '0');
api.LMSSetValue('cmi.core.score.max', '100');
api.LMSSetValue('cmi.core.session_time', '00:10:00');   // HH:MM:SS
api.LMSSetValue('cmi.core.exit', '');
api.LMSCommit('');
api.LMSFinish('');   // player auto-closes because URL sets autoCloseSCORM12=true
```

### SCORM 2004 (`window.API_1484_11`)

```js
api.Initialize('');
api.SetValue('cmi.completion_status', 'completed');
api.SetValue('cmi.success_status', 'passed');
api.SetValue('cmi.score.raw', '100');
api.SetValue('cmi.score.min', '0');
api.SetValue('cmi.score.max', '100');
api.SetValue('cmi.score.scaled', '1');
api.SetValue('cmi.progress_measure', '1');
api.SetValue('cmi.session_time', 'PT10M');   // ISO 8601 duration
api.SetValue('cmi.exit', 'normal');
api.Commit('');
api.Terminate('');
```

**Where the API lives.** SCORM 1.2 helpers on the `sco` frame historically
exposed `oLMS_API` directly; on newer content only `window.API` is present.
Rule: search every frame from the player top-window for the property, first
`API_1484_11` (2004), else `API` (1.2). `pw-scorm-complete.js` uses exactly
this walk.

**Every field must succeed.** `LMSSetValue` returns the string `"true"` on
success and `"false"` on failure (SCORM 1.2). If any field returns "false"
the LMS is refusing our writes — check whether the course is already
completed (guard in `fSetLessonStatus`), or whether the API was initialized
by earlier content (call Initialize a second time; the return "true" is a
no-op success).

**Why we set both `success_status` and `completion_status` on 2004**
because different LMS profiles gate certification on different fields. Saba
appears to require both. Setting only completion leaves the parent path
progress bar stalled.

**Why session_time is set** because some LMS gating requires a non-zero
attempt duration.

---

## Growth log — 2026-07-03

Session added:
- Variant A (SCORM 1.2 and 2004) — validated on ~10 courses across 3 certs
- Variant B (F2F assessment) — updated with multi-select-as-single-select
  lesson from HP A3 PageWide 2019
- Variant C (SlickQuiz) — first fully-automated pass
- Variant D (WISE) — recorded but not solved
- Multi-activity class caveat (force-close causes "unsuccessful" lock)

Certifications acquired end-to-end via the batch:
- HP LaserJet and PageWide Managed Helpdesk Qualification (12/12)
- A4 Mono LaserJet 300-400 Service Qualification (2/2)
- A4 Color LaserJet 300-400 Service Qualification (2/2)

---

## Growth log — 2026-07-20

- Confirmed that "Imaging and Printing Fundamentals Master Course, Rev. 11.3"
  is the existing multi-activity container type, not a new quiz variant.
- Extended `pw-container-batch.js` to handle SCORM 2004 children, Saba's
  icon-only completion markers, SPA re-render delays, committed activity exit,
  and final wrapper closure.
- Auto-detect now reads class-detail activity rows directly and opens the
  existing checkbox picker; `pw-class-batch.js` completes only the selected
  activities without requiring a manual launch/re-detect cycle.
- Added the registry-driven detect → confirm → execute → verify → learn loop.
  Every page gets a normalized fingerprint and ranked plan; every mutating run
  requires a confirmed token and writes a versioned attempt ledger.
- Candidate strategies now promote only after 3 independently verified
  successes across 2 targets, demote on regression, and can contain only the
  safe action DSL. Unknown/failed attempts create indexed evidence and a
  guided review-queue action.
- Added offline replay, verifier, promotion, confirmation-policy, and dry-run
  contract tests. Existing completion, quiz, and capture logs were migrated
  into the machine knowledge store.
- Learned the sequential prerequisite lock fingerprint on the HP PageWide XL
  new-generation path: VIEW + `.trq-aria-disabled` + the predefined-sequence
  notice + incomplete prerequisite counters. The roster now preflights this
  state, and partial/failed runs produce a structured root-cause diagnosis in
  the attempt ledger, Learning queue, and centered dashboard modal.
- Completed all five activities; the parent course reported Successful with
  score 100.

---

<!-- AUTO-EVIDENCE:START -->
## Automated evidence summary

This section is generated from verified attempt evidence in `data/knowledge/strategies.json`.

- **cert-batch** `legacy-cert-batch` — needs-review; 24 verified success(es), 11 failure(s), 34 distinct target(s).
- **cert-batch** `d9ba168f0c5e5c5bcb2bd341` — candidate; 0 verified success(es), 1 failure(s), 7 distinct target(s).
- **cert-batch** `unfingerprinted` — candidate; 0 verified success(es), 1 failure(s), 1 distinct target(s).
- **cert-batch** `live-prerequisite-lock` — candidate; 0 verified success(es), 1 failure(s), 1 distinct target(s).
- **cert-dry-run** `unfingerprinted` — candidate; 1 verified success(es), 0 failure(s), 1 distinct target(s).
- **container-batch** `legacy-container-batch` — promoted; 6 verified success(es), 1 failure(s), 7 distinct target(s).
- **scorm-complete** `legacy-scorm-complete` — candidate; 1 verified success(es), 0 failure(s), 1 distinct target(s).
- **server-assessment** `legacy-server-assessment` — candidate; 2 verified success(es), 6 failure(s), 8 distinct target(s).

<!-- AUTO-EVIDENCE:END -->
