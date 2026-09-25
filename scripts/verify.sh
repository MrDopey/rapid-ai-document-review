#!/usr/bin/env bash
# Duplicates the checks in the publish workflow's verify job
# (.github/workflows/publish.yml), for an agent to run locally.
# Assumes dependencies are already installed (npm ci).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

run_e2e=0

usage() {
  echo "Usage: $(basename "${BASH_SOURCE[0]}") [-e] [-h]"
  echo "  -e  Also run e2e tests (npm run test:e2e) after the build"
  echo "  -h  Show this help"
}

while getopts "eh" opt; do
  case "$opt" in
    e) run_e2e=1 ;;
    h) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
done

echo "==> Lint"
npm run lint

echo "==> Format check"
npm run format

echo "==> Build shared package"
npm run build --workspace=app/shared

echo "==> Test"
npm run test

echo "==> Build"
npm run build

echo "==> Check frontend bundle size"
npm run check:bundle-size --workspace=app/frontend

if [ "$run_e2e" -eq 1 ]; then
  echo "==> E2E"
  npm run test:e2e
fi
