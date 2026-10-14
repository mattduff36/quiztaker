import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  chooseReleaseAsset,
  classifyReleaseAsset,
  createApplyScript,
  createHelperRestartLines,
  helperUpdateError,
  installHelperUpdate,
  isAllowedReleaseHost,
  quoteCommandArg,
  reconcileHelperUpdate,
  type HelperUpdateOffer,
} from '../src/updater.js';

const version = '1.0.4';
const zipUrl = `https://github.com/mattduff36/quiztaker/releases/download/v${version}/vitriol-helper-windows-x64-v${version}.zip`;
const msiUrl = `https://github.com/mattduff36/quiztaker/releases/download/v${version}/VitriolHelper-${version}-win-x64.msi`;

test('accepts only the Vitriol release assets for one version', () => {
  assert.equal(classifyReleaseAsset(zipUrl, version), 'zip');
  assert.equal(classifyReleaseAsset(msiUrl, version), 'msi');
  assert.equal(classifyReleaseAsset(msiUrl, '1.0.5'), null);
  assert.equal(classifyReleaseAsset('http://github.com/mattduff36/quiztaker/releases/download/v1.0.4/VitriolHelper-1.0.4-win-x64.msi', version), null);
  assert.equal(classifyReleaseAsset(`${msiUrl}?download=1`, version), null);
  assert.equal(classifyReleaseAsset('https://example.com/VitriolHelper-1.0.4-win-x64.msi', version), null);
  assert.equal(classifyReleaseAsset('https://github.com/other/quiztaker/releases/download/v1.0.4/VitriolHelper-1.0.4-win-x64.msi', version), null);
  assert.equal(isAllowedReleaseHost('https://release-assets.githubusercontent.com/file'), true);
  assert.equal(isAllowedReleaseHost('http://release-assets.githubusercontent.com/file'), false);
  assert.equal(isAllowedReleaseHost('https://evil.example/file'), false);
});

test('prefers a checksummed MSI and otherwise uses the ZIP', () => {
  const msi = chooseReleaseAsset(offer({ installerUrl: msiUrl, installerSha256: 'a'.repeat(64) }));
  assert.equal(msi?.kind, 'msi');
  const zip = chooseReleaseAsset(offer({ installerUrl: msiUrl, installerSha256: null }));
  assert.equal(zip?.kind, 'zip');
  assert.equal(chooseReleaseAsset(offer({ downloadUrl: 'https://example.com/helper.zip' })), null);
});

test('quotes Windows short paths and rejects command metacharacters', () => {
  assert.equal(
    quoteCommandArg('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\helper-update.msi'),
    '"C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\helper-update.msi"',
  );
  assert.throws(() => quoteCommandArg('C:\\temp\\helper%TEMP%.msi'));
  assert.throws(() => quoteCommandArg('C:\\temp\\helper&whoami.msi'));
});

test('the installer script waits for this process and does not embed a download URL', () => {
  const script = createApplyScript();
  assert.match(script, /msiexec\.exe/);
  assert.match(script, /\/qn \/norestart/);
  assert.match(script, /set "ARG=--control-plane-url=%CONTROL%"/);
  assert.match(script, /if \/I "%CONTROL%"=="https:\/\/www\.vitriol\.co\.uk" set "ARG=--production"/);
  assert.match(script, /start "" \/D "%DIR%" cmd\.exe \/d \/s \/c ""%LAUNCHER%" %ARG%"/);
  assert.doesNotMatch(script, /start "" "%LAUNCHER%" --control-plane-url="%CONTROL%"/);
  assert.doesNotMatch(script, /github\.com/);
  assert.doesNotMatch(script, /tasklist[^\r\n]*\|/);
  assert.match(script, /findstr \/C:"%PID%" "%PROCESS_CHECK%"/);
});

