// Per-arm and per-task pass rates with Wilson 95% score intervals. A difference is
// reported only when the two arms' intervals do not overlap; otherwise the verdict
// is 'inconclusive'. Small run counts give wide intervals by design.
import type { Run } from './runner.js';
export function wilson(passes: number, n: number, z = 1.96): [number, number] {
    if (n <= 0)
        return [0, 1];
    const p = passes / n, z2 = z * z, denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
export interface ArmSummary {
    runs: number;
    passes: number;
    incompletes: number;
    passRate: number | null;
    ci95: [number, number];
}
function arm(rows: Run[]): ArmSummary {
    const passes = rows.filter(r => r.outcome === 'pass').length;
    // Anything other than a completed pass/fail (limit, overflow, timeout, harness error).
    const incompletes = rows.filter(r => r.outcome !== 'pass' && r.outcome !== 'fail').length;
    return { runs: rows.length, passes, incompletes, passRate: rows.length ? passes / rows.length : null, ci95: wilson(passes, rows.length) };
}
function verdict(direct: ArmSummary, kitzur: ArmSummary): string {
    if (direct.runs && kitzur.runs && direct.ci95[1] < kitzur.ci95[0])
        return 'kitzur higher (intervals do not overlap)';
    if (direct.runs && kitzur.runs && kitzur.ci95[1] < direct.ci95[0])
        return 'direct higher (intervals do not overlap)';
    return 'inconclusive';
}
function group(rows: Run[]) {
    const direct = arm(rows.filter(r => r.arm === 'direct')), kitzur = arm(rows.filter(r => r.arm === 'kitzur'));
    return { direct, kitzur, verdict: verdict(direct, kitzur) };
}
export function summarize(runs: Run[]) {
    const tasks = [...new Set(runs.map(r => r.task))];
    return { overall: group(runs), tasks: tasks.map(task => ({ task, ...group(runs.filter(r => r.task === task)) })) };
}
export function summaryText(summary: ReturnType<typeof summarize>): string {
    const pct = (x: number) => (x * 100).toFixed(1) + '%';
    const line = (label: string, g: ReturnType<typeof group>) => (['direct', 'kitzur'] as const).map(a => { const s = g[a]; return `${label} ${a}: runs ${s.runs}, passes ${s.passes}, incompletes ${s.incompletes}, pass rate ${s.passRate === null ? 'n/a' : pct(s.passRate)} (95% CI ${pct(s.ci95[0])}-${pct(s.ci95[1])})`; }).concat(`${label} verdict: ${g.verdict}`);
    return ['Pass-rate summary (Wilson 95% intervals)', ...line('all', summary.overall), ...summary.tasks.flatMap(t => line(t.task, t))].join('\n') + '\n';
}
