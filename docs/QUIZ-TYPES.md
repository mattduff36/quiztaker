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
  the DOM. Saba may first display an evaluation prompt, worded either
  "Evaluate this course?" or "Congratulations! You have completed the course.
  Do you want to evaluate the course now?" The overlay blocks those cards.
  Shared roster reads dismiss it with Close, never Evaluate, then expand
  every module toggle with `aria-expanded="false"` before collecting or
  clicking course actions. If a toggle click is blocked, the run screenshots
  the viewport, closes this overlay when it is still there, and continues.
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

### Brainshark presentation embedded in a Saba content player

- **Fingerprint** - the Saba wrapper starts a `remote_frameset_modern.html`
  player. Inside is a Brainshark frame with a Content outline, a `scrub-bar`
  slider, a current-slide counter, and a Completion Criteria indicator.
  The browser's frame URL can be blank even when the frame's own location
  identifies Brainshark. This variant was observed in Servicing HP PCs 2024,
  Pillar 3 Before Replacing Parts (138 slides).
- **Launch** - apply the existing `PATCH_OPEN` from `lib/cert-status.js` to
  the selected Saba course detail page before clicking Continue. It drops
  window features so Chrome can open the real player as a second tab. Keep
  the originating Saba tab open to receive the player's result.
- **Playback** - start with Play, then confirm the scrub value advances.
  When the operator has asked to expedite playback, seek close to the end
  with the visible slider and allow the slide to end and auto-advance.
  The outline's played marker verifies progress. Jumping through the outline
  can leave unplayed slides behind, even when the slide counter advances.
  Here, seeking produced 100% slides viewed while audio remained below the
  separate requirement. Use continuous playback for audio credit. During
  diagnosis, the player's read-only completion state exposed the exact
  settings and progress without changing the result: 75% slides, 75% audio,
  and 0% minimum question score. These settings are per presentation.
  In timed samples, 2x playback credited 41 audio seconds in 24 wall-clock
  seconds and 4x credited 26 in 15. Both earned approximately 1.7 seconds
  of credit per second. At 2x, more credit was collected per slide, so it
  required less revisiting. Replayed questions retained their original
  answers and could be advanced with Next once playback stopped.
- **Knowledge checks** - playback can stop at the end of a slide until a
  response is submitted. Use the visible question and material to answer.
  A custom radio control may need keyboard Space after focus. Verify the
  answer selected and Submit enabled. Other checks use checkboxes or a
  written response, followed by a separate answer or model answer slide.
- **Vitriol diagnosis** - this Brainshark frame exposed a Document in the
  element ancestor chain. Passing it to `getComputedStyle` threw and caused
  an empty snapshot. Guard visibility reads for element nodes and prioritize
  question and playback controls ahead of long outlines. Use slide identity
  and available controls for stale-action checks during playback, since the
  displayed counter changes continuously.
- **Result verification** - the Saba wrapper exposes a SCORM 1.2 status,
  while Brainshark independently checks its own audio and slide progress.
  Verify the Brainshark indicator and the Saba course status separately when
  testing the player flow.

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

### Direct Saba Storyline terminal lesson (MyKnowledge App)

- **Fingerprint** - The selected Saba content-player has one activity, a direct
  Storyline `sco` iframe and sibling `scorm_api` frame inside a
  `remote_frameset_modern.html` frame, where the live SCORM API resides.
  Its terminal Thank You
  slide offers Close module; an originating course detail tab may not exist.
- **Strategy** - Use the independent learner's scoped local finalizer. It commits
  only existing completion, uses observed ordinary exits and checks the same
  activity plus the returned course enrollment or exact enabled certificate.
- **Verification** - Thank You alone is not success. Missing completion, unsafe
  dialogs or ambiguous targets stay unverified; never synthesize a score/pass.

### Saba Storyline knowledge check (Poly Video Fundamentals)

