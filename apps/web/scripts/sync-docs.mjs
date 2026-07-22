import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(webRoot, '..', '..');
const contentRoot = resolve(webRoot, 'content');
await mkdir(contentRoot, { recursive: true });
for (const [source, destination] of [
  ['AGENTS.md', 'AGENTS.md'],
  ['docs/QUIZ-TYPES.md', 'QUIZ-TYPES.md'],
  ['docs/RUNBOOK.md', 'RUNBOOK.md'],
  ['docs/DEPLOYMENT.md', 'DEPLOYMENT.md'],
]) await cp(resolve(repositoryRoot, source), resolve(contentRoot, destination));
