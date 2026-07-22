import { cpSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHelperDirectories, getAutomationRoot, getHelperHome } from './config.js';

export function migrateLegacyLocalData(explicitSource?: string): void {
  ensureHelperDirectories();
  const marker = join(getHelperHome(), '.legacy-data-imported');
  if (existsSync(marker) && !explicitSource) return;
  const source = explicitSource || process.env.QUIZTAKER_LEGACY_DATA_DIR || join(getAutomationRoot(), 'data');
  const destination = join(getHelperHome(), 'data');
  if (existsSync(source) && source !== destination) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      cpSync(join(source, entry.name), join(destination, entry.name), {
        recursive: entry.isDirectory(),
        force: false,
        errorOnExist: false,
      });
    }
    writeFileSync(marker, `${new Date().toISOString()}\n`);
  }
}
