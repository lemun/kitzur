import type { ChatMessage } from '../../src/types.js';
export interface CodingTask {
    id: string;
    initial: string;
    requirement: string;
    correction: string;
    solution: string;
    currentRule: string;
    obsoleteRule?: string;
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
];
export function seededHistory(task: CodingTask, pressureChars = 18000): ChatMessage[] {
    const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a coding agent. Only workspace file solution.mjs exists. Use read_file/write_file/run_tests tools, then finish. Work only on the requested function.' },
        { role: 'user', content: 'Work on solution.mjs; await the detailed function requirement.' },
        { role: 'assistant', content: 'Ready for the function requirement.' },
        { role: 'user', content: task.requirement },
    ];
    for (let i = 0; i < 8; i++) {
        const id = `seed-${i}`;
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{"path":"solution.mjs"}' } }] }, { role: 'tool', tool_call_id: id, content: task.initial + '\n/* archived diagnostic output: ' + ('checked source; no implementation change. '.repeat(Math.ceil(pressureChars / 8 / 42))) + ' */' });
    }
    return messages;
}
