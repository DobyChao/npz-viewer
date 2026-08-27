#!/usr/bin/env bash
# Idempotent bootstrap for the npz-viewer Cloud Agent environment.
# Prepares the Python backend virtualenv, sample data, and frontend deps.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Python virtualenv + backend dependencies.
# The base image ships Python 3.12 but not the venv/ensurepip package, so
# self-heal by installing it only when creating the venv fails.
if [ ! -x .venv/bin/python ]; then
  if ! python3 -m venv .venv 2>/dev/null; then
    rm -rf .venv
    sudo apt-get update -qq
    sudo apt-get install -y python3-venv
    python3 -m venv .venv
  fi
fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r requirements-dev.txt

# 2. Sample npz tree + roots.json (both gitignored) so the app has data to show.
if [ ! -d sample_data ] || [ ! -f roots.json ]; then
  .venv/bin/python scripts/make_sample_npz.py
fi

# 3. Frontend dependencies + Playwright browser for the e2e suite.
cd frontend
npm ci
npx playwright install chromium

echo "npz-viewer environment ready."
