import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Loader } from 'astro/loaders';

// Docs pages rendered straight from the repo's markdown, so the prose lives in one place.
// `section` keeps only that `## ` heading's body (README is also the GitHub landing page).
const pages = [
  { id: 'docs', file: 'docs/README.md' },
  { id: 'docs/quick-start', file: 'README.md', section: 'Quick start' },
  { id: 'docs/configuration', file: 'CONFIG.md' },
  { id: 'docs/design', file: 'DESIGN.md' },
  { id: 'docs/deployment', file: 'deploy/README.md' },
  { id: 'docs/diagnostics', file: 'docs/DIAGNOSTICS.md' },
  { id: 'docs/troubleshooting', file: 'docs/TROUBLESHOOTING.md' },
  { id: 'docs/upstream-rotation', file: 'docs/UPSTREAM-ROTATION.md' },
  { id: 'docs/gobstopper-interop', file: 'docs/GOBSTOPPER-INTEROP.md' },
  { id: 'docs/security', file: 'SECURITY.md' },
  { id: 'docs/benchmarks', file: 'bench/README.md' },
  { id: 'docs/changelog', file: 'CHANGELOG.md' },
];

const blob = 'https://github.com/lemun/kitzur/blob/main/';
const raw = 'https://raw.githubusercontent.com/lemun/kitzur/main/';
const slugify = (s: string) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function pageFor(path: string, hash: string) {
  return pages.find((p) => p.file === path && (!p.section || hash === `#${slugify(p.section)}`));
}

/** Rewrites a repo-relative link (or a GitHub link to a paged file) from `file` to a site route, or else to the file on GitHub. */
export function rewriteLink(target: string, file: string, base: string, asset = false): string {
  const github = target.startsWith(blob);
  if (!github && /^([a-z][\w+.-]*:|\/|#)/i.test(target)) return target;
  const [rel, frag = ''] = (github ? target.slice(blob.length) : target).split(/(?=#)/);
  const path = github ? rel : posix.normalize(posix.join(posix.dirname(file), rel));
  const page = pageFor(path, frag);
  if (page) return `${base}/${page.id}/${page.section ? '' : frag}`;
  return (asset ? raw : blob) + path + frag;
}

export function toPage(md: string, file: string, base: string, section?: string) {
  let body = md;
  let title = section;
  if (section) {
    const start = md.indexOf(`\n## ${section}\n`);
    const end = md.indexOf('\n## ', start + 1);
    body = md.slice(start + section.length + 5, end < 0 ? undefined : end);
  } else {
    const h1 = /^# (.+)\n/m.exec(md);
    title = h1?.[1];
    if (h1) body = md.slice(0, h1.index) + md.slice(h1.index + h1[0].length);
  }
  body = body
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (_, bang, text, t) => `${bang}[${text}](${rewriteLink(t, file, base, !!bang)})`)
    .replace(/\b(src|href)="([^"]+)"/g, (_, attr, t) => `${attr}="${rewriteLink(t, file, base, attr === 'src')}"`);
  return { title: title ?? file, body };
}

export function repoDocsLoader(): Loader {
  return {
    name: 'kitzur:repo-docs',
    load: async ({ config, store, parseData, renderMarkdown, generateDigest }) => {
      const repo = new URL('../', config.root);
      const base = config.base.replace(/\/$/, '');
      store.clear();
      for (const [order, { id, file, section }] of pages.entries()) {
        const md = await readFile(new URL(file, repo), 'utf8');
        const { title, body } = toPage(md, file, base, section);
        const data = await parseData({ id, data: { title, sidebar: { order } } });
        // Starlight builds its sidebar tree from filePath, as if the page lived in src/content/docs.
        const filePath = `src/content/docs/${id}.md`;
        store.set({ id, data, body, filePath, digest: generateDigest(body), rendered: await renderMarkdown(body) });
      }
    },
  };
}
