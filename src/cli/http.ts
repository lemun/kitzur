import http from 'node:http';
import https from 'node:https';
import { AppModuleError } from '../app.js';
import type { LearnedState } from '../types.js';

export function httpGet(url: string, timeoutMs: number, token: string | null = null): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { agent: false, timeout: timeoutMs, headers: token === null ? {} : { authorization: 'Bearer ' + token } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolveP({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

export async function importState(): Promise<{
  showState(dir: string, filter?: string): { path: string; state: LearnedState; error: string | null };
  resetState(dir: string, filter?: string): string[];
}> {
  const spec = '../proxy/state.js';
  try {
    return (await import(new URL(spec, import.meta.url).href)) as Awaited<ReturnType<typeof importState>>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') throw new AppModuleError('this build has no src/proxy/state.ts');
    throw e;
  }
}
