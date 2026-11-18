# Vitriol Operations

Vitriol is the existing authenticated course-automation control plane and Windows
helper. This release extends Operations to mobile; it is not a rebrand or a new
learning product.

## Confirmed product decisions

- The same signed-in account on desktop and mobile shares the selected course,
  goal, activity, assistant question, reply and guidance drafts. Jobs/results
  remain authoritative on the server. Routes, page scrolling and site navigation
  stay independent.
- Remote browser access works whenever the paired Windows helper is connected;
  desktop Operations need not be open.
- Task and View Browser are two surfaces of the same Operations page. Switching
  surfaces must not stop an acknowledged task or discard a draft.
- View Browser shows the existing desktop Vitriol CDP browser, with its existing
  cookies, tabs and login. It does not launch a second session. The owner can
  manually sign in using encrypted remote input.
- Remote viewing is read-only during automation. Take control requests the normal
  pause/cancellation flow, waits for the actual helper to be idle, and reserves a
  single bounded controller lease. Releasing control does not resume automation.
- Touch controls provide tab selection, tap, scroll, text/paste and common keys.
  Browser geometry, desktop layout, zoom and window placement remain unchanged.
  No native Computer Use or public CDP service is involved.
- Course new-window instructions on selected HTTPS pages, their frames and actual
  children become same-window tabs. This is placement normalization, not
  permission to follow arbitrary content, answer an assessment or bypass a
  security warning. Named iframe and same-document targeting remain intact.

## Privacy and limits

Ephemeral P-256 ECDH and AES-GCM encrypt remote images and input between viewer
and helper. Private keys live only in endpoint memory. Relay storage contains
public keys, bounded ciphertext and expiry/control metadata, not login plaintext.
Only the latest image and one unconsumed command are retained per viewer.
Drafts are normal account-owned Operations data: never put login secrets in them.

The first release polls rather than streaming video. Input is best-effort
at-most-once: a lost acknowledgement never causes automatic re-execution.
Reconnect and inspect before deliberately retrying an uncertain action.
Remote access cannot unlock Windows, approve browser security dialogs or recover
a disconnected helper. Closing/hiding the viewer releases control or lets its
15-second lease expire. Client-orchestrated task preparation requires that
initiating Operations page to remain open; an acknowledged helper job continues
independently. The owner-paused Electro/Mechanical assessment is not part of
implementation verification.

## Mobile running view (1.0.48)

- Acknowledged work focuses on current activity, Stop and expandable steering.
  Course/goal, task administration, recent descriptive helper output, remembered
  conversation and coverage remain available without dominating the running view.
- All four service indicators fit in one row on a narrow phone. Full state and
  recovery details remain in accessible labels and the desktop presentation.
- Visible Operations reconciles shared pause/task state within a few seconds;
  successful server snapshots clear transient protection warnings. Retry checks
  connectivity and never silently resumes automation.
- Back, Forward and Refresh require the same exclusive manual-control lease as
  other browser inputs. They operate the selected desktop tab without changing
  window geometry or zoom.
- Float preview keeps a read-only browser image alongside Task. System pop-out
  uses a locally generated video of the decrypted preview where supported; it
  is not a separate capture service or recording. iPhone/background restrictions
  can suspend updates. Hidden previews explicitly show Paused; they release
  manual control rather than retaining authority in another app. Always inspect
  a fresh image after returning. Native iPhone acceptance remains device testing.
