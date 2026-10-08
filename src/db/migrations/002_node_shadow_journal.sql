-- DBA review only. Never run automatically. Append-only, dedicated Shadow schema.
CREATE TABLE IF NOT EXISTS shadow_trading_v1.node_shadow_journal (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activation_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('ACTIVATION', 'TRANSITION')),
  signal_timestamp TIMESTAMPTZ,
  event_timestamp TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL,
  model_hash TEXT NOT NULL,
  feature_schema_hash TEXT NOT NULL,
  state_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((event_type = 'ACTIVATION' AND signal_timestamp IS NULL)
    OR (event_type = 'TRANSITION' AND signal_timestamp IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS node_shadow_journal_activation_id_id_idx
  ON shadow_trading_v1.node_shadow_journal (activation_id, id DESC);
CREATE TRIGGER node_shadow_journal_reject_mutation
  BEFORE UPDATE OR DELETE ON shadow_trading_v1.node_shadow_journal
  FOR EACH ROW EXECUTE FUNCTION shadow_trading_v1.reject_mutation();
GRANT SELECT, INSERT ON shadow_trading_v1.node_shadow_journal TO bybit_shadow;
GRANT USAGE, SELECT ON SEQUENCE shadow_trading_v1.node_shadow_journal_id_seq TO bybit_shadow;
-- No producer grant, no UPDATE/DELETE grant.
