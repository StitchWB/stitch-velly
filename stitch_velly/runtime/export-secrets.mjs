import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTokenReader } from './token.mjs';

export async function exportSecrets({ profile, directory, includeDeviceKey = false, readSecret }) {
  const read = readSecret || (fileName => createTokenReader({ profile, fileName, environment: {} })());
  const data = { version: 1, access_token: await read('auth.bin') };
  if (includeDeviceKey) data.device_key = await read('secret-device-key.bin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const path = join(directory, `velly-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { path, fields: includeDeviceKey ? ['access_token', 'device_key'] : ['access_token'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const result = await exportSecrets(JSON.parse(input));
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stderr.write('Не удалось прочитать или сохранить секреты Velly. Проверьте профиль и вход в Velly.');
    process.exitCode = 1;
  }
}
