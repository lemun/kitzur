// SIGTERM while a streaming response is in flight (deploy/README.md, "Restart / upgrade"): the compiled
// `kitzur serve` stops accepting, lets the stream finish, flushes state and stats, then exits 0; a second
// SIGTERM during the drain exits at once (130). The upstream streams 20 chunks over about 400 ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const CLI = join(ROOT, 'dist', 'src', 'cli.js');
const CHUNKS = 20;

const UPSTREAM_JS = `
const http = require('node:http');
const chunk = (o) => 'data: ' + JSON.stringify(o) + '\\n\\n';
const s = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    // rejecting the injected field makes the proxy learn includeUsageRejected (a debounced state write)
    if (body.includes('stream_options')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => {
      if (i === 5 && body.includes('stall')) return; // never finishes: only a forced exit ends the drain
      if (i < ${CHUNKS}) { res.write(chunk({ choices: [{ index: 0, delta: { content: 'c' + i++ } }] })); return; }
      clearInterval(t);
      res.end(chunk({ choices: [], usage: { prompt_tokens: 50, completion_tokens: ${CHUNKS} } }) + 'data: [DONE]\\n\\n');
    }, 20);
  });
});
s.listen(0, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + s.address().port));
`;

function spawnListening(args: string[]): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.once('exit', (code) => reject(new Error(`child exited ${code} before listening`)));
  });
}

const exitOf = (c: ChildProcess, ms: number): Promise<{ code: number | null; ms: number }> => {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no exit within ${ms} ms`)), ms);
    c.once('exit', (code) => { clearTimeout(timer); resolve({ code, ms: Date.now() - t0 }); });
  });
};

/** POSTs a streaming chat request; onChunk sees the running count of content chunks. */
function streamRequest(port: number, onChunk: (n: number) => void, content = 'hello'): Promise<string> {
  const body = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content }] });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { text += d; onChunk((text.match(/"content":"c\d+"/g) ?? []).length); });
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const connect = (port: number): Promise<number | string> => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/v1/models', agent: false }, (res) => { res.resume(); resolve(res.statusCode!); });
  req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
});

async function withServe(f: (o: { serve: ChildProcess; port: number; dir: string }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-stop-'));
  const up = await spawnListening(['-e', UPSTREAM_JS]);
  let serve: ChildProcess | undefined;
  try {
    const s = await spawnListening([CLI, 'serve', '--upstream', `http://127.0.0.1:${up.port}`, '--port', '0', '--state-dir', dir,
      '--stats', join(dir, 'stats.jsonl'), '--log-file', join(dir, 'serve.log'), '--drain-ms', '10000', '-s', 'stream.injectIncludeUsage=true']);
    serve = s.child;
    await f({ serve, port: s.port, dir });
  } finally {
    serve?.kill('SIGKILL');
    up.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SIGTERM during a stream: the stream finishes, new connections are refused, state and stats flush, exit 0', () =>
  withServe(async ({ serve, port, dir }) => {
    let signalled: Promise<number | string> | undefined;
    const exited = exitOf(serve, 5000);
    const text = await streamRequest(port, (n) => {
      if (n >= 3 && !signalled) {
        serve.kill('SIGTERM');
        signalled = new Promise((r) => setTimeout(r, 50)).then(() => connect(port));
      }
    });
    assert.ok(signalled, 'SIGTERM was sent mid-stream');
    assert.deepEqual(text.match(/"content":"c\d+"/g), Array.from({ length: CHUNKS }, (_, i) => `"content":"c${i}"`));
    assert.match(text, /data: \[DONE\]\n\n$/);
    // the listener is closed at the signal: a new connection is refused rather than answered
    assert.equal(await signalled, 'ECONNREFUSED');
    const { code } = await exited;
    assert.equal(code, 0);
    const stats = readFileSync(join(dir, 'stats.jsonl'), 'utf8');
    assert.match(stats, /\n$/);
    const recs = stats.split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
    assert.equal(recs.length, 1);
    const jsonFiles = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(jsonFiles.includes('learned.json'), `state written (${jsonFiles.join(', ')})`);
    for (const f of jsonFiles) JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const learned = JSON.parse(readFileSync(join(dir, 'learned.json'), 'utf8')) as { entries: Record<string, { includeUsageRejected?: boolean }> };
    assert.ok(Object.values(learned.entries).some((e) => e.includeUsageRejected), 'the entry learned mid-stream was flushed');
    assert.match(readFileSync(join(dir, 'serve.log'), 'utf8'), /SIGTERM: stopping; draining/);
  }));

test('a second SIGTERM during the drain exits 130 without waiting for a stalled stream', () =>
  withServe(async ({ serve, port }) => {
    let sent = false;
    const exited = exitOf(serve, 5000);
    const stream = streamRequest(port, (n) => {
      if (n >= 3 && !sent) {
        sent = true;
        serve.kill('SIGTERM');
        setTimeout(() => serve.kill('SIGTERM'), 30);
      }
    }, 'stall').catch((e: Error) => e.message);
    const { code } = await exited;
    assert.equal(code, 130);
    assert.ok(sent, 'SIGTERM was sent mid-stream');
    assert.doesNotMatch(await stream, /\[DONE\]/);
  }));
