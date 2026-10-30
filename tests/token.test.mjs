import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenReader } from '../stitch_velly/runtime/token.mjs';

async function makeProfile(token) {
  const directory = await mkdtemp(join(tmpdir(), 'velly-profile-'));
  await writeFile(join(directory, 'auth.bin'), token);
  await writeFile(join(directory, 'Local State'), '{}');
  return directory;
}

const cleanup = (t, ...dirs) => t.after(() => Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))));

test('configured profile without storage falls back to the real Velly profile', async t => {
  const real = await makeProfile('fallback-token');
  cleanup(t, real);
  const read = createTokenReader({
    profile: join(real, 'workspace-sandbox'),
    fallbackProfile: real,
    environment: {},
    decryptDPAPI: async data => data,
    appDataResolver: async () => null,
  });
  assert.equal(await read(), 'fallback-token');
});

test('configured profile with storage wins over fallback', async t => {
  const primary = await makeProfile('primary-token');
  const fallback = await makeProfile('fallback-token');
  cleanup(t, primary, fallback);
  const read = createTokenReader({
    profile: primary,
    fallbackProfile: fallback,
    environment: {},
    decryptDPAPI: async data => data,
    appDataResolver: async () => null,
  });
  assert.equal(await read(), 'primary-token');
});

test('storage absent in every profile keeps VELY_STORAGE', async t => {
  const empty = await mkdtemp(join(tmpdir(), 'velly-empty-'));
  cleanup(t, empty);
  const read = createTokenReader({
    profile: join(empty, 'sandbox'),
    fallbackProfile: join(empty, 'real'),
    environment: {},
    decryptDPAPI: async data => data,
    appDataResolver: async () => null,
  });
  await assert.rejects(read, error => error.code === 'VELLY_STORAGE');
});
