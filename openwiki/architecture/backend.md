---
type: Reference
title: Architecture and Backend Services
description: Details on the Fastify backend, SQLite persistence, Automerge CRDT document storage, and Pi Coding Agent SDK integration.
tags: [architecture, backend, fastify, sqlite, automerge, pi-sdk]
---

# Architecture & Backend Services

The backend is built with Fastify, communicating with the Vue frontend over HTTP and WebSocket.

## Core Data Stores & State

1. **Automerge CRDT (`app/backend/src/crdt/` or equivalent)**:
   - Owns the document state, incremental edits, and collaborative text structures.
2. **SQLite Persistence (`node:sqlite`)**:
   - Stores revisions, session history metadata, and auxiliary data.
3. **Pi Coding Agent SDK**:
   - Drives agent conversations, tool calls (such as `web_search` via SearXNG), and model interactions.
   - The application enforces strict boundaries: the backend is authoritative for document edits, review hunks, and acceptance workflows, while Pi manages conversation turns and prompts.

## Configuration & Environment

The backend reads configuration prefixed with `RADR_BE_`:
- `RADR_BE_PORT` (default `3000`)
- `RADR_BE_HOST` (`127.0.0.1` loopback-only)
- `RADR_BE_DATABASE_PATH` (`./data/document-review.sqlite`)
- `RADR_BE_PI_SESSION_STORAGE_PATH` (`./data/pi-sessions`)
- `RADR_BE_PI_CODING_AGENT_DIR` (`./data/pi-agent`)
- `RADR_BE_PI_AGENT_MODEL` (Required model specifier like `anthropic/claude-opus-4-5`)
- `RADR_BE_PI_FAKE_SESSIONS` (`1` to use credential-free fake sessions for testing)
- `RADR_BE_SEARXNG_URL` (`http://searxng:8080`)
