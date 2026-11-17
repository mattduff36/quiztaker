// Capture only the helper's unambiguous console/Terminal window, including a
// hidden Terminal after restart. Never
// use the foreground window or the hidden zero-size ConPTY console as a target.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HelperWindowPlacement {
  left:number; top:number; right:number; bottom:number;
  showCmd:1|2|3;
  restoreToMaximized?:boolean;
  savedAt:number;
}

export function validWindowPlacement(value:unknown, now=Date.now()):value is HelperWindowPlacement {
  if(!value || typeof value!=='object')return false;
  const v=value as HelperWindowPlacement;
  return [v.left,v.top,v.right,v.bottom].every(n=>Number.isInteger(n)&&Math.abs(n)<=100_000)
    && v.right-v.left>=160 && v.right-v.left<=10_000 && v.bottom-v.top>=80 && v.bottom-v.top<=10_000
    && [1,2,3].includes(v.showCmd) && (v.restoreToMaximized===undefined || typeof v.restoreToMaximized==='boolean')
    && Number.isFinite(v.savedAt) && v.savedAt<=now && now-v.savedAt<30*60_000;
}

export const placementNativeTypes = `using System; using System.Text; using System.Diagnostics; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class VitriolPlacement {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Placement { public int Length, Flags, ShowCmd; public Point MinPosition, MaxPosition; public Rect NormalPosition; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  public delegate bool WindowVisitor(IntPtr window, IntPtr data);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetConsoleTitle(StringBuilder title, uint size);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint id);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
  [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  public sealed class Candidate {
    public IntPtr Handle; public string Title, ClassName, ProcessName; public bool Visible; public Rect Bounds;
  }
  public static IntPtr UniqueHelperWindow(IEnumerable<Candidate> windows) {
    IntPtr found=IntPtr.Zero,hidden=IntPtr.Zero; int visibleCount=0,hiddenCount=0;
    foreach(var w in windows) {
      bool host=(w.ClassName=="CASCADIA_HOSTING_WINDOW_CLASS" && String.Equals(w.ProcessName,"WindowsTerminal",StringComparison.OrdinalIgnoreCase))
        || (w.ClassName=="ConsoleWindowClass" && (String.Equals(w.ProcessName,"conhost",StringComparison.OrdinalIgnoreCase) || String.Equals(w.ProcessName,"OpenConsole",StringComparison.OrdinalIgnoreCase)));
      if(!host || w.Title!="Vitriol Helper" || w.Bounds.Right-w.Bounds.Left<160 || w.Bounds.Bottom-w.Bounds.Top<80)continue;
      if(w.Visible){found=w.Handle;visibleCount++;}else{hidden=w.Handle;hiddenCount++;}
    }
    return visibleCount==1?found:visibleCount>1?IntPtr.Zero:hiddenCount==1?hidden:IntPtr.Zero;
  }
  public static IntPtr FindHelperWindow(uint processId) {
    FreeConsole();
    if(!AttachConsole(processId))return IntPtr.Zero;
    var consoleTitle=new StringBuilder(512);
    GetConsoleTitle(consoleTitle,512);
    if(consoleTitle.ToString()!="Vitriol Helper")return IntPtr.Zero;
    var candidates=new List<Candidate>();
    EnumWindows(delegate(IntPtr window, IntPtr unused) {
      var title=new StringBuilder(512); GetWindowText(window,title,512);
      if(title.ToString()!="Vitriol Helper")return true;
      var name=new StringBuilder(256); GetClassName(window,name,256);
      uint id; GetWindowThreadProcessId(window,out id);
      string processName;
      try { processName=Process.GetProcessById((int)id).ProcessName; } catch(ArgumentException) { return true; }
      var p=new Placement(); p.Length=Marshal.SizeOf(p);
      if(GetWindowPlacement(window,ref p))candidates.Add(new Candidate{Handle=window,Title=title.ToString(),ClassName=name.ToString(),ProcessName=processName,Visible=IsWindowVisible(window),Bounds=p.NormalPosition});
      return true;
    },IntPtr.Zero);
    return UniqueHelperWindow(candidates);
  }
  public static Rect Clamp(Rect bounds, Rect area) {
    int width=Math.Min(bounds.Right-bounds.Left,area.Right-area.Left),height=Math.Min(bounds.Bottom-bounds.Top,area.Bottom-area.Top);
    int left=Math.Max(area.Left,Math.Min(bounds.Left,area.Right-width)),top=Math.Max(area.Top,Math.Min(bounds.Top,area.Bottom-height));
    return new Rect{Left=left,Top=top,Right=left+width,Bottom=top+height};
  }
  public static Rect ToScreen(Rect normal, MonitorInfo monitor) {
    int x=monitor.Work.Left-monitor.Monitor.Left,y=monitor.Work.Top-monitor.Monitor.Top;
    return new Rect{Left=normal.Left+x,Top=normal.Top+y,Right=normal.Right+x,Bottom=normal.Bottom+y};
  }
  public static Rect ToWorkspace(Rect screen, MonitorInfo monitor) {
    int x=monitor.Work.Left-monitor.Monitor.Left,y=monitor.Work.Top-monitor.Monitor.Top;
    return new Rect{Left=screen.Left-x,Top=screen.Top-y,Right=screen.Right-x,Bottom=screen.Bottom-y};
  }
}`;

