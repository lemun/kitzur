// Demo upstream for the README recordings: an OpenAI-compatible Chat Completions stub.
// It answers every request with a canned reply; it is not a model. Usage: node mock-upstream.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8000);

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const prompt = Math.ceil(body.length / 4);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'demo',
      object: 'chat.completion',
      model: 'demo-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok (demo upstream)' } }],
      usage: { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 },
    }));
  });
}).listen(port, '127.0.0.1');
