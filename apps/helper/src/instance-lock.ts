import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** An OS mutex avoids deleting another launch's lock during stale-owner recovery. */
export async function acquireInstanceLock(helperHome: string): Promise<() => void> {
  const key = createHash('sha256').update(resolve(helperHome).toLowerCase()).digest('hex');
  const script = [
    `$mutex = [System.Threading.Mutex]::new($false, 'Global\\VitriolHelper-${key}')`,
    '$owned = $false',
    'try {',
    '  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }',
    '  if (-not $owned) { [Console]::WriteLine("BUSY"); exit 2 }',
    '  [Console]::WriteLine("LOCKED")',
    '  [Console]::In.ReadLine() | Out-Null',
    '} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }',
  ].join('\n');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let held = false;
  let released = false;
  holder.stdin.on('error', () => { /* A terminated holder has already released its mutex. */ });
  const release = () => {
    if (released) return;
    released = true;
    holder.stdin.end('\n');
    process.removeListener('exit', release);
  };
  try {
    await new Promise<void>((accept, reject) => {
      let output = '';
      const startupTimer = setTimeout(() => {
        holder.kill();
        reject(new Error('The helper instance reservation timed out. Try launching it again.'));
      }, 15_000);
      holder.stdout.on('data', chunk => {
        output += String(chunk);
        if (output.includes('LOCKED')) { clearTimeout(startupTimer); held = true; accept(); }
        else if (output.includes('BUSY')) { clearTimeout(startupTimer); reject(new Error('Vitriol Helper is already running. Use its existing window.')); }
      });
      holder.once('error', error => { clearTimeout(startupTimer); reject(error); });
      holder.once('exit', () => {
        clearTimeout(startupTimer);
        if (!held) reject(new Error('The helper could not reserve its running instance. Try launching it again.'));
        else if (!released) {
          console.error('The helper instance reservation was lost. Stopping this helper safely.');
          process.kill(process.pid, 'SIGTERM');
        }
      });
      // Drain diagnostic output without ever displaying environment or user paths.
      holder.stderr.resume();
    });
    process.once('exit', release);
    return release;
  } catch (error) { release(); throw error; }
}
