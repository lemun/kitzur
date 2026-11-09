# Cutting a release
This is a checklist for the maintainer preparing a release, written for v0.3.0. Nothing in the repository tags, publishes or releases by itself: every step below is run by a person. Publishing the npm package to the registry, if wanted, is a separate maintainer decision that this checklist does not make.

## Before the tag
- [ ] In [CHANGELOG.md](../CHANGELOG.md), `[Unreleased]` becomes a dated `[0.3.0]` section, and `node scripts/release-notes.mjs v0.3.0` prints it. The release workflow fails without that section.
- [ ] At the end of CHANGELOG.md, the compare links follow: `[Unreleased]` points to `compare/v0.3.0...HEAD`, and a new `[0.3.0]` line points to `compare/v0.2.1...v0.3.0`.
- [ ] If dependencies changed, re-read [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the [LICENSES](../LICENSES) folder against the packed files; only the maintainer edits them.
- [ ] The figures in the draft release notes still match [README.md](../README.md).
- [ ] The maintainer sets `version` to `0.3.0` in both `package.json` and `package-lock.json`. The tag must equal `v` plus the package.json version, or the workflow stops.
- [ ] `npm test` passes on Node 22, and the CI matrix is green on the release commit.
- [ ] `npm run bench:perf`, `npm run crosscheck`, `npm run check:pack` and `npm run sbom` pass.
- [ ] The [draft release notes](community/RELEASE-NOTES-0.3.0-DRAFT.md) are reviewed; when they are used, remove their DRAFT banner.

## The tag and the automatic draft
Maintainer step: push an annotated tag on the release commit.
```sh
git tag -a v0.3.0 -m v0.3.0 && git push origin v0.3.0
```
The release workflow runs on a `v*` tag, or by hand on an existing tag. It checks the tag against package.json, runs `scripts/release-notes.mjs`, `npm run check:pack`, `scripts/pack-offline.sh` and `scripts/pack-windows.py`, writes the SBOM and a `SHA256SUMS` over every asset, then creates a **draft** GitHub release with these assets:
- `kitzur-0.3.0.tgz` (npm package), `kitzur-0.3.0-offline.tar.gz` (offline bundle), `kitzur-0.3.0-windows.zip` (Windows bundle)
- `kitzur-0.3.0.cdx.json` (SBOM) and `SHA256SUMS`

## After the draft
- [ ] Download the assets and run `sha256sum -c SHA256SUMS`.
- [ ] Extract the offline bundle and the Windows zip, and run `node deploy/verify-bundle.mjs <extracted-dir>` on each (see [deployment](../deploy/README.md)).
- [ ] Install the downloaded npm package into an empty scratch folder and run it from there: `kitzur version` prints `kitzur 0.3.0`, `kitzur completions bash` prints the script, and `kitzur doctor` runs and reports its checks (it may flag a missing upstream on a scratch machine).

Maintainer step: install the downloaded tarball into a scratch folder.
```sh
mkdir scratch && cd scratch && npm init -y && npm install ../kitzur-0.3.0.tgz
npx kitzur version
npx kitzur completions bash
npx kitzur doctor
```
- [ ] Read the draft notes against the CHANGELOG section.
- [ ] A person publishes the draft on GitHub after this review.

## Rollback
Before publishing: delete the draft release, delete the tag (`git push origin :refs/tags/v0.3.0` and `git tag -d v0.3.0`), fix the problem on `main`, then tag again.

## After publishing
- [ ] CHANGELOG.md has an empty `## [Unreleased]` heading above `[0.3.0]` again, so the next change has a place.
- [ ] The maintainer moves the `version` in package.json on to the next development version.
