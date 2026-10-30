import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';
import { startBridge, syncOpenCodeKey, updateOpenCode } from '../stitch_velly/runtime/bridge.mjs';
import { catalogPath, normalizeCatalog, buildProvider, modelCard, autoChains } from '../stitch_velly/runtime/catalog.mjs';
import { ModelHealth } from '../stitch_velly/runtime/health.mjs';
import { createTokenReader } from '../stitch_velly/runtime/token.mjs';

const raw = {
  models: [
    {
      id: 'openai/gpt-6.1-sol',
      name: 'Sol',
      agent: 'codex',
      context: 1050000,
      vision: true,
      reasoning: true,
    },
    {
      id: 'openai/gpt-6-astra',
      name: 'Astra',
      agent: 'codex',
      context: 1050000,
      vision: true,
      reasoning: true,
    },
    {
      id: 'anthropic/claude-sonnet-5.5',
      name: 'Sonnet',
      agent: 'claude',
      context: 1000000,
      vision: true,
      reasoning: true,
    },
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek',
      agent: 'claude',
      context: 1048576,
      vision: false,
      reasoning: true,
    },
    {
      id: 'vendor/unverified',
      name: 'New model',
      agent: 'opencode',
      context: 128000,
      vision: false,
      reasoning: false,
    },
  ],
};
const models = normalizeCatalog(raw);
async function bridgeFor(t, options = {}) {
  const bridge = await startBridge({
    apiKey: 'local-test-key',
    tokenReader: async () => 'test-token',
    initialModels: models,
    refreshMs: 0,
    chains: { responses: [models[0].id, models[1].id], messages: [models[2].id, models[3].id] },
    ...options,
  });
  t.after(() => bridge.close());
  return bridge;
}
const call = (bridge, path, body) =>
  fetch(bridge.baseURL + path, {
    method: 'POST',
    headers: { authorization: 'Bearer local-test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('Messages preserves instructions, tools, image content, history and exact CLI identity', async t => {
  let captured;
  const bridge = await bridgeFor(t, {
    fetchImpl: async (url, options) => {
      captured = { url, headers: options.headers, body: JSON.parse(options.body) };
      return Response.json({ content: [{ type: 'text', text: 'OK' }] });
    },
  });
  const request = {
    model: models[2].id,
    max_tokens: 4000,
    system: [{ type: 'text', text: 'User system instructions' }],
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }] },
    ],
    tools: [{ name: 'read', input_schema: { type: 'object' } }],
    thinking: { type: 'adaptive' },
  };
  const response = await call(bridge, '/messages', request);
  assert.equal(response.status, 200);
  assert.equal(captured.url, 'https://velly.one/v1/messages');
  assert.equal(captured.headers['user-agent'], 'claude-cli/2.1.308 (external, sdk-cli)');
  assert.equal(captured.headers.authorization, 'Bearer test-token');
  assert.deepEqual(captured.body.system.slice(1), request.system);
  assert.deepEqual(captured.body.messages, request.messages);
  assert.deepEqual(captured.body.tools, request.tools);
  assert.deepEqual(captured.body.thinking, request.thinking);
  assert.equal(captured.body.max_tokens, 4000);
});

test('Responses and Chat retain their native tool schemas and options', async t => {
  const requests = [];
  const bridge = await bridgeFor(t, {
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return Response.json({ ok: true });
    },
  });
  const responseBody = {
    model: models[0].id,
    input: [{ role: 'user', content: 'do it' }],
    instructions: 'keep me',
    tools: [{ type: 'function', name: 'write', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' },
    max_output_tokens: 12000,
  };
  assert.equal((await call(bridge, '/responses', responseBody)).status, 200);
  assert.deepEqual(requests[0].body, { ...responseBody, store: false });
  const chatBody = {
    model: models[4].id,
    messages: [{ role: 'user', content: 'do it' }],
    tools: [{ type: 'function', function: { name: 'write' } }],
    temperature: 0.2,
  };
  assert.equal((await call(bridge, '/chat/completions', chatBody)).status, 200);
  assert.deepEqual(requests[1].body, chatBody);
});

test('rejects invalid local key, JSON and protocol without invoking upstream', async t => {
  let calls = 0;
  const bridge = await bridgeFor(t, {
    fetchImpl: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.equal((await fetch(bridge.baseURL + '/models')).status, 401);
  const invalid = await fetch(bridge.baseURL + '/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer local-test-key' },
    body: '{',
  });
  assert.equal(invalid.status, 400);
  assert.equal((await call(bridge, '/messages', { model: models[0].id })).status, 503);
  assert.equal(calls, 0);
});

test('rotated token retries authorization once; unchanged token never loops', async t => {
  const auth = [];
  let forced = 0;
  const bridge = await bridgeFor(t, {
    tokenReader: async force => {
      if (force) forced++;
      return force ? 'rotated' : 'old';
    },
    fetchImpl: async (url, options) => {
      auth.push(options.headers.authorization);
      return auth.length === 1 ? new Response('', { status: 401 }) : Response.json({ ok: true });
    },
  });
  assert.equal(
    (await call(bridge, '/responses', { model: models[0].id, input: 'ok' })).status,
    200
  );
  assert.deepEqual(auth, ['Bearer old', 'Bearer rotated']);
  assert.equal(forced, 1);
  let calls = 0;
  const same = await bridgeFor(t, {
    fetchImpl: async () => {
      calls++;
      return new Response('', { status: 401 });
    },
  });
  assert.equal((await call(same, '/responses', { model: models[0].id, input: 'ok' })).status, 401);
  assert.equal(calls, 2);
});

test('model 401 with accepted catalog token does not demand sign-in or replay generation', async t => {
  const paths = [];
  const bridge = await bridgeFor(t, {
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      paths.push(path);
      return path === '/models' ? Response.json(raw) : new Response('', { status: 401 });
    },
  });
  const response = await call(bridge, '/messages', { model: models[2].id, messages: [] });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-velly-auth-source'), 'model_route');
  assert.equal((await response.json()).error.source, 'model_route');
  assert.deepEqual(paths, ['/v1/messages', '/models']);
});

