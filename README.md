# TierForge — Resilient Bulk Store Scoring & Tiering

Node.js (Express) · React (Vite) · PostgreSQL. Built from `../TierForge_Spec.md`.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **20 or newer** (22 LTS tested) | Needed for built-in `fetch` and `AbortController`. `nvm use` reads `.nvmrc`. |
| npm | 10+ (ships with Node 20+) | |
| Docker | any recent | Runs PostgreSQL 16. Docker Desktop must be running. |
| Python | 3.9+ | Only for the provided enrichment simulator. |

Check: `node -v && npm -v && docker --version && python3 --version`

## Ports

| Component | Port | Env / flag |
|---|---|---|
| Frontend (Vite) | 5173 | |
| Backend API | 8000 | `PORT` in `backend/.env` |
| Enrichment simulator | 8001 | `--port 8001`, **no `--workers` flag** |
| PostgreSQL (Docker) | 5433 → 5432 | `DATABASE_URL` |

If something else already uses 8000, run the API on another port (e.g. `PORT=8010 npm run dev`) and start the frontend with `VITE_API_URL=http://localhost:8010 npm run dev`.

## Run it (one terminal per step, in this order)

**1. PostgreSQL** (first time creates the container; afterwards `docker start tierforge-postgres`)
```bash
docker run --name tierforge-postgres -e POSTGRES_USER=tierforge \
  -e POSTGRES_PASSWORD=tierforge -e POSTGRES_DB=tierforge \
  -p 5433:5432 -d postgres:16
```

**2. Enrichment simulator** (provided separately; do not modify it)
```bash
cd <path-to>/enrichment_simulator
pip install -r requirements.txt      # first time only
uvicorn main:app --port 8001         # or: python3 -m uvicorn main:app --port 8001
```

**3. Backend API** — applies `sql/schema.sql` automatically on boot
```bash
cd backend
cp .env.example .env                 # first time only; defaults match the steps above
npm install                          # first time only
npm run dev                          # http://localhost:8000  (docs: /docs)
```

**4. Worker** — a separate process; run exactly **one** (its rate limiter is per process)
```bash
cd backend
npm run worker
```

**5. Frontend**
```bash
cd frontend
cp .env.example .env                 # first time only; set VITE_API_URL if the API is not on 8000
npm install                          # first time only
npm run dev                          # http://localhost:5173
```

Open http://localhost:5173 and upload `sample-data/stores_5000.csv`. A full 5,000-store run takes roughly 20–25 minutes.

API docs: http://localhost:8000/docs (raw spec: `/openapi.json`)

## Docker (PostgreSQL)

Docker is used for the database only; the API, worker, frontend and simulator run directly with Node/Python.

| Task | Command |
|---|---|
| Create and start (first time) | `docker run --name tierforge-postgres -e POSTGRES_USER=tierforge -e POSTGRES_PASSWORD=tierforge -e POSTGRES_DB=tierforge -p 5433:5432 -d postgres:16` |
| Start / stop (data is kept) | `docker start tierforge-postgres` / `docker stop tierforge-postgres` |
| Is it running? | `docker ps --filter name=tierforge-postgres` |
| Logs | `docker logs -f tierforge-postgres` |
| Open a SQL shell | `docker exec -it tierforge-postgres psql -U tierforge -d tierforge` |
| Run one query | `docker exec tierforge-postgres psql -U tierforge -d tierforge -c "SELECT status, COUNT(*) FROM enrichments GROUP BY status;"` |
| Empty all job data (keeps tables) | `docker exec tierforge-postgres psql -U tierforge -d tierforge -c "TRUNCATE jobs RESTART IDENTITY CASCADE;"` |
| Delete the container and all data | `docker rm -f tierforge-postgres` |

Connection details: host `localhost`, port `5433`, database/user/password all `tierforge`
(`postgresql://tierforge:tierforge@localhost:5433/tierforge`). A GUI client (TablePlus, DBeaver, pgAdmin) can use the same values.
Tests use a separate database, `tierforge_test`, which is created automatically.

Inside the container shell (Docker Desktop → Exec tab) skip the `docker exec` part and run `psql -U tierforge -d tierforge`.

If `docker` reports it cannot connect to the daemon, start Docker Desktop first.

## Stopping

Press **Ctrl+C** in each terminal. Stopping the worker is safe: it finishes in-flight calls, the job stays `RUNNING`, and it continues when the worker is started again. Stop the database with `docker stop tierforge-postgres` (data is kept).

## Configuration

