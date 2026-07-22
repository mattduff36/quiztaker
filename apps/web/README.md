# QuizTaker control plane

Next.js App Router application deployed from the `apps/web` Vercel project
root. It uses Supabase Auth, Postgres, and private Storage.

Required environment variables are documented in the repository
`.env.example`. Apply `supabase/migrations/` before starting this app.

```bash
npm run dev --workspace=@quiztaker/web
```