test('downloads a verified MSI and launches the installer once', async () => {
  const bytes = Buffer.from('helper-installer');
  const home = mkdtempSync(join(tmpdir(), 'vitriol-helper-update-'));
  const localAppData = mkdtempSync(join(tmpdir(), 'vitriol-local-'));
  const launcher = join(localAppData, 'Programs', 'Vitriol Helper');
  mkdirSync(launcher, { recursive: true });
  writeFileSync(join(launcher, 'Start Vitriol Helper.cmd'), '@echo off\r\n');
  const commands: string[] = [];
  const pending = offer({
    installerUrl: msiUrl,
    installerSha256: createHash('sha256').update(bytes).digest('hex'),
  });
  const fetchImpl: typeof fetch = async () => new Response(bytes);

  const first = await installHelperUpdate({
    offer: pending,
    helperHome: home,
    controlPlaneUrl: 'https://www.vitriol.co.uk',
    platform: 'win32',
    localAppData,
    fetchImpl,
    spawnImpl: (commandLine) => commands.push(commandLine),
  });
  const second = await installHelperUpdate({
    offer: pending,
    helperHome: home,
    controlPlaneUrl: 'https://www.vitriol.co.uk',
    platform: 'win32',
    localAppData,
    fetchImpl,
    spawnImpl: (commandLine) => commands.push(commandLine),
  });

  assert.equal(first, 'restarting', readFileSync(join(home, 'updates', 'status.json'), 'utf8'));
  assert.equal(second, 'skipped');
  assert.equal(commands.length, 1);
  assert.match(commands[0], /apply-update\.cmd/);
  assert.match(commands[0], /https:\/\/www\.vitriol\.co\.uk/);
  assert.match(readFileSync(join(home, 'updates', 'apply-update.cmd'), 'utf8'), /msiexec\.exe/);
  assert.doesNotMatch(readFileSync(join(home, 'updates', 'apply-update.cmd'), 'utf8'), /github\.com/);
});

test('records a checksum failure and does not retry that same request', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-helper-update-'));
  const localAppData = mkdtempSync(join(tmpdir(), 'vitriol-local-'));
  mkdirSync(join(localAppData, 'Programs', 'Vitriol Helper'), { recursive: true });
  writeFileSync(join(localAppData, 'Programs', 'Vitriol Helper', 'Start Vitriol Helper.cmd'), '@echo off\r\n');
  let downloads = 0;
  const fetchImpl: typeof fetch = async () => {
    downloads += 1;
    return new Response(Buffer.from('wrong-bytes'));
  };
  const pending = offer({
    installerUrl: msiUrl,
    installerSha256: 'b'.repeat(64),
  });

  assert.equal(await installHelperUpdate({
    offer: pending,
    helperHome: home,
    controlPlaneUrl: 'https://vitriol.co.uk',
    platform: 'win32',
    localAppData,
    fetchImpl,
    spawnImpl: () => assert.fail('installer launched'),
  }), 'failed');
  assert.equal(await installHelperUpdate({
    offer: pending,
    helperHome: home,
    controlPlaneUrl: 'https://vitriol.co.uk',
    platform: 'win32',
    localAppData,
    fetchImpl,
    spawnImpl: () => assert.fail('installer launched'),
  }), 'skipped');
  assert.equal(downloads, 1);
  assert.match(await helperUpdateError(home) || '', /checksum/);

  const retried = await installHelperUpdate({
    offer: { ...pending, requestedAt: '2026-10-02T16:00:00.000Z' },
    helperHome: home,
    controlPlaneUrl: 'https://vitriol.co.uk',
    platform: 'win32',
    localAppData,
    fetchImpl,
    spawnImpl: () => assert.fail('installer launched'),
  });
  assert.equal(retried, 'failed');
  assert.equal(downloads, 2);
});

