import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helperRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(helperRoot, '..', '..');
const packageValue = JSON.parse(readFileSync(join(helperRoot, 'package.json'), 'utf8'));
const version = process.env.RELEASE_VERSION || packageValue.version;
const nodeVersion = process.env.NODE_RUNTIME_VERSION || '22.18.0';
const outputRoot = join(helperRoot, 'release');
const stageRoot = join(outputRoot, 'stage');
const downloadRoot = join(outputRoot, 'downloads');
const nodeArchive = join(downloadRoot, `node-v${nodeVersion}-win-x64.zip`);

rmSync(outputRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
mkdirSync(stageRoot, { recursive: true });
mkdirSync(downloadRoot, { recursive: true });

run('npm', ['run', 'build', '--workspace=@quiztaker/core'], repositoryRoot);
run('npm', ['run', 'build', '--workspace=@quiztaker/helper'], repositoryRoot);
await installNodeRuntime();
stageHelper();
stageAutomation();
installAutomationDependencies();
writeLauncher();
writeInstallNotes();

const wixSource = join(outputRoot, 'VitriolHelper.wxs');
writeFileSync(wixSource, createWixSource(stageRoot));
const msiName = `VitriolHelper-${version}-win-x64.msi`;
const msiPath = join(outputRoot, msiName);
run('wix', ['build', wixSource, '-arch', 'x64', '-o', msiPath], repositoryRoot);
if (process.env.SIGN_CERTIFICATE_PATH && process.env.SIGN_CERTIFICATE_PASSWORD) {
  run('signtool.exe', [
    'sign',
    '/fd', 'SHA256',
    '/f', process.env.SIGN_CERTIFICATE_PATH,
    '/p', process.env.SIGN_CERTIFICATE_PASSWORD,
    '/tr', process.env.SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com',
    '/td', 'SHA256',
    msiPath,
  ], repositoryRoot);
}

const zipRoot = join(outputRoot, `vitriol-helper-windows-x64-v${version}`);
mkdirSync(zipRoot, { recursive: true });
cpSync(msiPath, join(zipRoot, msiName));
cpSync(join(stageRoot, 'INSTALL.txt'), join(zipRoot, 'INSTALL.txt'));
cpSync(join(stageRoot, 'LICENSE.txt'), join(zipRoot, 'LICENSE.txt'));
cpSync(join(stageRoot, 'THIRD_PARTY_NOTICES.txt'), join(zipRoot, 'THIRD_PARTY_NOTICES.txt'));
const msiHash = sha256(readFileSync(msiPath));
writeFileSync(join(zipRoot, 'SHA256SUMS.txt'), `${msiHash}  ${msiName}\n`);
const zipPath = `${zipRoot}.zip`;
run('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Compress-Archive -Path '${zipRoot}\\*' -DestinationPath '${zipPath}' -Force`,
], repositoryRoot);

const release = {
  version,
  publishedAt: new Date().toISOString(),
  file: basename(zipPath),
  sha256: sha256(readFileSync(zipPath)),
  minimumHelperVersion: '1.0.0',
  signed: false,
};
writeFileSync(join(outputRoot, 'release.json'), JSON.stringify(release, null, 2));
console.log(JSON.stringify({ ok: true, zipPath, ...release }, null, 2));

