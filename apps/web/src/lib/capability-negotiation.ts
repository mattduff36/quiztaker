const legacyCapabilities = new Set([
  'start-browser', 'list-tabs', 'cert-status', 'cert-batch', 'cert-dry-run',
  'scorm-complete', 'container-batch', 'learn-capture',
]);

export function capabilityNegotiationError(input: {
  protocolVersion: number;
  supported: Array<{ id?: string; version?: number }>;
  capabilityId: string;
  capabilityVersion: number;
}): string | null {
  const supported = input.supported.some((item) => (
    item.id === input.capabilityId && Number(item.version) >= input.capabilityVersion
  ));
  if (input.protocolVersion < 2) {
    return legacyCapabilities.has(input.capabilityId) ? null : 'Update the Windows helper to use this action';
  }
  return supported ? null : 'The paired helper does not support this action';
}