test('restarts the spaced install path with the production argument', {
  skip: process.platform !== 'win32',
}, () => {
  const launcher = 'C:\\Users\\mattd\\AppData\\Local\\Programs\\Vitriol Helper\\Start Vitriol Helper.cmd';
  const directory = 'C:\\Users\\mattd\\AppData\\Local\\Programs\\Vitriol Helper';
  const productionCommand = `start "" /D "${directory}" cmd.exe /d /s /c ""${launcher}" --production"`;
  assert.equal(expandRestartCommand(launcher, 'https://www.vitriol.co.uk'), productionCommand);
  assert.equal(
    expandRestartCommand(launcher, 'http://127.0.0.1:4000'),
    `start "" /D "${directory}" cmd.exe /d /s /c ""${launcher}" --control-plane-url=http://127.0.0.1:4000"`,
  );
  assert.doesNotMatch(productionCommand, /start "" "[^"]*Vitriol Helper\\Start Vitriol Helper\.cmd" --/);

  const root = mkdtempSync(join(tmpdir(), 'vitriol-restart-'));
  const folder = join(root, 'Programs', 'Vitriol Helper');
  mkdirSync(folder, { recursive: true });
  const sampleLauncher = join(folder, 'Start Vitriol Helper.cmd');
  const output = join(root, 'launched.txt');
  writeFileSync(sampleLauncher, [
    '@echo off',
    `>"${output}" echo ARGS=%*`,
    `>>"${output}" echo CD=%CD%`,
    'exit /b 0',
    '',
  ].join('\r\n'));
  const script = join(root, 'restart.cmd');
  writeFileSync(script, [
    '@echo off',
    'setlocal EnableExtensions',
    'set "LAUNCHER=%~1"',
    'set "CONTROL=%~2"',
    ...createHelperRestartLines(),
    'exit /b 0',
    '',
  ].join('\r\n'));

  rmSync(output, { force: true });
  runRestartScript(script, sampleLauncher, 'https://www.vitriol.co.uk');
  const production = readLaunchResult(output);
  assert.equal(production.args, '--production');
  assert.equal(production.cwd, folder);

  rmSync(output, { force: true });
  runRestartScript(script, sampleLauncher, 'http://127.0.0.1:4000');
  const local = readLaunchResult(output);
  assert.equal(local.args, '--control-plane-url=http://127.0.0.1:4000');
  assert.equal(local.cwd, folder);
});

test('clears update state once the installed version catches up', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-helper-update-'));
  mkdirSync(join(home, 'updates'), { recursive: true });
  writeFileSync(join(home, 'updates', 'status.json'), JSON.stringify({
    version: '1.0.4',
    requestedAt: '2026-10-02T15:00:00.000Z',
    phase: 'installing',
  }));
  writeFileSync(join(home, 'updates', 'installer-exit.txt'), '0\r\n');
  await reconcileHelperUpdate(home, '1.0.4');
  assert.equal(await helperUpdateError(home), undefined);
});

test('reports an installer exit code when the version stays behind', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vitriol-helper-update-'));
  mkdirSync(join(home, 'updates'), { recursive: true });
  writeFileSync(join(home, 'updates', 'status.json'), JSON.stringify({
    version: '1.0.4',
    requestedAt: '2026-10-02T15:00:00.000Z',
    phase: 'installing',
  }));
  writeFileSync(join(home, 'updates', 'installer-exit.txt'), '1603\r\n');
  await reconcileHelperUpdate(home, '1.0.2');
  assert.match(await helperUpdateError(home) || '', /1603/);
});

function expandRestartCommand(launcher: string, controlOrigin: string): string {
  const directory = launcher.slice(0, launcher.lastIndexOf('\\'));
  const argument = controlOrigin === 'https://www.vitriol.co.uk'
    ? '--production'
    : `--control-plane-url=${controlOrigin}`;
  return `start "" /D "${directory}" cmd.exe /d /s /c ""${launcher}" ${argument}"`;
}

function runRestartScript(script: string, launcher: string, controlOrigin: string): void {
  // Windows PowerShell 5.1 Start-Process splits an argument array on spaces.
  // Node's execFile quoting matches the updater's cmd.exe /d /s /c launch.
  execFileSync('cmd.exe', ['/d', '/c', script, launcher, controlOrigin], {
    windowsHide: true,
  });
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'if (-not (Select-String -LiteralPath $env:VITRIOL_RESTART_CMD -Pattern \'cmd\\.exe /d /s /c ""%LAUNCHER%" %ARG%"\' -Quiet)) { exit 1 }',
  ], {
    env: { ...process.env, VITRIOL_RESTART_CMD: script },
    windowsHide: true,
  });
}

function readLaunchResult(output: string): { args: string; cwd: string } {
  const deadline = Date.now() + 5_000;
  while (!existsSync(output)) {
    if (Date.now() > deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  const lines = readFileSync(output, 'utf8').trim().split(/\r?\n/);
  return {
    args: lines[0]?.replace(/^ARGS=/, '') || '',
    cwd: lines[1]?.replace(/^CD=/, '') || '',
  };
}

function offer(overrides: Partial<HelperUpdateOffer> = {}): HelperUpdateOffer {
  return {
    version,
    requestedAt: '2026-10-02T15:00:00.000Z',
    downloadUrl: zipUrl,
    sha256: 'c'.repeat(64),
    installerUrl: null,
    installerSha256: null,
    ...overrides,
  };
}
