import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable.');

for (const workspace of ['@quiztaker/core', '@quiztaker/helper', '@quiztaker/web']) {
  const result = spawnSync(process.execPath, [
    npmCli,
    'run',
    'build',
    `--workspace=${workspace}`,
  ], {
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
