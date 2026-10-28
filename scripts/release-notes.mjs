#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, for the release notes: node scripts/release-notes.mjs <version> [changelog]
// The version may carry a leading "v". A section starts at "## [x.y.z]" (or "## x.y.z") and runs up to the next "## "
// heading; the heading itself is left out. Exits 1 when the section is missing or empty.
import { readFileSync } from 'node:fs';

const [arg, file = 'CHANGELOG.md'] = process.argv.slice(2);
if (!arg) {
  console.error('release-notes: usage: release-notes.mjs <version> [changelog]');
  process.exit(2);
}
const version = arg.replace(/^v/, '');
const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const heading = (line) => line.match(/^##\s+\[?([^\]\s]+)\]?/)?.[1];
const start = lines.findIndex((line) => heading(line) === version);
if (start < 0) {
  console.error(`release-notes: no section for ${version} in ${file}`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
if (end < 0) end = lines.length;
const notes = lines.slice(start + 1, end).join('\n').trim();
if (!notes) {
  console.error(`release-notes: the section for ${version} in ${file} is empty`);
  process.exit(1);
}
console.log(notes);
