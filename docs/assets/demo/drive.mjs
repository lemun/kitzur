// Demo client for the README recordings: a scripted "agent" that reads files and sends a growing
// session through a proxy. Prints what Kitzur reported for each request.
// Usage: node drive.mjs [baseURL] [steps] [pauseMs]
const base = process.argv[2] ?? 'http://127.0.0.1:8270/v1';
const steps = Number(process.argv[3] ?? 14);
const pauseMs = Number(process.argv[4] ?? 0);

const filler = (n) => Array.from({ length: 220 }, (_, i) => `line ${n}.${i}: const value_${n}_${i} = compute(${i * 7 + n});`).join('\n');
const messages = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'Fix the flaky login test. Do not edit anything under src/auth/. Keep the change small.' },
];

for (let step = 1; step <= steps; step++) {
  const id = `call_${step}`;
  messages.push(
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: `src/module${step}.ts` }) } }] },
    { role: 'tool', tool_call_id: id, content: filler(step) },
  );
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'demo-model', max_tokens: 8000, messages }),
  });
  await res.arrayBuffer();
  const action = res.headers.get('x-kitzur-action') ?? '-';
  const tokens = res.headers.get('x-kitzur-tokens') ?? '-';
  if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  console.log(`step ${String(step).padStart(2)}  action=${action.padEnd(11)} tokens(in/out/trigger)=${tokens}`);
}
