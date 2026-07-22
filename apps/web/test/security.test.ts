import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPairingCodeForOrigin } from '../src/lib/pairing-code.js';

test('binds pairing codes to the control-plane origin', () => {
  const localHash = hashPairingCodeForOrigin('ABCD-2345', 'http://localhost:4000/helper');

  assert.equal(
    localHash,
    hashPairingCodeForOrigin('abcd 2345', 'http://localhost:4000/api/helper/pair'),
  );
  assert.notEqual(
    localHash,
    hashPairingCodeForOrigin('ABCD-2345', 'https://www.vitriol.co.uk/helper'),
  );
});
