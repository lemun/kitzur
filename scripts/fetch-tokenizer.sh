#!/bin/sh
# Development input; never include this tokenizer in a release archive.
# Use the served model's own tokenizer for deployment.
set -eu
dir="$(dirname "$0")/../bench/.cache"
mkdir -p "$dir"
file="$dir/Qwen3.6-27B-tokenizer.json"
verify() {
  node --input-type=module - "$1" <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = createHash('sha256').update(readFileSync(process.argv[2])).digest('hex');
process.exit(hash === '5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42' ? 0 : 1);
JS
}
if [ -f "$file" ] && verify "$file"; then
  echo "verified cached $file"
  exit 0
fi
tmp=$(mktemp "$dir/tokenizer-download.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
curl -fL --retry 3 -o "$tmp" \
  https://huggingface.co/Qwen/Qwen3.6-27B/resolve/6a9e13bd6fc8f0983b9b99948120bc37f49c13e9/tokenizer.json
verify "$tmp" || { echo 'development tokenizer checksum mismatch' >&2; exit 1; }
mv "$tmp" "$file"
echo "saved $file"
