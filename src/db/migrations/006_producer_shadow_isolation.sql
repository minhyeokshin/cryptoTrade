-- DBA review/apply only. New append-only operational evidence; no canonical mutation.
CREATE TABLE IF NOT EXISTS bybit_live.node_producer_heartbeats (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch_id UUID NOT NULL REFERENCES bybit_live.node_producer_epochs(epoch_id),
  backend_pid INTEGER NOT NULL CHECK (backend_pid > 0),
  state TEXT NOT NULL CHECK (state IN ('RUNNING','DEGRADED','FAILED')),
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS node_producer_heartbeats_epoch_id_id_idx
  ON bybit_live.node_producer_heartbeats(epoch_id, id DESC);
CREATE TRIGGER node_producer_heartbeats_reject_mutation
  BEFORE UPDATE OR DELETE ON bybit_live.node_producer_heartbeats
  FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();
GRANT SELECT, INSERT ON bybit_live.node_producer_heartbeats TO bybit_producer;
GRANT USAGE, SELECT ON SEQUENCE bybit_live.node_producer_heartbeats_id_seq TO bybit_producer;
GRANT SELECT ON bybit_live.node_producer_heartbeats TO bybit_shadow;

CREATE TABLE IF NOT EXISTS shadow_trading_v1.node_shadow_suspensions (
  activation_id UUID PRIMARY KEY,
  producer_epoch_id UUID NOT NULL,
  open_position JSONB,
  reason TEXT NOT NULL,
  fault_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS node_shadow_open_suspensions_idx
  ON shadow_trading_v1.node_shadow_suspensions(activation_id)
  WHERE open_position IS NOT NULL;
CREATE TRIGGER node_shadow_suspensions_reject_mutation
  BEFORE UPDATE OR DELETE ON shadow_trading_v1.node_shadow_suspensions
  FOR EACH ROW EXECUTE FUNCTION shadow_trading_v1.reject_mutation();
GRANT SELECT, INSERT ON shadow_trading_v1.node_shadow_suspensions TO bybit_shadow;
