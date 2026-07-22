import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createMinimizeScript, shouldAutoMinimize } from '../src/windows.js';

test('auto-minimizes only for an enabled Windows helper', () => {
  assert.equal(shouldAutoMinimize([], 'win32', undefined), true);
  assert.equal(shouldAutoMinimize(['--no-minimize'], 'win32', undefined), false);
  assert.equal(shouldAutoMinimize([], 'win32', '1'), false);
  assert.equal(shouldAutoMinimize([], 'linux', undefined), false);
});

test('generates valid PowerShell for minimizing the helper window', {
  skip: process.platform !== 'win32',
}, () => {
  const script = createMinimizeScript(1234);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$null = [scriptblock]::Create([Console]::In.ReadToEnd())',
  ], {
    input: script,
    windowsHide: true,
  });
});
