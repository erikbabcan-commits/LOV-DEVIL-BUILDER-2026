#!/usr/bin/env python3
"""Back up only LOV-DEVIL PostgreSQL; verify restoration before publishing."""
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
from urllib.parse import unquote, urlparse

ROOT = Path('/root/lov-devil-backups')
CONTAINER = 'lov-postgres'
STAMP = re.compile(r'^\d{8}T\d{6}Z$')


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def private_write(path, data):
    with path.open('xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def docker(args, **kwargs):
    result = subprocess.run(
        ['docker', 'exec', CONTAINER] + args,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, **kwargs)
    if result.returncode:
        raise RuntimeError('database command failed: ' + args[0])
    return result.stdout


def backup():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    ROOT.chmod(0o700)
    env = {}
    for line in Path('/opt/lov-devil/.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip().strip('\"\'')
    url = urlparse(env['DATABASE_URL'])
    if url.hostname != CONTAINER:
        raise RuntimeError('unexpected database host')
    user = unquote(url.username or 'postgres')
    database = unquote(url.path.lstrip('/'))
    if not database or database.startswith('-') or user.startswith('-'):
        raise RuntimeError('invalid database configuration')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    destination = ROOT / stamp
    staging = ROOT / ('.' + stamp + '.partial')
    staging.mkdir(mode=0o700)
    dump = staging / 'database.dump'
    verify_db = 'lov_restorecheck_' + stamp.lower()
    created = False
    try:
        with dump.open('xb') as stream:
            os.chmod(dump, 0o600)
            result = subprocess.run(
                ['docker', 'exec', CONTAINER, 'pg_dump', '--username=' + user,
                 '--dbname=' + database, '--format=custom'], stdout=stream,
                stderr=subprocess.PIPE, timeout=180)
        if result.returncode or not dump.stat().st_size:
            raise RuntimeError('pg_dump failed')
        with dump.open('rb') as stream:
            result = subprocess.run(
                ['docker', 'exec', '-i', CONTAINER, 'pg_restore', '--list'],
                stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=60)
        if result.returncode:
            raise RuntimeError('archive validation failed')
        docker(['createdb', '--username=' + user, verify_db])
        created = True
        with dump.open('rb') as stream:
            result = subprocess.run(
                ['docker', 'exec', '-i', CONTAINER, 'pg_restore',
                 '--username=' + user, '--no-owner', '--exit-on-error',
                 '--dbname=' + verify_db], stdin=stream,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        if result.returncode:
            raise RuntimeError('isolated restore failed')
        tables = int(docker([
            'psql', '--username=' + user, '--dbname=' + verify_db, '-Atc',
            "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
        ]).strip())
        if tables < 3:
            raise RuntimeError('restored schema is incomplete')
        docker(['dropdb', '--username=' + user, verify_db])
        created = False
        manifest = {
            'format': 1, 'snapshot': stamp, 'restore_verified': True,
            'restored_tables': tables,
            'files': {'database.dump': {
                'bytes': dump.stat().st_size,
                'sha256': checksum(dump)}}
        }
        private_write(staging / 'manifest.json',
                      (json.dumps(manifest, indent=2) + '\n').encode())
        staging.rename(destination)
        latest_tmp = ROOT / '.latest.tmp'
        latest_tmp.unlink(missing_ok=True)
        private_write(latest_tmp, (json.dumps(manifest) + '\n').encode())
        latest_tmp.replace(ROOT / 'latest.json')
        snapshots = sorted(p for p in ROOT.iterdir()
                           if STAMP.fullmatch(p.name) and p.is_dir()
                           and not p.is_symlink()
                           and (p / 'manifest.json').is_file())
        for old in snapshots[:-14]:
            shutil.rmtree(old)
        print(json.dumps({'ok': True, 'snapshot': stamp, 'restore_verified': True,
                          'tables': tables, 'bytes': manifest['files']['database.dump']['bytes']}))
    finally:
        if created:
            docker(['dropdb', '--username=' + user, '--if-exists', verify_db])
        if staging.exists():
            shutil.rmtree(staging)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if sys.argv[1:] == ['--latest']:
            print((ROOT / 'latest.json').read_text().strip())
        elif sys.argv[1:]:
            raise ValueError('unsupported argument')
        else:
            with open('/run/lock/lov-devil-backup.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                backup()
    except Exception as error:
        # Never print command stderr, DATABASE_URL or environment values.
        print('LOV-DEVIL backup failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