- **Fingerprint** - Saba embeds a Storyline module with Pick One, Pick Many, and Dropdown list question slides. Radio buttons and checkboxes may be unnamed or share a generic name such as Rectangle 24. The answer text appears in separate elements.
- **Strategy** - Match each label to its visible control by row. Read each installation dropdown individually because the same choices are shuffled separately in each row. Submit using the visible controls and use NEXT > on the feedback panel.
- **Verification** - Results Slide reports Your Score and Passing Score. Continue to Summary, select EXIT, then check for Completed Successfully in the Saba roster. Verified on Module 2 at 90%, with 80% required.

- **Drag and drop** - Module 7 required dragging visible items into their matching slots. Complete this interaction in the course browser when Vitriol asks for help, then resume from the resulting slide.

### Saba Articulate Rise course and quiz (Poly Lens Fundamentals)

- **Fingerprint** - The Saba SCORM 1.2 player contains a Rise course with a lesson menu, course completion percentage, and a separate Check your Knowledge lesson. Each active quiz card offers labelled radio buttons or checkboxes and separate SUBMIT and NEXT controls.
- **Strategy** - For course completion, work through the unfinished lessons using the lesson menu and complete required interactions as prompted. The direct Check your Knowledge link is useful for quiz-only goals. On an active card, select the named controls with Space, submit once, and use NEXT after feedback.
- **Verification** - Quiz Results showed 91% with an 80% pass mark. After opening Summary and the final lesson and using EXIT COURSE, the course still showed In Progress in Saba and the reopened player showed 30% complete. In Poly Lens Fundamentals, opening each of the seven unfinished lessons and scrolling through its nested page panel to the bottom brought the player from 30% to 100%. Exit Course then led to Successful in Saba. Check the lesson checklist and the portal result independently before marking the course complete.

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
  The same gate appeared on 2026-10-02 for MyKnowledge App and PrintOS
  MyKnowledge App quiz (`99 attempts remaining`, buttons Cancel and Proceed).
  `pw-cert-batch.js` records `attempt-confirmation` and does not click Proceed.
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

### Variant F: Confirmed quiz learner (unknown or document page)

- **Fingerprint** — detection reports `unknown` or `document-wbt` on a content
  player that is not SCORM, SlickQuiz, a container, or a server-scored
  assessment. The first live page for this variant has not been recorded yet.
- **Strategy** — `quiz-learn` / `pw-learn-quiz.js <tabIdx>`. One confirmed plan
  allows at most 20 steps. The helper sends a page snapshot to the control
  plane. It uses the user's configured personal OpenAI, Gemini or OpenRouter
  connection, or the inherited OpenAI-compatible HTTP provider when
  `LEARNER_API_KEY` is set. The model may return `click` on a
  navigation control, `answer-select`,
  `scroll`, `wait`, `capture`, or `verify`. A pass is recorded only when the
  page text itself shows it. Submit, finish, exit, and grade are rejected.
  The plan is refused unless the latest detection is `unknown` or `document-wbt`.
- **Not this variant** — a timed server assessment stays on Variant B. Detect
  still offers capture only, and Learn quiz stays disabled on that page.
- **Script** — `pw-learn-quiz.js`. `--dry` observes the tab and does not click.

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

### Xerox Learning Central: Atlantis Platform 4.5

Verified on 2026-11-03 using the hosted Operations guided runner and installed
Vitriol Helper 1.0.14. The open ATP45XTA Atlantis Platform 4.5 Differences
Service Training player at `learningcentral.xerox.com` exposes SCORM 2004
through nested frames. The existing registry and executor handled it without
a new strategy: Operations reported verified completion and the Xerox page
independently showed **100%**, then moved to **Feedback Survey** with a
**Start Survey** button. The survey is separate; it was left untouched.
No learner question was raised during this run. Do not infer that a survey
has been answered or that a broader certification has been awarded.

Xerox player addresses can contain a `user_cookie` session token. Show only
the origin in course-selection guidance; never copy the full address into
handoffs, documentation, or screenshots intended for sharing.

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
## Hosted Vitriol targeting

