#!/usr/bin/env python3
"""Apply OAuth credentials from stdin while preserving the running API image."""
import copy
import datetime as dt
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import time
import urllib.request


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def api(method, path, body=None):
    connection = DockerConnection('localhost', timeout=45)
    data = json.dumps(body).encode() if body is not None else None
    try:
        connection.request(method, path, data, {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read()
        if response.status not in (200, 201, 204, 304):
            raise RuntimeError('Docker API operation failed, HTTP ' + str(response.status))
        return json.loads(raw) if raw else None
    finally:
        connection.close()


def private_file(path, data):
    with path.open('xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)


def replace_env(path, data):
    temporary = path.with_name('.env.oauth-' + secrets.token_hex(8))
    private_file(temporary, data)
    temporary.replace(path)


def apply():
    updates = json.load(sys.stdin)
    expected = {
        'GITHUB_CALLBACK_URL': 'https://lov.2.29.52.59.sslip.io/api/github/auth/callback',
        'LOV_APP_URL': 'https://lov.2.29.52.59.sslip.io/',
        'GITHUB_ALLOWED_ORIGINS': 'https://lov.2.29.52.59.sslip.io',
        'GITHUB_SESSION_DIR': '/data/sessions'
    }
    allowed = set(expected) | {'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_OAUTH_SCOPE'}
    if set(updates) - allowed or any(not isinstance(v, str) or any(c in v for c in '\n\r\0')
                                   for v in updates.values()):
        raise ValueError('invalid OAuth input')
    if any(updates.get(k) != v for k, v in expected.items()):
        raise ValueError('unexpected OAuth destination')
    if not re.fullmatch(r'Ov23[A-Za-z0-9]{16,}', updates.get('GITHUB_CLIENT_ID', '')):
        raise ValueError('invalid client ID')
    if not re.fullmatch(r'[0-9a-f]{40}', updates.get('GITHUB_CLIENT_SECRET', '')):
        raise ValueError('invalid client secret')
    updates.setdefault('GITHUB_OAUTH_SCOPE', 'public_repo')
    if updates['GITHUB_OAUTH_SCOPE'] not in ('public_repo', 'repo'):
        raise ValueError('unsupported OAuth scope')
    original = api('GET', '/containers/lov-devil-api/json')
    if not original['State']['Running'] or original['HostConfig'].get('AutoRemove'):
        raise RuntimeError('container is not eligible for safe replacement')
    if list(original['NetworkSettings']['Networks']) != ['lov-net']:
        raise RuntimeError('unexpected networks; inspect before replacing')
    mounts = original['Mounts']
    if len(mounts) != 1 or mounts[0].get('Name') != 'lov-devil-sessions' or mounts[0]['Destination'] != '/data/sessions':
        raise RuntimeError('unexpected mounts; inspect before replacing')
    session_path = Path(mounts[0]['Source'])
    if session_path.is_symlink():
        raise RuntimeError('session directory is a symlink')
    session_path.chmod(0o700)
    env_path = Path('/opt/lov-devil/.env')
    before = env_path.read_bytes()
    existing = {}
    for line in before.decode().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            existing[key.strip()] = value.strip().strip('\"\'')
    current_env = dict(item.split('=', 1) for item in original['Config']['Env'])
    if any(value != current_env.get(key) for key, value in existing.items()
           if key not in updates and key != 'GITHUB_SESSION_SECRET'):
        raise RuntimeError('unrelated env changes are pending; inspect first')
    session_secret = existing.get('GITHUB_SESSION_SECRET') or secrets.token_hex(32)
    if not re.fullmatch(r'[a-fA-F0-9]{64}', session_secret):
        raise ValueError('existing session secret is invalid')
    updates['GITHUB_SESSION_SECRET'] = session_secret
    lines = [line for line in before.decode().splitlines()
             if line.split('=', 1)[0].strip() not in updates]
    after = ('\n'.join(lines + [key + '=' + value for key, value in updates.items()]) + '\n').encode()
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/root/lov-devil-env-rollback') / stamp
    backup.mkdir(mode=0o700, parents=True)
    backup.parent.chmod(0o700)
    private_file(backup / 'app.env', before)
    private_file(backup / 'container.json', json.dumps(original).encode())
    config = copy.deepcopy(original['Config'])
    config['Image'] = original['Image']
    config['Env'] = [item for item in config['Env'] if item.split('=', 1)[0] not in updates]
    config['Env'] += [key + '=' + value for key, value in updates.items()]
    config['HostConfig'] = copy.deepcopy(original['HostConfig'])
    endpoint = original['NetworkSettings']['Networks']['lov-net']
    network = {key: endpoint[key] for key in ('IPAMConfig', 'Links', 'Aliases', 'DriverOpts', 'GwPriority')
               if endpoint.get(key) is not None}
    if network.get('Aliases'):
        network['Aliases'] = [a for a in network['Aliases']
                              if a not in (original['Id'], original['Id'][:12])]
    config['NetworkingConfig'] = {'EndpointsConfig': {'lov-net': network}}
    candidate_name = 'lov-devil-api-pending-' + stamp.lower()
    old_name = 'lov-devil-api-rollback-' + stamp.lower()
    candidate = api('POST', '/containers/create?name=' + candidate_name, config)['Id']
    stopped = False
    renamed = False
    candidate_renamed = False
    env_written = False
    try:
        if api('GET', '/containers/lov-devil-api/json')['Id'] != original['Id'] or env_path.read_bytes() != before:
            raise RuntimeError('concurrent deployment detected')
        replace_env(env_path, after)
        env_written = True
        api('POST', '/containers/' + original['Id'] + '/stop?t=20')
        stopped = True
        api('POST', '/containers/' + original['Id'] + '/rename?name=' + old_name)
        renamed = True
        api('POST', '/containers/' + candidate + '/rename?name=lov-devil-api')
        candidate_renamed = True
        api('POST', '/containers/' + candidate + '/start')
        deadline = time.monotonic() + 90
        healthy = False
        while time.monotonic() < deadline:
            state = api('GET', '/containers/' + candidate + '/json')
            if not state['State']['Running']:
                raise RuntimeError('new API process exited')
            try:
                with urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3) as response:
                    healthy = response.status == 200 and state['State'].get('Health', {}).get('Status') == 'healthy'
            except Exception:
                healthy = False
            if healthy:
                break
            time.sleep(1)
        if not healthy:
            raise RuntimeError('new API health check failed')
        if state['Image'] != original['Image']:
            raise RuntimeError('image changed unexpectedly')
        print(json.dumps({'ok': True, 'same_image': True, 'healthy': True,
                          'scope': updates['GITHUB_OAUTH_SCOPE'],
                          'rollback_container': old_name, 'rollback_directory': str(backup)}))
    except Exception:
        if env_written and env_path.read_bytes() == after:
            replace_env(env_path, before)
        if stopped:
            try:
                api('POST', '/containers/' + candidate + '/stop?t=10')
            except Exception:
                pass
            if renamed:
                if candidate_renamed:
                    api('POST', '/containers/' + candidate + '/rename?name=' + candidate_name)
                api('POST', '/containers/' + original['Id'] + '/rename?name=lov-devil-api')
            api('POST', '/containers/' + original['Id'] + '/start')
        try:
            api('DELETE', '/containers/' + candidate + '?force=true&v=false')
        except Exception:
            pass
        raise


if __name__ == '__main__':
    os.umask(0o077)
    try:
        with open('/run/lock/lov-devil-env.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            apply()
    except Exception as error:
        # Input, inspect data and Docker error bodies may contain secrets.
        print('OAuth environment update failed: ' + type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