test('catalog requests carry the platform gate the official client uses', async t => {
  assert.equal(catalogPath('win32'), '/models?platform=win32');
  assert.equal(catalogPath('linux'), '/models');
  const urls = [];
  const bridge = await bridgeFor(t, {
    platform: 'win32',
    fetchImpl: async url => {
      urls.push(url);
      return Response.json(raw);
    },
  });
  const origin = new URL(bridge.baseURL).origin;
  const response = await fetch(origin + '/control/refresh', {
    method: 'POST',
    headers: { authorization: 'Bearer local-test-key' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(urls, ['https://velly.one/models?platform=win32']);
});

test('provider OAuth error preserves HTTP status but explains the upstream session failure', async t => {
  const bridge = await bridgeFor(t, {
    fetchImpl: async () => new Response('OAuth session expired and could not be refreshed', { status: 529 }),
  });
  const response = await call(bridge, '/messages', { model: models[2].id, messages: [] });
  assert.equal(response.status, 529);
  assert.equal((await response.json()).error.source, 'upstream_session');
});

test('local storage failure is distinct from server token rejection', async t => {
  const bridge = await bridgeFor(t, {
    tokenReader: async () => { throw Object.assign(new Error('fixture'), { code: 'VELLY_STORAGE' }); },
    fetchImpl: async () => { throw new Error('must not call upstream'); },
  });
  const response = await call(bridge, '/responses', { model: models[0].id, input: 'ok' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.source, 'local_storage');
});

test('catalog refresh is single-flight, keeps last good metadata and does not mark generation healthy', async t => {
  let calls = 0;
  let fail = false;
  const bridge = await bridgeFor(t, {
    fetchImpl: async () => {
      calls++;
      await new Promise(r => setTimeout(r, 10));
      return fail ? new Response('', { status: 503 }) : Response.json(raw);
    },
  });
  await Promise.all([bridge.refresh(), bridge.refresh(), bridge.refresh()]);
  assert.equal(calls, 1);
  assert.equal(bridge.status().rows[0].status, 'unknown');
  const timestamp = bridge.status().refreshedAt;
  fail = true;
  await bridge.refresh();
  assert.equal(bridge.status().refreshedAt, timestamp);
  assert.equal(bridge.status().rows.length, 5);
  assert.ok(bridge.status().catalogError);
});

test('explicit model never switches; automatic alias falls back and isolates failed model', async t => {
  const calls = [];
  const bridge = await bridgeFor(t, {
    fetchImpl: async (url, options) => {
      const model = JSON.parse(options.body).model;
      calls.push(model);
      return model === models[0].id
        ? new Response('temporary', { status: 529 })
        : Response.json({ model });
    },
    chains: { coding: [models[0].id, models[1].id] },
  });
  assert.equal(
    (await call(bridge, '/responses', { model: models[0].id, input: 'ok' })).status,
    529
  );
  assert.deepEqual(calls, [models[0].id]);
  const response = await call(bridge, '/responses', { model: 'auto/coding', input: 'ok' });
  assert.equal(response.headers.get('x-velly-selected-model'), models[1].id);
  assert.equal((await response.json()).model, models[1].id);
  assert.equal(bridge.status().rows.find(m => m.id === models[0].id).status, 'cooldown');
  assert.equal(bridge.status().rows.find(m => m.id === models[2].id).status, 'unknown');
});

test('automatic alias tries next model before headers and never retries request errors', async t => {
  const calls = [];
  const bridge = await bridgeFor(t, {
    chains: { coding: [models[0].id, models[1].id] },
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body).model);
      return calls.length === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true });
    },
  });
  assert.equal(
    (await call(bridge, '/responses', { model: 'auto/coding', input: 'ok' })).status,
    200
  );
  assert.deepEqual(calls, [models[0].id, models[1].id]);
  const bad = await bridgeFor(t, {
    chains: { coding: [models[0].id, models[1].id] },
    fetchImpl: async () => new Response('', { status: 400 }),
  });
  assert.equal((await call(bad, '/responses', { model: 'auto/coding', input: 'ok' })).status, 400);
  assert.equal(bad.status().rows[1].status, 'unknown');
});

