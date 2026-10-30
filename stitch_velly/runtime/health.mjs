export class ModelHealth {
  constructor({ now = Date.now, cooldownMs = 60000 } = {}) {
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.states = new Map();
    this.reserved = new Set();
  }

  get(id) {
    return this.states.get(id) || { status: 'unknown', failures: 0, retryAt: 0 };
  }
  available(id) {
    return this.get(id).retryAt <= this.now() && !this.reserved.has(id);
  }
  reserve(id) {
    if (!this.available(id)) return false;
    if (this.get(id).status === 'cooldown') this.reserved.add(id);
    return true;
  }
  release(id) {
    this.reserved.delete(id);
  }
  record(id, status, retryAfter = null, error = null) {
    const old = this.get(id);
    const failures = status >= 400 ? old.failures + 1 : 0;
    const temporary = status === 429 || status === 408 || status >= 500;
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    const delay =
      retryAfter && Number.isFinite(seconds)
        ? seconds * 1000
        : retryAfter && Number.isFinite(date)
          ? date - this.now()
          : this.cooldownMs;
    const blocked = status === 403 || status === 404;
    this.states.set(id, {
      ...old,
      status:
        status < 400
          ? 'healthy'
          : temporary
            ? 'cooldown'
            : status === 401
              ? 'auth_failed'
              : blocked
                ? 'unavailable'
                : 'request_error',
      failures,
      httpStatus: status,
      checkedAt: this.now(),
      retryAt: temporary
        ? this.now() + Math.max(1000, Math.min(delay, 86400000))
        : blocked
          ? this.now() + 300000
          : 0,
      error,
    });
    this.release(id);
  }
}
