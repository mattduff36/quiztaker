import { queryRows, type SqlQuery } from '@/lib/db';
import { DEFAULT_LEARNER_INSTRUCTIONS, LEARNER_INSTRUCTIONS_MAX } from '@/lib/learner';

export type LearnerInstructionsRecord = {
  instructions: string;
  updatedAt: string | null;
  isDefault: boolean;
};

export type LearnerPreferencesDeps = {
  query: SqlQuery;
};

export const learnerPreferencesSql = {
  read: `select instructions, updated_at
     from learner_preferences
     where user_id = $1`,
  save: `insert into learner_preferences (user_id, instructions, updated_at)
     values ($1, $2, now())
     on conflict (user_id) do update set
       instructions = excluded.instructions,
       updated_at = now()
     where learner_preferences.user_id = $1
     returning instructions, updated_at`,
  reset: `delete from learner_preferences
     where user_id = $1
     returning user_id`,
} as const;

export function validateLearnerInstructions(
  value: unknown,
): { ok: true; instructions: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'Learner instructions must be text' };
  const instructions = value.trim();
  if (!instructions) return { ok: false, error: 'Learner instructions are empty' };
  if (instructions.length > LEARNER_INSTRUCTIONS_MAX) {
    return { ok: false, error: 'Learner instructions are too long' };
  }
  return { ok: true, instructions };
}

export async function readLearnerInstructions(
  userId: string,
  deps?: LearnerPreferencesDeps,
): Promise<LearnerInstructionsRecord> {
  const found = await runQuery<{ instructions: string; updated_at: string | Date }>(
    learnerPreferencesSql.read,
    [userId],
    deps,
  );
  const row = found[0];
  if (!row) return defaultRecord();
  const validated = validateLearnerInstructions(row.instructions);
  if (!validated.ok) return defaultRecord();
  return {
    instructions: validated.instructions,
    updatedAt: stamp(row.updated_at),
    isDefault: false,
  };
}

export async function saveLearnerInstructions(
  userId: string,
  value: unknown,
  deps?: LearnerPreferencesDeps,
): Promise<{ ok: true; record: LearnerInstructionsRecord } | { ok: false; error: string }> {
  const validated = validateLearnerInstructions(value);
  if (!validated.ok) return validated;
  const saved = await runQuery<{ instructions: string; updated_at: string | Date }>(
    learnerPreferencesSql.save,
    [userId, validated.instructions],
    deps,
  );
  const row = saved[0];
  if (!row) return { ok: false, error: 'Could not save learner instructions' };
  return {
    ok: true,
    record: {
      instructions: validated.instructions,
      updatedAt: stamp(row.updated_at),
      isDefault: false,
    },
  };
}

export async function resetLearnerInstructions(
  userId: string,
  deps?: LearnerPreferencesDeps,
): Promise<LearnerInstructionsRecord> {
  await runQuery(learnerPreferencesSql.reset, [userId], deps);
  return defaultRecord();
}

function defaultRecord(): LearnerInstructionsRecord {
  return {
    instructions: DEFAULT_LEARNER_INSTRUCTIONS,
    updatedAt: null,
    isDefault: true,
  };
}

function stamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

async function runQuery<T>(sql: string, values: unknown[], deps?: LearnerPreferencesDeps): Promise<T[]> {
  const query = deps?.query ?? queryRows;
  return query<T>(sql, values);
}
