import { parseAutomationResult } from './outcome.js';
import type { RunOutcome } from './types.js';

export interface RunDiagnosis {
  schemaVersion: 1;
  severity: 'warning' | 'error';
  title: string;
  completed: number | null;
  total: number | null;
  likelyCause: ReturnType<typeof reasonDetails>;
  evidence: string[];
  affectedTargets: Array<{
    title: string;
    reason: string;
    diagnosis: string;
    artifact: string | null;
  }>;
  recommendations: string[];
  artifacts: string[];
}

export function reasonDetails(reason?: string) {
  const code = String(reason ?? 'unknown').toLowerCase();
  const known: Record<string, { label: string; confidence: number; explanation: string; recommendation: string }> = {
    'prerequisites-incomplete': {
      label: 'Required prerequisites are incomplete',
      confidence: 0.99,
      explanation: 'Saba has locked the selected courses until prerequisite progress is complete.',
      recommendation: 'Complete prerequisite modules, then run detection again.',
    },
    'button-not-found': {
      label: 'The Saba roster changed during the run',
      confidence: 0.85,
      explanation: 'A selected action disappeared during an Angular re-render.',
      recommendation: 'Refresh the roster and retry only the remaining items.',
    },
    'no-player-tab': {
      label: 'No supported course player appeared',
      confidence: 0.82,
      explanation: 'The launch action did not open a known SCORM or assessment player.',
      recommendation: 'Open the item manually and capture it for classification.',
    },
    'no-api': {
      label: 'No supported course API appeared',
      confidence: 0.82,
      explanation: 'The player opened without a supported SCORM API.',
      recommendation: 'Capture the player and classify it before retrying.',
    },
  };
  return {
    code,
    ...(known[code] ?? {
      label: 'The completion result could not be verified',
      confidence: 0.65,
      explanation: 'The run ended without enough evidence to confirm all selected items.',
      recommendation: 'Review the output and rerun detection after resolving the blocker.',
    }),
  };
}

export function diagnoseRun(input: {
  script: string;
  code: number | null;
  output?: string;
  outcome?: RunOutcome | null;
}): RunDiagnosis | null {
  const output = input.output ?? '';
  const structured = parseAutomationResult(output);
  const summary = output.match(/(\d+)\/(\d+)\s+confirmed (?:Successful|complete)/i);
  const completed = structured?.completed ?? (summary?.[1] ? Number(summary[1]) : null);
  const total = structured?.total ?? (summary?.[2] ? Number(summary[2]) : null);
  const failures = structured?.failures ?? [];
  const isFailure = input.code !== 0 || input.outcome?.outcome === 'failure' || failures.length > 0;
  if (!isFailure) return null;

  const primary = reasonDetails(failures[0]?.reason ?? input.outcome?.failureSignature ?? `exit-${input.code}`);
  const evidence = [...new Set(failures.flatMap((failure) => failure.evidence ?? []))].slice(0, 8);
  const artifacts = [...new Set(failures.flatMap((failure) => failure.artifact ? [failure.artifact] : []))];
  return {
    schemaVersion: 1,
    severity: input.code === 0 ? 'warning' : 'error',
    title: completed == null || total == null ? 'Not all selected items completed' : `${completed} of ${total} selected items completed`,
    completed,
    total,
    likelyCause: primary,
    evidence,
    affectedTargets: failures.map((failure) => ({
      title: failure.title,
      reason: failure.reason,
      diagnosis: reasonDetails(failure.reason).label,
      artifact: failure.artifact ?? null,
    })),
    recommendations: [primary.recommendation, 'Run detection again after resolving the blocker.'],
    artifacts,
  };
}
