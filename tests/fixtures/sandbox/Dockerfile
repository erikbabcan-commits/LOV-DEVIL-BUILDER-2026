# Test-only replacement for the worker executable; never used by compose.sandbox.yaml.
FROM lov-devil-sandbox:ws4
ARG SCENARIO=constraints
ENV SCENARIO=${SCENARIO}
COPY tests/fixtures/sandbox/harness.mjs /app/harness.mjs
ENTRYPOINT ["node", "/app/harness.mjs"]
