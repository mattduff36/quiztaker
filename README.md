# QuizTaker

QuizTaker is a split control-plane/local-helper application for Saba learning
automation.

- `apps/web`: authenticated Next.js control plane for Vercel.
- `apps/helper`: interactive Windows helper, outbound polling, DPAPI credentials,
  executor validation, packaging.
- `packages/core`: shared capability, plan, signing, outcome, and diagnosis
  contracts.
- `packages/automation`: local Playwright automation package boundary.
- `database/migrations`: Neon Postgres, RLS, and transactional job ledger.
- Root `server.js`, `public/`, and `pw-*.js`: compatible legacy dashboard and
  automation executors retained during hosted cutover.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Copy `.env.example` to `.env.local`, provide Neon credentials, enable Managed
Auth, and connect a private Vercel Blob store. Apply migrations with
`npm run db:migrate`. Start the hosted app with `npm run dev:web` and the
helper with `npm run dev:helper`.

The legacy local dashboard remains available through `npm start`.

See `docs/DEPLOYMENT.md` for Neon/Vercel configuration, release packaging,
backup, helper recovery, privacy boundaries, and the future LLM integration
point.