Hosted runs do not trust a tab index captured earlier. The helper publishes a
browser-session id, revision, and per-tab fingerprint. A confirmed plan must
match that snapshot. Refresh the tab list after navigation, then detect again
before a class, SCORM, container, or SlickQuiz run. Timed server assessments
stay manual: detection may capture them, and it must not submit an attempt.

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
- **start-browser** `unfingerprinted` — candidate; 0 verified success(es), 0 failure(s), 1 distinct target(s).

<!-- AUTO-EVIDENCE:END -->

## Canon / Cornerstone OnDemand curriculum (2026-10-14)

Reusable player documentation and observed family evidence are now described in
`docs/PLAYER-KNOWLEDGE.md`. The hosted Learning page keeps this knowledge separate
from course answers and verified execution strategies. Unknown players and
no-progress runs enter the research queue; documentation alone never proves that
a navigation strategy works.

The Canon Development Hub uses `*.csod.com/phnx/driver.aspx?routename=Learning/Curriculum/CurriculumPlayer`, a different platform from the HP Saba integration. The captured Engineer Certification Programme curriculum shows module sections and a Launch Test control. A curriculum is not an assessment question page. Detection recognizes it and offers capture, with instructions to open the intended module then detect again. Do not apply Saba roster selectors or SCORM completion assumptions to this host. Actual assessment controls, attempt limits, and passing verification are not yet inspected or supported by a verified strategy.
## Guided course workflow

Choose the course tab in Operations and use **Inspect and start**. Vitriol refreshes and inspects that exact tab, then runs a supported SCORM/container/SlickQuiz strategy or captures an unfamiliar page and starts bounded AI learning. Helper 1.0.8 adds learner questions; older helpers must update first.

Questions pause the job as `awaiting-input`, never as a passed quiz or failed strategy. Answer and continue to inspect the current page again and send the stored answer to the configured AI provider. Missing AI configuration links to Settings. Exhausted provider requests stop with an error. Technical actions and output remain under Advanced tools.

Learning is navigation and control discovery, not model training or a guarantee of passing an arbitrary assessment. Server-scored assessments still require review; final submission remains disabled in the learner. Verified completion requires page evidence. Keep Operations open for automatic follow-up steps; closing it leaves the current helper job visible in Advanced tools.

## Canon Cornerstone Device Features (observed 2026-10-14)

The curriculum launches a SCORM 1.2 wrapper containing a Brightwave course in
`CourseIframe`. The wrapper body is empty; read the content frames. The welcome
page has a link-style Start control and a language selector (English selected).
Classify this as `csod-learning` and use the learner, rather than the Saba SCORM
completion strategy. Read the actual material; a launch is not completion.
The separate Device Features Assessment remains unverified.

The welcome Start opens a separate `master.htm` course window. Follow the
selected page's popup, and re-read the page before acting if it changed while
the provider was deciding. Brightwave tiles use empty `button.invisibutton`
overlays: their visible topic labels are in `menuTopicButtonClosed*` children
of `menuscreen_panel_N`. Next/Back/Home names come from visible navBtn parents.
Do not treat the welcome wrapper saying "course is in progress" as material.

A later slide is not those navBtn parents. On the captured "Take a look at
Scan and Store" screen (`1_110`), the transparent buttons sit on visible
`.screenElement` boxes. `.backbtn` / `.nextbtn` (`1_110_backbtn`,
`1_110_nextbtn`) are Previous and Next. A `.box` whose id matches
`N_N_clickN` (observed `1_110_click1`, 150×140 over Scan and Store) is an
unlabelled hotspot named `Course interaction: <id>`. The name is the element
id only. The full-slide image button (`1_110_slide`, `.screenElement.image`)
is not a control. This is recognition of that overlay, not a completed course
and not a verified passing strategy. If the same action and target leave the
view unchanged three times, the learner asks the operator to resume instead of
repeating until the step cap.

## Guided course reading and quiz intent (implementation, not a live pass claim)

