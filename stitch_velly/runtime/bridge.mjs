import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, rename, copyFile, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ModelHealth } from './health.mjs';
import { catalogPath, normalizeCatalog, buildProvider, defaultChains } from './catalog.mjs';
import { authDiagnostic, errorPreview } from './auth-diagnostics.mjs';

const identity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const paths = { messages: '/messages', responses: '/responses', chat: '/chat/completions' };

export function adaptMessages(body) {
  const system =
    typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : body.system || [];
  if (!Array.isArray(system)) throw new Error('Invalid system blocks');
  return {
    ...body,
    system: [{ type: 'text', text: identity }, ...system.filter(block => block?.text !== identity)],
  };
}

export async function writeJson(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function updateOpenCode(path, provider) {
  const raw = await readFile(path, 'utf8');
  const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  config.provider ||= {};
  config.provider.velly = provider;
  config.plugin ||= [];
  config.plugin = config.plugin.filter(
    p => typeof p !== 'string' || !/\/velly-opencode-plugin\.mjs$/.test(p.replaceAll('\\', '/'))
  );
  const hook = new URL('./opencode-plugin.mjs', import.meta.url).href;
  if (!config.plugin.includes(hook)) config.plugin.push(hook);
  const backup = `${path}.bak-velly-${Date.now()}-${randomUUID()}`;
  await copyFile(path, backup);
  if ((await readFile(path, 'utf8')) !== raw)
    throw new Error('OpenCode configuration changed concurrently');
  await writeJson(path, config);
  return { models: Object.keys(provider.models).length, backup, restartRequired: true };
}

export async function syncOpenCodeKey(path, baseURL, apiKey) {
  const raw = await readFile(path, 'utf8');
  const config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const options = config.provider?.velly?.options;
  if (!options || options.baseURL !== baseURL || options.apiKey === apiKey)
    return { updated: false };
  options.apiKey = apiKey;
  const backup = `${path}.bak-velly-${Date.now()}-${randomUUID()}`;
  await copyFile(path, backup);
  if ((await readFile(path, 'utf8')) !== raw)
    throw new Error('OpenCode configuration changed concurrently');
  await writeJson(path, config);
  return { updated: true, backup };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024 * 1024)
      throw Object.assign(new Error('Request exceeds 64 MiB'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

export async function startBridge({
  dataDir,
  apiKey,
  tokenReader,
  fetchImpl = fetch,
  upstream = 'https://velly.one',
  platform = process.platform,
  port = 0,
  refreshMs = 600000,
  chains = defaultChains,
  userAgent = 'claude-cli/2.1.308 (external, sdk-cli)',
  outputLimit = 32000,
  maxInFlight = 4,
  health = new ModelHealth(),
  initialModels = [],
} = {}) {
  if (!apiKey || !tokenReader) throw new Error('Missing bridge credentials');
  let models = initialModels;
  let refreshedAt = null;
  let catalogError = null;
  let refreshing;
  let inFlight = 0;
  let closed = false;
  let selections = [];
  const controllers = new Set();
  const catalogFile = dataDir && join(dataDir, 'catalog.json');
  if (catalogFile) {
    try {
      const saved = JSON.parse(await readFile(catalogFile, 'utf8'));
      models = normalizeCatalog(saved.raw);
      refreshedAt = saved.refreshedAt;
    } catch {}
  }
  if (dataDir) {
    try {
      const saved = JSON.parse(await readFile(join(dataDir, 'health.json'), 'utf8'));
      for (const [id, value] of saved.states || [])
        if (typeof id === 'string' && value && Number.isFinite(value.retryAt))
          health.states.set(id, value);
      selections = Array.isArray(saved.selections) ? saved.selections.slice(-50) : [];
    } catch {}
  }
  let persisting = Promise.resolve();
  function persistHealth() {
    if (dataDir)
      persisting = persisting
        .then(() =>
          writeJson(join(dataDir, 'health.json'), { states: [...health.states], selections })
        )
        .catch(() => {});
    return persisting;
  }
  let baseURL;
  const effectiveModels = () =>
    models.map(m => ({
      ...m,
      toolsVerified: m.toolsVerified || health.get(m.id).toolsVerified === true,
    }));
  const provider = () => buildProvider(effectiveModels(), chains, baseURL, apiKey, outputLimit);
  const status = () => ({
    running: true,
    baseURL,
    refreshedAt,
    catalogError,
    inFlight,
    rows: effectiveModels().map(m => ({
      ...m,
      ...health.get(m.id),
      historicallyVerified: m.toolsVerified,
    })),
    chains,
    lastSelection: selections.at(-1) || null,
  });
  async function authorizedFetch(url, options) {
    let token = await tokenReader();
    let response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      headers: { ...options.headers, authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      const updated = await tokenReader(true);
      if (updated !== token) {
        await response.body?.cancel();
        token = updated;
        response = await fetchImpl(url, {
          ...options,
          redirect: 'error',
          headers: { ...options.headers, authorization: `Bearer ${token}` },
        });
      }
    }
    return response;
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const response = await authorizedFetch(`${upstream}${catalogPath(platform)}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
        const raw = await response.json();
        const next = normalizeCatalog(raw);
        if (!next.length) throw new Error('Empty Velly catalog');
        const timestamp = new Date().toISOString();
        if (catalogFile) await writeJson(catalogFile, { raw, refreshedAt: timestamp });
        models = next;
        refreshedAt = timestamp;
        catalogError = null;
      } catch {
        catalogError =
          'Catalog refresh failed; last successful catalog retained. Check Velly sign-in and network.';
      }
      return { refreshedAt, catalogError, models: models.length };
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  function candidates(name, protocol, body) {
    const automatic = name.startsWith('auto/');
    const ids = automatic ? chains[name.slice(5)] || [] : [name];
    const result = ids
      .map(id => effectiveModels().find(m => m.id === id))
      .filter(m => m?.protocol === protocol);
    if (!automatic) return result;
    const images = JSON.stringify([body.messages, body.input]).includes('"image');
    const reasoning = !!(body.reasoning || body.thinking);
    return result.filter(
      m =>
        health.available(m.id) &&
        (!body.tools?.length || m.toolsVerified) &&
        (!images || m.vision === true) &&
        (!reasoning || m.reasoning === true)
    );
  }
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    res.on('close', () => {
      controller.abort();
      controllers.delete(controller);
    });
    const json = (code, value) => {
      if (!res.destroyed) {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(value));
      }
    };
    let selected;
    let admitted = false;
    try {
      if (req.headers.authorization !== `Bearer ${apiKey}` && req.headers['x-api-key'] !== apiKey) {
        json(401, { error: { message: 'Local bridge authentication required' } });
        return;
      }
      let path = new URL(req.url, 'http://localhost').pathname;
      const scoped = path.match(/^\/(messages|responses|chat)(\/v1(?:\/.*)?)$/);
      const scope = scoped?.[1];
      if (scoped) path = scoped[2];
      if (req.method === 'GET' && path === '/control/status') {
        json(200, status());
        return;
      }
      if (req.method === 'GET' && path === '/control/provider') {
        json(200, provider());
        return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        const advertised = [
          ...models,
          ...Object.entries(provider().models)
            .filter(([id]) => id.startsWith('auto/'))
            .map(([id, card]) => ({
              id,
              context: card.limit.context,
              protocol: models.find(m => chains[id.slice(5)].includes(m.id))?.protocol,
            })),
        ].filter(m => !scope || m.protocol === scope);
        json(200, {
          object: 'list',
          data: advertised.map(m => ({
            id: m.id,
            object: 'model',
            owned_by: 'velly',
            context_window: m.context,
            protocol: m.protocol,
            generation_status: health.get(m.id).status,
          })),
        });
        return;
      }
      if (req.method === 'POST' && path === '/control/refresh') {
        json(200, await refresh());
        return;
      }
      if (req.method === 'POST' && path === '/control/probe') {
        const body = await readBody(req);
        json(200, await probe(body.model));
        return;
      }
      if (req.method === 'POST' && path === '/control/export') {
        const body = await readBody(req);
        if (!Object.keys(provider().models).length) {
          json(503, {
            error: { message: 'No model metadata available; configuration was not changed' },
          });
          return;
        }
        json(200, await updateOpenCode(body.path, provider()));
        return;
      }
      const protocol = Object.keys(paths).find(key => `/v1${paths[key]}` === path);
      if (req.method !== 'POST' || !protocol || (scope && scope !== protocol)) {
        json(404, { error: { message: 'Unknown bridge route' } });
        return;
      }
      if (inFlight >= maxInFlight) {
        json(429, { error: { message: 'Local concurrency limit reached' } });
        return;
      }
      const body = await readBody(req);
      if (!body || typeof body.model !== 'string') {
        json(400, { error: { message: 'Missing model ID' } });
        return;
      }
      const automatic = body.model.startsWith('auto/');
      if (automatic && (body.previous_response_id || body.conversation)) {
        json(400, {
          error: { message: 'Use an explicit model for server-side conversation continuation' },
        });
        return;
      }
      if (automatic && !Object.hasOwn(provider().models, body.model)) {
        json(400, {
          error: { message: 'Automatic chain has missing context or incompatible models' },
        });
        return;
      }
      const choices = candidates(body.model, protocol, body);
      if (!choices.length) {
        json(503, {
          error: { message: 'No eligible model for the requested protocol and capabilities' },
        });
        return;
      }
      if (inFlight >= maxInFlight) {
        json(429, { error: { message: 'Local concurrency limit reached' } });
        return;
      }
      inFlight++;
      admitted = true;
      const maxOutput = body.max_tokens ?? body.max_output_tokens;
      if (automatic && maxOutput > provider().models[body.model].limit.output) {
        json(400, { error: { message: 'Output limit exceeds the automatic chain limit' } });
        return;
      }
      for (let index = 0; index < choices.length; index++) {
        selected = choices[index];
        if (automatic && !health.reserve(selected.id)) continue;
        let payload = { ...body, model: selected.id };
        const headers = { 'content-type': 'application/json' };
        if (protocol === 'messages') {
          headers['anthropic-version'] = '2023-06-01';
          if (selected.id !== 'antigravity/gemini-4-argon') {
            payload = adaptMessages(payload);
            headers['user-agent'] = userAgent;
          }
        }
        if (protocol === 'responses') payload.store = false;
        for (const name of [
          'anthropic-beta',
          'x-velly-task',
          'x-velly-purpose',
          'x-velly-workflow',
        ])
          if (req.headers[name]) headers[name] = req.headers[name];
        let response;
        try {
          response = await authorizedFetch(`${upstream}/v1${paths[protocol]}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          health.record(selected.id, 502, null, 'Transport failure');
          if (automatic && index + 1 < choices.length) continue;
          throw error;
        }
        if (!response.ok) {
          const preview = await errorPreview(response);
          let catalogStatus = null;
          if (response.status === 401) {
            try {
              const check = await authorizedFetch(`${upstream}${catalogPath(platform)}`, {
                signal: AbortSignal.timeout(5000),
              });
              catalogStatus = check.status;
              await check.body?.cancel();
            } catch {}
          }
          const diagnostic = authDiagnostic(response.status, preview, catalogStatus);
          if (diagnostic) {
            const status = response.status;
            const retryAfter = response.headers.get('retry-after');
            await response.body?.cancel();
            response = Response.json({
              type: 'error',
              error: { type: 'authentication_error', message: diagnostic.message, source: diagnostic.source },
            }, { status, headers: {
              'x-velly-auth-source': diagnostic.source,
              ...(retryAfter ? { 'retry-after': retryAfter } : {}),
            } });
          }
          health.record(
            selected.id,
            response.status,
            response.headers.get('retry-after'),
            diagnostic?.message || `Upstream HTTP ${response.status}`
          );
          const retryable = response.status === 429 || [502, 503, 529].includes(response.status);
          if (automatic && retryable && index + 1 < choices.length) {
            await response.body?.cancel();
            continue;
          }
        }
        const outgoing = {
          'content-type': response.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
          'x-velly-selected-model': selected.id,
          'x-velly-requested-model': body.model,
        };
        const reason = automatic
          ? selected.id === chains[body.model.slice(5)][0]
            ? 'primary'
            : 'primary_unavailable'
          : 'explicit';
        selections.push({
          requested: body.model,
          selected: selected.id,
          reason,
          httpStatus: response.status,
          at: new Date().toISOString(),
        });
        selections = selections.slice(-50);
        outgoing['x-velly-selection-reason'] = reason;
        for (const name of ['retry-after', 'request-id', 'x-request-id', 'x-velly-auth-source'])
          if (response.headers.has(name)) outgoing[name] = response.headers.get(name);
        res.writeHead(response.status, outgoing);
        let eventBuffer = '';
        let streamFailed = false;
        for await (const chunk of response.body || []) {
          eventBuffer = (eventBuffer + Buffer.from(chunk).toString('utf8')).slice(-32768);
          if (/event:\s*error|"type"\s*:\s*"(?:error|response\.failed)"/.test(eventBuffer))
            streamFailed = true;
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        if (response.ok)
          health.record(
            selected.id,
            streamFailed ? 502 : 200,
            null,
            streamFailed ? 'Upstream stream error' : null
          );
        res.end();
        return;
      }
      json(503, { error: { message: 'Automatic recovery probe already in progress' } });
    } catch (error) {
      if (!controller.signal.aborted) {
        if (res.headersSent) {
          if (selected) health.record(selected.id, 502, null, 'Stream interrupted');
          res.destroy();
        } else
          json(error.status || 502, {
            error: {
              message: error.status
                ? error.message
                : error.code === 'VELLY_STORAGE'
                  ? 'Не удалось прочитать хранилище Velly. Проверьте путь профиля и пользователя Windows; это локальная ошибка, а не отказ токена сервером.'
                : 'Velly bridge request failed. Check sign-in, catalog and network.',
              ...(error.code === 'VELLY_STORAGE' ? { source: 'local_storage' } : {}),
            },
          });
      }
    } finally {
      if (selected) health.release(selected.id);
      if (admitted) inFlight--;
      if (admitted) void persistHealth();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const timer = refreshMs
    ? setInterval(() => {
        if (!closed) void refresh();
      }, refreshMs)
    : null;
  timer?.unref();
  async function probe(modelId) {
    const model = effectiveModels().find(m => m.id === modelId);
    if (!model) throw new Error('Unknown model');
    if (model.toolsVerified)
      return {
        model: modelId,
        skipped: true,
        reason: 'Tools already verified; no generation sent',
      };
    if (!dataDir) throw new Error('Probe needs a plugin data directory');
    const marker = randomUUID();
    const schema = {
      type: 'object',
      properties: { marker: { type: 'string', enum: [marker] } },
      required: ['marker'],
      additionalProperties: false,
    };
    const prompt = `Call write_marker once with marker ${marker}. Do not answer with prose.`;
    let payload;
    if (model.protocol === 'messages')
      payload = {
        model: modelId,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
        tools: [
          {
            name: 'write_marker',
            description: 'Write a test marker into the plugin test directory',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'tool', name: 'write_marker' },
      };
    else if (model.protocol === 'responses')
      payload = {
        model: modelId,
        stream: true,
        input: [{ role: 'user', content: prompt }],
        tools: [
          {
            type: 'function',
            name: 'write_marker',
            description: 'Write a test marker',
            parameters: schema,
          },
        ],
        tool_choice: { type: 'function', name: 'write_marker' },
      };
    else
      payload = {
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        tools: [
          {
            type: 'function',
            function: {
              name: 'write_marker',
              description: 'Write a test marker',
              parameters: schema,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'write_marker' } },
      };
    const response = await fetchImplForProbe(`${baseURL}${paths[model.protocol]}`, payload);
    if (!response.ok)
      return {
        model: modelId,
        verified: false,
        httpStatus: response.status,
        reason: 'API error; tool ability is unknown',
      };
    const raw = await response.text();
    const objects = [];
    try {
      objects.push(JSON.parse(raw));
    } catch {
      for (const line of raw.split('\n'))
        if (line.startsWith('data: ')) {
          try {
            objects.push(JSON.parse(line.slice(6)));
          } catch {}
        }
    }
    const calls = objects.flatMap(o => [
      ...(o.content || []),
      ...(o.output || []),
      ...(o.response?.output || []),
      ...(o.item ? [o.item] : []),
      ...(o.choices?.[0]?.message?.tool_calls || []),
    ]);
    const found = calls.some(call => {
      try {
        const name = call.name || call.function?.name;
        const args = call.input || JSON.parse(call.arguments || call.function?.arguments || '{}');
        return name === 'write_marker' && args.marker === marker;
      } catch {
        return false;
      }
    });
    if (!found)
      return { model: modelId, verified: false, reason: 'No matching tool call returned' };
    const directory = join(dataDir, 'probes');
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${marker}.txt`);
    await writeFile(file, marker, { flag: 'wx', mode: 0o600 });
    health.states.set(modelId, {
      ...health.get(modelId),
      toolsVerified: true,
      toolsVerifiedAt: new Date().toISOString(),
    });
    await persistHealth();
    return { model: modelId, verified: true, file };
  }
  const fetchImplForProbe = (url, payload) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000),
    });
  return {
    baseURL,
    status,
    refresh,
    provider,
    probe,
    async close() {
      closed = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await persisting;
    },
  };
}
