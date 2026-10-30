import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startBridge } from '../stitch_velly/runtime/bridge.mjs';
import { normalizeCatalog } from '../stitch_velly/runtime/catalog.mjs';

const cli = process.env.OPENCODE_CLI;
if (!cli) throw new Error('Set OPENCODE_CLI to an absolute OpenCode CLI executable path');
const directory = await mkdtemp(join(tmpdir(), 'velly-cli-check-'));
const requests = [];
const models = normalizeCatalog({
  models: [
    {
      id: 'anthropic/claude-sonnet-5.5',
      name: 'Sonnet',
      agent: 'claude',
      context: 1000000,
      vision: true,
      reasoning: true,
    },
    {
      id: 'openai/gpt-6.1-sol',
      name: 'Sol',
      agent: 'codex',
      context: 1050000,
      vision: true,
      reasoning: true,
    },
  ],
});
const sse = events =>
  events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
function messagesResponse(model) {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
}
function responsesResponse(model) {
  const item = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'OK', annotations: [] }],
  };
  const response = {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    model,
    status: 'completed',
    output: [item],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  return sse([
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'OK',
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: 'OK',
    },
    {
      type: 'response.content_part.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]);
}
const bridge = await startBridge({
  initialModels: models,
  apiKey: 'local-cli-test',
  tokenReader: async () => 'upstream-fixture-token',
  refreshMs: 0,
  chains: { responses: [models[1].id], messages: [models[0].id] },
  fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body, headers: options.headers });
    return new Response(
      url.endsWith('/messages') ? messagesResponse(body.model) : responsesResponse(body.model),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  },
});
const evidence = [];
try {
  for (const model of models) {
    const work = join(directory, model.protocol);
    await mkdir(work, { recursive: true });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|SystemRoot|WINDIR|ComSpec|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)
      )
    );
    Object.assign(env, {
      XDG_CONFIG_HOME: join(work, 'config'),
      XDG_DATA_HOME: join(work, 'data'),
      XDG_CACHE_HOME: join(work, 'cache'),
      XDG_STATE_HOME: join(work, 'state'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { velly: bridge.provider() },
        enabled_providers: ['velly'],
        model: `velly/${model.id}`,
        small_model: `velly/${model.id}`,
        plugin: [new URL('../stitch_velly/runtime/opencode-plugin.mjs', import.meta.url).href],
        permission: { '*': 'deny' },
        agent: {
          probe: {
            mode: 'primary',
            prompt: 'SYSTEM_MARKER_VELLY_837. Reply only OK.',
            tools: { '*': false },
          },
        },
      }),
    });
    const start = requests.length;
    const child = spawn(
      cli,
      [
        'run',
        '--format',
        'json',
        '--model',
        `velly/${model.id}`,
        '--agent',
        'probe',
        '--title',
        'Velly local integration',
        'Reply only OK.',
      ],
      { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.stderr.on('data', data => {
      output += data;
    });
    const timer = setTimeout(() => child.kill(), 40000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    await writeFile(join(work, 'cli.log'), output);
    assert.equal(code, 0, `CLI exit ${code}; see ${work}/cli.log`);
    const events = output.split('\n').flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    assert(
      events.some(event => event.type === 'text' && event.part?.text === 'OK'),
      `No text response: ${work}/cli.log`
    );
    const captured = requests.slice(start);
    assert(captured.length);
    for (const request of captured) {
      assert.equal(request.headers.authorization, 'Bearer upstream-fixture-token');
      if (model.protocol === 'messages') {
        assert.equal(request.headers['user-agent'], 'claude-cli/2.1.308 (external, sdk-cli)');
        assert(
          request.body.system.slice(1).some(block => block.text.includes('SYSTEM_MARKER_VELLY_837'))
        );
      } else {
        assert.equal(request.url, 'https://velly.one/v1/responses');
        assert.equal(request.body.store, false);
      }
    }
    evidence.push({
      protocol: model.protocol,
      model: model.id,
      cliExit: code,
      text: 'OK',
      fixtureRequests: captured.length,
    });
  }
  const report = { mode: 'local-fixtures-only', realGenerationRequests: 0, evidence };
  await writeFile(
    new URL('../reports/opencode-cli.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify(report));
  await rm(directory, { recursive: true, force: true });
} finally {
  await bridge.close();
}