async function installNodeRuntime() {
  const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
  const [archiveResponse, sumsResponse] = await Promise.all([
    fetch(`${baseUrl}/${basename(nodeArchive)}`),
    fetch(`${baseUrl}/SHASUMS256.txt`),
  ]);
  if (!archiveResponse.ok || !sumsResponse.ok) throw new Error('Could not download the pinned Node.js runtime.');
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const sums = await sumsResponse.text();
  const expected = sums.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === basename(nodeArchive))?.[0];
  if (!expected || sha256(archive) !== expected) throw new Error('Node.js runtime checksum mismatch.');
  writeFileSync(nodeArchive, archive);
  const extracted = join(downloadRoot, 'node');
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -Path '${nodeArchive}' -DestinationPath '${extracted}' -Force`,
  ], repositoryRoot);
  const source = join(extracted, `node-v${nodeVersion}-win-x64`);
  cpSync(source, join(stageRoot, 'runtime'), { recursive: true });
}

function stageHelper() {
  mkdirSync(join(stageRoot, 'helper'), { recursive: true });
  cpSync(join(helperRoot, 'dist'), join(stageRoot, 'helper'), { recursive: true });
}

function stageAutomation() {
  const automationRoot = join(stageRoot, 'automation');
  mkdirSync(automationRoot, { recursive: true });
  for (const name of readdirSync(repositoryRoot)) {
    if (/^pw-.*\.js$/i.test(name) || ['start-cdp-browser.js', 'quiz-log.js'].includes(name)) {
      cpSync(join(repositoryRoot, name), join(automationRoot, name));
    }
  }
  for (const name of ['lib', 'docs']) {
    cpSync(join(repositoryRoot, name), join(automationRoot, name), { recursive: true });
  }
  cpSync(join(repositoryRoot, 'AGENTS.md'), join(automationRoot, 'AGENTS.md'));
  writeFileSync(join(automationRoot, 'package.json'), JSON.stringify({
    name: '@quiztaker/automation-runtime',
    version,
    private: true,
    dependencies: {
      express: packageValue.dependencies?.express || '^4.21.2',
      playwright: '^1.58.2',
    },
  }, null, 2));
}

function installAutomationDependencies() {
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], join(stageRoot, 'automation'), {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  });
}

function writeLauncher() {
  writeFileSync(join(stageRoot, 'Start Vitriol Helper.cmd'), [
    '@echo off',
    'setlocal',
    'set "QUIZTAKER_AUTOMATION_ROOT=%~dp0automation"',
    'set "QUIZTAKER_NODE_PATH=%~dp0runtime\\node.exe"',
    '"%~dp0runtime\\node.exe" "%~dp0helper\\index.js" %*',
    'if errorlevel 1 pause',
  ].join('\r\n'));
}

function writeInstallNotes() {
  writeFileSync(join(stageRoot, 'INSTALL.txt'), [
    'Vitriol Helper for Windows 10/11 x64',
    '',
    'This private release is intentionally unsigned and may show Windows SmartScreen warnings.',
    'Install the MSI, start "Vitriol Helper" from the Start menu, then enter the pairing code shown by the website.',
    'Google Chrome is required. Browser credentials and cookies remain on this computer.',
    'To import an older data folder, run: "Start Vitriol Helper.cmd" --import-data=C:\\path\\to\\old-project\\data',
  ].join('\r\n'));
  writeFileSync(join(stageRoot, 'LICENSE.txt'), [
    'ISC License',
    '',
    'Copyright (c) 2026 Vitriol contributors',
    '',
    'Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.',
    'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE.',
  ].join('\r\n'));
  writeFileSync(join(stageRoot, 'THIRD_PARTY_NOTICES.txt'), [
    'Vitriol Helper includes Node.js, Playwright, and their production dependencies.',
    'Their license files are included with the staged runtime and node_modules tree.',
    'A CycloneDX software bill of materials is attached to each GitHub Release.',
  ].join('\r\n'));
}

function createWixSource(sourceRoot) {
  const files = listFiles(sourceRoot).filter((file) => basename(file) !== 'INSTALL.txt');
  const directoryIds = new Map([['', 'INSTALLFOLDER']]);
  for (const file of files) {
    let current = dirname(relative(sourceRoot, file));
    while (current !== '.' && current) {
      directoryIds.set(current, id('dir', current));
      current = dirname(current);
      if (current === '.') break;
    }
  }
  const directoryXml = buildDirectoryXml('', directoryIds);
  const componentXml = files.map((file) => {
    const relativePath = relative(sourceRoot, file);
    const directory = dirname(relativePath) === '.' ? '' : dirname(relativePath);
    const fileId = id('file', relativePath);
    const shortcut = basename(file) === 'Start Vitriol Helper.cmd'
      ? `<Shortcut Id=\"StartMenuShortcut\" Directory=\"ProgramMenuFolder\" Name=\"Vitriol Helper\" WorkingDirectory=\"INSTALLFOLDER\" Advertise=\"no\" />`
      : '';
    return `<Component Id=\"${id('cmp', relativePath)}\" Directory=\"${directoryIds.get(directory)}\" Guid=\"*\"><File Id=\"${fileId}\" Source=\"${xml(file)}\" KeyPath=\"yes\">${shortcut}</File></Component>`;
  }).join('');
  return `<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<Wix xmlns=\"http://wixtoolset.org/schemas/v4/wxs\">
  <Package Name=\"Vitriol Helper\" Manufacturer=\"Vitriol\" Version=\"${xml(version)}\" UpgradeCode=\"2B49AFEF-52D4-4CF4-830D-E0A0C1D348F7\" Scope=\"perUser\">
    <MajorUpgrade DowngradeErrorMessage=\"A newer version of Vitriol Helper is already installed.\" />
    <MediaTemplate EmbedCab=\"yes\" />
    <Feature Id=\"MainFeature\" Title=\"Vitriol Helper\" Level=\"1\">
      <ComponentGroupRef Id=\"AppFiles\" />
    </Feature>
  </Package>
  <Fragment>
    <StandardDirectory Id=\"LocalAppDataFolder\">
      <Directory Id=\"LocalProgramsFolder\" Name=\"Programs\">
        <Directory Id=\"INSTALLFOLDER\" Name=\"Vitriol Helper\">${directoryXml}</Directory>
      </Directory>
    </StandardDirectory>
    <StandardDirectory Id=\"ProgramMenuFolder\" />
  </Fragment>
  <Fragment>
    <ComponentGroup Id=\"AppFiles\">${componentXml}</ComponentGroup>
  </Fragment>
</Wix>`;
}

function buildDirectoryXml(parent, directoryIds) {
  const children = [...directoryIds.keys()].filter((value) => (
    value && (dirname(value) === '.' ? '' : dirname(value)) === parent
  ));
  return children.map((child) => (
    `<Directory Id=\"${directoryIds.get(child)}\" Name=\"${xml(basename(child))}\">${buildDirectoryXml(child, directoryIds)}</Directory>`
  )).join('');
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function id(prefix, value) {
  return `${prefix}_${createHash('sha1').update(value).digest('hex').slice(0, 24)}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function xml(value) {
  return String(value).replace(/[&<>\"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\"': '&quot;',
  }[character]));
}

function run(command, args, cwd, extraEnv = {}) {
  const isNpm = command === 'npm';
  const executable = isNpm ? process.execPath : command;
  const commandArgs = isNpm ? [process.env.npm_execpath, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
}
