-- Analytics event store.
-- Run once to provision; api/events.ts also runs CREATE TABLE/INDEX IF NOT EXISTS on cold start.

CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  client_ts    TIMESTAMPTZ,
  user_email   TEXT,
  session_id   TEXT NOT NULL,
  screen       TEXT,
  event_type   TEXT NOT NULL,
  event_name   TEXT NOT NULL,
  outcome      TEXT,
  duration_ms  INTEGER,
  content      JSONB,
  metadata     JSONB,
  app_version  TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_user_ts  ON events (user_email, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts  ON events (event_type, event_name, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_session  ON events (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_outcome  ON events (outcome) WHERE outcome = 'failure';

-- Example queries:

-- Menu OCR failures last 7 days, per user
-- SELECT user_email, count(*) FROM events
-- WHERE event_name='ocr_result' AND outcome='failure' AND ts > now()-interval '7 days'
-- GROUP BY user_email ORDER BY 2 DESC;

-- Average assistant reply latency per user
-- SELECT user_email, round(avg(duration_ms)) ms FROM events
-- WHERE event_name='llm_reply' GROUP BY user_email;

-- Conversation abandonment: sessions with user turns but no learnings.extracted
-- SELECT session_id FROM events WHERE event_name='turn'
-- EXCEPT SELECT session_id FROM events WHERE event_name='extracted';

-- Full transcript of one session, in order
-- SELECT client_ts, event_name, content FROM events
-- WHERE session_id=$1 AND event_type IN ('ask','message','speech') ORDER BY client_ts;
