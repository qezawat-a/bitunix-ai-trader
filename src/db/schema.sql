-- ============================================================
--  Neon / Postgres schema — long-term memory for the AI trader
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT DEFAULT 'system'
);

-- every message exchanged with the agent (telegram + internal)
CREATE TABLE IF NOT EXISTS conversations (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  role        TEXT NOT NULL,           -- user | assistant | tool | system
  content     TEXT NOT NULL,
  tool_name   TEXT,
  meta        JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_chat_idx ON conversations (chat_id, created_at DESC);

-- compacted summaries produced by autocompact
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id            BIGSERIAL PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  summary       TEXT NOT NULL,
  covers_until  BIGINT NOT NULL,       -- last conversations.id folded into this summary
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS summaries_chat_idx ON conversation_summaries (chat_id, created_at DESC);

-- durable semantic memory: lessons, market beliefs, user preferences
CREATE TABLE IF NOT EXISTS memories (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,           -- lesson | preference | market_note | rule | error
  subject     TEXT,                    -- symbol or topic
  content     TEXT NOT NULL,
  importance  INT NOT NULL DEFAULT 5,  -- 1..10
  hits        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS memories_kind_idx ON memories (kind, importance DESC);
CREATE INDEX IF NOT EXISTS memories_subject_idx ON memories (subject);

-- every signal produced by the scanner
CREATE TABLE IF NOT EXISTS signals (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,         -- LONG | SHORT
  confidence    NUMERIC NOT NULL,
  agreement     INT NOT NULL,
  strategies    JSONB NOT NULL,
  timeframes    JSONB NOT NULL,
  price         NUMERIC,
  atr           NUMERIC,
  atr_pct       NUMERIC,
  regime        TEXT,
  taken         BOOLEAN NOT NULL DEFAULT false,
  reject_reason TEXT,
  ai_verdict    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_symbol_idx ON signals (symbol, created_at DESC);

-- every position the agent opened, plus its outcome
CREATE TABLE IF NOT EXISTS trades (
  id             BIGSERIAL PRIMARY KEY,
  position_id    TEXT,
  client_id      TEXT,
  symbol         TEXT NOT NULL,
  side           TEXT NOT NULL,        -- LONG | SHORT
  entry_price    NUMERIC,
  qty            NUMERIC,
  leverage       INT,
  margin_mode    TEXT,
  margin_usdt    NUMERIC,
  tp_price       NUMERIC,
  sl_price       NUMERIC,
  atr            NUMERIC,
  confidence     NUMERIC,
  agreement      INT,
  strategies     JSONB,
  reasoning      TEXT,
  status         TEXT NOT NULL DEFAULT 'OPEN',   -- OPEN | CLOSED | FAILED
  exit_price     NUMERIC,
  realized_pnl   NUMERIC,
  roi_pct        NUMERIC,
  close_reason   TEXT,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trades_status_idx ON trades (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades (symbol, opened_at DESC);

-- rolling per-strategy performance, used to weight the consensus
CREATE TABLE IF NOT EXISTS strategy_stats (
  strategy    TEXT PRIMARY KEY,
  wins        INT NOT NULL DEFAULT 0,
  losses      INT NOT NULL DEFAULT 0,
  pnl         NUMERIC NOT NULL DEFAULT 0,
  weight      NUMERIC NOT NULL DEFAULT 1.0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- cooldowns per symbol
CREATE TABLE IF NOT EXISTS cooldowns (
  symbol     TEXT PRIMARY KEY,
  until      TIMESTAMPTZ NOT NULL,
  reason     TEXT
);

-- audit log of every action the agent takes
CREATE TABLE IF NOT EXISTS agent_events (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  symbol     TEXT,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_events_kind_idx ON agent_events (kind, created_at DESC);
