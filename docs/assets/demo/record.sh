#!/bin/sh
# Re-record the README demos. Needs vhs (https://github.com/charmbracelet/vhs), ffmpeg, and the
# development tokenizer (scripts/fetch-tokenizer.sh). Run from anywhere; outputs land in docs/assets/.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
tok="$repo/bench/.cache/Qwen3.6-27B-tokenizer.json"
[ -f "$tok" ] || { echo "run scripts/fetch-tokenizer.sh first" >&2; exit 1; }
(cd "$repo" && npm run build >/dev/null)

# A neutral working directory so the recordings show short relative paths.
demo=/tmp/kitzur-demo
rm -rf "$demo" && mkdir -p "$demo/work"
ln -s "$repo/dist" "$demo/dist"
ln -s "$here/mock-upstream.mjs" "$demo/work/mock-upstream.mjs"
ln -s "$here/drive.mjs" "$demo/work/drive.mjs"
ln -s "$tok" "$demo/work/tokenizer.json"

cat > "$demo/env.sh" <<'ENV'
export PS1='$ '
set +m
cd /tmp/kitzur-demo/work
kitzur() { node ../dist/src/cli.js "$@"; }
clear
ENV
cat > "$demo/env-running.sh" <<'ENV'
. /tmp/kitzur-demo/env.sh
kitzur config init --preset 32k --out kitzur.jsonc >/dev/null
sed -i.bak 's|"origin": null|"origin": "http://127.0.0.1:8000"|; s|"path": null|"path": "tokenizer.json"|' kitzur.jsonc
(node mock-upstream.mjs 8000 >/dev/null 2>&1 &)
(kitzur serve -c kitzur.jsonc >/dev/null 2>&1 &)
sleep 2
clear
ENV

cd "$here"
for tape in quickstart compaction; do
  vhs "$tape.tape"
done
pkill -f mock-upstream.mjs || true
pkill -f 'dist/src/cli.js serve' || true
