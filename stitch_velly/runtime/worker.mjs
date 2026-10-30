import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTokenReader } from './token.mjs';
import { startBridge, syncOpenCodeKey, writeJson } from './bridge.mjs';

const settings = JSON.parse(await readFile(process.argv[2], 'utf8'));
await mkdir(settings.dataDir, { recursive: true });
const key = (await readFile(join(settings.dataDir, 'local.key'), 'utf8')).trim();
const tokenReader = createTokenReader({ profile: settings.profile, environment: {} });
const bridge = await startBridge({ ...settings, apiKey: key, tokenReader });
await writeJson(join(settings.dataDir, 'runtime.json'), {
  pid: process.pid,
  baseURL: bridge.baseURL,
});
void bridge.refresh();
const opencodeConfig = process.env.STITCH_VELLY_OPENCODE_CONFIG;
if (opencodeConfig)
  void syncOpenCodeKey(opencodeConfig, bridge.baseURL, key).catch(() => {});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await bridge.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
process.stdin.on('end', stop);
