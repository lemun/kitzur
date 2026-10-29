import type { ChatMessage } from '../../src/types.js';
export interface CodingTask {
    id: string;
    initial: string;
    requirement: string;
    correction: string;
    solution: string;
    currentRule: string;
    obsoleteRule?: string;
    // Optional standing instruction in the first user turn, and an earlier user
    // change placed inside the synthetic history before the live correction.
    firstTurn?: string;
    interim?: string;
    cases: Array<{
        input: unknown;
        expected: unknown;
        inputExpression?: string;
    }>;
}
// Synthetic long histories describe this exact initial workspace. Acceptance cases
// are never exposed through the agent's file tools.
export const TASKS: CodingTask[] = [
    { id: 'corrected-dedupe', initial: 'export function solve(xs) { return xs; }\n',
        requirement: 'USER-DEDUPE-R1: Implement solve(xs): remove duplicate strings ignoring case, keeping the FIRST spelling.',
        correction: 'Correction for USER-DEDUPE-R1: keep the LAST spelling of each case-insensitive duplicate instead; preserve first-key order. Do not add dependencies.',
        solution: 'export function solve(xs) { const m=new Map(); for(const x of xs)m.set(x.toLowerCase(),x); return [...m.values()]; }\n',
        currentRule: 'LAST spelling', obsoleteRule: 'FIRST spelling',
        cases: [{ input: ['A', 'b', 'a', 'B', 'c'], expected: ['a', 'B', 'c'] }, { input: [], expected: [] }, { input: ['One', 'ONE', 'two'], expected: ['ONE', 'two'] }] },
    { id: 'hebrew-cancellation', initial: 'export function solve(xs) { return xs; }\n',
        requirement: 'USER-SORT-R2: ממש solve(xs): מיין מספרים בסדר עולה והסר כפילויות. בלי תלות חיצונית.',
        correction: 'תיקון עבור USER-SORT-R2: בטל את הסרת הכפילויות. מיין בסדר יורד במקום בסדר עולה ושמור כל מופע.',
        solution: 'export function solve(xs) { return [...xs].sort((a,b)=>b-a); }\n',
        currentRule: 'בסדר יורד', obsoleteRule: 'בסדר עולה והסר כפילויות',
        cases: [{ input: [2, 1, 2, 9], expected: [9, 2, 2, 1] }, { input: [-3, 0, -1], expected: [0, -1, -3] }, { input: [], expected: [] }] },
    { id: 'tool-pressure', initial: 'export function solve(xs) { return xs; }\n',
        requirement: 'Implement solve(xs): return sum of finite numeric values only. Keep input unchanged; no dependencies.',
        correction: 'Additional instruction: ignore numeric strings too. Keep the finite-number requirement.',
        solution: 'export function solve(xs) { return xs.filter(x=>typeof x==="number"&&Number.isFinite(x)).reduce((a,b)=>a+b,0); }\n',
        currentRule: 'finite numeric values',
        cases: [{ input: [1, '2', null, 3], expected: 4 }, { input: [-4, 2.5, 1.5], expected: 0 }, { input: [], expected: 0 }, { input: null, inputExpression: '[1,NaN,Infinity,-Infinity,"2"]', expected: 1 }] },
    { id: 'stacked-corrections', initial: 'export function solve(xs) { return xs; }\n',
        requirement: "USER-JOIN-R4: Implement solve(xs): return the strings joined with ','.",
        interim: "Correction for USER-JOIN-R4: use ';' as the separator, and skip empty strings.",
        correction: "Second correction for USER-JOIN-R4: use ' | ' instead of the semicolon. Keep skipping empty strings.",
        solution: "export function solve(xs) { return xs.filter(x=>x!=='').join(' | '); }\n",
        currentRule: "' | '", obsoleteRule: "use ';' as the separator",
        cases: [{ input: ['a', '', 'b'], expected: 'a | b' }, { input: [], expected: '' }, { input: ['', 'x', ''], expected: 'x' }] },
    { id: 'revoked-instruction', initial: 'export function solve(xs) { return xs; }\n',
        requirement: 'USER-CLAMP-R5: Implement solve(xs): clamp each number to [0, 100] and round each to an integer.',
        correction: 'Correction for USER-CLAMP-R5: revoke the rounding instruction; keep fractional values. Still clamp to [0, 100].',
        solution: 'export function solve(xs) { return xs.map(x=>Math.min(100,Math.max(0,x))); }\n',
        currentRule: 'keep fractional values', obsoleteRule: 'round each to an integer',
        cases: [{ input: [-5, 50.5, 120], expected: [0, 50.5, 100] }, { input: [], expected: [] }, { input: [99.9, 0.25], expected: [99.9, 0.25] }] },
    { id: 'corrected-constant', initial: 'export function solve(xs) { return xs; }\n',
        requirement: 'USER-FEE-R6: Implement solve(xs): add a flat fee of 25 cents to each amount (in cents).',
        correction: 'Correction for USER-FEE-R6: the flat fee is 40 cents, not 25. Everything else stays.',
        solution: 'export function solve(xs) { return xs.map(x=>x+40); }\n',
        currentRule: 'fee is 40 cents', obsoleteRule: 'fee of 25 cents',
        cases: [{ input: [0, 100], expected: [40, 140] }, { input: [], expected: [] }, { input: [-40], expected: [0] }] },
    { id: 'first-turn-rule', initial: 'export function solve(xs) { return xs; }\n',
        firstTurn: 'Work on solution.mjs; await the detailed function requirement. Standing rule USER-RULE-R7 for this session: never return negative numbers; replace any negative result with 0.',
        requirement: 'USER-DIFF-R7: Implement solve(xs): return the differences xs[i+1]-xs[i] for each adjacent pair.',
        correction: 'Correction for USER-DIFF-R7: return xs[i]-xs[i+1] for each adjacent pair instead.',
        solution: 'export function solve(xs) { return xs.slice(1).map((x,i)=>Math.max(0,xs[i]-x)); }\n',
        currentRule: 'never return negative numbers', obsoleteRule: 'xs[i+1]-xs[i]',
        cases: [{ input: [5, 3, 4], expected: [2, 0] }, { input: [1], expected: [] }, { input: [], expected: [] }, { input: [10, 1, 1], expected: [9, 0] }] },
];
export function seededHistory(task: CodingTask, pressureChars = 18000): ChatMessage[] {
    const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a coding agent. Only workspace file solution.mjs exists. Use read_file/write_file/run_tests tools, then finish. Work only on the requested function.' },
        { role: 'user', content: task.firstTurn ?? 'Work on solution.mjs; await the detailed function requirement.' },
        { role: 'assistant', content: 'Ready for the function requirement.' },
        { role: 'user', content: task.requirement },
    ];
    for (let i = 0; i < 8; i++) {
        const id = `seed-${i}`;
        if (i === 4 && task.interim)
            messages.push({ role: 'user', content: task.interim });
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{"path":"solution.mjs"}' } }] }, { role: 'tool', tool_call_id: id, content: task.initial + '\n/* archived diagnostic output: ' + ('checked source; no implementation change. '.repeat(Math.ceil(pressureChars / 8 / 42))) + ' */' });
    }
    return messages;
}
