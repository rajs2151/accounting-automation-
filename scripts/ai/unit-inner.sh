#!/usr/bin/env bash
# Runs inside node:22 for the AI loop gates. Source is mounted read-only at /src;
# node_modules lives in a named volume at /work/node_modules (Linux binaries, never the Windows ones).
# Usage: unit-inner.sh test | typecheck
set -uo pipefail
MODE="${1:-test}"

apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq rsync postgresql-client >/dev/null 2>&1

rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .ai \
  --exclude playwright-report --exclude test-results --exclude 'docs/reference/outputs' \
  /src/ /work/
cd /work

# Reinstall dependencies only when package-lock.json changed.
LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -f node_modules/.ai-lock-hash ] || [ "$(cat node_modules/.ai-lock-hash)" != "$LOCK_HASH" ]; then
  echo "+ npm ci (lockfile changed)"
  npm ci --silent || { echo "npm ci failed"; exit 2; }
  echo "$LOCK_HASH" > node_modules/.ai-lock-hash
fi

if [ "$MODE" = "typecheck" ]; then
  echo "+ tsc --noEmit"
  npx tsc --noEmit -p .
  exit $?
fi

# Fresh test database every run, all numbered migrations applied in order.
export PGPASSWORD=daftar-local-only
psql -h postgres -U daftar -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS daftar_test WITH (FORCE);" \
  -c "CREATE DATABASE daftar_test OWNER daftar;" || { echo "could not reset daftar_test"; exit 2; }
for f in db/*.sql; do
  if ! psql -h postgres -U daftar -d daftar_test -v ON_ERROR_STOP=1 -q -f "$f" >/tmp/mig.log 2>&1; then
    echo "MIGRATION WARNING: $f"; tail -5 /tmp/mig.log
  fi
done

export DATABASE_URL="postgresql://daftar_app:daftar-local-only@postgres:5432/daftar_test"
export DATABASE_URL_SUPER="postgresql://daftar:daftar-local-only@postgres:5432/daftar_test"
export WORKER_DATABASE_URL="postgresql://daftar_worker:daftar-local-only@postgres:5432/daftar_test"
export S3_ENDPOINT="http://minio:9000" S3_ACCESS_KEY="daftar" S3_SECRET_KEY="daftar-local-only"
export S3_BUCKET="statements" S3_REGION="us-east-1"
export IBAN_ENCRYPTION_KEY="dev-only-iban-key-change-me" OCR_PROVIDER="local" PDF_PROBE_MIN_CHARS="30"
export PORTAL_SECURITY_STATUS="FAIL"

echo "+ npm test"
npm test
