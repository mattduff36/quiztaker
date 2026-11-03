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

Integration requires quiz-learn capability4 in the helper and both capability
registries. Install the combined helper21 release and verify it advertises
capability4 before resuming a run. Capability3 plans cannot authorize the new
tool contract. Older optional snapshot fields remain backward-compatible.
