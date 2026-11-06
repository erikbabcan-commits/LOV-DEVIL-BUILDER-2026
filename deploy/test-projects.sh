#!/usr/bin/env bash
# Dedicated non-production Docker daemon only. Never uses the application's .env.
set -euo pipefail
if [[ "${PROJECTS_TEST_DAEMON:-}" != 1 ]]; then
  echo 'Select a non-production Docker daemon and set PROJECTS_TEST_DAEMON=1.' >&2
  exit 1
fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."
projectTestImage='docker.io/library/postgres:17-alpine@sha256:5d9ee39acd134b44f52fc49ca3b88fc651f0560b0db93292fcd37ff150c71d3a'
projectTestDir=$(mktemp -d)
projectTestContainer=''
cleanup() {
  local code=$?
  if [[ -n "$projectTestContainer" ]] && ! docker rm --force "$projectTestContainer" >/dev/null; then
    echo 'Test PostgreSQL cleanup failed.' >&2
    code=1
  fi
  rm -f "$projectTestDir/postgres.env"
  rmdir "$projectTestDir"
  exit "$code"
}
trap cleanup EXIT
python3 - "$projectTestDir/postgres.env" <<'PY'
import os,secrets,sys
with open(sys.argv[1],'x') as f:
    os.chmod(sys.argv[1],0o600)
    f.write('POSTGRES_USER=lovtest\nPOSTGRES_DB=lovtest\nPOSTGRES_PASSWORD='+secrets.token_hex(32)+'\n')
PY
# Official Alpine image runs PostgreSQL as uid/gid 70; verify before mounting tmpfs.
test "$(docker run --rm --network=none --pull=never --entrypoint id "$projectTestImage" -u postgres)" = 70
projectTestContainer=$(docker run -d --pull=never --label lov-devil.test=projects \
  --user 70:70 --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
  --memory=384m --memory-swap=384m --cpus=0.5 --pids-limit=128 --log-driver=none \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=268435456,uid=70,gid=70,mode=700 \
  --tmpfs /var/run/postgresql:rw,nosuid,nodev,size=1048576,uid=70,gid=70,mode=775 \
  --tmpfs /tmp:rw,nosuid,nodev,size=16777216,uid=70,gid=70,mode=700 \
  -p 127.0.0.1::5432 --env-file "$projectTestDir/postgres.env" "$projectTestImage")
projectTestReady=0
for ((attempt=0;attempt<50;attempt++)); do
  if docker exec "$projectTestContainer" pg_isready -U lovtest -d lovtest >/dev/null 2>&1; then projectTestReady=1; break; fi
  sleep 0.5
done
if [[ "$projectTestReady" != 1 ]]; then echo 'Test PostgreSQL did not become ready.' >&2; exit 1; fi
python3 - "$projectTestDir/postgres.env" "$projectTestContainer" <<'PY'
import os,subprocess,sys
values=dict(line.strip().split('=',1) for line in open(sys.argv[1]))
port=subprocess.check_output(['docker','port',sys.argv[2],'5432/tcp'],text=True).strip().rsplit(':',1)[1]
env=dict(os.environ,NODE_ENV='test',MISTRAL_API_KEY='',PROJECTS_PG_E2E='1',
    PROJECTS_TEST_DATABASE_URL='postgresql://lovtest:'+values['POSTGRES_PASSWORD']+'@127.0.0.1:'+port+'/lovtest')
os.execvpe('npm',['npm','test','--','tests/integration/projectsPostgres.test.ts','tests/integration/projectSyncPostgres.test.ts','tests/integration/cloudBridgePostgres.test.ts','--maxWorkers=2'],env)
PY
