import { execFileSync } from 'node:child_process';

export function shouldAutoMinimize(
  args = process.argv.slice(2),
  platform = process.platform,
  isDisabled = process.env.QUIZTAKER_NO_AUTO_MINIMIZE,
): boolean {
  return platform === 'win32'
    && isDisabled !== '1'
    && !args.includes('--no-minimize');
}

export function minimizeHelperWindow(): boolean {
  if (!shouldAutoMinimize()) return false;
  const script = createMinimizeScript(process.pid);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function createMinimizeScript(processId: number): string {
  return [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class VitriolWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }\'',
    `$currentId = ${processId}`,
    '$allowedNames = @("windowsterminal", "powershell", "pwsh", "cmd", "conhost")',
    'while ($currentId -gt 0) {',
    '  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction SilentlyContinue',
    '  if ($null -eq $processInfo) { break }',
    '  $windowProcess = Get-Process -Id $currentId -ErrorAction SilentlyContinue',
    '  if ($null -ne $windowProcess -and $allowedNames -contains $windowProcess.ProcessName.ToLowerInvariant() -and $windowProcess.MainWindowHandle -ne 0) {',
    '    [VitriolWindow]::ShowWindowAsync($windowProcess.MainWindowHandle, 6) | Out-Null',
    '    exit 0',
    '  }',
    '  $currentId = $processInfo.ParentProcessId',
    '}',
    '$consoleHandle = [VitriolWindow]::GetConsoleWindow()',
    'if ($consoleHandle -eq [IntPtr]::Zero) { exit 2 }',
    '[VitriolWindow]::ShowWindowAsync($consoleHandle, 6) | Out-Null',
  ].join('\n');
}
