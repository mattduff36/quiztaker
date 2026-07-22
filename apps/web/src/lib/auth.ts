import { redirect } from 'next/navigation';
import { getServerEnv } from '@/lib/env';
import { queryRows } from '@/lib/db';
import { getAuth } from '@/lib/neon-auth/server';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const { data: session, error } = await getAuth().getSession();
  const email = session?.user?.email?.toLowerCase();
  if (error || !session?.user?.id || !email) return null;
  if (email !== getServerEnv().ALLOWED_EMAIL.toLowerCase()) return null;
  const id = String(session.user.id);
  await queryRows(
    `insert into profiles (id, email)
     values ($1, $2)
     on conflict (id) do update set email = excluded.email`,
    [id, email],
  );
  return { id, email };
}

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  return user;
}