Backend settings live in `backend/.env` (see `backend/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql://tierforge:tierforge@localhost:5433/tierforge` | Postgres connection |
| `ENRICHMENT_API_URL` | `http://localhost:8001` | Where the worker calls `/enrich` |
| `PORT` / `CORS_ORIGIN` | `8000` / `http://localhost:5173` | API port and allowed frontend origin |
| `RATE_LIMIT_PER_SEC` | `4` | Worker request rate (simulator limit is 5) |
| `MAX_IN_FLIGHT` | `20` | Concurrent enrichment calls |
| `REQUEST_TIMEOUT_MS` | `5000` | Abort a call after this long |
| `LEASE_SECONDS` | `15` | Time before an unanswered claim is reclaimed |
| `MAX_ATTEMPTS` | `6` | Attempts per store before it is `FAILED` |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` | `1000` / `30000` | Retry backoff |
| `BREAKER_WINDOW` / `BREAKER_FAILURE_RATIO` | `30` / `0.9` | Circuit breaker |
| `PAUSE_PROBE_MS` / `PAUSE_MAX_MS` | `5000` / `1800000` | Auto-resume probing and give-up limit |

Frontend: `VITE_API_URL` in `frontend/.env` (default `http://localhost:8000`).

## Troubleshooting

- **`EADDRINUSE` / port already in use:** find the process with `lsof -i :8000`, or use another port as described under Ports.
- **`ECONNREFUSED` on 5433 / API won't start:** Docker is not running or the container is stopped — `docker start tierforge-postgres`.
- **Job sits at `PENDING`:** the worker is not running.
- **Job shows `PAUSED`:** the enrichment API is unreachable; it resumes automatically when the simulator is back.
- **Lots of "rate limited (429)" failures:** more than one worker is running. Stop extras with `pkill -f worker/index.js`, then start one.
- **Browser shows "Cannot reach the API server":** check `VITE_API_URL` matches the API port, then restart `npm run dev` in `frontend`.

## Project structure

```
tierforge/
├── sample-data/stores_5000.csv
├── backend/
│   ├── sql/schema.sql              # idempotent schema
│   ├── src/
│   │   ├── server.js               # API entry point
│   │   ├── app.js                  # Express app factory
│   │   ├── config/                 # env parsing + defaults
│   │   ├── db/                     # pg pool, migrate
│   │   ├── routes/                 # URL → controller wiring (/api)
│   │   ├── controllers/            # HTTP layer: validate request, shape response
│   │   ├── services/               # business logic + SQL (csv, jobs, scoring)
│   │   ├── middleware/             # error handler, async handler
│   │   └── worker/                 # separate process: index.js (entry), engine, claim,
│   │                               #   enrichClient, rateLimiter, backoff, circuitBreaker
│   └── tests/
│       ├── unit/                   # pure logic, no DB
│       ├── integration/            # needs Postgres (skipped if unreachable)
│       ├── e2e/                    # black-box, needs live API + worker (npm run test:e2e)
│       └── helpers/                # test DB + fake enrichment server
└── frontend/
    └── src/
        ├── main.jsx, app/          # bootstrap + routes
        ├── pages/                  # route-level screens
        ├── components/             # grouped by feature: progress/ scoring/ stores/ common/
        ├── hooks/                  # usePolling
        ├── api/                    # fetch client
        ├── utils/                  # formatting helpers
        └── styles/                 # global.css
```

## Architecture

API and worker are separate processes that share only PostgreSQL.

| Decision | Choice |
|---|---|
| Slow vs fast | Separate worker; API/scoring never wait on enrichment |
| Queue | `enrichments` table, claimed with `FOR UPDATE SKIP LOCKED` |
| Hung calls | 5 s client abort + 15 s lease; reaper returns expired leases to `PENDING` |
| Late responses | All post-claim writes are guarded by `attempt_token` + `status='IN_PROGRESS'` |
| Rate limit | Process-local token bucket, 4 req/s (limit is 5) |
| Retries | Capped exponential backoff + equal jitter, stored in `next_attempt_at` |
| Systemic failure | `MAX_ATTEMPTS` per store + job-level circuit breaker (≥90 % of last 30 calls) → `PAUSED`, auto-resume on recovery, `FAILED` after the pause limit |
| Scoring | One `INSERT … SELECT` over stored metrics; every run is a new `scoring_configs` row |
| Progress | Computed live with `GROUP BY status`, no stored counters |

### Resilience walkthrough
- **Timeouts:** each call aborts after `REQUEST_TIMEOUT_MS`; the unit is retried.
- **Classification:** 429/500/502/503/504/timeout/network → retry; other 4xx and malformed 200 → permanent `FAILED`, no retry.
- **Lease + token:** a claim gets a fresh token. If a worker stalls past the lease, the reaper requeues the unit and the old token matches nothing, so a late answer is discarded.
- **Breaker + auto-resume:** a full window of mostly failures pauses the job (`PAUSED`, reason shown in the UI); remaining units stay `PENDING`. The worker probes the API every `PAUSE_PROBE_MS` (5 s) and resumes automatically when it answers. After `PAUSE_MAX_MS` (30 min) of continuous outage the job ends `FAILED` with a clear reason. A worker restart also picks up `PAUSED` jobs.

### Deviations / notes
- Token bucket **capacity defaults to 1** (not 4). With capacity 4 a bucket can emit `capacity + rate` calls in one window (8 > 5); capacity 1 keeps any 1 s window at ≈4.
- The response body of `/enrich` is `{estimated_monthly_footfall, estimated_monthly_revenue, store_size_sqft}`; mapped in `parseEnrichment` in `backend/src/worker/enrichClient.js`.
- Permanent 4xx responses count as "API healthy" for the breaker.

## Known limitations
- Rate limiter is process-local: run exactly one worker process. Multiple workers/jobs would need a shared limiter.
- One job at a time; no auth; idempotent `schema.sql` instead of a migrations framework.
- Polling instead of SSE/WebSocket; offset pagination.
- Restart behaviour: unfinished units stay `PENDING` or expire back to `PENDING`, so a restarted worker continues the job (not formally tested).
- Simpler alternative if needed: run `createEngine(...).runForever()` inside the API process.

## Tests

```bash
cd backend && npm test
```

`tests/unit` always runs. `tests/integration` (claim/guarded writes, API, worker against a fake enrichment server) use `TEST_DATABASE_URL` (default `postgresql://tierforge:tierforge@localhost:5433/tierforge_test`, created automatically) and are **skipped if Postgres is unreachable**.

## Workflow
![TierForge workflow](docs/workflow.png)