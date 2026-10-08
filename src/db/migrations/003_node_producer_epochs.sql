-- DBA review only. Apply before enabling Node canonical WRITE; never run automatically.
-- Existing canonical/history rows remain untouched. Each restart creates a new live epoch.
CREATE TABLE IF NOT EXISTS bybit_live.node_producer_epochs (
  epoch_id UUID PRIMARY KEY,
  runtime_name TEXT NOT NULL CHECK (runtime_name = 'cryptoTrade-node'),
  runtime_version TEXT NOT NULL,
  epoch_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  writer_role TEXT NOT NULL CHECK (writer_role = 'bybit_producer'),
  historical_source_gap TEXT NOT NULL CHECK (historical_source_gap = 'OPEN')
);
CREATE TRIGGER node_producer_epochs_reject_mutation
  BEFORE UPDATE OR DELETE ON bybit_live.node_producer_epochs
  FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();
GRANT SELECT, INSERT ON bybit_live.node_producer_epochs TO bybit_producer;
GRANT SELECT ON bybit_live.node_producer_epochs TO bybit_shadow;
-- No UPDATE/DELETE, shadow INSERT, or research/source grants.
