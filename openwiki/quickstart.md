---
type: Playbook
title: Quickstart and Development Guide
description: Step-by-step instructions for installing dependencies, configuring environment variables, running development servers, and executing test suites.
tags: [quickstart, development, testing, installation, playbook]
---

# Quickstart & Development Guide

## Prerequisites

- **Node.js**: `>= 26.1.0` (pinned in `.nvmrc` and `package.json`).
- **npm**: Bundled with Node 26.1.0.
- **Docker**: Optional, for containerised deployment.
- **Playwright Chromium**: Required for end-to-end testing (`npx playwright install chromium`).

## Installation

```bash
npm install
```

## Running in Development

1. Configure environment variables (or rely on defaults with fake sessions for local trial):
   - Set `RADR_BE_PI_FAKE_SESSIONS=1` to run agent interactions against deterministic fake sessions without an API key.
   - Set `RADR_BE_PI_AGENT_MODEL=anthropic/claude-opus-4-5` (required if live sessions are used).
2. Start the backend:
   ```bash
   npm run dev
   ```
3. Start the frontend:
   ```bash
   npm run dev:frontend
   ```

## Running Tests

- Unit, integration, and contract tests:
  ```bash
  npm test
  ```
- End-to-end tests (requires Playwright):
  ```bash
  npm run test:e2e
  ```
- Linting and formatting checks:
  ```bash
  npm run lint
  npm run format
  ```
