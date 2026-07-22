# Saba quiz — automation runbook (fresh, 2026-04-17)

> **New agents: read `AGENTS.md` at the repo root first**, then
> `docs/QUIZ-TYPES.md`. This runbook only applies to **Variant B** in the
> quiz-types encyclopedia: a live, timed multi-question assessment where the
> LMS scores answers server-side and the SCORM API cheat cannot be used.
>
> For SCORM-based Web Based Trainings (the ~95% case) use
> `pw-cert-batch.js` and read `docs/QUIZ-TYPES.md#variant-a`.

Prior answer knowledge has been deliberately cleared. Every question is read,
researched, and answered fresh. Only per-attempt logs accumulate going forward.

## Primary goal (do not drift)

1. Read each question from the live page (DOM + screenshot).
2. Research the answer online. Prefer **two** independent, authoritative sources.
3. Pick the answer(s), log the decision + confidence + reasoning.
4. Advance, verifying the question number incremented by exactly 1.
5. Before submit, open QUESTION LIST and reconcile: **60/60 answered, no gaps**.
6. Review every `low` / `med` confidence answer, change if a better option is now
   clear, then submit.
7. If the score is ≥ 80%, done. Otherwise retake and, on each repeat question,
   consult the prior attempt's pick + confidence before deciding.

## Workspace layout

| Path | What |
|------|------|
| `pw-cdp.js` | Shared: attach Playwright to the user's Chromium via CDP (port 9222). |
| `start-cdp-browser.js` | Launch a visible Chromium listening on CDP 9222. |
| `pw-quiz-read.js` | Dump the current page as JSON (mode, qNum, stem, options, selected, score). Also screenshots into the active attempt folder. |
| `pw-quiz-pick.js` | Click radio/checkbox option(s) by exact or partial label. |
| `pw-quiz-next.js` | Advance to the next question, verify `qNum` went up by exactly 1 (or reached end/result). |
| `pw-quiz-jump.js` | Open QUESTION LIST and jump to a specific question number. |
| `pw-quiz-start.js` | Click START on the welcome screen AND create a fresh attempt folder under `data/runs/<id>/`. |
| `pw-quiz-retake.js` | EXIT → YES → LAUNCH → RETAKE. Stops before START (run `pw-quiz-start.js` next). |
| `pw-quiz-log-answer.js` | Record the selected answer + confidence + reasoning to the attempt log. |
| `pw-quiz-review.js` | Open QUESTION LIST and return `{ answered, unanswered, lowConfidence }` for the pre-submit pass. |
| `pw-quiz-submit.js` | Submit, wait for result, parse score, finalise the attempt. |
| `pw-quiz-prior.js` | Look up prior picks + confidence for a stem (the current question by default). |
| `pw-quiz-checkboxes.js` | Legacy helper for listing all checkbox states. |
| `pw-screenshot.js`, `pw-page-text.js`, `pw-click.js`, `pw-goto.js` | Generic Playwright helpers. |
| `kill-quiz-procs.js` | Kill stray Node quiz processes. |
| `data/runs/<attemptId>/answers.jsonl` | One JSON row per question: stem, options, picks, confidence, reasoning. |
| `data/runs/<attemptId>/q<NN>.png` / `.txt` | Per-question screenshot + visible text dump. |
| `data/runs/<attemptId>/meta.json` | Attempt metadata: started/finished/score/pass. |
| `data/runs/history.json` | Cumulative per-stem history across attempts. |
| `data/runs/index.json` | List of all attempts with scores. |
| `data/runs/current-attempt.txt` | ID of the attempt currently being written. |
| `archive/2026-04-17/` | Everything from the previous effort (scripts + data + runbook). |

## Canonical flow

```bash
# One-time (already running): visible Chromium with CDP on 9222
node start-cdp-browser.js

# When I am on the welcome screen and ready:
node pw-quiz-start.js --note "fresh attempt"

# For EACH question:
node pw-quiz-read.js           # JSON + screenshot -> data/runs/<id>/qNN.png
#   ... I research online (multiple sources) ...
node pw-quiz-pick.js "Option label"                 # single-select
node pw-quiz-pick.js "Label A" "Label B"            # multi-select
node pw-quiz-log-answer.js --qNum 1 --stem "..." \
    --picks '["Option label"]' --confidence high \
    --reasoning "source1 ..., source2 ..."
node pw-quiz-next.js --expect 2                     # verify advance

# After question 60:
node pw-quiz-review.js                              # reconcile 60/60 + low-conf
#   ... change any low-confidence answers I now disagree with ...
node pw-quiz-submit.js                              # submits + finalises log

# If score < 80%:
node pw-quiz-retake.js                              # back to welcome
node pw-quiz-start.js --note "retake N"
#   ... per question, ALWAYS check `node pw-quiz-prior.js` first ...
```

## Known Saba UI quirks (kept from prior session, still true)

- **Next**: multiple `button.next-btn` in the DOM; only one is visible. Our
  `pw-quiz-next.js` filters by `offsetParent !== null`, `!hidden`, and
  `aria-hidden !== "true"`.
- **Submit**: `[aria-label="Submit the Test"]` is often visually hidden; we
  click it via `evaluate` rather than Playwright's locator.
- **Question counter jumps**: if you advance before the page has reloaded you
  can skip a question. `pw-quiz-next.js` verifies `qNum` incremented by exactly
  1 and exits non-zero otherwise. The caller should `pw-quiz-jump.js <N>` back
  if the jump misbehaved.
- **Option order shuffles** between attempts. Always match by label text, never
  by index.
- **Retake not available mid-test**: EXIT only shows after a Submit / result
  screen. `pw-quiz-retake.js` is safe to run repeatedly — missing buttons are
  skipped, not errored.

## Confidence labels

| Label | Meaning | Behaviour on retake |
|-------|---------|---------------------|
| `high` | Two independent authoritative sources confirm the same answer. | Keep on retake unless the score-level evidence (wrong on a passed attempt) contradicts. |
| `med` | One strong source, or strong reasoning from multiple weaker hits. | Re-research first on retake; try an untried option only if new evidence supports it. |
| `low` | Best guess; limited or conflicting sources. | Rotate to the next most plausible untried option on retake. |
