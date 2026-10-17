import type { Config } from './schema.js';

export function isLoopbackHost(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

/** Refuse to expose configured upstream credentials without client authentication. */
export function listenSecurityError(cfg: Config): string | null {
  return !isLoopbackHost(cfg.listen.host) && Object.keys(cfg.upstream.headers).length > 0 && cfg.listen.token === null
    ? 'listen.token is required when listen.host is not loopback and upstream.headers is set'
    : null;
}