Vitriol defaults to **Read course material**. It follows observed course links,
cards, panels and modal controls through nested frames, retains successive
viewport excerpts with their sources, and pauses with a summary. Reading never
uses a SCORM completion shortcut or claims an assessment pass. Choose **Take
the quiz** to authorize observed answer/navigation and final submission controls
for that run. The signed job input and stored plan constraints determine this
intent; page text cannot grant permission. Old jobs default to reading.
The learner can select an already-open course/lesson/quiz tab offered in its
snapshot on the same website, and revisit it without operator window changes.
It rechecks the exact tab URL/title before switching. Unrelated websites are
not offered; a new course popup opened by a selected control is followed.

Helper 1.0.15 / quiz-learn capability 3 is required. The learner is finite: 80
steps per run, up to 16 visible frames and 40 controls per category, 8,000 chars
per observation, 64 retained excerpts and a 24,000-character model context with
relevance selection for later questions. Resume a reading run if more remains.
Only visible quiz pass/score evidence counts as passing; a model summary does
not. Failure evidence remains in course memory for a deliberate subsequent run.
Offline Chrome fixtures cover the controls and quiz flow; these fixtures are
not evidence that any live qualification has been passed.

### Persistent course slides and visible controls (Canon observation)

On 4 November, Device Features used a draggable `.instructionpanel` overlay
with a bold subject ("Scan and Store") and an invisible button on the matching
`1_110_click1` hotspot. The overlay text was readable, but the hotspot had no
accessible label. Helper 1.0.25 labels it from the instruction only when that
slide has exactly one visible hotspot and one visible emphasized subject.
Multiple targets keep their technical IDs rather than guessing. Previous/Next
remain separate controls. A read-only check on the live stalled page confirmed
the named target; offline fixtures verify clicking, hidden and ambiguous cases.

The same session froze during screenshot capture: the terminal sanitizer's
nested slash regex could backtrack indefinitely on base64 in learner stdout,
blocking all heartbeats. Helper 1.0.25 omits embedded data URLs and uses a
single token scan for relative-URL query redaction. A timeout-isolated regression
protects both long slash strings and screenshot-bearing stdout.

Canon PaperTheory keeps earlier slides in the DOM: the live page had 161
interactive candidates, with visible navigation only after index 120. Helper
1.0.17 budgets the first 120 visible, front-facing candidates rather than raw
DOM positions, and still returns at most 40 controls. It accepts observed
`javascript:;` no-op links, excludes arbitrary JavaScript URLs and hidden
flipcard backs, and attributes excerpts to a visible heading. Offline Chrome
coverage verifies these controls; this is not a live course-pass claim.
Pointer-enabled DKI speech bubbles and rollover information icons are also
observed controls; unlabeled icons receive a stable human-readable number.

### Long Cornerstone curricula (control discovery)

Helper 1.0.19 excludes passive `data-toggle="cso-frame"` layout/progress
containers unless they have interactive evidence. It prioritizes controls
intersecting the current viewport before the 120-candidate scan and 40-control
output limits, with offscreen controls retained as a fallback. This lets
scrolling reveal later curriculum modules. An offline Chrome fixture exercises
150 module links and actual scroll/click actions; live completion is not implied.

### Canon ASP.NET assessment navigation

The subsequent restored-session run on 3 November reached Summary, submitted
final answers and visibly **Passed: 75% (15/20), threshold 70%**. Some earlier
selections survived sign-in recovery; inspect the checked states before
re-entering answers. The owner requires normal-user operation through the UI,
with Vitriol using its own learning/research; do not feed it answers extracted
from internal logs. A `Pass/Fail: Passed` results table with a score below100%
fell through automatic learner verification in helper1.0.21; the operator
verified the visible result and paused the session. Helper1.0.22 recognizes
the named Canon result table and records the real score/counts automatically.
Visible pass or fail ends the run immediately, with no implicit retake.
Do not retake a visibly passed assessment to satisfy internal status.

Observed on 3 November with helper 1.0.21: checked-state observations let the
learner select answers once, handle multiple selections and advance through a
20-question Engineer Certification Programme Assessment. Retained material
search and actual public web searches supplied reference evidence. The final
Next led to an expired-session page before submission/result verification.
This is not a pass or fail. Restore sign-in and reopen the existing saved
attempt; never infer a result or start a retake from this state.

