-- DBA review/apply only. Append-only evidence; no canonical row mutation.
CREATE TABLE IF NOT EXISTS bybit_live.node_live_epoch_boundaries (
  approval_id UUID PRIMARY KEY,
  epoch_id UUID NOT NULL REFERENCES bybit_live.node_producer_epochs(epoch_id),
  gap_start TIMESTAMPTZ NOT NULL,
  gap_end TIMESTAMPTZ NOT NULL,
  first_verified_trade_id TEXT NOT NULL,
  first_complete_minute_start TIMESTAMPTZ NOT NULL,
  historical_source_gap TEXT NOT NULL CHECK (historical_source_gap = 'OPEN'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (gap_end > gap_start),
  CHECK (first_complete_minute_start > gap_end)
);
CREATE TRIGGER node_live_epoch_boundaries_reject_mutation
  BEFORE UPDATE OR DELETE ON bybit_live.node_live_epoch_boundaries
  FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();
GRANT SELECT, INSERT ON bybit_live.node_live_epoch_boundaries TO bybit_producer;
GRANT SELECT ON bybit_live.node_live_epoch_boundaries TO bybit_shadow;
