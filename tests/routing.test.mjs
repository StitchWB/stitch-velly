import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from '../stitch_velly/runtime/bridge.mjs';
import { normalizeCatalog, buildProvider } from '../stitch_velly/runtime/catalog.mjs';
import VellyBridgePlugin from '../stitch_velly/runtime/opencode-plugin.mjs';

const models = normalizeCatalog({
  models: [
    { id: 'openai/gpt-6.1-sol', agent: 'codex', context: 1050000, vision: true, reasoning: true },
    { id: 'openai/gpt-6-astra', agent: 'codex', context: 1050000, vision: true, reasoning: true },
    {
      id: 'anthropic/claude-sonnet-5.5',
      agent: 'claude',
      context: 1000000,
      vision: true,
      reasoning: true,
    },
  ],
});
async function setup(t, options = {}) {
  const bridge = await startBridge({
    initialModels: models,
    apiKey: 'test-key',
    tokenReader: async () => 'fixture',
    refreshMs: 0,
    chains: { responses: [models[0].id, models[1].id], messages: [models[2].id] },
    ...options,
  });
  t.after(() => bridge.close());
  return bridge;
}
const headers = { authorization: 'Bearer test-key', 'content-type': 'application/json' };
const invoke = bridge =>
  fetch(bridge.baseURL + '/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: models[0].id, input: 'local fixture' }),
  });

test('protocol-scoped discovery prevents cross-protocol gateway imports', async t => {
  let calls = 0;
  const bridge = await setup(t, {
    fetchImpl: async () => {
      calls++;
      return Response.json({});
    },
  });
  const base = bridge.baseURL.replace('/v1', '');
  const catalog = await (await fetch(base + '/messages/v1/models', { headers })).json();
  assert(catalog.data.length >= 1);
  assert(catalog.data.every(m => m.protocol === 'messages'));
  assert.equal(
    (await fetch(base + '/messages/v1/responses', { method: 'POST', headers, body: '{}' })).status,
    404
  );
  assert.equal(calls, 0);
});

test('startup hook updates model cards while preserving unrelated configuration', async t => {
  const bridge = await setup(t);
  const config = {
    model: 'other/model',
    provider: { other: { name: 'Other' }, velly: bridge.provider() },
  };
  config.provider.velly.models[models[0].id].limit.context = 128000;
  const plugin = await VellyBridgePlugin();
  await plugin.config(config);
  assert.equal(config.provider.velly.models[models[0].id].limit.context, 1050000);
  assert.equal(config.model, 'other/model');
  assert.equal(config.provider.other.name, 'Other');
});

test('a removed catalog model does not disable the remaining automatic chain', () => {
  const provider = buildProvider(
    models,
    { coding: ['removed/model', models[0].id] },
    'http://127.0.0.1:1/v1',
    'local'
  );
  assert.equal(provider.models['auto/coding'].limit.context, 1050000);
});

test('local concurrency admission applies after request parsing', async t => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let arrived;
  const firstArrived = new Promise(resolve => {
    arrived = resolve;
  });
  const bridge = await setup(t, {
    maxInFlight: 1,
    fetchImpl: async () => {
      arrived();
      await gate;
      return Response.json({ ok: true });
    },
  });
  const first = invoke(bridge);
  await firstArrived;
  try {
    assert.equal((await invoke(bridge)).status, 429);
  } finally {
    release();
  }
  assert.equal((await first).status, 200);
  assert.equal(bridge.status().inFlight, 0);
});

test('an account authorization failure checks catalog but never selects another model', async t => {
  let calls = 0;
  const bridge = await setup(t, {
    fetchImpl: async () => {
      calls++;
      return new Response('', { status: 401 });
    },
  });
  const response = await fetch(bridge.baseURL + '/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'auto/responses', input: 'fixture' }),
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 2);
  assert.equal((await response.json()).error.source, 'velly_token');
  assert.equal(bridge.status().rows[1].status, 'unknown');
});
