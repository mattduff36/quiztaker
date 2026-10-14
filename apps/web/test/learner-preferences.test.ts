import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqlQuery } from '../src/lib/db.js';
import {
  DEFAULT_LEARNER_INSTRUCTIONS,
  LEARNER_CONTEXT_CHARS,
  LEARNER_INSTRUCTIONS_MAX,
  STANDING_INSTRUCTIONS_LABEL,
  requestLearnerDecision,
  withStandingInstructions,
} from '../src/lib/learner.js';
import {
  learnerPreferencesSql,
  readLearnerInstructions,
  resetLearnerInstructions,
  saveLearnerInstructions,
  validateLearnerInstructions,
  type LearnerPreferencesDeps,
} from '../src/lib/learner-preferences.js';

const userA = 'user-a';
const userB = 'user-b';

interface PreferenceRow {
  user_id: string;
  instructions: string;
  updated_at: string;
}

function createHarness(): LearnerPreferencesDeps & { rows: PreferenceRow[] } {
  const rows: PreferenceRow[] = [];
  let tick = 0;
  const query: SqlQuery = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => {
    const userId = String(values[0]);
    if (sql === learnerPreferencesSql.read) {
      return rows.filter((row) => row.user_id === userId).map(clone) as T[];
    }
    if (sql === learnerPreferencesSql.save) {
      const instructions = String(values[1]);
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick += 1)).toISOString();
      const existing = rows.find((row) => row.user_id === userId);
      if (existing) {
        existing.instructions = instructions;
        existing.updated_at = at;
        return [clone(existing)] as T[];
      }
      const row = { user_id: userId, instructions, updated_at: at };
      rows.push(row);
      return [clone(row)] as T[];
    }
    if (sql === learnerPreferencesSql.reset) {
      const index = rows.findIndex((row) => row.user_id === userId);
      if (index < 0) return [];
      const [removed] = rows.splice(index, 1);
      return [{ user_id: removed.user_id }] as T[];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return { query, rows };
}

function clone(row: PreferenceRow): PreferenceRow {
  return { ...row };
}

test('learner instruction validation trims and enforces the 2000 character bound', () => {
  assert.equal(DEFAULT_LEARNER_INSTRUCTIONS.length <= LEARNER_INSTRUCTIONS_MAX, true);
  assert.deepEqual(validateLearnerInstructions('  Collect the transcript.  '), {
    ok: true,
    instructions: 'Collect the transcript.',
  });
  assert.deepEqual(validateLearnerInstructions('   '), { ok: false, error: 'Learner instructions are empty' });
  assert.deepEqual(validateLearnerInstructions('x'.repeat(LEARNER_INSTRUCTIONS_MAX)), {
    ok: true,
    instructions: 'x'.repeat(LEARNER_INSTRUCTIONS_MAX),
  });
  assert.equal(validateLearnerInstructions('x'.repeat(LEARNER_INSTRUCTIONS_MAX + 1)).ok, false);
  assert.equal(validateLearnerInstructions({ instructions: 'nope' }).ok, false);
});

test('saved learner instructions stay bound to the owner', async () => {
  const harness = createHarness();
  assert.match(learnerPreferencesSql.read, /where user_id = \$1/);
  assert.match(learnerPreferencesSql.save, /where learner_preferences\.user_id = \$1/);
  assert.match(learnerPreferencesSql.reset, /where user_id = \$1/);

  const saved = await saveLearnerInstructions(userA, '  Alpha notes  ', harness);
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.record.instructions, 'Alpha notes');
  assert.equal(saved.record.isDefault, false);

  const other = await saveLearnerInstructions(userB, 'Beta notes', harness);
  assert.equal(other.ok, true);

  const alpha = await readLearnerInstructions(userA, harness);
  const beta = await readLearnerInstructions(userB, harness);
  const missing = await readLearnerInstructions('user-c', harness);
  assert.equal(alpha.instructions, 'Alpha notes');
  assert.equal(beta.instructions, 'Beta notes');
  assert.equal(missing.isDefault, true);
  assert.equal(missing.instructions, DEFAULT_LEARNER_INSTRUCTIONS);

  const reset = await resetLearnerInstructions(userA, harness);
  assert.equal(reset.isDefault, true);
  assert.equal((await readLearnerInstructions(userB, harness)).instructions, 'Beta notes');
  assert.equal(harness.rows.some((row) => row.user_id === userA), false);
});

test('standing instructions stay separate while the current page and guidance persist', () => {
  const page = 'Visible overview and transcript.';
  const guidance = 'Finish module 2 before the assessment.';
  const instructions = 'Collect the transcript first.';
  const result = withStandingInstructions({
    text: page,
    guidance,
    title: 'Course',
  }, `  ${instructions}  `);
  const marker = `${STANDING_INSTRUCTIONS_LABEL}:\n`;
  const text = result.text ?? '';
  const at = text.indexOf(marker);
  assert.ok(at > page.length);
  assert.equal(text.slice(0, at).trimEnd(), page);
  assert.equal(text.slice(at + marker.length), instructions);
  assert.equal(text.includes(page + instructions), false);
  assert.equal(result.guidance, guidance);
  assert.ok(text.length <= LEARNER_CONTEXT_CHARS);

  const full = 'P'.repeat(LEARNER_CONTEXT_CHARS);
  const flat = withStandingInstructions({ text: full, guidance }, instructions);
  const flatText = flat.text ?? '';
  assert.equal(flatText.startsWith('P'.repeat(8_000)), true);
  assert.equal(flatText.includes('P'.repeat(8_001)), false);
  assert.equal(flatText.includes(`${marker}${instructions}`), true);
  assert.ok(flatText.length <= LEARNER_CONTEXT_CHARS);
  assert.equal(flat.guidance, guidance);

  const currentPage = 'C'.repeat(8_000);
  const goal = 'Operator goal: Finish module 2.';
  const dialogue = 'Prior conversation:\nuser: continue here';
  const material = `Retained course material:\n${'M'.repeat(20_000)}`;
  const crowded = withStandingInstructions({
    text: [currentPage, goal, dialogue, material].join('\n\n'),
    guidance,
  }, instructions);
  const crowdedText = crowded.text ?? '';
  assert.equal(crowdedText.startsWith(currentPage), true);
  assert.equal(crowdedText.includes(goal), true);
  assert.equal(crowdedText.includes(dialogue), true);
  assert.equal(crowdedText.includes(`${marker}${instructions}`), true);
  assert.equal(crowdedText.endsWith(instructions), true);
  assert.equal(crowdedText.includes('M'.repeat(20_000)), false);
  assert.ok(crowdedText.length <= LEARNER_CONTEXT_CHARS);
  assert.equal(crowded.guidance, guidance);
});

test('unsupported actions offer a plain control choice instead of a technical id', async () => {
  const result = await requestLearnerDecision({
    apiKey: 'test-key',
    snapshot: {
      buttons: [
        { id: 'b1', name: 'Course interaction: 3_100_click1' },
        { id: 'b2', name: 'Next' },
        { id: 'b3', name: 'Home' },
      ],
    },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"click","targetId":"b9"}' } }],
    })),
  });
  assert.deepEqual(result.action, {
    action: 'ask-user',
    question: 'I need a safe control on this page. Which of these should I use?',
    options: ['Next', 'Home', 'Ask me to identify the control'],
  });
});
