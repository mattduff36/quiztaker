import { redirect } from 'next/navigation';
import { getServerEnv } from '@/lib/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  const email = data.user?.email?.toLowerCase();
  if (error || !data.user || !email) return null;
  if (email !== getServerEnv().ALLOWED_EMAIL.toLowerCase()) return null;
  return { id: data.user.id, email };
}

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  return user;
}
