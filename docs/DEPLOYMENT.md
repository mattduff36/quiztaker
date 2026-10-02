# Hosted deployment and helper operations

## Control plane

1. Create a dedicated Neon project. Enable Neon Managed Auth with email and
   password authentication, then configure the production and preview origins.
2. Copy `.env.example` to `.env.local`. Set `DATABASE_URL`,
   `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`,
   `ALLOWED_EMAIL`, and `HELPER_MASTER_KEY`.
3. Apply `database/migrations/` with `npm run db:migrate`, then verify the
   schema and transactional protocol with `npm run test:db`.
4. Create a Vercel project for the repository. `vercel.json` builds
   `apps/web`. Connect the Neon integration and a private Vercel Blob store.
5. Add the server variables in Vercel. Set `NEXT_PUBLIC_SITE_URL` to
   `https://vitriol.co.uk`. Keep cookie, master-key, database, and Blob
   credentials server-only.
6. Protect previews. The legacy Express dashboard has no authentication and
   must remain local-only during parity validation.

`ALLOWED_EMAIL` is checked server-side after Neon Auth resolves a session.
Database access is made only by authenticated server routes. Postgres RLS is
enabled as a defense-in-depth, deny-by-default boundary.

## Local development

From the repository root, `npm run dev` starts `apps/web`, the same Next.js
application deployed to Vercel. `npm run dev:web` is an explicit alias. The
legacy unauthenticated Express dashboard is retained under
`npm run dev:legacy` (watch mode, port 4000) and `npm run start:legacy`
(port 3000); it is not the production site.

Pairing codes are bound to the control-plane origin that generated them. The
MSI registers the per-user `vitriol-helper://` protocol, and the Local helper
page uses it for a **Launch Vitriol Helper** button that carries the one-time
code and the correct local or production origin. The helper accepts protocol
launches only for localhost or the Vitriol production domains. The Start menu
shortcut remains available for normal launches and defaults to production.
After its first accepted heartbeat, the helper confirms that it is online and
minimizes its terminal window. Pass `--no-minimize` (or set
`QUIZTAKER_NO_AUTO_MINIMIZE=1`) when diagnosing it interactively.

## Private artifacts

Connect a private Vercel Blob store. Helpers upload through an authenticated
device route. Browser downloads use `/api/artifacts/:id/url`, which rechecks
record ownership and streams the private object without exposing storage
credentials.

## Validation and cutover

Run `npm ci`, `npm audit --audit-level=high`, `npm test`, `npm run typecheck`,
`npm run build`, and `npm run test:db`. Deploy a protected preview before
production. In the preview:

1. Sign in with the allowed email and confirm another account is rejected.
2. Pair one helper and confirm a second claim of the same code fails.
3. Run List tabs, Detect page, and one confirmed mutating job.
4. Confirm replay rejection, event idempotency, cancellation, offline recovery,
   private artifact access, and migrated history/learning parity.
5. Only remove `server.js` and `public/` after hosted parity is verified. They
   intentionally remain available for rollback today.

## Backups and restore

- Use Neon point-in-time restore and retain scheduled encrypted `pg_dump`
  exports outside the project.
- Configure Vercel Blob retention separately; database backups do not include
  Blob objects.
- After restoring, rotate `HELPER_MASTER_KEY`, revoke existing helpers, and
  pair again. A restored database must not trust old device secrets silently.
- Local JSONL remains an offline cache/export, not the hosted authority.

## Helper recovery and migration

For compatibility, Vitriol Helper keeps mutable state under the legacy
`%LOCALAPPDATA%\QuizTaker Helper\` path. MSI upgrades and uninstall must not
delete this directory.

Import an older project data folder:

```powershell
& "Start Vitriol Helper.cmd" --import-data="C:\path\to\old-project\data"
```

To recover pairing, revoke the old helper in Settings, delete or rename
`%LOCALAPPDATA%\QuizTaker Helper\config.json`, start the helper with `--pair`,
and enter a new one-time code.

## Release procedure

Push a `vX.Y.Z` tag or run the **Windows helper release** GitHub workflow with
a version. The Windows runner verifies tests and audit status, checks the
pinned Node.js runtime against Node's published SHA-256 list, builds a per-user
Vitriol Helper WiX MSI, packages the MSI and instructions in
`vitriol-helper-windows-x64-vX.Y.Z.zip`, emits checksums and a CycloneDX SBOM,
and attaches the ZIP, the MSI, checksums, and the SBOM to a GitHub Release.
The Operations page shows **Update helper** when the paired helper is still on
protocol 1 or behind that release. Helpers from v1.0.5 download the release,
check its SHA-256, install the per-user MSI, and restart. Older helpers cannot
apply an update themselves; the same button downloads the MSI, or the ZIP when
a release has no separate installer. Pairing data under
`%LOCALAPPDATA%\QuizTaker Helper\` is kept. Before announcing the release,
confirm the authenticated Download page shows the version and checksum, then
install, pair, heartbeat, and poll one job from a Windows 10/11 x64 session.

The v1 package is unsigned and may trigger SmartScreen or Defender warnings.
The packaging script includes dormant Authenticode hooks for a future publisher
certificate.

## Hosted parity rollout

Apply `database/migrations/0003_hosted_parity.sql` with `npm run db:migrate` before
enabling new Operations actions. The migration is additive. Do not drop the new
tables to roll back.

- Protocol 1 helpers keep the original cards: start browser, list tabs,
  certification status, certification batch, dry-run, SCORM, container, and
  learning capture.
- Protocol 2 helpers advertise supported capability versions and unlock
  detection, class batch, SlickQuiz, tab fit/inspect, CDP check, open URL, and
  browser close.
- Set `PARITY_NEW_ACTIONS=0` to stop creating plans for those new actions while
  leaving existing rows readable. Legacy cards stay available.
- Browser targets expire when the helper rotates the CDP session or the tab
  fingerprint changes. The control plane rejects a stale target instead of
  guessing a tab index. Refresh tabs and detect again.
- Open URL accepts any HTTP or HTTPS address only after confirmation. Vitriol
  does not fetch the address. Stored recent URLs drop userinfo, fragments, and
  query keys that look like tokens, secrets, passwords, codes, sessions, or
  credentials. Use Forget to hide a recent URL.
- End Session moves `open → ending → ended`. If the browser close cannot be
  queued, the row stays `close_failed` and can be retried with a new
  idempotency key. A running course-state job blocks browser close unless the
  caller explicitly sets `forceClose`.
- Postgres is the authority for strategy evidence. Helpers upload observations
  and replace their local `strategies.json` from `GET /api/helper/strategies`.
  They do not merge counters back into Postgres.
- Import existing local history with `npm run import:legacy -- --dry`, then run
  it again with `IMPORT_USER_ID` set to the signed-in profile id. Repeating the
  import does not duplicate rows.
- `server.js` and `public/` stay in service until a protected preview and
  production both pass the parity checklist and cutover is explicitly approved.

## Privacy boundary

- Chrome, CDP, SSO cookies, and the persistent Chrome profile stay local.
- The helper exposes no inbound listener and polls over outbound HTTPS.
- The control plane stores confirmed plans, job metadata, normalized
  history/learning records, and explicitly uploaded private artifacts.
- Device secrets are derived from a server-only master key and protected with
  current-user Windows DPAPI.

## Future LLM insertion point

An LLM may propose a `PlanProposal` only. It cannot create signed jobs or call
helper endpoints. Every proposal still passes capability authorization,
explicit confirmation, immutable signing, local whitelist validation, and
post-run verification.
