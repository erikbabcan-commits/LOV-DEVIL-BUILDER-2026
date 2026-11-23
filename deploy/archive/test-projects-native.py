#!/usr/bin/env python3
"""Disposable real PostgreSQL tests without Docker. Supply trusted local binaries.

Creates a private cluster, uses SCRAM and loopback only, runs the existing opt-in
contracts, then stops the cluster and removes its files. Never reads app dotenv.
No binary download/install or production-database option is provided here.
"""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', required=True, type=Path)
    parser.add_argument('--workers', type=int, choices=(1, 2), default=1,
                        help='Local test workers; default 1 avoids oversubscribing development machines.')
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error('Run as an unprivileged local user.')
    binaries = args.bin_dir.resolve()
    for name in ('postgres', 'initdb', 'pg_ctl'):
        if not os.access(binaries / name, os.X_OK):
            parser.error('Required PostgreSQL binary is unavailable: ' + name)
    repo = Path(__file__).resolve().parent.parent
    subprocess.run([str(binaries / 'postgres'), '--version'], check=True)
    directory = Path(tempfile.mkdtemp(prefix='lov-pg-'))
    os.chmod(directory, 0o700)
    data = directory / 'data'
    password = secrets.token_hex(32)
    pwfile = directory / 'password'
    pwfile.touch(mode=0o600)
    pwfile.write_text(password + '\n')
    empty_env = directory / 'empty.env'
    empty_env.touch(mode=0o600)
    code = 1
    try:
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        subprocess.run([str(binaries / 'initdb'), '-D', str(data), '-U', 'lovtest',
                        '--pwfile=' + str(pwfile), '--auth-host=scram-sha-256',
                        '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C'],
                       check=True, stdout=subprocess.DEVNULL)
        subprocess.run([str(binaries / 'pg_ctl'), '-D', str(data), '-l', str(directory / 'server.log'),
                        '-o', f'-h 127.0.0.1 -p {port} -k {directory} -c shared_buffers=32MB -c max_connections=20',
                        '-w', '-t', '15', 'start'], check=True)
        environment = dict(os.environ, NODE_ENV='test', MISTRAL_API_KEY='',
                           OPENAI_API_KEY='', ANTHROPIC_API_KEY='', AUTH_ENABLED='0',
                           DATABASE_URL='', CLOUD_AUTH_ISSUER='', GITHUB_SESSION_DIR='',
                           GITHUB_SESSION_SECRET='', DOTENV_CONFIG_PATH=str(empty_env),
                           PROJECTS_PG_E2E='1', PROJECTS_TEST_DATABASE_URL=
                           f'postgresql://lovtest:{password}@127.0.0.1:{port}/postgres')
        result = subprocess.run([str(repo / 'node_modules/.bin/vitest'), 'run',
                                 'tests/integration/projectsPostgres.test.ts',
                                 'tests/integration/projectSyncPostgres.test.ts',
                                 'tests/integration/cloudBridgePostgres.test.ts',
                                 'tests/integration/billingPostgres.test.ts',
                                 'tests/integration/publishPostgres.test.ts', '--maxWorkers=' + str(args.workers),
                                 # Native schema/crypto/JIT cold starts can exceed unit-test budgets
                                 # on a shared development machine; SQL/API limits remain unchanged.
                                 '--hookTimeout=60000', '--testTimeout=15000'],
                                cwd=repo, env=environment, timeout=300)
        code = result.returncode
    finally:
        running = subprocess.run([str(binaries / 'pg_ctl'), '-D', str(data), 'status'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if running:
            stopped = subprocess.run([str(binaries / 'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', '-t', '15', 'stop']).returncode == 0
            if not stopped:
                raise RuntimeError('Test PostgreSQL cleanup failed; private cluster retained: ' + str(directory))
        shutil.rmtree(directory)
        print('native_pg_cleanup=stopped_and_removed', flush=True)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
