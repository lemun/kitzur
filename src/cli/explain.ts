import type { RetentionAttribution, RetentionSource } from '../engine/contracts.js';

export interface RetentionRenderOptions {
  limit?: number;
}

const sourceLabel = (source: RetentionSource): string => {
  switch (source.kind) {
    case 'message': return `message[${source.messageIndex}]`;
    case 'tool-call': return `tool-call[${source.messageIndex}:${source.callIndex}]`;
    case 'tool-result': return `tool-result[${source.messageIndex}]${source.call ? ` from tool-call[${source.call.messageIndex}:${source.call.callIndex}]` : ''}`;
  }
};

export function renderRetention(retention: RetentionAttribution[], opts: RetentionRenderOptions = {}): string {
  const limit = opts.limit ?? 20;
  const summarized = retention.filter((item) => item.disposition === 'summarized').length;
  const dropped = retention.length - summarized;
  const lines = [`retention: ${summarized} summarized, ${dropped} dropped`];

  if (retention.length) {
    lines.push('category    reason             summarized  dropped');
    const counts = new Map<string, { summarized: number; dropped: number }>();
    for (const item of retention) {
      const key = `${item.category}\0${item.reason}`;
      const count = counts.get(key) ?? { summarized: 0, dropped: 0 };
      count[item.disposition]++;
      counts.set(key, count);
    }
    for (const [key, count] of counts) {
      const [category, reason] = key.split('\0');
      lines.push(`${category!.padEnd(11)} ${reason!.padEnd(18)} ${String(count.summarized).padStart(10)} ${String(count.dropped).padStart(7)}`);
    }
  }

  const shown = limit === 0 ? retention.length : Math.min(limit, retention.length);
  for (const item of retention.slice(0, shown)) {
    const fields = [item.category, item.disposition, item.reason, item.sources.map(sourceLabel).join(', ') || 'no source'];
    if (item.supersededBy.length) fields.push(`superseded by ${item.supersededBy.join(', ')}`);
    if (item.signals?.length) fields.push(`signals ${item.signals.join(', ')}`);
    lines.push(`  ${fields.join(' | ')}`);
  }
  if (shown < retention.length) lines.push(`... and ${retention.length - shown} more (use --explain-limit 0)`);
  return lines.join('\n');
}
