# Current fixes and known limitations

Updated 3 November 2026 for helper 1.0.22. Full findings and validation are in
[AUDIT-2026-11-03.md](AUDIT-2026-11-03.md).

## Canon task

Canon displayed **Passed:75% (15/20), threshold70%**. The operator marked the
finished task complete, with that visible result recorded as operator evidence.
The browser tabs, course material and conversation were preserved. The session
was paused. Do not start another attempt to repair an internal status.

The owner requires normal-user operation of courses: use the visible interface
and let Vitriol use its own learning/research. Do not supply answers extracted
from internal logs or otherwise inaccessible data.

## Addressed

- DKI rollover controls, WebForms postbacks and observed checked answers.
- Canon result tables (including a learner-name suffix), pass/fail and real
  scores; terminal results finish immediately without automatic retakes.
- Missing paused questions, 1,000-character goal limit and stale goal reset.
- Competing refresh/polling loops, background-job output replacement, stale
  pause responses and incorrect CTA states.
- Direct operator Complete/Failed controls, independent browser-session ending,
  persistent outcome/history and protection against late actions/events.
- Terminal outbox replay before idle heartbeats/update installation; one helper
  instance per state folder, with OS-owned crash recovery.
- Mobile sign-out, pairing without redundant download, expired codes and
  action-error feedback, private artifact links and misleading capture copy.
- Obsolete Cursor adapter, unsupported legacy learner advertising, duplicate
  scripts and process-kill utility removed or disabled as appropriate.

## Historical Windows child crash: cause unproven

Earlier child processes exited with `0xC0000409` (`3221226505`). Restarting the
helper with system Node allowed refresh to succeed, but both Node binaries
were byte-identical and validly signed. Duplicate helpers and lifecycle races
are now guarded. Do not claim a defective bundled binary or disable Windows
security. If this native status recurs, preserve the exact spawn/environment
and crash evidence before selecting a fix. No broad browser/process killing.