Observed Next, Summary and Save/Return Later anchors use standard WebForms
JavaScript postbacks rather than ordinary links. Helper 1.0.20 recognizes only
button anchors with identifier targets, empty string arguments and the observed
fixed WebForm flags, rejecting extra script and external action URLs. These
controls are classified as quiz navigation and excluded in Read mode. The
offline regression clicks the exact postback markup; it is not a live pass claim.

### Quick scrape for manually paced course players

Select the course tab in Operations, choose Quick scrape, and start recording.
Wait for Recording, then click through the course and open its panels yourself.
Finish recording in Operations. The Windows helper writes a local replay
(`replay.html`), timestamped frames, and text and JSONL transcripts under
`%LOCALAPPDATA%\QuizTaker Helper\data\quick-scrape`. The most recent 64
text excerpts feed course memory for later questions. Image-only content appears
in the visual replay. Capture samples visual changes up to five times a second
and buffers fast DOM changes. Capture is limited to the selected HTTPS course
origin; authentication screens and editable fields are excluded. Stop limits
are 15 minutes, 200 MiB, or 4,500 frames per recording.

### Canon timed multi-question forms

The Device Features assessment renders multiple numbered fieldsets on one long
page. Radio buttons and checkboxes share the hosted 40-choice limit. Collect
them together in document order, put viewport intersections first, and retain
their distinct radio/checkbox IDs and checked states. Canon fieldsets expose
their displayed question number, which distinguishes repeated answer labels.
The visible �Time remaining� line ticks between observations. Ignore only the
numeric value on that labelled line when rechecking a decision; changes to
questions, selections, navigation or expiry still invalidate it.

Canon's UserTestSummary.aspx and UserTestReview.aspx are post-attempt pages.
Read mode can collect their feedback. The summary can split the heading,
name, score and percent sign across text nodes. On 4 November the visible
summary showed 14/20 (70%), with 75% required. Its six incorrect review rows
gave a category and blank explanations. Keep that distinction in memory;
a category alone does not identify the correct answer.

### Work independently findings from the Brainshark live test (17 November 2026)

- Goal planner treats the ordinary phrase "if needed" anywhere as ambiguous, even when "submit the assessment" is explicit; separate clause-level detection.
- Saba class-detail detector found one unfinished activity, but Work independently stopped with generic ask to open course; add narrowly scoped Continue/Launch in same Chrome window from landing and auto-select associated player.
- Vitriol retained prior Poly course objective/history after New task; first model ask chosen HP vs Poly. Scope task objectives/dialogue and retained course content by actual course, reuse same course while switching to authorized player. Old score was visible without a selected course.
- Brainshark DOM ancestor traversal can return Document from HTML.parentElement; getComputedStyle throws and loses all controls and text. Guard element nodeType at every visibility ancestry scan; use in-frame location for source when OOPIF Playwright URL is blank.
- Player exposes 138 slides via Table of Contents, actual started/played markers and scrub slider. Need a playback-aware wait and narrowly scoped opt-in seek via real player range. Avoid repeated provider calls during autoplay and keep old question available through tab refresh.
- Observed old reply requested "Enable control detection", which is not an Operations control. Ask for a concrete action the operator can actually take.
- Live elapsed time changes made the same-view guard discard proposed actions during normal autoplay. Compare stable slide ID and actionable controls, with running time tracked separately.
- Brainshark custom radio selection needed focus and Space before SUBMIT enabled. Put active question controls before the 40-control limit occupied by table-of-contents items. Free-text checks need an actionable operator handoff or a bounded text action.
- After approximately 90 seconds, Operations hid a live user question behind a browser check. Refresh restored the question. Keep pending questions visible while rechecking the browser in the background.
- The live player completed after continuous audio playback reached its 75% requirement. The SCORM wrapper then reported completed through a read-only status check. Operator intervention was needed for launch, visibility recovery, playback and quiz controls. This run does not establish unassisted completion.