test('broken SSE is not replayed after output begins', async t => {
  let calls = 0;
  const bridge = await bridgeFor(t, {
    chains: { coding: [models[0].id, models[1].id] },
    fetchImpl: async () => {
      calls++;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.output_text.delta\ndata: {"delta":"started"}\n\n'
            )
          );
          setTimeout(() => controller.error(new Error('transport lost')), 25);
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await call(bridge, '/responses', {
    model: 'auto/coding',
    input: 'ok',
    stream: true,
  });
  await assert.rejects(response.text());
  assert.equal(calls, 1);
  assert.equal(bridge.status().rows[0].status, 'cooldown');
});

test('SSE error event is forwarded and recorded, without trying a second model', async t => {
  let calls = 0;
  const bridge = await bridgeFor(t, {
    fetchImpl: async () => {
      calls++;
      return new Response('event: error\ndata: {"type":"error"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const response = await call(bridge, '/responses', {
    model: 'auto/responses',
    input: 'ok',
    stream: true,
  });
  assert.match(await response.text(), /event: error/);
  assert.equal(calls, 1);
  assert.equal(bridge.status().rows[0].status, 'cooldown');
});

test('half-open recovery allows only one probe and respects Retry-After', () => {
  let now = 1000;
  const health = new ModelHealth({ now: () => now });
  health.record('a', 429, '2');
  assert.equal(health.available('a'), false);
  assert.equal(health.available('b'), true);
  now = 3001;
  assert.equal(health.reserve('a'), true);
  assert.equal(health.reserve('a'), false);
  health.record('a', 200);
  assert.equal(health.available('a'), true);
});

test('cards use reported context, conservative auto capabilities and explicit client output cap', () => {
  const provider = buildProvider(
    models,
    { coding: [models[2].id, models[3].id] },
    'http://127.0.0.1:1/v1',
    'local'
  );
  assert.equal(provider.models[models[0].id].limit.context, 1050000);
  assert.equal(provider.models['auto/coding'].limit.context, 1000000);
  assert.equal(provider.models['auto/coding'].attachment, false);
  assert.equal(provider.models['auto/coding'].limit.output, 32000);
  assert.equal(provider.models[models[4].id].tool_call, true);
  assert.equal(provider.models[models[0].id].provider.npm, '@ai-sdk/openai');
  assert.throws(() => normalizeCatalog({ models: [{ id: 'x' }, { id: 'x' }] }), /duplicate/);
});

test('catalog treats every upstream model as tools-capable', () => {
  const [model] = normalizeCatalog({
    models: [{ id: 'moonshotai/kimi-k3.1-pro', agent: 'claude', context: 1048576 }],
  });
  assert.equal(model.toolsVerified, true);
  assert.equal(modelCard(model).tool_call, true);
});

test('autoChains groups eligible models per protocol and skips singletons and small contexts', () => {
  const catalog = normalizeCatalog({
    models: [
      { id: 'a/r1', agent: 'codex', context: 200000 },
      { id: 'b/m1', agent: 'claude', context: 200000 },
      { id: 'c/r2', agent: 'codex', context: 200000 },
      { id: 'd/small', agent: 'codex', context: 32000 },
      { id: 'e/chat1', agent: 'opencode', context: 200000 },
    ],
  });
  assert.deepEqual(autoChains(catalog), { responses: ['a/r1', 'c/r2'] });
});

test('autoChains keeps catalog order, fixed protocol order and caps chains at eight members', () => {
  const catalog = normalizeCatalog({
    models: [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `v/r${i}`, agent: 'codex', context: 200000 })),
      { id: 'w/m0', agent: 'claude', context: 200000 },
      { id: 'w/m1', agent: 'claude', context: 200000 },
    ],
  });
  const chains = autoChains(catalog);
  assert.deepEqual(Object.keys(chains), ['responses', 'messages']);
  assert.deepEqual(
    chains.responses,
    ['v/r0', 'v/r1', 'v/r2', 'v/r3', 'v/r4', 'v/r5', 'v/r6', 'v/r7']
  );
  assert.deepEqual(chains.messages, ['w/m0', 'w/m1']);
});

