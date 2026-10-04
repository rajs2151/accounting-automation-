#!/usr/bin/env bash
set -euo pipefail
export PGPASSWORD=daftar-local-only
for f in /work/db/*.sql; do
  psql -h postgres -U daftar -d daftar_test -v ON_ERROR_STOP=0 -f "$f" >/dev/null 2>&1 || true
done
cd /work
if [ ! -f node_modules/.bin/tsx ]; then
  npm ci --silent
fi
npx tsx --test \
  src/lib/company-match.test.ts \
  src/lib/fiscal-year.test.ts \
  src/lib/invoice-validation.test.ts \
  src/server/books/inbox-review.test.ts
