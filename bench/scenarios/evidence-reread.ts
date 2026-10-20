import { seededHistory, type CodingTask } from '../coding/tasks.js';

export interface EvidenceTask extends CodingTask {
  evidence?: { path: string; content: string; marker: string };
}
// Immutable file evidence, first observed before synthetic pressure. Acceptance
// requires both the old file value and the later correction, not marker presence.
export const evidenceReread: EvidenceTask = {
  id: 'evidence-reread',
  initial: 'export function solve(x) { return x; }\n',
  requirement: 'USER-OFFSET-R3: Implement solve(x): add the offset from calibration.txt. Use read_file to recover that file if necessary.',
  correction: 'Correction for USER-OFFSET-R3: subtract the offset instead of adding it. Keep input unchanged.',
  currentRule: 'subtract the offset', obsoleteRule: 'add the offset',
  evidence: { path: 'calibration.txt', marker: 'calibration offset = 731', content: 'Calibration dump\n' + 'sample unchanged\n'.repeat(150) + 'calibration offset = 731\n' + 'sample unchanged\n'.repeat(150) },
  solution: 'export function solve(x) { return x - 731; }\n',
  cases: [{ input: 731, expected: 0 }, { input: 0, expected: -731 }, { input: -2, expected: -733 }],
};

export function retentionHistory(task: EvidenceTask, pressureChars: number) {
  const messages = seededHistory(task, pressureChars);
  if (task.evidence) {
    messages[0]!.content = `You are a coding agent. Workspace files: solution.mjs (writable) and ${task.evidence.path} (read-only). Use read_file/write_file/run_tests, then finish. Work only on the requested function.`;
    messages.splice(4, 0,
    { role: 'assistant', content: null, tool_calls: [{ id: 'old-evidence', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: task.evidence.path }) } }] },
    { role: 'tool', tool_call_id: 'old-evidence', content: task.evidence.content });
  }
  return messages;
}