- Final live verification on 17 November 2026: Brainshark displayed COMPLETED at 75.4% audio, and its Saba wrapper reported completed. The player subsequently closed and Saba displayed Successful with a completion date of 17-NOV-2026 and Print Certificate. Operations reported a failed resumed job after the player closed, leaving an obsolete question visible. Its task record was manually marked complete only after Saba success was verified. Add landing-page result reconciliation after player closure to the next batch.

### Follow-up performance work requested for the following release

Recognize repeated assessment layouts and execute observed answer, selection verification, Submit, feedback verification and Next as a bounded sequence. Measure model requests and elapsed time before and after, preserve question identity and stop if the page changes unexpectedly. This is future work. Version 1.0.39 monitors approved Brainshark playback locally, avoiding model requests for each playback check.


### Saba Cloud 66 native assessment coordination test - 17 November 2026

Pillar 3 Before Replacing Parts Assessment (cours000000001194014): 10 questions, 80% required, passed with 100% on one attempt. Vitriol handled answer choices, question navigation and submission. Coordinator assisted native trq-radio selection using its associated visible label, verified input.checked, and four-way matching dropdowns using role=combobox and visible role=option labels. The sequence dropdowns displayed descriptions rather than step numbers; use actual observed labels. Never infer unchanged question from repeated Select placeholders: verify question number and stem. Continue and Proceed stayed in the same Chrome window with scoped popup protection. Landing displayed both Continue and activity Launch, so single combined-match launch logic needs priority handling.

After submission Saba displayed Test score 100%, Test status Pass. The learner did not recognize this variant and paused for unchanged-page input. Normal Close Player returned to the same course showing Successful, Score: 100 and completion date17-NOV-2026. Operations also missed this final state and was manually marked complete after external verification. Batch fixes are recorded in data/sessions/pending-2026-11-17-quiz.md. This assisted pass does not establish independent capability.


### Current registration versus historical completion - 17 November 2026

HP Connector Handling Procedures (cours000000001172089) was In Progress for its current registration while Progress History also showed Successful from30-JUN-2023. Never use an arbitrary Successful label anywhere on the detail page to skip launch or verify completion. Read the single visible course--detail__thirdRow__enrollmentStatus__text current enrollment header and verify the exact originating course. Unknown or ambiguous current status is not proof of completion. Helper1.0.41 includes this guard.


### HP Connector Handling Procedures live completion - 17 November 2026

The single unfinished activity0001104702_20211206 was detected as class-detail. Operations queued the existing class-batch capability through helper1.0.43. It launched the selected activity, used the supported SCORM executor and verified the class result. The current course enrollment showed Successful, Score100 and completed17-NOV-2026; Operations automatically showed Task complete with Pause session hidden. This run needed no learner-model question loop or manual content/quiz clicks. The old2023 Successful history was not used as verification.


### Canon Intermediate Professional/Production Print: direct lesson extraction - 18 November 2026

The owner authorized direct course-data collection and prioritized the fastest verified completion over replaying every lesson interaction. Brightwave's authored English lesson data is available through the normal authenticated browser session: observed publication index.htm -> referenced lib/js/splash.js -> lib_en/templates/master.htm -> referenced course.js -> referenced master.xml -> individual page XML files. Extract the text elements' CDATA/HTML, retaining source URLs and topic/page labels. Follow exact nested dialogue XML references inside pages as well: for example, Workflow's JDF explanation is in dialogue_what_is_jdf.xml and is absent from the main page text. Strip XML comments before enumerating references; Finishing includes a commented-out missing can767009_04_115.xml. Unused dialogue/transcript references can also return404. Report missing material instead of inventing it. Read referenced lesson images when text is insufficient; Troubleshooting's error-code description was in can767006_02_280.jpg. No authentication bypass or LMS status mutation is needed.

Observed publication IDs: Firmware1194, Printer Drivers1195, Network Connectivity1196, Troubleshooting1197, Working Safely1198, Finishing1199, Colour Management Basics1202, Colour Theory1203, Professional Print Workflow1204. Only use IDs/URLs established from the actual course, not guessed ranges. Session artifacts and bounded read-only collectors are under data/prep/canon-material; the detailed checkpoint is data/sessions/canon-2026-11-18-progress.json. Course material was added, with provenance, to this helper/account's bounded learner material store and is available to search_course_material. This is reference material, not current clickable IDs or pass evidence.

