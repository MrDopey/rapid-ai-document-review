# Docker Deployment

This directory holds the production `Dockerfile` and the `docker-compose.yml` used to run the
containerized deployment. See the repo-root [`README.md`](../README.md) for the application
overview, architecture, and local (non-Docker) development workflow — this file only covers the
Docker path.

## Prerequisites

- Docker (with the Compose plugin — `docker compose`, not the standalone `docker-compose` v1).

## Setup

1. Copy the env template and fill in the required model:

   ```bash
   cp docker/.env.example docker/.env
   ```

   Edit `docker/.env` and set `RADR_BE_PI_AGENT_MODEL` (required — the backend fails fast at
   startup without it). See `docker/.env.example` for what every variable does and its default.

   `docker/.env` is gitignored; never commit it. Docker Compose automatically loads a `.env` file
   from the same directory as the compose file it's given via `-f` (`docker/.env` here) to
   interpolate the `${VAR}` references in `docker-compose.yml` — no `env_file:` directive is
   needed for this.

2. Build and run, from the repo root:

   ```bash
   docker compose -f docker/docker-compose.yml up --build
   ```

   This builds the frontend and backend in a multi-stage build (see `docker/Dockerfile`: one stage
   compiles all three workspaces, a second installs only `app/shared` and `app/backend`'s
   production dependencies) and starts the backend on `http://127.0.0.1:3000` (or whatever
   `RADR_BE_PORT` is set to — the published port mapping tracks it automatically). The published
   port is bound to `127.0.0.1` only.

## Data persistence

Application data (the SQLite database, Pi session files, and Pi's agent config directory) is
bind-mounted from the container's `/data` to `<repo-root>/app/backend/data` on the host
(`../app/backend/data:/data`, relative to this compose file's own directory) — the same directory
`npm run dev`'s defaults (`RADR_BE_DATABASE_PATH=./data/...` etc., resolved from `app/backend/`'s
cwd) already use locally. Docker creates that directory automatically if it doesn't exist yet — you
don't need to create it yourself. It's already covered by the repo's `.gitignore`
(`app/backend/data/`).

Because it's a bind mount rather than a named volume, you can inspect, back up, or delete the
database and session files directly:

```bash
ls app/backend/data/
rm app/backend/data/document-review.sqlite*   # reset, see repo-root README's "Resetting the application"
```

**Ownership note**: `docker/Dockerfile`'s runtime stage has no `USER` directive, so the container
runs as `root` (the `node:26.1.0-trixie` base image's default). This means the bind mount works
without any permission setup, but files it creates under `data/` are owned by `root` on the host.
On most single-user local/dev setups this is a minor inconvenience rather than a blocker (`sudo rm`
if needed), but it's worth knowing before you try to edit those files as your own user.

## Known gaps

- **The frontend is not actually served.** `docker/Dockerfile` copies the built frontend into
  `app/backend/dist/public` inside the image, but `app/backend/src/server.ts` has no static-file
  serving code (no `@fastify/static`, no catch-all route) and `app/backend/package.json` doesn't
  even depend on a static-file plugin. In its current state, `docker compose up` starts a working
  backend API but **does not serve the UI** — hitting `http://127.0.0.1:3000` gets you `/healthz`
  and the JSON API/WebSocket routes only, not the Vue app. This is a backend application gap, not
  a Docker configuration issue; fixing it means adding static-file serving (and an SPA fallback
  route) to the backend.
- **Model provider credentials aren't wired through.** `docker-compose.yml`'s `environment:` block
  only sets the `RADR_BE_*` variables read directly by `app/backend/src/config.ts`; it does not
  pass through a provider credential like `ANTHROPIC_API_KEY`. Live agent conversations need one
  (see the repo-root README's Configuration section) — add it to both `docker/.env` and the
  `environment:` block yourself if you need live model calls from the containerized deployment.
