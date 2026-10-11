-- One row per uploaded CSV. The worker drives status; counts are derived from enrichments.
CREATE TABLE IF NOT EXISTS jobs (
  id            BIGSERIAL PRIMARY KEY,
  filename      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
     -- PENDING | RUNNING | PAUSED | COMPLETED | COMPLETED_WITH_FAILURES | FAILED
  failure_reason TEXT,                 -- set when status = FAILED (breaker tripped)
  total_stores  INT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stores (          -- raw CSV input, immutable
  id          BIGSERIAL PRIMARY KEY,
  job_id      BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  store_id    TEXT NOT NULL,
  store_name  TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  UNIQUE (job_id, store_id)
);

CREATE TABLE IF NOT EXISTS enrichments (     -- unit of work + raw result, 1 per store
  id               BIGSERIAL PRIMARY KEY,
  store_pk         BIGINT NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
  job_id           BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'PENDING',
     -- PENDING | IN_PROGRESS | SUCCESS | FAILED
  attempts         INT  NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- attempt_token/lease_expires_at: set while a worker holds the unit; stale results are rejected by token.
  attempt_token    UUID,                -- identifies the current claim
  lease_expires_at TIMESTAMPTZ,
  last_error       TEXT,                -- latest error; becomes the failure reason
  footfall         INT,
  revenue          NUMERIC(12,2),
  size_sqft        INT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_enr_claim serves the worker's claim query; idx_enr_lease serves the expired-lease reaper.
CREATE INDEX IF NOT EXISTS idx_enr_claim  ON enrichments (job_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_enr_lease  ON enrichments (status, lease_expires_at);

CREATE TABLE IF NOT EXISTS scoring_configs ( -- one row per scoring run (history)
  id                BIGSERIAL PRIMARY KEY,
  job_id            BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  footfall_bar      INT           NOT NULL CHECK (footfall_bar >= 0),
  footfall_weight   INT           NOT NULL CHECK (footfall_weight BETWEEN 0 AND 100),
  revenue_bar       NUMERIC(12,2) NOT NULL CHECK (revenue_bar >= 0),
  revenue_weight    INT           NOT NULL CHECK (revenue_weight BETWEEN 0 AND 100),
  size_bar          INT           NOT NULL CHECK (size_bar >= 0),
  size_weight       INT           NOT NULL CHECK (size_weight BETWEEN 0 AND 100),
  large_threshold   INT           NOT NULL CHECK (large_threshold BETWEEN 0 AND 100),
  medium_threshold  INT           NOT NULL CHECK (medium_threshold BETWEEN 0 AND 100),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CHECK (footfall_weight + revenue_weight + size_weight = 100),
  CHECK (large_threshold >= medium_threshold)
);

-- Computed tier per store per scoring run; stores that failed enrichment have no row (shown as 'unscored').
CREATE TABLE IF NOT EXISTS store_scores (
  config_id  BIGINT NOT NULL REFERENCES scoring_configs(id) ON DELETE CASCADE,
  store_pk   BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  score      INT  NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('Large','Medium','Small')),
  PRIMARY KEY (config_id, store_pk)
);
CREATE INDEX IF NOT EXISTS idx_scores_tier ON store_scores (config_id, tier);
