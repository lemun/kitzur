// @ts-check
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';

const site = 'https://lemun.github.io';
const base = '/kitzur';
const title = 'Kitzur';
const description =
  'Zero-dependency context compaction proxy for coding agents using local LLMs. Keep coding in the context window your local model actually serves.';

// The OG image lives in the repo's docs/assets; copy it into the build output
// instead of keeping a second copy under site/public.
const socialPreview = fileURLToPath(new URL('../docs/assets/social-preview.png', import.meta.url));
const ogImage = `${site}${base}/social-preview.png`;

/** @returns {import('astro').AstroIntegration} */
function socialPreviewImage() {
  return {
    name: 'kitzur:social-preview',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        await copyFile(socialPreview, new URL('social-preview.png', dir));
      },
    },
  };
}

export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title,
      description,
      logo: { src: '../docs/assets/logo.svg', alt: 'Kitzur' },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/lemun/kitzur' }],
      customCss: ['./src/styles/kitzur.css'],
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImage } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1280' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '640' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: ogImage } },
      ],
    }),
    sitemap(),
    socialPreviewImage(),
  ],
});
