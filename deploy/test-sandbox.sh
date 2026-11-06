#!/usr/bin/env bash
# Run only against an explicitly selected non-production Linux Docker daemon.
set -euo pipefail
if [[ "${SANDBOX_TEST_DAEMON:-}" != 1 ]]; then
  echo 'Select a test-only Docker context/DOCKER_HOST, then set SANDBOX_TEST_DAEMON=1.' >&2
  exit 1
fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -n "$(docker ps -aq --filter label=lov-devil.sandbox=ws4)" ]]; then
  echo 'Reconcile existing WS-4 workers before starting; this script never deletes other containers.' >&2
  exit 1
fi
export MISTRAL_API_KEY=
export NODE_ENV=test
docker build -f deploy/Dockerfile.sandbox -t lov-devil-sandbox:ws4 .
docker build -f deploy/Dockerfile.sandbox-runner -t lov-devil-sandbox-runner:ws4 .
for scenario in constraints hang oom output invalid; do
  docker build -f tests/fixtures/sandbox/Dockerfile --build-arg "SCENARIO=$scenario" \
    -t "lov-devil-sandbox-test:$scenario" .
done
SANDBOX_DOCKER_E2E=1 npm test -- tests/integration/sandboxDocker.test.ts
