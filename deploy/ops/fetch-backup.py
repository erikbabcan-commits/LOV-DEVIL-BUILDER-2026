#!/usr/bin/env python3
"""Copy the latest verified LOV-DEVIL database backup to this Mac."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

BASE = Path.home() / '.local/share/lov-devil'
ROOT = BASE / 'backups'
SSH = ['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
       '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', 'hetzner-vps']
STAMP = re.compile(r'^\d{8}T\d{6}Z$')


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_status(value):
    temporary = BASE / '.backup-status.tmp'
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(BASE / 'backup-status.json')


def fetch():
    result = subprocess.run(
        SSH + ['/usr/bin/python3 /usr/local/libexec/lov-devil/backup-database.py --latest'],
        capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('backup manifest unavailable')
    manifest = json.loads(result.stdout)
    stamp = manifest['snapshot']
    if not STAMP.fullmatch(stamp) or manifest.get('restore_verified') is not True:
        raise ValueError('unverified snapshot')
    if set(manifest.get('files', {})) != {'database.dump'}:
        raise ValueError('unexpected manifest files')
    expected = manifest['files']['database.dump']
    if not re.fullmatch('[0-9a-f]{64}', expected['sha256']):
        raise ValueError('invalid checksum')
    if not isinstance(expected['bytes'], int) or not 0 < expected['bytes'] <= 2_000_000_000:
        raise ValueError('invalid backup size')
    age = (dt.datetime.now(dt.timezone.utc) -
           dt.datetime.strptime(stamp, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc))
    if age.total_seconds() < -300 or age.total_seconds() > 36 * 3600:
        raise RuntimeError('server backup is stale')
    destination = ROOT / stamp
    local_dump = destination / 'database.dump'
    if not (local_dump.is_file() and not local_dump.is_symlink()
            and local_dump.stat().st_size == expected['bytes']
            and checksum(local_dump) == expected['sha256']):
        staging = ROOT / ('.' + stamp + '.partial')
        if staging.exists():
            if staging.is_symlink():
                raise ValueError('unsafe staging path')
            shutil.rmtree(staging)
        staging.mkdir(mode=0o700)
        try:
            dump = staging / 'database.dump'
            with dump.open('xb') as stream:
                os.chmod(dump, 0o600)
                result = subprocess.run(
                    SSH + ['cat /root/lov-devil-backups/' + stamp + '/database.dump'],
                    stdout=stream, stderr=subprocess.PIPE, timeout=300)
            if result.returncode or dump.stat().st_size != expected['bytes']:
                raise RuntimeError('backup transfer incomplete')
            if checksum(dump) != expected['sha256']:
                raise RuntimeError('backup checksum mismatch')
            if destination.exists():
                raise RuntimeError('existing snapshot requires inspection')
            (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            staging.rename(destination)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    # Also attach a verified manifest to an already matching manual copy.
    if not (destination / 'manifest.json').exists():
        (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    snapshots = sorted(p for p in ROOT.iterdir()
                       if STAMP.fullmatch(p.name) and p.is_dir()
                       and not p.is_symlink() and (p / 'manifest.json').is_file())
    for old in snapshots[:-30]:
        shutil.rmtree(old)
    write_status({'ok': True, 'snapshot': stamp, 'sha256_verified': True,
                  'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                  'local_path': str(local_dump)})
    print(json.dumps({'ok': True, 'snapshot': stamp, 'sha256_verified': True}))


if __name__ == '__main__':
    os.umask(0o077)
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    BASE.chmod(0o700)
    ROOT.chmod(0o700)
    try:
        with (BASE / 'fetch-backup.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fetch()
    except Exception as error:
        write_status({'ok': False, 'error': type(error).__name__,
                      'checked_at': dt.datetime.now(dt.timezone.utc).isoformat()})
        print('LOV-DEVIL backup fetch failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