test('export preserves other providers and options, backs up and removes only legacy bridge hook', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'velly-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'opencode.json');
  const original = {
    model: 'other/model',
    provider: { other: { models: {} } },
    plugin: ['oh-my-openagent', 'file:///old/velly-opencode-plugin.mjs'],
  };
  await writeFile(path, JSON.stringify(original));
  const result = await updateOpenCode(path, { name: 'Velly', models: { test: {} } });
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.model, original.model);
  assert.deepEqual(config.provider.other, original.provider.other);
  assert.equal(config.plugin[0], 'oh-my-openagent');
  assert.ok(config.plugin[1].endsWith('/opencode-plugin.mjs'));
  assert.equal(config.plugin.length, 2);
  assert.deepEqual(JSON.parse(await readFile(result.backup, 'utf8')), original);
});

test('stale bridge key in opencode config is synced only for the matching baseURL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'velly-key-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'opencode.json');
  const original = {
    provider: {
      velly: { options: { baseURL: 'http://127.0.0.1:38761/v1', apiKey: 'old-key' } },
      other: { options: { baseURL: 'http://127.0.0.1:38761/v1', apiKey: 'old-key' } },
    },
  };
  await writeFile(path, JSON.stringify(original));
  const synced = await syncOpenCodeKey(path, 'http://127.0.0.1:38761/v1', 'new-key');
  assert.equal(synced.updated, true);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(config.provider.velly.options.apiKey, 'new-key');
  assert.equal(config.provider.other.options.apiKey, 'old-key');
  const again = await syncOpenCodeKey(path, 'http://127.0.0.1:38761/v1', 'new-key');
  assert.equal(again.updated, false);
  const foreign = await syncOpenCodeKey(path, 'http://127.0.0.1:9999/v1', 'x');
  assert.equal(foreign.updated, false);
  assert.equal(JSON.parse(await readFile(synced.backup, 'utf8')).provider.velly.options.apiKey, 'old-key');
});

test('token reader decrypts AES-GCM, observes rotation and can bypass cached stamp', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'velly-token-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encrypt = value => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([
      Buffer.from('v10'),
      iv,
      cipher.update(value),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  };
  await writeFile(
    join(directory, 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPImock').toString('base64') } })
  );
  await writeFile(join(directory, 'auth.bin'), encrypt('first-test-token'));
  const reader = createTokenReader({
    profile: directory,
    environment: {},
    decryptDPAPI: async () => Buffer.from(key),
  });
  assert.equal(await reader(), 'first-test-token');
  await writeFile(join(directory, 'auth.bin'), encrypt('second-test-token-longer'));
  assert.equal(await reader(), 'second-test-token-longer');
  assert.equal(await reader(true), 'second-test-token-longer');
});

test('every catalog model skips manual probe without sending generation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'velly-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const bridge = await bridgeFor(t, {
    dataDir: directory,
    fetchImpl: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.equal((await bridge.probe(models[0].id)).skipped, true);
  assert.equal((await bridge.probe(models[4].id)).skipped, true);
  assert.equal(calls, 0);
});

test('automatic server-side continuation is rejected before upstream calls', async t => {
  let calls = 0;
  const bridge = await bridgeFor(t, {
    fetchImpl: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.equal(
    (
      await call(bridge, '/responses', {
        model: 'auto/responses',
        previous_response_id: 'server-state',
        input: 'ok',
      })
    ).status,
    400
  );
  assert.equal(calls, 0);
});

test('bridge without explicit chains builds auto chains from the fetched catalog', async t => {
  const bridge = await startBridge({
    apiKey: 'local-test-key',
    tokenReader: async () => 'test-token',
    refreshMs: 0,
    fetchImpl: async () => Response.json(raw),
  });
  t.after(() => bridge.close());
  await bridge.refresh();
  const expected = {
    responses: [models[0].id, models[1].id],
    messages: [models[2].id, models[3].id],
  };
  assert.deepEqual(bridge.status().chains, expected);
  assert.ok(bridge.provider().models['auto/responses']);
  assert.ok(bridge.provider().models['auto/messages']);
  assert.equal(bridge.provider().models['auto/chat'], undefined);
});

test('explicit chains override the dynamically built catalog chains', async t => {
  const bridge = await startBridge({
    apiKey: 'local-test-key',
    tokenReader: async () => 'test-token',
    initialModels: models,
    refreshMs: 0,
    chains: { coding: [models[0].id, models[1].id] },
  });
  t.after(() => bridge.close());
  assert.deepEqual(bridge.status().chains, { coding: [models[0].id, models[1].id] });
  assert.ok(bridge.provider().models['auto/coding']);
  assert.equal(bridge.provider().models['auto/responses'], undefined);
});
