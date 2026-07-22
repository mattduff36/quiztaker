# QuizTaker control plane

Next.js App Router application deployed from the `apps/web` Vercel project
root. It uses Neon Managed Auth, Neon Postgres, and private Vercel Blob storage.

Required environment variables are documented in the repository
`.env.example`. Apply `database/migrations/` before starting this app.

```bash
npm run dev --workspace=@quiztaker/web
```
