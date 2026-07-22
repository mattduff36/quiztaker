# Hosted deployment and helper operations

## Control plane

1. Create a Supabase project and apply every SQL file in
   `supabase/migrations/` in filename order.
2. In Supabase Authentication, enable email magic links and set the Site URL
   and redirect URL to the Vercel deployment.
3. Create a Vercel project with `apps/web` as its Root Directory.
4. Add the variables shown in `.env.example`. Generate `HELPER_MASTER_KEY`
   with at least 32 cryptographically random characters. Never expose either
   server key through a `NEXT_PUBLIC_` variable.
5. Protect the first preview with Vercel Deployment Protection. Verify sign-in,
   pairing, a read-only tab-list job, explicit mutating confirmation,
   cancellation, and signed artifact access before promoting to production.

The single-user release rejects every authenticated email except
`ALLOWED_EMAIL`. The service-role key is used only in server route handlers.
All user-owned tables have RLS enabled.

## Backups and restore

- Enable Supabase point-in-time recovery if the project plan supports it.
- Export `history_events`, `attempt_events`, `strategies`, and `review_items`
  before destructive migrations.
- Keep the private `private-artifacts` bucket under the same retention and
  backup policy as the database.
- Local JSONL remains an offline cache/export, not the hosted authority.

## Helper recovery and migration

Mutable helper state lives under `%LOCALAPPDATA%\QuizTaker Helper\`. MSI
upgrade/uninstall must not delete this directory.

To import an older project data folder:

```powershell
& "Start QuizTaker Helper.cmd" --import-data="C:\path\to\old-project\data"
```

To recover pairing, revoke the old helper in Settings, delete or rename
`%LOCALAPPDATA%\QuizTaker Helper\config.json`, start the helper with `--pair`,
and enter a new one-time code.

## Release procedure

Push a `vX.Y.Z` tag or run the **Windows helper release** GitHub workflow with
a version. The Windows runner:

1. verifies tests and audit status;
2. downloads the pinned official Node.js x64 ZIP and checks it against
   Node's published `SHASUMS256.txt`;
3. builds a per-user WiX MSI;
4. packages the MSI, instructions, and checksums in
   `quiztaker-helper-windows-x64-vX.Y.Z.zip`;
5. emits a CycloneDX SBOM and `release.json`;
6. attaches all release files to a GitHub Release.

The v1 package is unsigned and may trigger SmartScreen or Defender warnings.
The packaging script contains dormant Authenticode hooks
(`SIGN_CERTIFICATE_PATH`, `SIGN_CERTIFICATE_PASSWORD`, and
`SIGN_TIMESTAMP_URL`) for a future publisher certificate.

## Privacy boundary

- Chrome, CDP port 9222, SSO cookies, and the persistent Chrome profile remain
  local.
- The helper exposes no inbound listener and polls the control plane over
  outbound HTTPS.
- The control plane stores immutable confirmed plans, job/event metadata,
  normalized history/learning data, and private artifacts.
- Device secrets are derived from a Vercel-only master key and protected on
  Windows with current-user DPAPI.

## Future LLM insertion point

An LLM may propose a `PlanProposal` only. It must not create signed jobs or
call helper endpoints directly. Proposed capabilities, arguments, risk,
targets, evidence, constraints, and verifier pass through the same capability
registry, explicit confirmation, `authorizeRun()`, immutable job signing, local
whitelist validation, and post-run verification pipeline used today.
