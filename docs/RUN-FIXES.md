# Current Canon run: fixes to batch

Owner direction, 3 November 2026: use manual workarounds for small UI defects,
keep the course moving, and batch fixes. Stop for code only when a workaround
cannot get past the blocker. New feature ideas still need the owner's decision.

## Ready for the next batch

- **DKI rollover information icons:** hovering replaces the original image and
  intercepts normal clicks. The focused fix treats the visible base/rollover
  pair as one observed control. Implemented and locally applied for this run;
  focused base, already-hovered and hidden-target tests pass. Release pending.
- **WebForms regression timing:** wait for the actual postback result in the
  browser fixture rather than reading its label immediately after clicking.
  This fixes the timing failure in the v1.0.20 CI/release checks. Focused test
  passes; release pending with the rollover fix.

## Workaround in use; cause still needs investigation

- **Selected answers missing from snapshots:** Vitriol correctly selected the
  first assessment answer, but repeated the selection because radio/checkbox
  state is absent from the snapshot. Manual Next advanced to question 2. Add
  observed checked state through the helper/server contract in the batch;
  current guidance says select once per question, then Next.
- **Paused question not visible after navigation:** the run showed "Your input
  is needed" without displaying its question after moving from the lesson to
  the assessment. The saved event contained the repeated-action question.
  Investigate question scope/display together; manual navigation and a fresh
  goal on the actual assessment let the run continue.

- **Packaged Node child crashes:** repeated browser-refresh jobs exited with
  Windows status `0xC0000409` (`3221226505`, signed `-1073740791`). The same
  helper with `QUIZTAKER_NODE_PATH` pointing to the existing system Node
  completed a refresh successfully on 3 November at 19:47 London time.
  Keep the existing browser launcher and course tabs. Do not infer the cause
  from the status alone or change Windows security settings. Investigate the
  packaged runtime/child environment before choosing a permanent fix.
  Both Node executables are version 22.18.0, byte-identical, validly signed,
  and passed minimal probes. No matching Application crash/WER evidence was
  found. Restart and executable path changed together, so a binary defect is
  not established.

## Already addressed

- Canon assessment Next/Summary/Save use standard ASP.NET button postbacks.
  Their narrowly parsed navigation is now offered in Quiz mode. The runtime
  change is locally applied; v1.0.20 source is committed.
- Oversized Windows exit codes are normalized on ingestion while retaining raw
  evidence; reporting failures use the helper outbox. Website fix is live.

Local runtime patches are temporary: do not install an older helper release
over them during an active assessment. Publish a combined release and verify
the installed version at a natural pause.
