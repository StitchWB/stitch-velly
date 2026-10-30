export function authDiagnostic(status, body, catalogStatus) {
  if (/oauth.{0,100}(?:expired|refresh)|(?:expired|refresh).{0,100}oauth/i.test(body))
    return {
      source: 'upstream_session',
      message: 'Истекла OAuth-сессия поставщика за Velly. Повторный вход в Velly не подтверждён как решение; требуется восстановление сессии на стороне шлюза.',
    };
  if (status !== 401) return null;
  if (catalogStatus === 200)
    return {
      source: 'model_route',
      message: 'Velly принимает текущий токен для каталога, но маршрут модели отказал в авторизации. Требование перелогиниться не подтверждено.',
    };
  if (catalogStatus === 401)
    return {
      source: 'velly_token',
      message: 'Velly отклонил актуальный токен и для модели, и для каталога. Откройте Velly и проверьте вход; мост подхватит обновлённый auth.bin автоматически.',
    };
  return {
    source: 'unknown',
    message: 'Маршрут модели вернул 401. Проверить токен через каталог не удалось; необходимость повторного входа не установлена.',
  };
}

export async function errorPreview(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  const deadline = new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 1000);
    timer.unref?.();
  });
  try {
    while (size < 16384) {
      const part = await Promise.race([reader.read(), deadline]);
      if (!part || part.done) break;
      chunks.push(Buffer.from(part.value).subarray(0, 16384 - size));
      size += part.value.length;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  } finally {
    void reader.cancel().catch(() => {});
  }
}
