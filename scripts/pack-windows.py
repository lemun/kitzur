#!/usr/bin/env python3
"""Build Windows ZIP from a fresh offline bundle; optional private deployment overlay.
Never pass a private profile/tokenizer to npm pack. No downloads or publish step.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', default='dist/offline')
parser.add_argument('--deployment-profile', type=Path)
parser.add_argument('--include-approved-tokenizer', type=Path)
args = parser.parse_args()
if args.include_approved_tokenizer and not args.deployment_profile:
    parser.error('Bundled tokenizer requires an explicit approved deployment profile.')
out = Path(args.out).resolve()
# Validate overlay before building. Profile is private input, never stored under deploy/.
profile = None
if args.deployment_profile:
    profile = json.loads(args.deployment_profile.read_text())
    required_fields = {'gatewayBaseURL', 'modelId', 'tokenizerSha256', 'provenance', 'config'}
    if not required_fields.issubset(profile) or set(profile) - required_fields - {'tokenizerTemplate'}:
        parser.error('Profile must contain the documented fields and optional tokenizerTemplate; no keys/credentials.')
    if profile.get('tokenizerTemplate', 'qwen3') not in {'qwen3', 'chatml', 'generic', 'sim'}:
        parser.error('Unsupported tokenizerTemplate.')
    from urllib.parse import urlsplit
    u = urlsplit(profile['gatewayBaseURL'])
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or not u.path.endswith('/v1') or u.hostname.endswith('.invalid'):
        parser.error('Complete a credential-free HTTPS gateway base ending /v1.')
    import re
    if not re.fullmatch('[a-f0-9]{64}', profile['tokenizerSha256']):
        parser.error('Supply the approved lowercase tokenizer SHA256.')
    required = {'model', 'revision', 'source', 'approval', 'license'}
    if set(profile['provenance']) != required or any(not isinstance(v, str) or not v or 'REPLACE' in v for v in profile['provenance'].values()):
        parser.error('Complete all tokenizer provenance fields.')
    if not isinstance(profile['modelId'], str) or not profile['modelId'] or 'REPLACE' in profile['modelId']:
        parser.error('Specify the target model and actual gateway model ID.')
    # Reject credentials/endpoints/paths in imported eval configuration. Admin keeps policy only.
    blocked = {'upstream', 'tokenizer', 'listen', 'stateDir', 'stats', 'store', 'ledger', 'errors'}
    if blocked.intersection(profile['config']):
        parser.error('Profile config must contain policy only; remove upstream/tokenizer/listen/stateDir/stats/store/ledger/errors. Errors may contain private free-text patterns; review separately locally.')
    if args.include_approved_tokenizer:
        digest = hashlib.file_digest(args.include_approved_tokenizer.open('rb'), 'sha256').hexdigest()
        if digest != profile['tokenizerSha256']:
            parser.error('Approved tokenizer checksum mismatch.')
subprocess.run(['bash', str(root / 'scripts/pack-offline.sh'), str(out)], cwd=root, check=True)
version = json.loads((root / 'package.json').read_text())['version']
name = f'kitzur-{version}'
archive_name = name + ('-windows-deployment.zip' if profile else '-windows.zip')
with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp)
    with tarfile.open(out / f'{name}-offline.tar.gz') as tar:
        # The freshly generated archive has no links; still reject unsafe extraction members.
        for m in tar.getmembers():
            p = Path(m.name)
            if p.is_absolute() or '..' in p.parts or not (m.isfile() or m.isdir()):
                raise ValueError('Unsafe bundle member')
        tar.extractall(temp, filter='data')
    stage = temp / name
    if profile:
        deployment = stage / 'deployment'
        deployment.mkdir()
        (deployment / 'profile.json').write_text(json.dumps(profile, indent=2) + '\n')
        if args.include_approved_tokenizer:
            import shutil
            shutil.copyfile(args.include_approved_tokenizer, deployment / 'tokenizer.json')
        (deployment / 'DISTRIBUTION.txt').write_text('PRIVATE CUSTOM RELEASE ONLY. Do not upload to npm, public releases, or public storage.\nTokenizer bundled: ' + str(bool(args.include_approved_tokenizer)) + '\n')
    manifest = stage / 'SHA256SUMS'
    files = sorted(p for p in stage.rglob('*') if p.is_file() and p != manifest)
    manifest.write_text(''.join(f'{hashlib.file_digest(p.open("rb"), "sha256").hexdigest()}  ./{p.relative_to(stage).as_posix()}\n' for p in files))
    # Fixed timestamps, stable ordering, POSIX permissions. No staging paths leak into ZIP metadata.
    epoch = int(os.environ.get('SOURCE_DATE_EPOCH', '315532800'))
    import time
    stamp = time.gmtime(max(315532800, epoch))[:6]
    with zipfile.ZipFile(out / archive_name, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(stage.rglob('*')):
            if not p.is_file():
                continue
            info = zipfile.ZipInfo(f'{name}/{p.relative_to(stage).as_posix()}', stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, p.read_bytes())
    manifest_hash = hashlib.file_digest(manifest.open('rb'), 'sha256').hexdigest()
    (out / (archive_name + '.manifest-sha256')).write_text(manifest_hash + '\n')
    archive_hash = hashlib.file_digest((out / archive_name).open('rb'), 'sha256').hexdigest()
    (out / (archive_name + '.sha256')).write_text(f'{archive_hash}  {archive_name}\n')
print(f'Built {out / archive_name}')
print('Manifest SHA256 (distribute through trusted approved deployment channel): ' + manifest_hash)
