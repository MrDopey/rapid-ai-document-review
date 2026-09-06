#!/usr/bin/env bash
# Duplicates the checks in the publish workflow's verify job
# (.github/workflows/publish.yml), for an agent to run locally.
# Assumes dependencies are already installed (npm ci).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

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
