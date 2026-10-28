import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ENGINE_ALGO_VERSION } from '../../src/types.js';
import { buildApp } from '../../src/app.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import type { ChatMessage, ChatRequest } from '../../src/types.js';
import { TASKS, type CodingTask } from './tasks.js';
import { retentionHistory, type EvidenceTask } from '../scenarios/evidence-reread.js';
export interface EvalOptions {
    endpoint?: string;
    model: string;
    apiKey?: string;
    repeats: number;
    maxTurns: number;
    timeoutMs: number;
    outputTokens: number;
    window: number;
    pressureChars?: number;
    postPressureChars?: number;
    mock?: boolean;
    mockWrong?: boolean;
    mockMissingUsage?: boolean;
    mockEarlyFinal?: boolean;
    mockReject?: boolean;
    mockRetry?: boolean;
    mockDelayMs?: number;
    mockFinishReason?: string;
    mockPartialUsage?: boolean;
    mockLengthWithTools?: boolean;
    mockDelayAfterTurn?: number;
    mockInvalidUsage?: boolean;
}
export interface Attempt {
    status: number;
    latencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
    bodyBytes: number;
    afterCorrection: boolean;
    compactedPrompt: boolean;
    currentRulePresent: boolean;
    obsoleteRulePresent: boolean;
    evidencePresent?: boolean;
    overflow?: boolean;
}
export interface Run {
    task: string;
    repeat: number;
    arm: 'direct' | 'kitzur';
    outcome: 'pass' | 'fail' | 'overflow' | 'timeout' | 'harness-error' | 'incomplete';
    checksPassed: number;
    checksTotal: number;
    turns: number;
    latencyMs: number;
    attempts: Attempt[];
    promptTokens: number | null;
    completionTokens: number | null;
    usageCoverage: number;
    promptUsageCoverage: number;
    completionUsageCoverage: number;
    compactions: number | null;
    postCorrectionCompactions: number | null;
    workspaceHash: string;
    evidenceReads?: Array<{ sha256: string; evicted: boolean }>;
}
const tools = ['read_file', 'write_file', 'run_tests'].map(name => ({ type: 'function', function: { name, description: name === 'run_tests' ? 'Run public syntax/import check' : name, parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: name === 'write_file' ? ['path', 'content'] : name === 'read_file' ? ['path'] : [] } } }));
async function listen(server: http.Server): Promise<string> {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
async function close(server: http.Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
async function body(req: http.IncomingMessage): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
    if (chunks.reduce((n, b) => n + b.length, 0) > 4000000)
        throw Error('request too large');
} return Buffer.concat(chunks); }
const safeEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP };
function checkFile(root: string): string {
    const file = join(root, 'solution.mjs');
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())
        throw Error('invalid task file');
    return file;
}
export function grade(root: string, task: CodingTask): {
    passed: number;
    total: number;
} {
    const file = checkFile(root);
    // Hidden grader lives outside the writable tool surface; no endpoint credentials
    // or user environment enter the trusted task-code process.
    const cases = '[' + task.cases.map(c => '{input:' + (c.inputExpression ?? JSON.stringify(c.input)) + ',expected:' + JSON.stringify(c.expected) + '}').join(',') + ']';
    const script = `import assert from 'node:assert/strict';import {solve} from ${JSON.stringify(pathToFileURL(file).href)};let passed=0;for(const c of ${cases}){try{const before=structuredClone(c.input);assert.deepEqual(solve(c.input),c.expected);assert.deepEqual(c.input,before);passed++;}catch{}}console.log(JSON.stringify({passed,total:${task.cases.length}}));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: safeEnv, timeout: 3000, maxBuffer: 4096, encoding: 'utf8' });
    if (r.status !== 0)
        return { passed: 0, total: task.cases.length };
    try {
        return JSON.parse(r.stdout.trim()) as {
            passed: number;
            total: number;
        };
    }
    catch {
        return { passed: 0, total: task.cases.length };
    }
}
async function one(task: EvidenceTask, repeat: number, arm: Run['arm'], opts: EvalOptions): Promise<Run> {
    const root = mkdtempSync(join(tmpdir(), 'kitzur-coding-'));
    writeFileSync(join(root, 'solution.mjs'), task.initial);
    const attempts: Attempt[] = [];
    const pending = new Set<Promise<void>>();
    const controllers = new Set<AbortController>();
    let correctionDelivered = false;
    let correctionTurn = 0;
    const settle = async () => { for (const c of controllers)
        c.abort(); await Promise.allSettled([...pending]); };
    let mockTurn = 0;
    let evidenceVisible = false, wrote = false, tested = false;
    const evidenceReads: Array<{ sha256: string; evicted: boolean }> = [];
    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const started = performance.now();
        const attempt: Attempt = { status: 0, latencyMs: 0, promptTokens: null, completionTokens: null, bodyBytes: 0, afterCorrection: correctionDelivered, compactedPrompt: false, currentRulePresent: false, obsoleteRulePresent: false };
        const controller = new AbortController();
        controllers.add(controller);
        try {
            const bytes = await body(req);
            attempt.bodyBytes = bytes.length;
            attempts.push(attempt);
            const parsed = JSON.parse(bytes.toString()) as ChatRequest;
            const text = parsed.messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
            attempt.compactedPrompt = text.includes('[kitzur]');
            attempt.currentRulePresent = text.includes(task.currentRule);
            attempt.obsoleteRulePresent = !!task.obsoleteRule && text.includes(task.obsoleteRule);
            if (task.evidence) attempt.evidencePresent = evidenceVisible = text.includes(task.evidence.marker);
            let status: number;
            let response: Buffer;
            if (opts.mock) {
                const prompt = Math.ceil(bytes.length / 4);
                if (opts.mockDelayMs && mockTurn >= (opts.mockDelayAfterTurn ?? 0))
                    await new Promise<void>((r, reject) => { const t = setTimeout(r, opts.mockDelayMs); controller.signal.addEventListener('abort', () => { clearTimeout(t); reject(Error('observer aborted')); }, { once: true }); });
                if (opts.mockReject) {
                    status = 400;
                    response = Buffer.from('{"error":{"code":"invalid_request"}}');
                }
                else if ((opts.mockRetry && arm === 'kitzur' && attempts.length === 1) || prompt + opts.outputTokens > opts.window) {
                    status = 400;
                    response = Buffer.from(JSON.stringify({ error: { code: 'context_length_exceeded', message: `maximum context length is ${opts.mockRetry ? Math.floor(opts.window * 0.85) : opts.window} tokens. requested ${prompt + opts.outputTokens} tokens (${prompt} in the messages, ${opts.outputTokens} in the completion)` } }));
                }
                else {
                    status = 200;
                    mockTurn++;
                    let calls = opts.mockEarlyFinal && mockTurn === 1 ? undefined : mockTurn === (opts.mockEarlyFinal ? 2 : 1) ? [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"solution.mjs"}' } }] : mockTurn === (opts.mockEarlyFinal ? 3 : 2) ? [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'solution.mjs', content: opts.mockWrong ? task.initial : task.solution }) } }] : mockTurn === (opts.mockEarlyFinal ? 4 : 3) ? [{ id: 'test', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] : opts.postPressureChars && mockTurn < 8 ? [{ id: 'pressure-' + mockTurn, type: 'function', function: { name: 'run_tests', arguments: '{}' } }] : undefined;
                    if (task.evidence) {
                        const name = mockTurn === 1 ? 'read_file' : mockTurn < 7 ? 'run_tests' : !evidenceVisible ? 'read_file' : !wrote ? 'write_file' : !tested ? 'run_tests' : null;
                        const args = name === 'read_file' ? { path: mockTurn === 1 ? 'solution.mjs' : task.evidence.path } : name === 'write_file' ? { path: 'solution.mjs', content: !opts.mockWrong && attempt.currentRulePresent ? task.solution : task.initial } : {};
                        calls = name ? [{ id: `evidence-${mockTurn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] : undefined;
                        if (name === 'write_file') wrote = true;
                        else if (name === 'run_tests' && wrote) tested = true;
                    }
                    response = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: calls ? null : 'Done.', ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? (opts.mockLengthWithTools ? 'length' : 'tool_calls') : opts.mockFinishReason ?? 'stop' }], ...(!opts.mockMissingUsage ? { usage: { prompt_tokens: opts.mockInvalidUsage ? -1 : prompt, ...(opts.mockPartialUsage ? {} : { completion_tokens: 20 }) } } : {}) }));
                }
            }
            else {
                const upstream = await fetch(opts.endpoint!, { method: 'POST', headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) }, body: bytes, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(opts.timeoutMs)]) });
                status = upstream.status;
                response = Buffer.from(await upstream.arrayBuffer());
            }
            attempt.overflow = status === 400 && /context_length_exceeded|maximum context length|context window/i.test(response.toString());
            let usage: {
                prompt_tokens?: number;
                completion_tokens?: number;
            } | undefined;
            try {
                usage = JSON.parse(response.toString()).usage;
            }
            catch { /* absent usage */ }
            const valid = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
            Object.assign(attempt, { status, latencyMs: performance.now() - started, promptTokens: valid(usage?.prompt_tokens) ? usage!.prompt_tokens! : null, completionTokens: valid(usage?.completion_tokens) ? usage!.completion_tokens! : null });
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(response);
        }
        catch {
            attempt.latencyMs = performance.now() - started;
            if (!attempts.includes(attempt))
                attempts.push(attempt);
            if (!res.destroyed) {
                res.writeHead(504);
                res.end('{"error":{"code":"observer_timeout"}}');
            }
        }
        finally {
            controllers.delete(controller);
        }
    };
    const observer = http.createServer((req, res) => { const p = handle(req, res); pending.add(p); void p.finally(() => pending.delete(p)); });
    let origin: string;
    try {
        origin = await listen(observer);
    }
    catch {
        await close(observer);
        throw Error('observer setup failed');
    }
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    const stats = join(root, 'stats.jsonl');
    let url = origin + '/v1/chat/completions';
    try {
        if (arm === 'kitzur') {
            const cfg = structuredClone(DEFAULT_CONFIG);
            cfg.upstream.origin = origin;
            cfg.listen.port = 0;
            cfg.stateDir = join(root, 'state');
            cfg.stats.path = stats;
            cfg.tokenizer.mode = 'estimate';
            cfg.tokenizer.template.name = 'generic';
            cfg.budget.window = opts.window;
            cfg.budget.defaultMaxTokens = opts.outputTokens;
            cfg.upstream.timeoutMs = opts.timeoutMs;
            app = await buildApp(cfg);
            const address = await app.listen();
            url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
        }
    }
    catch {
        await settle();
        await app?.close(0);
        await close(observer);
        throw Error('proxy setup failed');
    }
    const finalizedStats = async () => {
        await app?.close(0); app = undefined;
        if (arm === 'direct') return {compactions:0, postCorrectionCompactions:0};
        try {
            const rows=readFileSync(stats,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x) as {compacted?:boolean;seq:number});
            return {compactions:rows.filter(r=>r.compacted).length,postCorrectionCompactions:rows.filter(r=>r.compacted&&r.seq>correctionTurn).length};
        } catch {return {compactions:null,postCorrectionCompactions:null};}
    };
    const messages = retentionHistory(task, opts.pressureChars ?? 18000);
    const start = performance.now();
    let turns = 0;
    let outcome: Run['outcome'] = 'incomplete';
    try {
        for (; turns < opts.maxTurns;) {
            if (performance.now() - start > opts.timeoutMs) {
                outcome = 'timeout';
                break;
            }
            const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: opts.model, messages, tools, temperature: 0, max_tokens: opts.outputTokens, stream: false }), signal: AbortSignal.timeout(Math.max(1, Math.floor(opts.timeoutMs - (performance.now() - start)))) });
            turns++;
            if (!response.ok) {
                const error = await response.text();
                outcome = /context_length_exceeded|maximum context length|context window/i.test(error) ? 'overflow' : response.status === 504 ? 'timeout' : 'harness-error';
                break;
            }
            const json = await response.json() as {
                choices?: Array<{
                    message: ChatMessage;
                    finish_reason?: string;
                }>;
            };
            const choice = json.choices?.[0];
            if (!choice?.message) {
                outcome = 'harness-error';
                break;
            }
            if(choice.finish_reason==='length'){outcome='incomplete';break;}
            messages.push(choice.message);
            if (!choice.message.tool_calls?.length) {
                if (!correctionDelivered && choice.finish_reason === 'stop') {
                    messages.push({ role: 'user', content: task.correction });
                    correctionDelivered = true;
                    correctionTurn = turns;
                    continue;
                }
                outcome = choice.finish_reason === 'stop' ? 'fail' : choice.finish_reason === 'length' ? 'incomplete' : 'harness-error';
                break;
            }
            for (const call of choice.message.tool_calls) {
                let result: string;
                try {
                    const args = JSON.parse(call.function.arguments) as {
                        path?: string;
                        content?: string;
                    };
                    if (call.function.name === 'run_tests') {
                        const checked = spawnSync(process.execPath, ['--check', checkFile(root)], { env: safeEnv, timeout: 2000, maxBuffer: 4096 });
                        result = checked.status === 0 ? 'Syntax check passed.' : 'Syntax check failed.';
                    }
                    else if (call.function.name === 'read_file' && task.evidence && args.path === task.evidence.path) {
                        result = task.evidence.content;
                        evidenceReads.push({ sha256: createHash('sha256').update(result).digest('hex'), evicted: !evidenceVisible });
                    }
                    else {
                        if (args.path !== 'solution.mjs')
                            throw Error('Only solution.mjs is accessible');
                        const file = checkFile(root);
                        if (call.function.name === 'read_file')
                            result = readFileSync(file, 'utf8');
                        else if (call.function.name === 'write_file' && typeof args.content === 'string' && args.content.length <= 50000) {
                            writeFileSync(file, args.content);
                            result = 'Written.';
                        }
                        else
                            throw Error('Unsupported tool or arguments');
                    }
                }
                catch {
                    result = 'Tool rejected: invalid tool, path, or arguments.';
                }
                if (correctionDelivered && opts.postPressureChars)
                    result += '\n' + ('Archived diagnostic log; no source changes. '.repeat(Math.ceil(opts.postPressureChars / 42)));
                messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
            // Same predetermined event boundary in both arms; correction arrives after
            // first real read, never bundled with model-specific compaction decisions.
            if (!correctionDelivered) {
                messages.push({ role: 'user', content: task.correction });
                correctionDelivered = true;
                correctionTurn = turns;
            }
        }
        await settle();
        const checks = grade(root, task);
        if (outcome === 'fail')
            outcome = checks.passed === checks.total ? 'pass' : 'fail';
        const compactionCounts=await finalizedStats();
        const completeUsage = attempts.length > 0 && attempts.every(a => a.promptTokens !== null && a.completionTokens !== null);
        return { task: task.id, repeat, arm, outcome, checksPassed: checks.passed, checksTotal: checks.total, turns, latencyMs: performance.now() - start, attempts,
            promptTokens: completeUsage ? attempts.reduce((n, a) => n + a.promptTokens!, 0) : null, completionTokens: completeUsage ? attempts.reduce((n, a) => n + a.completionTokens!, 0) : null,
            usageCoverage: attempts.filter(a => a.promptTokens !== null && a.completionTokens !== null).length, promptUsageCoverage: attempts.filter(a => a.promptTokens !== null).length, completionUsageCoverage: attempts.filter(a => a.completionTokens !== null).length, ...compactionCounts,
            evidenceReads, workspaceHash: createHash('sha256').update(readFileSync(checkFile(root))).digest('hex') };
    }
    catch (e) {
        await settle();
        const compactionCounts=await finalizedStats();
        return { task: task.id, repeat, arm, outcome: /Timeout|Abort/.test((e as Error).name) ? 'timeout' : 'harness-error', checksPassed: 0, checksTotal: task.cases.length, turns, latencyMs: performance.now() - start, attempts, promptTokens: null, completionTokens: null, usageCoverage: attempts.filter(a => a.promptTokens !== null && a.completionTokens !== null).length, promptUsageCoverage: attempts.filter(a => a.promptTokens !== null).length, completionUsageCoverage: attempts.filter(a => a.completionTokens !== null).length, ...compactionCounts, evidenceReads, workspaceHash: '' };
    }
    finally {
        await settle();
        await app?.close(0);
        await close(observer);
    }
}
export async function evaluate(opts: EvalOptions, tasks: EvidenceTask[] = TASKS) {
    if (!opts.mock && (!opts.endpoint || !/^https?:\/\//.test(opts.endpoint)))
        throw Error('Live evaluation requires a Chat Completions endpoint');
    for (const key of ['repeats', 'maxTurns', 'timeoutMs', 'outputTokens', 'window'] as const)
        if (!Number.isInteger(opts[key]) || opts[key] <= 0)
            throw Error(`Invalid ${key}`);
    if (opts.pressureChars !== undefined && (!Number.isInteger(opts.pressureChars) || opts.pressureChars < 0 || opts.pressureChars > 1000000))
        throw Error('Invalid pressureChars');
    if (opts.postPressureChars !== undefined && (!Number.isInteger(opts.postPressureChars) || opts.postPressureChars < 0 || opts.postPressureChars > 1000000))
        throw Error('Invalid postPressureChars');
    if (!opts.mock && opts.model === 'deterministic-mock')
        throw Error('Live evaluation requires explicit model');
    if (opts.repeats > 100 || opts.maxTurns > 100 || opts.timeoutMs > 3600000)
        throw Error('Run limits exceeded');
    const runs: Run[] = [];
    for (let repeat = 0; repeat < opts.repeats; repeat++)
        for (const task of tasks)
            for (const arm of (repeat % 2 ? ['kitzur', 'direct'] : ['direct', 'kitzur']) as Run['arm'][])
                runs.push(await one(task, repeat, arm, opts));
    const arms = Object.fromEntries((['direct', 'kitzur'] as const).map(arm => { const rows = runs.filter(r => r.arm === arm); return [arm, { runs: rows.length, passed: rows.filter(r => r.outcome === 'pass').length, completed: rows.filter(r => r.outcome === 'pass' || r.outcome === 'fail').length, latencyMs: rows.map(r => r.latencyMs), promptTokens: rows.map(r => r.promptTokens), compactions: rows.reduce((n, r) => n + (r.compactions ?? 0), 0),compactionCoverage:rows.filter(r=>r.compactions!==null).length }]; }));
    return { version: 1, reproducibility: { engineVersion: ENGINE_ALGO_VERSION, countingMode: 'estimate', template: 'generic', taskHash: createHash('sha256').update(JSON.stringify(tasks)).digest('hex'), toolHash: createHash('sha256').update(JSON.stringify(tools)).digest('hex'), baseConfigHash: createHash('sha256').update(JSON.stringify(DEFAULT_CONFIG)).digest('hex'), partialEngineSourceHash: createHash('sha256').update(readFileSync(new URL('../../src/engine/ledger/supersede.js', import.meta.url))).update(readFileSync(new URL('../../src/engine/plan.js', import.meta.url))).update(readFileSync(new URL('../../src/engine/summary.js', import.meta.url))).digest('hex'), runnerHash: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') }, mode: opts.mock ? 'deterministic-mock' : 'live-model', liveValidation: opts.mock ? 'pending' : 'executed', syntheticPrehistory: true, clientCompactionPolicy: 'none', settings: { model: opts.model, repeats: opts.repeats, maxTurns: opts.maxTurns, timeoutMs: opts.timeoutMs, outputTokens: opts.outputTokens, window: opts.window, pressureChars: opts.pressureChars ?? 18000, postPressureChars: opts.postPressureChars ?? 0, temperature: 0 }, arms, runs };
}