The faster assisted assessment flow selects a group of visible answers from the extracted material, verifies checked states visually, then asks Vitriol to use Summary, check every question answered, Submit Final Answers and verify the actual result. Canon WebForms may put3-12 questions on one long page. Keep model/parent browser actions sequential; never operate the same page concurrently. Native accessibility text did not reliably expose checked states; screenshots did. Use small input batches (at most4-5 actions): an eight-click call applied the selections but failed its response and reset the computer-use connection. Reinspect the saved attempt after an interruption, rather than retaking.

At this point the run verified Firmware85%, Colour Theory85%, Colour Management88%, Professional Print Workflow94%, Printer Drivers100%, Network Connectivity100%, Working Safely100%, Troubleshooting94%. Device Features was already passed and was not retaken. Finishing subsequently passed100% (12/12). Returning via Done showed curriculum100% with all ten assessment sections Completed; evidence is data/prep/canon-intermediate-completed.png and .txt. None of the individual scores alone was treated as curriculum completion. The assisted flow does not establish independent extraction or grouped-answer capability in the installed runner.

Batch candidates: automatic safe authored-material extraction with nested panels/images; multi-select and same-page answer batching; Brightwave graphical hotspot/overlapping Start targeting; reused lesson-popup rebinding; stale questions after interrupted ten-minute runs; positive quiz-intent parsing (a Do not clause elsewhere can incorrectly select Read mode); preserving a new task's tab/goal during delayed previous-job updates; and screenshot scaling. The owner supplied a recording showing rapid alternation between two course sizes during quick-scrape at Chrome80% zoom. Stopping the recorder saved39 observations/100frames and removed that capture path; the precise scaling fault remains unproven. Do not claim this bug fixed or deploy speculative changes during a live assessment.

### Canon Brightwave autonomous reading and recovery (helper 1.0.46)

- Read the observed publication loader chain: index.htm -> referenced splash.js -> observed lib_LANG/templates/master.htm -> referenced course.js -> masterObj.init XML -> active page XML -> recursive linked dialogue XML. Strip XML comments; never enumerate publication IDs or use hidden assessment sources as an answer key.
- The integrated learner collects source-labelled text through same-origin browser authentication and normal scoped learner memory. It rejects redirects and out-of-publication paths and enforces request/page/depth/byte/time/text limits. Missing sources, image-only pages and excluded assessment sources remain explicit gaps; source collection is not visual reading, mastery or LMS completion.
- Use topic-specific Start labels and hit-tested graphical hotspots. Only a publication-scoped graphical SIMS example login without password/form controls is a simulation. Genuine portal authentication remains manual. Follow only new or navigated course children of the exact opener, including reused named windows; never jump back from an inner lesson to its launcher.
- In quizzes, answer-group sets at most eight observed radio/checkbox/written responses on the same current answer page. Preflight all targets, set desired states idempotently, stop on changed questions/options/navigation and verify actual final values. Next and Submit remain separate actions. Grouped answers require the observed answerPageId; older snapshots keep single-answer behavior.
- Native no-clip viewport capture plus offline scaling avoids changing Chrome zoom/device metrics during recording and learner capture. The isolated headed fixture measures actual 80% zoom, repeated captures and privacy-mask alignment. It is not proof of the historical flicker's exact cause or of a new live course pass.
- After a coordination/input timeout, keep the course open and use Resume from current page. Do not restore an answered historical question, replay old guidance or restart a finished assessment. Read-only/no-submit remains binding; excluding a named Device Features retake does not negate an explicit Firmware assessment request in another clause.
- After verified or operator-recorded task completion, a new start invalidates delayed old context and retains the new goal/tab. Ready indicates an idle interface, not an unverified LMS completion. Offline fixtures are the evidence for this implementation; no live completion is claimed.