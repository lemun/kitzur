#!/usr/bin/env bash
# Builds the offline bundle (DESIGN.md "Deploy and packaging"):
#   <out>/kitzur-<version>.tgz                 npm pack of a clean build (install with npm, offline)
#   <out>/kitzur-<version>-offline.tar.gz      the vendored tarball: dist/src, presets, deploy, docs, LICENSE,
#                                               package.json and a SHA256SUMS manifest of every file
#   <out>/SHA256SUMS                            checksums of the two archives
# kitzur has no runtime dependencies, so nothing else needs vendoring. The build is compiled fresh into a
# temporary directory, so stale files in dist/ never ship. Archives are reproducible for a given
# SOURCE_DATE_EPOCH (default: the last commit's time, else 0).
#
# usage: scripts/pack-offline.sh [out-dir]          (default: dist/offline, git-ignored)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
out=$(mkdir -p "${1:-dist/offline}" && cd "${1:-dist/offline}" && pwd)
version=$(node -p "require('./package.json').version")
name="kitzur-${version}"
epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "building ${name} (clean tsc build)..." >&2
# Source maps from a temporary build can embed the build machine's source path.
npx --no-install tsc -p tsconfig.json --sourceMap false --outDir "$tmp/build"
test -f "$tmp/build/src/cli.js" || { echo "pack-offline: the build produced no src/cli.js" >&2; exit 1; }

stage="$tmp/$name"
mkdir -p "$stage/dist"
cp -R "$tmp/build/src" "$stage/dist/src"
chmod +x "$stage/dist/src/cli.js"
cp -R presets deploy LICENSES "$stage/"
cp package.json "$stage/"
missing=()
for f in README.md CONFIG.md DESIGN.md SECURITY.md THIRD_PARTY_NOTICES.md LICENSE; do
  if [ -f "$f" ]; then cp "$f" "$stage/"; else missing+=("$f"); fi
done
if [ -d docs ] && [ -n "$(ls -A docs)" ]; then cp -R docs "$stage/docs"; fi
if [ ${#missing[@]} -gt 0 ]; then echo "pack-offline: warning: not in the repository yet: ${missing[*]}" >&2; fi

# smoke test of the staged bundle: it runs and finds its presets without the repository
node "$stage/dist/src/cli.js" version >/dev/null
node "$stage/dist/src/cli.js" config validate --preset 32k --upstream http://127.0.0.1:1 >/dev/null

(cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS)

# npm package from the same clean build (npm pack honours package.json "files")
(cd "$stage" && npm pack --silent --pack-destination "$out" >/dev/null)

# vendored tarball, reproducible
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@${epoch}" -C "$tmp" -cf - "$name" | gzip -n -9 > "$out/${name}-offline.tar.gz"

(cd "$out" && sha256sum "${name}.tgz" "${name}-offline.tar.gz" > SHA256SUMS)

cat <<EOF
Built in ${out}:
  ${name}-offline.tar.gz   $(du -h "$out/${name}-offline.tar.gz" | cut -f1)   vendored bundle (no dependencies)
  ${name}.tgz              $(du -h "$out/${name}.tgz" | cut -f1)   npm package
  SHA256SUMS

On the offline host (Node.js >= 20; nothing is downloaded):
  sha256sum -c --ignore-missing SHA256SUMS
  mkdir -p ~/.local/lib && tar -xzf ${name}-offline.tar.gz -C ~/.local/lib
  mv ~/.local/lib/${name} ~/.local/lib/kitzur && (cd ~/.local/lib/kitzur && sha256sum -c SHA256SUMS)
  mkdir -p ~/.local/bin && ln -sf ~/.local/lib/kitzur/dist/src/cli.js ~/.local/bin/kitzur
  kitzur config init --preset 100k --out ~/.config/kitzur/kitzur.jsonc   # then set upstream.origin, tokenizer.path
  kitzur config validate -c ~/.config/kitzur/kitzur.jsonc
  # as a user service: ~/.local/lib/kitzur/deploy/README.md
or with npm (offline):  npm install --prefix ~/.local ./${name}.tgz
EOF
