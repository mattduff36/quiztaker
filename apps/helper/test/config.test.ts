import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PRODUCTION_CONTROL_PLANE_URL,
  getConfigPath,
  migrateLegacyConfig,
  protectSecret,
  readConfig,
  unprotectSecret,
  writeConfig,
  type HelperConfig,
} from '../src/config.js';

test('protects and restores a helper secret with the platform credential store', {
  skip: process.platform !== 'win32',
}, () => {
  const secret = `helper-secret-${randomUUID()}`;
  const protectedSecret = protectSecret(secret);

  assert.match(protectedSecret, /^dpapi:/);
  assert.doesNotMatch(protectedSecret, new RegExp(secret));
  assert.equal(unprotectSecret(protectedSecret), secret);
});

test('stores production and local-development pairings independently', () => {
  withHelperHome((helperHome) => {
    const productionConfig = createConfig(PRODUCTION_CONTROL_PLANE_URL, 'production-helper');
    const localConfig = createConfig('http://localhost:4000', 'local-helper');

    writeConfig(productionConfig, helperHome);
    writeConfig(localConfig, helperHome);

    assert.notEqual(
      getConfigPath(PRODUCTION_CONTROL_PLANE_URL, helperHome),
      getConfigPath('http://localhost:4000', helperHome),
    );
    assert.deepEqual(readConfig(PRODUCTION_CONTROL_PLANE_URL, helperHome), productionConfig);
    assert.deepEqual(readConfig('http://localhost:4000', helperHome), localConfig);
  });
});

test('migrates a legacy localhost pairing without selecting it for production', () => {
  withHelperHome((helperHome) => {
    const localConfig = createConfig('http://localhost:4000', 'local-helper');
    const legacyPath = join(helperHome, 'config.json');
    writeFileSync(legacyPath, JSON.stringify(localConfig));

    const migration = migrateLegacyConfig(helperHome);

    assert.equal(migration.status, 'migrated');
    assert.equal(migration.controlPlaneUrl, 'http://localhost:4000');
    assert.deepEqual(readConfig('http://localhost:4000', helperHome), localConfig);
    assert.equal(readConfig(PRODUCTION_CONTROL_PLANE_URL, helperHome), null);
    assert.equal(existsSync(legacyPath), true);
    assert.deepEqual(JSON.parse(readFileSync(legacyPath, 'utf8')), localConfig);
  });
});

test('migrates a legacy production pairing into the production slot', () => {
  withHelperHome((helperHome) => {
    const productionConfig = createConfig(PRODUCTION_CONTROL_PLANE_URL, 'production-helper');
    writeFileSync(join(helperHome, 'config.json'), JSON.stringify(productionConfig));

    assert.equal(migrateLegacyConfig(helperHome).status, 'migrated');
    assert.deepEqual(readConfig(PRODUCTION_CONTROL_PLANE_URL, helperHome), productionConfig);
    assert.equal(migrateLegacyConfig(helperHome).status, 'already-migrated');
  });
});

test('does not replace an existing scoped pairing during legacy migration', () => {
  withHelperHome((helperHome) => {
    const currentConfig = createConfig('http://localhost:4000', 'current-helper');
    const legacyConfig = createConfig('http://localhost:4000', 'legacy-helper');
    writeConfig(currentConfig, helperHome);
    writeFileSync(join(helperHome, 'config.json'), JSON.stringify(legacyConfig));

    assert.equal(migrateLegacyConfig(helperHome).status, 'already-migrated');
    assert.deepEqual(readConfig('http://localhost:4000', helperHome), currentConfig);
  });
});

function createConfig(controlPlaneUrl: string, helperId: string): HelperConfig {
  return {
    schemaVersion: 1,
    controlPlaneUrl,
    helperId,
    encryptedDeviceSecret: 'dpapi:test-value',
    deviceName: 'Test device',
    pairedAt: '2026-07-23T00:00:00.000Z',
  };
}

function withHelperHome(callback: (helperHome: string) => void): void {
  const helperHome = mkdtempSync(join(tmpdir(), 'vitriol-helper-config-'));
  try {
    callback(helperHome);
  } finally {
    rmSync(helperHome, { recursive: true, force: true });
  }
}
