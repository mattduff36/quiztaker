export const riskLevels = ['none', 'low', 'medium', 'high'] as const;

export interface Capability {
  id: string;
  version: number;
  script: string;
  label: string;
  description: string;
  risk: (typeof riskLevels)[number];
  mutatesCourse: boolean;
  args?: string[];
  dryRunArgs?: string[];
  card?: boolean;
  picker?: string;
  refreshAfter?: string;
  verifier: string;
}

export interface PlanTarget {
  id?: string;
  title: string;
}

export interface PlanProposal {
  planId: string;
  attemptId: string;
  userId: string;
  helperId: string;
  source: 'auto-detect' | 'manual-capability' | 'direct-readonly';
  capabilityId: string;
  capabilityVersion: number;
  script: string;
  args: string[];
  label: string;
  risk: Capability['risk'];
  mutatesCourse: boolean;
  verifier: string;
  steps: string[];
  constraints: Record<string, unknown> | null;
  targets: PlanTarget[];
  confidence: number;
  evidence: string[];
  fingerprint: string | null;
  tabIdx: number | null;
  confirmed: boolean;
  consumed: boolean;
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
}

export interface SignedJobPayload {
  jobId: string;
  planId: string;
  attemptId: string;
  helperId: string;
  capabilityId: string;
  capabilityVersion: number;
  script: string;
  args: string[];
  fingerprint: string | null;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface JobEnvelope {
  payload: SignedJobPayload;
  signature: string;
}

export interface JobEventInput {
  sequence: number;
  event: 'accepted' | 'started' | 'stdout' | 'stderr' | 'completed' | 'failed' | 'cancelled';
  data: Record<string, unknown>;
  occurredAt: string;
}

export interface RunOutcome {
  outcome: 'success' | 'failure' | 'partial' | 'cancelled';
  verified: boolean;
  status: string;
  failureSignature?: string;
  artifacts?: string[];
}

export interface HelperRelease {
  version: string;
  publishedAt: string;
  downloadUrl: string;
  sha256: string;
  minimumHelperVersion: string;
}
