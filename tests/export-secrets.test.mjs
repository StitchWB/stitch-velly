import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSecrets } from '../stitch_velly/runtime/export-secrets.mjs';
import { createTokenReader } from '../stitch_velly/runtime/token.mjs';

for (const includeDeviceKey of [false, true]) {
  test(`exports the chosen secrets without returning their values: device=${includeDeviceKey}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'velly-export-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const calls = [];
    const result = await exportSecrets({
      directory, includeDeviceKey,
      readSecret: async file => { calls.push(file); return file === 'auth.bin' ? 'fixture-api' : 'fixture-device'; },
    });
    const saved = JSON.parse(await readFile(result.path, 'utf8'));
    assert.equal(saved.access_token, 'fixture-api');
    assert.equal(saved.device_key, includeDeviceKey ? 'fixture-device' : undefined);
    assert.deepEqual(calls, includeDeviceKey ? ['auth.bin', 'secret-device-key.bin'] : ['auth.bin']);
    assert.ok(!JSON.stringify(result).includes('fixture-'));
    const second = await exportSecrets({ directory, readSecret: async () => 'second' });
    assert.notEqual(result.path, second.path);
  });
}

test('device key is read from its own storage and never replaced by VELLY_TOKEN', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'velly-device-test-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, 'secret-device-key.bin'), 'fixture-encrypted');
  await writeFile(join(profile, 'Local State'), '{}');
  const read = createTokenReader({ profile, fileName: 'secret-device-key.bin', environment: { VELLY_TOKEN: 'wrong-api-token' }, decryptDPAPI: async () => Buffer.from('fixture-device-key') });
  assert.equal(await read(), 'fixture-device-key');
  assert.throws(() => createTokenReader({ fileName: '../other-secret' }), /Unknown Velly secret/);
});
