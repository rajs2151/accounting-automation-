#!/usr/bin/env bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq postgresql-client rsync >/dev/null
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .git \
  /src/ /work/
export PGPASSWORD=daftar-local-only
for f in /work/db/*.sql; do
  psql -h postgres -U daftar -d daftar_test -v ON_ERROR_STOP=0 -f "$f" >/dev/null 2>&1 || true
done
if [ ! -f /work/node_modules/.bin/tsx ]; then
  npm ci --silent
fi
npx tsx --test \
  src/lib/invoice-validation.test.ts \
  src/lib/review-bbox.test.ts \
  src/server/books/phase1.test.ts \
  src/server/books/company-a-golden.test.ts
