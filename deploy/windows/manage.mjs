// No shell interpolation, downloads, credentials, prompt logs, or arbitrary PID termination.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
class SafeError extends Error {}
const script = fileURLToPath(import.meta.url);
const root = path.join(process.env.LOCALAPPDATA || '', 'Kitzur');
const appDir = path.join(root, 'app');
const configFile = path.join(root, 'config', 'kitzur.json');
const lock = path.join(root, 'run.json');
const stopFile = path.join(root, 'stop.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', {mode: 0o600});
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const startupFile = () => path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Kitzur.lnk');
const log = event => {
  const p = path.join(root, 'logs', 'lifecycle.jsonl');
  if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) fs.renameSync(p, p + '.previous');
  fs.appendFileSync(p, JSON.stringify({at: new Date().toISOString(), event}) + '\n');
};
function cleanEnv() {
  // Runtime environment must not silently override the approved config or inject test faults.
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^KITZUR_/i.test(k)));
}
async function modules(base) {
  const imp = p => import(pathToFileURL(path.join(base, 'dist', 'src', p)).href);
  const [{loadConfig}, {validateConfig}, {setupCounter, buildApp}] = await Promise.all([
    imp('config/load.js'), imp('config/validate.js'), imp('app.js')]);
  return {loadConfig, validateConfig, setupCounter, buildApp};
}
async function configuration(base, file) {
  const m = await modules(base);
  const cfg = m.loadConfig({configPath: file, env: cleanEnv()}).config;
  if (m.validateConfig(cfg, {checkFiles: true}).errors.length) throw new SafeError('Config validation failed; review config locally (values suppressed).');
  if (cfg.listen.host !== '127.0.0.1' || cfg.listen.port !== 8270 || !cfg.upstream.origin || cfg.upstream.insecureTls || Object.keys(cfg.upstream.headers).length || cfg.stats.path || cfg.store.persist || cfg.ledger.mirrorPath) {
    throw new SafeError('Windows profile requires loopback port 8270, TLS verification, no stored headers, stats, persisted plans or ledger mirror.');
  }
  if (cfg.upstream.origin !== new URL(read(path.join(root, 'profile.json')).gatewayBaseURL).origin) throw new SafeError('Config gateway differs from approved profile.');
  if (cfg.shadow) throw new SafeError('Windows launcher requires active mode.');
  const expected = read(path.join(root, 'profile.json')).tokenizerSha256;
  if (!cfg.tokenizer.path || sha(cfg.tokenizer.path) !== expected) throw new SafeError('Approved tokenizer checksum mismatch.');
  const counter = m.setupCounter(cfg, {stateDir: cfg.stateDir});
  if (counter.counter.mode !== 'exact') throw new SafeError('Exact tokenizer prerequisite failed; estimate mode is not accepted.');
  return {m, cfg};
}
function probe(baseURL, caFile) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseURL.replace(/\/$/, '') + '/models');
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, {timeout: 10000, ...(caFile ? {ca: fs.readFileSync(caFile)} : {})}, res => {
      res.resume();
      // No credential is needed to check TLS/routing. 401/403 require a separate admin auth check.
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new SafeError('Gateway connection/TLS check failed; verify VPN, direct routing and approved CA.')));
  });
}
async function live() {
  try {
    const r = await fetch('http://127.0.0.1:8270/kitzur/status', {signal: AbortSignal.timeout(2000)});
    const s = await r.json();
    return s.name === 'kitzur' ? s : null;
  } catch { return null; }
}
function currentRun() {
  try { const r = read(lock); if (!Number.isSafeInteger(r.pid) || typeof r.nonce !== 'string') return null; process.kill(r.pid, 0); return r; } catch { return null; }
}
function numericMap(m, allowed) {
  return Object.fromEntries(Object.entries(m || {}).filter(([k,v]) => allowed.includes(k) && typeof v === 'number' && Number.isFinite(v)));
}
export function diagnostics(s) {
  // Never export raw /status: it includes origins, model keys, paths and free-text warnings.
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => typeof o?.[k] === 'number').map(k => [k,o[k]]));
  return {at: new Date().toISOString(), running: !!s, version: /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(s?.version) ? s.version : undefined,
    limits: pick(s?.config, ['window','defaultMaxTokens','planMaxTokens']),
    budget: pick(s?.budget, ['budget','trigger','target','clientPoint']),
    budgetMode: ['prompt_only','total'].includes(s?.config?.server?.budgetMode) ? s.config.server.budgetMode : 'other',
    counterMode: s?.counter?.mode === 'exact' ? 'exact' : 'other',
    counters: pick(s?.counters, ['requests','chat_requests','retries','usage_mismatch','fail_open','upstream_rejected_rewrite']),
    actions: numericMap(s?.actions, ['passthrough','reuse','compact','admit','truncate','clamp','restore','shadow','impossible','guard_fallback','guard_reject']), guard: {engineExceptions: Object.entries(s?.guard || {}).filter(([k,v]) => k.startsWith('engine:') && typeof v === 'number').reduce((n,[,v]) => n+v,0), other: Object.entries(s?.guard || {}).filter(([k,v]) => !k.startsWith('engine:') && typeof v === 'number').reduce((n,[,v]) => n+v,0)}, errorKinds: numericMap(s?.error_kinds, ['overflow_prompt','overflow_total','overflow_unknown','max_tokens_too_large','payload_too_large','gateway_error','overflow_suspect','excluded','unmatched']),
    openCodeCompactions: 'not observed by proxy; record count and timestamps from UI separately'};
}
async function install([bundle, profilePath, tokenizerPath, startup]) {
  if (currentRun() || await live()) throw new SafeError('Stop Kitzur before installing/upgrading.');
  // Verify every manifest entry before importing or copying executable files. Reject links/traversal.
  for (const line of fs.readFileSync(path.join(bundle,'SHA256SUMS'),'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (?:\.\/)?(.+)$/.exec(line);
    if (!match || path.isAbsolute(match[2]) || /^[a-z]:/i.test(match[2]) || match[2].split(/[\\/]/).includes('..')) throw new SafeError('Invalid bundle manifest.');
    const p = path.join(bundle,match[2]);
    if (!fs.realpathSync(p).startsWith(fs.realpathSync(bundle) + path.sep) || !fs.lstatSync(p).isFile() || sha(p) !== match[1]) throw new SafeError('Bundle checksum verification failed.');
  }
  const profile = read(profilePath);
  const u = new URL(profile.gatewayBaseURL);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.pathname.endsWith('/v1') || u.hostname.endsWith('.invalid')) throw new SafeError('Profile requires a credential-free HTTPS LiteLLM API base ending /v1.');
  if (!/^[a-f0-9]{64}$/.test(profile.tokenizerSha256) || sha(tokenizerPath) !== profile.tokenizerSha256.toLowerCase()) throw new SafeError('Tokenizer checksum failed.');
  if (!profile.modelId || /REPLACE|[\r\n]/.test(profile.modelId) || !profile.provenance?.approval || JSON.stringify(profile.provenance).includes('REPLACE')) throw new SafeError('Admin must complete model ID and tokenizer provenance/approval.');
  if (fs.existsSync(path.join(root,'profile.json')) && JSON.stringify(read(path.join(root,'profile.json'))) !== JSON.stringify(profile)) throw new SafeError('Profile changed: administrator must migrate preserved config/profile explicitly.');
  for (const d of ['config','logs','state','assets']) fs.mkdirSync(path.join(root,d), {recursive:true});
  const staged = path.join(root,'app.new');
  fs.rmSync(staged,{recursive:true,force:true});
  // Copy only manifest-listed files; unlisted private files never enter the installed app.
  for (const line of fs.readFileSync(path.join(bundle,'SHA256SUMS'),'utf8').trim().split('\n')) {
    const rel = line.slice(66).replace(/^\.\//,'');
    if (rel.startsWith('deployment/')) continue;
    const dest = path.join(staged,rel);
    fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(bundle,rel),dest);
  }
  const tok = path.join(root,'assets','tokenizer.json');
  if (fs.existsSync(tok) && sha(tok) !== profile.tokenizerSha256) throw new SafeError('Existing tokenizer differs; explicit admin migration required.');
  if (!fs.existsSync(tok)) fs.copyFileSync(tokenizerPath,tok);
  if (!fs.existsSync(path.join(root,'profile.json'))) write(path.join(root,'profile.json'),profile);
  if (!fs.existsSync(configFile)) {
    const cfg = structuredClone(profile.config || {});
    cfg.upstream = {...cfg.upstream, origin:u.origin};
    cfg.tokenizer = {...cfg.tokenizer, path:tok, template:{name:'qwen3'}};
    cfg.listen = {host:'127.0.0.1',port:8270}; cfg.stateDir = path.join(root,'state');
    cfg.stats = {path:null}; cfg.store = {...cfg.store,persist:false}; cfg.ledger = {...cfg.ledger,mirrorPath:null};
    write(configFile,cfg);
  }
  const {cfg} = await configuration(staged,configFile);
  const code = await probe(profile.gatewayBaseURL,cfg.upstream.caFile);
  if (![200,401,403].includes(code)) throw new SafeError('Gateway API path check failed (expected 200/401/403).');
  console.log(code === 200 ? 'Gateway route/TLS reachable.' : 'Gateway route/TLS reachable; authentication still requires an admin/client check.');
  const old = path.join(root,'app.previous');
  fs.rmSync(old,{recursive:true,force:true});
  if (fs.existsSync(appDir)) fs.renameSync(appDir,old);
  fs.renameSync(staged,appDir);
  fs.writeFileSync(path.join(root,'node-path.txt'),process.execPath);
  const template = read(path.join(appDir,'deploy','windows','opencode.template.json'));
  template.provider.kitzur.options.baseURL = 'http://127.0.0.1:8270' + u.pathname.replace(/\/$/,'');
  template.provider.kitzur.models = {[profile.modelId]:template.provider.kitzur.models.REPLACE_WITH_GATEWAY_MODEL_ID};
  template.model = template.small_model = 'kitzur/' + profile.modelId;
  const clientFile = path.join(root,'config','opencode.generated.json');
  if (!fs.existsSync(clientFile)) write(clientFile,template);
  if (startup === 'startup') {
    // A .lnk uses separate executable/arguments fields and handles spaces without shell evaluation.
    const ps = path.join(appDir,'deploy','windows','Register-Startup.ps1');
    await new Promise((resolve,reject) => {
      const child = spawn('powershell.exe',['-NoProfile','-File',ps],{stdio:'inherit',windowsHide:true});
      child.on('error',reject); child.on('exit',code => code === 0 ? resolve() : reject(new SafeError('Startup registration failed (check approved script policy).')));
    });
  }
  console.log('Installed per-user. Config preserved. OpenCode template: ' + clientFile);
  console.log('Run app\\deploy\\windows\\Kitzur.ps1 -Action Start, then Status.');
}
async function supervise() {
  const nonce = randomUUID();
  let fd;
  try { fd = fs.openSync(lock,'wx'); } catch { return; }
  fs.closeSync(fd);
  const heartbeat = () => write(lock,{nonce,pid:process.pid,heartbeat:Date.now()});
  heartbeat();
  let instance;
  let timer;
  try {
    const {m,cfg} = await configuration(appDir,configFile);
    // Discard free-text messages; log only fixed events. No stderr file or request stats.
    const safeLog = Object.fromEntries(['info','warn','error','debug'].map(k => [k, () => { if (k === 'error') log('runtime_error'); }]));
    instance = await m.buildApp(cfg,{log:safeLog,env:cleanEnv()});
    await instance.listen(); log('started');
    await new Promise(resolve => {
      timer = setInterval(() => {
        heartbeat();
        try { if (read(stopFile).nonce === nonce) resolve(); } catch {}
      },1000);
      process.once('SIGTERM',resolve); process.once('SIGINT',resolve);
    });
    clearInterval(timer);
    // Keep ownership heartbeat alive while draining so another start cannot race this process.
    timer = setInterval(heartbeat,1000);
    log('draining'); await instance.close(30000); log('stopped');
  } catch { if (instance) await instance.close(0).catch(() => {}); log('startup_or_runtime_failed'); process.exitCode = 1; }
  finally { clearInterval(timer); fs.rmSync(lock,{force:true}); fs.rmSync(stopFile,{force:true}); }
}
async function main() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA || !process.env.APPDATA) throw new SafeError('Windows per-user environment required.');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new SafeError('Node.js 20+ required; install your organisation-approved Node build.');
  const [action,...args] = process.argv.slice(2);
  if (action === 'install') return install(args);
  if (action === 'supervise') return supervise();
  if (action === 'start') {
    if (currentRun()) { console.log('Kitzur already starting/running.'); return; }
    if (await live()) throw new SafeError('Port 8270 already hosts Kitzur outside this launcher.');
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 60000) throw new SafeError('Launcher is starting; retry status shortly.');
    fs.rmSync(lock,{force:true}); fs.rmSync(stopFile,{force:true});
    await configuration(appDir,configFile);
    spawn(process.execPath,[script,'supervise'],{detached:true,stdio:'ignore',windowsHide:true,env:cleanEnv()}).unref();
    for (let i=0;i<30;i++) { await sleep(1000); if (await live()) { console.log('Kitzur running at 127.0.0.1:8270.'); return; } }
    throw new SafeError('Start timed out. Check logs/lifecycle.jsonl and config locally.');
  }
  if (action === 'stop' || action === 'uninstall') {
    const run = currentRun();
    if (!run && await live()) throw new SafeError('Kitzur on this port is not owned by this launcher; stop it through its original launcher.');
    if (run) {
      write(stopFile,{nonce:run.nonce});
      for (let i=0;i<40 && currentRun();i++) await sleep(1000);
      if (currentRun()) throw new SafeError('Stop timed out; launcher did not terminate any unrelated process.');
    }
    if (action === 'uninstall') {
      fs.rmSync(startupFile(),{force:true});
      // Keep data and the manager itself for review/removal; never recursively delete user config.
      console.log('Login startup removed, proxy stopped. Delete %LOCALAPPDATA%\\Kitzur after reviewing config/state/logs.');
    } else console.log('Kitzur stopped.');
    return;
  }
  if (action === 'status' || action === 'diagnose') {
    const result = diagnostics(await live());
    if (action === 'diagnose') { write(path.join(root,'logs','diagnostics.json'),result); console.log('Safe report: logs/diagnostics.json'); }
    console.log(JSON.stringify(result,null,2)); return;
  }
  throw new SafeError('Use start, stop, status, diagnose or uninstall.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) main().catch(e => { console.error(e instanceof SafeError ? e.message : 'Prerequisite/config/file operation failed; inspect local settings (details suppressed).'); process.exitCode=1; });
