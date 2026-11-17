import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capturePlacementScript, restorePlacementScript, saveHelperWindowPlacement, restoreHelperWindowPlacement, validWindowPlacement, placementNativeTypes } from '../src/window-placement.js';

test('placement accepts an adjacent monitor and maximised state, and rejects stale or invalid bounds',()=>{
  const p={left:-1400,top:20,right:-200,bottom:820,showCmd:3 as const,savedAt:Date.now()};
  assert.equal(validWindowPlacement(p),true);
  assert.equal(validWindowPlacement({...p,right:p.left}),false);
  assert.equal(validWindowPlacement({...p,showCmd:99}),false);
  assert.equal(validWindowPlacement({...p,savedAt:Date.now()-31*60_000}),false);
  assert.match(restorePlacementScript(1234,p),/MonitorFromRect\(\[ref\]\$bounds, 2\)/);
  assert.match(restorePlacementScript(1234,p),/\$placement.ShowCmd=3/);
  assert.doesNotMatch(capturePlacementScript(1234),/GetForegroundWindow|GetConsoleWindow|MainWindowHandle/);
});

test('an update saves one placement and the new helper restores it only once',{skip:process.platform!=='win32'},()=>{
  const home=mkdtempSync(join(tmpdir(),'vitriol-placement-'));
  try {
    assert.equal(saveHelperWindowPlacement(home,script=>{
      assert.match(script,/FindHelperWindow\(4321\)/);
      return JSON.stringify({left:120,top:60,right:1020,bottom:660,showCmd:2,restoreToMaximized:true});
    },4321),true);
    assert.equal(existsSync(join(home,'update-window-placement.json')),true);
    let restored='';
    assert.equal(restoreHelperWindowPlacement(home,script=>{restored=script;return '';}),true);
    assert.match(restored,/\$bounds.Left=120; \$bounds.Top=60; \$bounds.Right=1020; \$bounds.Bottom=660/);
    assert.match(restored,/\$placement.ShowCmd=2/);
    assert.match(restored,/\$placement.Flags=2/);
    assert.match(restored,/ShowWindowAsync\(\$handle,\$placement.ShowCmd\)/);
    assert.equal(restoreHelperWindowPlacement(home,()=>assert.fail('Placement was consumed')),false);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('native resolver rejects pseudoconsoles, unrelated/ambiguous windows and clamps to monitor work areas without moving windows',{skip:process.platform!=='win32'},()=>{
  const script=[
    `Add-Type -TypeDefinition '${placementNativeTypes}'`,
    'function candidate($id,$title="Vitriol Helper",$visible=$true,$class="CASCADIA_HOSTING_WINDOW_CLASS",$name="WindowsTerminal",$width=900) {',
    '$w=New-Object VitriolPlacement+Candidate; $w.Handle=[IntPtr]$id; $w.Title=$title; $w.Visible=$visible; $w.ClassName=$class; $w.ProcessName=$name;',
    '$r=New-Object VitriolPlacement+Rect; $r.Right=$width; $r.Bottom=600; $w.Bounds=$r; return $w }',
    '$good=candidate 17',
    '$hidden=candidate 18 "Vitriol Helper" $false',
    '$zero=candidate 19 "Vitriol Helper" $true "ConsoleWindowClass" "conhost" 0',
    '$wrong=candidate 20 "Vitriol Helper" $true "NotAConsole" "WindowsTerminal"',
    '$other=candidate 21 "Other terminal"',
    '$wrongProcess=candidate 23 "Vitriol Helper" $true "CASCADIA_HOSTING_WINDOW_CLASS" "unrelated"',
    '$r=New-Object VitriolPlacement+Rect; $r.Left=-2000; $r.Top=-800; $r.Right=-200; $r.Bottom=100',
    '$area=New-Object VitriolPlacement+Rect; $area.Left=0; $area.Top=40; $area.Right=1200; $area.Bottom=840',
    '$clamped=[VitriolPlacement]::Clamp($r,$area)',
    '$m=New-Object VitriolPlacement+MonitorInfo; $m.Work=$area; $display=$area; $display.Top=0; $m.Monitor=$display',
    '$normal=[VitriolPlacement]::ToWorkspace($clamped,$m); $screen=[VitriolPlacement]::ToScreen($normal,$m)',
    '@{ unique=[VitriolPlacement]::UniqueHelperWindow([VitriolPlacement+Candidate[]]@($good,$hidden,$zero,$wrong,$other,$wrongProcess)).ToInt64();',
    'ambiguous=[VitriolPlacement]::UniqueHelperWindow([VitriolPlacement+Candidate[]]@($good,(candidate 22))).ToInt64();',
    'hidden=[VitriolPlacement]::UniqueHelperWindow([VitriolPlacement+Candidate[]]@($hidden,$zero,$wrong,$other,$wrongProcess)).ToInt64();',
    'hiddenAmbiguous=[VitriolPlacement]::UniqueHelperWindow([VitriolPlacement+Candidate[]]@($hidden,(candidate 24 "Vitriol Helper" $false))).ToInt64();',
    'absent=[VitriolPlacement]::UniqueHelperWindow([VitriolPlacement+Candidate[]]@($zero,$wrong,$other,$wrongProcess)).ToInt64();',
    'clamp=@($screen.Left,$screen.Top,$screen.Right,$screen.Bottom); workspaceTop=$normal.Top } | ConvertTo-Json -Compress',
  ].join('\n');
  const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000}));
  assert.deepEqual(result,{unique:17,ambiguous:0,hidden:18,hiddenAmbiguous:0,absent:0,clamp:[0,40,1200,840],workspaceTop:0});
});

test('stale placement is consumed with a warning and never reaches a native window',{skip:process.platform!=='win32'},()=>{
  const home=mkdtempSync(join(tmpdir(),'vitriol-stale-placement-')),file=join(home,'update-window-placement.json');
  const warn=console.warn;const warnings:string[]=[];console.warn=message=>warnings.push(String(message));
  try{
    writeFileSync(file,JSON.stringify({left:0,top:0,right:900,bottom:600,showCmd:1,savedAt:Date.now()-31*60000}));
    assert.equal(restoreHelperWindowPlacement(home,()=>assert.fail('Stale placement must not move a window')),false);
    assert.equal(existsSync(file),false);assert.match(warnings[0],/could not be restored/);
  }finally{console.warn=warn;rmSync(home,{recursive:true,force:true});}
});

test('capture and restore scripts parse on Windows without moving a real window',{skip:process.platform!=='win32'},()=>{
  const p={left:120,top:60,right:1020,bottom:660,showCmd:1 as const,savedAt:Date.now()};
  for(const script of [capturePlacementScript(1234),restorePlacementScript(1234,p)]) {
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$null=[scriptblock]::Create([Console]::In.ReadToEnd())'],{input:script,windowsHide:true,stdio:['pipe','ignore','pipe']});
  }
});
