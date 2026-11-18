# Learner browser tools

The signed run mode and observed-target policy still govern every action. Tools
operate only on the selected page and its observed frames; they do not accept
scripts, selectors, navigation URLs or browser credentials.

- `answer-select` uses observed choice IDs. Snapshots expose `checked` only when
  the DOM provides an explicit native/ARIA state. Already-selected answers are
  rejected. Quiz-mode Next on a visible “Question N of M” page requires an
  answer when every observed radio explicitly reports unchecked. Legacy unknown
  states and course-reading navigation keep their prior behavior.
- `scroll` accepts optional `direction: "up" | "down"`, defaulting to down.
- `find-text` accepts a literal nonempty `text` of at most160 characters and
  scrolls an existing rendered, front-facing match into view. Missing text is
  reported in the next observation; it does not fail the job or execute text.
- `capture` requests one viewport JPEG (quality55, CSS pixel scale, at most
  900,000 data-URL characters). It appears as optional `snapshot.image` on the
  next proposal only. Authentication pages, visible password/sensitive forms,
  unreadable safety checks, oversized images or capture failures return text
  feedback instead. Images alone do not affect stale-target revalidation.
- `snapshot.outlines` inventories up to four canonical source documents, each
  with at most60 distinct headings of at most160 characters. Hidden authoring
  headings are inventory, **not evidence of reading**. Concrete content documents
  are preferred over generic LMS wrappers; assessment/question pages are
  excluded. Actual course excerpts remain separate in `snapshot.text`.

The existing 40-control output and 120-candidate scan limits remain. The helper
waits up to120 seconds for a proposal to allow bounded server-side research.
These behaviors have offline fixture coverage; no live course pass is implied.

Direct Saba Storyline wrappers with one observed activity can finalize an
observed terminal lesson through Close module, Close Player and a scoped,
ordinary course-exit confirmation. The local finalizer reads and commits only
completion already recorded by the course; it never writes status or scores.
A Thank You slide is not proof of success: the same activity must show
Completed Successfully, followed by the same course's Successful enrollment
or its unique enabled certificate action on the originating certification.
Missing/ambiguous identities, unsafe confirmations and unverified results stop
with an incomplete outcome. No unrelated or landing tab is closed.

For non-question Storyline Next/Previous navigation, local slide semantics and
the exact control model identity survive presentation-only animation and
control-ID shifts. Changed slides, content, questions, choices, selections or
dialogs still invalidate a pending decision. This does not relax answer or
submission guards.

Container activity activation uses the exact full observed title attribute,
not a substring of truncated visible text, and refuses ambiguous matches.
Partial runs include structured failure reasons and exit nonzero; activity
completion alone is not proof that the parent course succeeded.

Operations shows **Working** when a fresh helper heartbeat identifies its
running learner job and the last browser check was connected but is now old.
This is not a fresh connection claim. Idle stale checks remain **Check overdue**;
an explicitly disconnected browser or stale helper is never reported Working.

Question-bound matching requires quiz-learn capability6 in the helper and both
capability registries. Deploy the corresponding web and helper builds together;
older signed plans cannot authorize the current matching contract. Optional
snapshot fields remain backward-compatible.
