#!/usr/bin/env bash
# Runs inside python:3.12 for the AI loop pytest gate. Source is mounted read-only at /src.
# The virtualenv lives in a named volume at /venv and pip/docTR caches in /root/.cache, so torch/docTR are
# only reinstalled when worker/pyproject.toml changes (same idea as unit-inner.sh for node_modules).
set -euo pipefail

mkdir -p /work
cp -a /src/. /work/
cd /work
sed -i 's/127.0.0.1/postgres/g' worker/tests/conftest.py

DEPS_HASH="$(sha256sum worker/pyproject.toml | cut -d' ' -f1)"
if [ ! -x /venv/bin/python ] || [ ! -f /venv/.ai-deps-hash ] || [ "$(cat /venv/.ai-deps-hash)" != "$DEPS_HASH" ]; then
  echo "+ pip install (worker/pyproject.toml changed or no venv yet)"
  rm -rf /venv/* /venv/.ai-deps-hash 2>/dev/null || true
  python -m venv /venv
  /venv/bin/pip install -q -e "./worker[dev]" "moto[server]"
  echo "$DEPS_HASH" > /venv/.ai-deps-hash
else
  echo "+ reuse cached venv"
  # Source moved into a fresh /work each run; re-point the editable install without touching dependencies.
  /venv/bin/pip install -q --no-deps -e "./worker[dev]"
fi

/venv/bin/python - <<'PY'
from daftar.parsers import register_builtin_parsers
print("parsers", [p.name for p in register_builtin_parsers()])
PY
cd worker
/venv/bin/python -m pytest -v --tb=short
