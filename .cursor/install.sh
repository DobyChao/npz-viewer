#!/usr/bin/env bash
# Idempotent bootstrap for the npz-viewer Cloud Agent environment.
# Prepares the Python backend virtualenv, sample data, and frontend deps.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The backend's video export streams frames to ffmpeg and then closes stdin
# before calling subprocess.communicate(). That pattern only works on CPython
# with the fix from PR #142061, which shipped in Python 3.13/3.14 but NOT in the
# base image's 3.12. The project is developed on 3.14, so pin the venv to it.
PYVER=3.14
PYTHON="python${PYVER}"

install_python_from_deadsnakes() {
  sudo apt-get update -qq
  sudo apt-get install -y software-properties-common
  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt-get update -qq
  sudo apt-get install -y "python${PYVER}" "python${PYVER}-venv"
}

# 1. Python virtualenv + backend dependencies.
# Recreate the venv when it is missing or older than 3.13; self-heal by
# installing Python from deadsnakes when creating the venv fails.
need_venv=0
if [ ! -x .venv/bin/python ]; then
  need_venv=1
elif ! .venv/bin/python -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 13) else 1)'; then
  need_venv=1
fi

if [ "$need_venv" -eq 1 ]; then
  rm -rf .venv
  if ! { command -v "$PYTHON" >/dev/null 2>&1 && "$PYTHON" -m venv .venv 2>/dev/null; }; then
    rm -rf .venv
    install_python_from_deadsnakes
    "$PYTHON" -m venv .venv
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
