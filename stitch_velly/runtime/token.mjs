import { readFile, stat } from 'node:fs/promises';
import { createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function unprotect(data) {
  const command =
    'Add-Type -AssemblyName System.Security; $blob=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain))';
  const executable = join(
    process.env.SystemRoot || 'C:/Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'
  );
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.stdin.end(data.toString('base64'));
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => clearTimeout(timer));
  if (code !== 0)
    throw Object.assign(new Error('Не удалось открыть DPAPI-ключ Velly под текущим пользователем Windows.'), { code: 'VELLY_STORAGE' });
  return Buffer.from(Buffer.concat(chunks).toString().trim(), 'base64');
}

let shellAppData;
function registryAppData() {
  shellAppData ??= new Promise(resolve => {
    const child = spawn(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', '/v', 'AppData'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.resume();
    child.on('error', () => resolve(null));
    child.on('close', code => {
      const match =
        code === 0 && Buffer.concat(chunks).toString('utf8').match(/REG_SZ\s+(.+)/);
      resolve(match ? match[1].trim() : null);
    });
  });
  return shellAppData;
}

export function createTokenReader({
  profile = process.env.VELLY_PROFILE || join(homedir(), 'AppData/Roaming/Velly'),
  fallbackProfile = process.env.VELLY_PROFILE || join(homedir(), 'AppData/Roaming/Velly'),
  decryptDPAPI = unprotect,
  appDataResolver = registryAppData,
  environment = process.env,
  fileName = 'auth.bin',
} = {}) {
  if (!['auth.bin', 'secret-device-key.bin'].includes(fileName)) throw new Error('Unknown Velly secret');
  // sidecar хаба прячет USERPROFILE/APPDATA в песочницу — реальный профиль достаём из реестра
  let cached;
  let loading;
  async function resolveProfile() {
    const registry = await appDataResolver();
    const list = [profile, fallbackProfile];
    if (registry) list.push(join(registry, 'Velly'));
    for (const candidate of [...new Set(list.filter(Boolean))]) {
      const present = await Promise.all([
        stat(join(candidate, fileName)),
        stat(join(candidate, 'Local State')),
      ]).then(
        () => true,
        () => false
      );
      if (present) return candidate;
    }
    throw Object.assign(new Error(
      'Не найдено хранилище Velly. Войдите в Velly под этим пользователем Windows.'
    ), { code: 'VELLY_STORAGE' });
  }
  async function read(force) {
    if (fileName === 'auth.bin' && environment.VELLY_TOKEN) return environment.VELLY_TOKEN;
    const active = await resolveProfile();
    const authPath = join(active, fileName);
    const statePath = join(active, 'Local State');
    const [authStat, stateStat] = await Promise.all([stat(authPath), stat(statePath)]);
    const stamp = `${active}|${authStat.mtimeMs}:${authStat.size}:${stateStat.mtimeMs}:${stateStat.size}`;
    if (!force && cached?.stamp === stamp) return cached.token;
    const data = await readFile(authPath);
    let plain;
    if (['v10', 'v11'].includes(data.subarray(0, 3).toString('ascii'))) {
      if (data.length < 31) throw new Error('Некорректный зашифрованный auth.bin Velly.');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const encryptedKey = Buffer.from(state.os_crypt?.encrypted_key || '', 'base64');
      if (encryptedKey.subarray(0, 5).toString('ascii') !== 'DPAPI')
        throw new Error('Неизвестный формат ключа Chromium в Velly.');
      const key = await decryptDPAPI(encryptedKey.subarray(5));
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(3, 15));
        decipher.setAuthTag(data.subarray(-16));
        plain = Buffer.concat([decipher.update(data.subarray(15, -16)), decipher.final()]);
      } finally {
        key.fill(0);
      }
    } else plain = await decryptDPAPI(data);
    const token = plain.toString('utf8').trim();
    plain.fill(0);
    if (!token || /[\r\n]/.test(token)) throw new Error('Некорректный токен Velly.');
    cached = { stamp, token };
    return token;
  }
  return async (force = false) => {
    if (force && loading) await loading.catch(() => {});
    if (!loading)
      loading = read(force).finally(() => {
        loading = undefined;
      });
    return loading;
  };
}
