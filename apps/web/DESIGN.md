# Inherited Vitriol design

Authority: `src/app/globals.css`, `src/components/app-shell.tsx`, Operations and
GuidedRunner. This is an Operate-mode responsive extension, not a redesign.

- Keep Vitriol identity, dark slate navigation, pale blue-gray canvas, white
  panels, slate text and cyan emphasis. Existing tokens include background
  `#eef2f3`, foreground `#0f172a`, line `#d8e0e3`, accent `#0e7490` and bright
  accent `#22d3ee`.
- Retain the Plex sans / JetBrains mono typography system, rounded panels,
  restrained borders and semantic amber/rose/emerald states.
- Preserve desktop layout and zoom. Adapt content flow with responsive grids,
  wrapping actions and `min-width: 0`; never change browser/device metrics.
- Primary touch actions have at least 44px targets. Forms use visible labels,
  keyboard focus indicators, semantic controls and readable mobile input sizes.
- Keep current task, primary action and assistant question together. Task/View
  Browser is a local surface switch, not synchronized navigation.
- Show view-only, stopping, manual-control, disconnected, expired and uncertain
  input states explicitly. Never present a queued cancellation as actual idle,
  or an accepted relay command as proof that an action was applied.
- The browser image retains its intrinsic aspect ratio. Coordinate conversion
  maps image taps to the existing browser's CSS pixels; offline image scaling
  must not alter the source viewport.