function windowScript(processId:number):string {
  if(!Number.isInteger(processId)||processId<=0)throw Error('Invalid helper process');
  return [
    '$ErrorActionPreference="Stop"',
    `Add-Type -TypeDefinition '${placementNativeTypes}'`,
    `$handle = [VitriolPlacement]::FindHelperWindow(${processId})`,
    'if ($handle -eq [IntPtr]::Zero) { throw "No unique Vitriol Helper window belongs to the attached console." }',
    '$placement = New-Object VitriolPlacement+Placement',
    '$placement.Length = [Runtime.InteropServices.Marshal]::SizeOf($placement)',
    'if (-not [VitriolPlacement]::GetWindowPlacement($handle, [ref]$placement)) { throw "Cannot read helper placement." }',
    '$monitor = New-Object VitriolPlacement+MonitorInfo',
    '$monitor.Size = [Runtime.InteropServices.Marshal]::SizeOf($monitor)',
  ].join('\n');
}

export function capturePlacementScript(processId:number):string {
  return windowScript(processId)+'\n'+[
    '$r = $placement.NormalPosition',
    '$screen = [VitriolPlacement]::MonitorFromRect([ref]$r, 2)',
    'if (-not [VitriolPlacement]::GetMonitorInfo($screen, [ref]$monitor)) { throw "Cannot read helper monitor." }',
    '$r = [VitriolPlacement]::ToScreen($r,$monitor)',
    '@{left=$r.Left; top=$r.Top; right=$r.Right; bottom=$r.Bottom; showCmd=$placement.ShowCmd; restoreToMaximized=!!($placement.Flags -band 2)} | ConvertTo-Json -Compress',
  ].join('\n');
}

export function restorePlacementScript(processId:number, value:HelperWindowPlacement):string {
  if(!validWindowPlacement(value))throw Error('Invalid helper window placement');
  return windowScript(processId)+'\n'+[
    '$bounds = New-Object VitriolPlacement+Rect',
    `$bounds.Left=${value.left}; $bounds.Top=${value.top}; $bounds.Right=${value.right}; $bounds.Bottom=${value.bottom}`,
    '$screen = [VitriolPlacement]::MonitorFromRect([ref]$bounds, 2)',
    'if (-not [VitriolPlacement]::GetMonitorInfo($screen, [ref]$monitor)) { throw "Cannot read destination monitor." }',
    '$bounds = [VitriolPlacement]::Clamp($bounds,$monitor.Work)',
    '$placement.NormalPosition=[VitriolPlacement]::ToWorkspace($bounds,$monitor)',
    `$placement.ShowCmd=${value.showCmd}`,
    `$placement.Flags=${value.restoreToMaximized?2:0}`,
    'if (-not [VitriolPlacement]::SetWindowPlacement($handle, [ref]$placement)) { throw "Cannot restore helper placement." }',
    '[VitriolPlacement]::ShowWindowAsync($handle,$placement.ShowCmd) | Out-Null',
  ].join('\n');
}

function runPlacementScript(script:string):string {
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,encoding:'utf8',timeout:10_000,stdio:['ignore','pipe','pipe']});
}

/** Read-only capture, including a named existing helper PID for the first 1.0.39 upgrade. */
export function captureHelperWindowPlacement(processId=process.pid, run=runPlacementScript):HelperWindowPlacement|null {
  if(process.platform!=='win32')return null;
  const value:unknown={...JSON.parse(run(capturePlacementScript(processId))),savedAt:Date.now()};
  return validWindowPlacement(value)?value:null;
}

export function saveHelperWindowPlacement(helperHome:string, run=runPlacementScript, processId=process.pid):boolean {
  if(process.platform!=='win32')return false;
  try {
    const value=captureHelperWindowPlacement(processId,run);
    if(!value)throw Error('Invalid captured helper placement');
    mkdirSync(helperHome,{recursive:true});
    const file=join(helperHome,'update-window-placement.json');
    writeFileSync(file+'.tmp',JSON.stringify(value));
    renameSync(file+'.tmp',file);
    return true;
  } catch {
    console.warn('Helper window placement could not be saved; the update will use the default window position.');
    return false;
  }
}

export function restoreHelperWindowPlacement(helperHome:string, run=runPlacementScript):boolean {
  if(process.platform!=='win32')return false;
  const file=join(helperHome,'update-window-placement.json');
  if(!existsSync(file))return false;
  try {
    const value:unknown=JSON.parse(readFileSync(file,'utf8'));
    if(!validWindowPlacement(value))throw Error('Stale or invalid helper placement');
    run(restorePlacementScript(process.pid,value));
    rmSync(file,{force:true});
    return true;
  } catch {
    console.warn('Helper window placement could not be restored; using the default window position.');
    rmSync(file,{force:true});
    return false;
  }
}
