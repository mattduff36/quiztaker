const blockedWhenDisabled = new Set([
  'detect',
  'class-batch',
  'slickquiz-solve',
  'open-url',
  'close-browser',
  'fit-tab',
  'tab-inspect',
  'cdp-check',
]);

export function parityEnabled(): boolean {
  return process.env.PARITY_NEW_ACTIONS !== '0';
}

export function parityAllows(capabilityId: string): boolean {
  return parityEnabled() || !blockedWhenDisabled.has(capabilityId);
}
