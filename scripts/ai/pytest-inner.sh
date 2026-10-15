#!/usr/bin/env bash
# Runs inside python:3.12 for the AI loop pytest gate. Source is mounted read-only at /src.
# The virtualenv lives in a named volume at /venv and pip/docTR caches in /root/.cache, so torch/docTR are
# only reinstalled when worker/pyproject.toml changes (same idea as unit-inner.sh for node_modules).
set -euo pipefail

# System deps the worker tests need (psql for conftest migrations; same OCR/GL libs as worker/Dockerfile).
APT="apt-get -o Acquire::Retries=5 -qq"
$APT update >/tmp/apt.log 2>&1 || { cat /tmp/apt.log; echo "apt-get update failed"; exit 100; }
$APT install -y --no-install-recommends postgresql-client libgl1 libglib2.0-0 libgomp1 \
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara >/tmp/apt.log 2>&1 || { tail -20 /tmp/apt.log; echo "apt-get install failed"; exit 100; }

mkdir -p /work
tar -C /src --exclude=./node_modules --exclude=./.next --exclude=./.git --exclude=./.ai \
  --exclude=./test-results --exclude=./playwright-report -cf - . | tar -C /work -xf -
cd /work
sed -i 's/127.0.0.1/postgres/g' worker/tests/conftest.py

DEPS_HASH="$(sha256sum worker/pyproject.toml | cut -d' ' -f1)"
if [ ! -x /venv/bin/python ] || [ ! -f /venv/.ai-deps-hash ] || [ "$(cat /venv/.ai-deps-hash)" != "$DEPS_HASH" ]; then
  echo "+ pip install (worker/pyproject.toml changed or no venv yet)"
  rm -rf /venv/* /venv/.ai-deps-hash 2>/dev/null || true
  python -m venv /venv
  PIP="/venv/bin/pip install -q --timeout 120 --retries 8"
  # Same as worker/Dockerfile: CPU-only torch/torchvision first (PyPI's default Linux torch pulls GBs of CUDA libs).
  $PIP torch torchvision --index-url https://download.pytorch.org/whl/cpu
  $PIP -e "./worker[dev]" "moto[server]"
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
