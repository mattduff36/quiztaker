import { isAbsolute, relative } from 'node:path';
import { getAutomationRoot, getHelperHome } from './config.js';

export function isAllowedArtifact(file: string): boolean {
  return [getHelperHome(), getAutomationRoot()].some((root) => {
    const fromRoot = relative(root, file);
    return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
  });
}
