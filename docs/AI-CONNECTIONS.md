# AI connections

Settings → Hosted AI lets each signed-in user choose OpenAI, Gemini or OpenRouter,
enter a chat-completions-compatible model and API key, and test before saving.
The small synthetic test must return a valid learner action. A failed test leaves
the previous connection intact. API access and credit are separate from chat-app
subscriptions. The hosted selector supports the three providers above.

During learning, the selected provider receives the current page text and answer
controls. Connections are scoped to the authenticated user; credentials are
encrypted with AES-256-GCM and bound to the user and provider. Responses never
include the saved key. Fixed HTTPS endpoints reject redirects. Tests have a
persistent 30-second per-user cooldown, a 15-second timeout and bounded output.
Disconnect clears the stored secret and prevents fallback to deployment credentials,
including when an earlier connection test is still running.

## Deployment

1. Apply migration `0006_llm_connections.sql` with `npm run db:migrate` before
   deploying the new web application.
2. Set `LLM_CREDENTIAL_KEY` to a dedicated random 32-byte key encoded as base64 in
   every environment using these tables. Keep this key stable and back it up
   securely. Losing or changing it requires users to reconnect their providers.
3. Deploy and verify Settings and Operations while authenticated.

Existing `LEARNER_API_KEY` configuration remains the default until a user saves or
disconnects a personal connection. Settings explicitly identifies this inherited
configuration as untested by the connection flow. Public registration remains
subject to the existing account access policy.

Connecting a model does not teach it permanently or guarantee assessment success.
Vitriol still needs a supported page interaction path and observed feedback. The
Canon Cornerstone curriculum page is recognized as a launch page; capture the
actual assessment before adding or claiming support for its question types.
## Co-ordinate with a Codex chat

1. Use a Codex chat attached to this repository on the Windows PC that runs
   Vitriol Helper. In that chat, run `node scripts/vitriol-coordinate.mjs connect`
   to give the chat a four-hour connection to the helper.
2. In Operations, select the course tab and choose **Co-ordinate with ChatGPT**.
   The helper asks the connected chat at the start and when it needs guidance.
   Ordinary course actions continue through the existing learner. This requires
   Vitriol Helper v1.0.32 or later.
3. The chat reads requests with `node scripts/vitriol-coordinate.mjs pending`
   and pipes one JSON action to `node scripts/vitriol-coordinate.mjs reply <id>`.
   For example, `{"action":"click","targetId":"b3"}` is valid only when that
   target was offered for the current page. Keep the chat active to process
   requests. The helper validates each reply before it can drive the browser.
4. Verify each module against visible results and the course roster. Record
   recoverable browser issues for one batch at a safe checkpoint. Pause for
   sign-in or when the current page offers no safe way forward.

Run `node scripts/vitriol-coordinate.mjs disconnect` from the paired chat
when the session ends. Coordination requests stay on the local PC and expire
after a short wait.
