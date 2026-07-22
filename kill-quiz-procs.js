/**
 * Kill any stray quiz automation Node processes we started (pw-quiz-*.js,
 * start-cdp-browser.js). Useful before re-running the flow to make sure nothing
 * is still holding the CDP target.
 */
const { execSync } = require('child_process');

function list() {
  try {
    return execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:list', {
      encoding: 'utf8',
    });
  } catch {
    try {
      return execSync('ps -ef | grep node', { encoding: 'utf8' });
    } catch {
      return '';
    }
  }
}

function kill(pid) {
  try {
    process.kill(Number(pid));
    return true;
  } catch {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

const snap = list();
const lines = snap.split(/\r?\n/);
const killed = [];
let currentCmd = '';
let currentPid = '';
for (const line of lines) {
  if (line.startsWith('CommandLine=')) currentCmd = line.slice('CommandLine='.length).trim();
  else if (line.startsWith('ProcessId=')) {
    currentPid = line.slice('ProcessId='.length).trim();
    if (/pw-quiz|start-cdp-browser/i.test(currentCmd) && currentPid && currentPid !== String(process.pid)) {
      if (kill(currentPid)) killed.push({ pid: currentPid, cmd: currentCmd.slice(0, 120) });
    }
    currentCmd = '';
    currentPid = '';
  } else if (/pw-quiz|start-cdp-browser/i.test(line) && !line.includes('grep')) {
    const m = line.match(/\s(\d+)\s/);
    if (m) {
      const pid = m[1];
      if (pid !== String(process.pid) && kill(pid)) killed.push({ pid, cmd: line.trim().slice(0, 120) });
    }
  }
}

console.log(JSON.stringify({ killed }, null, 2));
