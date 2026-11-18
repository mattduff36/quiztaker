/** Shared timing policy; refresh traffic never counts as human activity. */
export const OPERATOR_IDLE_MS = 30 * 60_000;
export const OPERATOR_WARNING_MS = 2 * 60_000;
export const BROWSER_REFRESH_MS = 45_000;
export const SNAPSHOT_STALE_MS = 90_000;

export function operationsPollDelay(state: { active: boolean; visible: boolean; paused: boolean; failed: boolean }): number {
  if (!state.visible) return 60_000;
  if (state.failed) return 5_000;
  return state.active ? 2_000 : 3_000;
}
export function idlePhase(remainingMs: number): 'active' | 'warning' | 'paused' {
  return remainingMs <= 0 ? 'paused' : remainingMs <= OPERATOR_WARNING_MS ? 'warning' : 'active';
}
