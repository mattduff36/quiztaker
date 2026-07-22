import type { RunOutcome } from './types.js';
import { getCapabilityForRun } from './capabilities.js';

interface StructuredFailure {
  title: string;
  reason: string;
  artifact?: string;
  evidence?: string[];
}

interface AutomationResult {
  completed: number;
  total: number;
  failures?: StructuredFailure[];
}

export function parseAutomationResult(output = ''): AutomationResult | null {
  const matches = [...String(output).matchAll(/^AUTOMATION_RESULT\s+(.+)$/gm)];
  const value = matches.at(-1)?.[1];
  if (!value) return null;
  try {
    return JSON.parse(value) as AutomationResult;
  } catch {
    return null;
  }
}

export function classifyOutcome(input: {
  script: string;
  code: number | null;
  output?: string;
}): RunOutcome {
  const text = String(input.output ?? '');
  const structured = parseAutomationResult(text);
  const capture = text.match(/"dir"\s*:\s*"([^"]+)"/i)?.[1]?.replace(/\\\\/g, '/');
  const artifacts = [
    ...(capture ? [capture] : []),
    ...(structured?.failures ?? []).flatMap((failure) => failure.artifact ? [failure.artifact] : []),
  ];

  if (input.code !== 0) {
    const signature = text.match(/SCORM API not found|no-api|no-player-tab|button-not-found|TimeoutError|ECONNREFUSED/i)?.[0]
      ?? `exit-${input.code}`;
    return {
      outcome: 'failure',
      verified: false,
      status: `exit ${input.code}`,
      failureSignature: signature.toLowerCase(),
      artifacts,
    };
  }

  if (structured) {
    const isComplete = structured.total > 0 && structured.completed === structured.total;
    const result: RunOutcome = {
      outcome: isComplete ? 'success' : 'failure',
      verified: isComplete,
      status: `${structured.completed}/${structured.total} completed`,
      artifacts: [...new Set(artifacts)],
    };
    if (!isComplete) result.failureSignature = structured.failures?.[0]?.reason ?? 'partial-completion';
    return result;
  }

  if (input.script === 'pw-learn-capture.js' && /"ok"\s*:\s*true/i.test(text)) {
    return { outcome: 'success', verified: true, status: 'capture-written', artifacts };
  }
  if (/(\d+)\/\1\s+confirmed (?:Successful|complete)/i.test(text)) {
    return { outcome: 'success', verified: true, status: 'all-targets-complete', artifacts };
  }
  if (
    /"lesson_status"\s*:\s*"passed"/i.test(text) ||
    (/"completion"\s*:\s*"completed"/i.test(text) && /"success"\s*:\s*"passed"/i.test(text))
  ) return { outcome: 'success', verified: true, status: 'passed', artifacts };
  if (/Dry run:|Course roster:/i.test(text)) {
    return { outcome: 'success', verified: true, status: 'dry-run', artifacts };
  }
  const capability = getCapabilityForRun(input.script);
  if (capability?.verifier === 'process-exit') {
    return { outcome: 'success', verified: true, status: 'process-exit-0', artifacts };
  }
  return { outcome: 'success', verified: false, status: 'process-exit-0', artifacts };
}
