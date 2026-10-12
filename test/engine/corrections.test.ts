import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../../src/engine/engine.js';
import { createSummarizer } from '../../src/engine/summary.js';
import { createToolRules } from '../../src/engine/rules/index.js';
import { testConfig, estimateCounter } from './stubs.js';
import { pairingIntact } from './oracle.js';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import type { ChatMessage, ChatRequest } from '../../src/types.js';
for (const [name, old, current] of [
    ['English', 'USER-PLAN-R1: Run the payment tests.', 'Correction USER-PLAN-R1: Cancel the payment tests.'],
    ['Hebrew', 'USER-PLAN-R1: תריץ בדיקות תשלום.', 'תיקון USER-PLAN-R1: בטל בדיקות תשלום.'],
] as const)
    test(`${name}: repeated small-window compactions retain correction with deterministic paired output`, () => {
        const cfg = testConfig({ budget: { window: 8000, defaultMaxTokens: 256 }, compaction: { triggerTokens: 3500, targetTokens: 1500 }, tokenizer: { template: { name: 'generic' } } });
        const make = () => { const counter = estimateCounter('generic'); return { counter, engine: createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg) }) }; };
        const live = make();
        const messages: ChatMessage[] = [{ role: 'system', content: 'Coding task.' }, { role: 'user', content: 'Work on solution.mjs.' }, { role: 'assistant', content: 'Ready.' }, { role: 'user', content: old }, { role: 'assistant', content: 'Understood.' }, { role: 'user', content: current }];
        let compacted = 0;
        let previous: ChatMessage[] = [];
        let epoch = 0;
        for (let i = 0; i < 15; i++) {
            const id = `tool-${i}`;
            messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{"path":"solution.mjs"}' } }] }, { role: 'tool', tool_call_id: id, content: 'Diagnostic output. '.repeat(450) });
            const req: ChatRequest = { model: 'test', messages: structuredClone(messages), max_tokens: 256 };
            const result = live.engine.process(req, { attempt: 1 });
            const fresh = make().engine.process(req, { attempt: 1 });
            assert.equal(canonicalJSON(result.request), canonicalJSON(fresh.request));
            assert.ok(result.request);
            assert.ok(pairingIntact(result.request!.messages));
            assert.ok(live.counter.countRequest(result.request!) <= result.stats.budget.budget);
            const count = result.plan?.compactions ?? 0;
            if (count === epoch && previous.length)
                assert.equal(canonicalJSON(result.request!.messages.slice(0, previous.length)), canonicalJSON(previous));
            if (count > epoch) {
                compacted++;
                epoch = count;
                const summary = result.plan?.summary ?? '';
                assert.ok(summary.includes(current), summary);
                assert.ok(!summary.includes(old), summary);
            }
            previous = result.request!.messages;
        }
        assert.ok(compacted >= 2, `compactions ${compacted}`);
    });
