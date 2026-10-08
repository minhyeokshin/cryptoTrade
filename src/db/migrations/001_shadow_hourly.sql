-- DBA review only. Do not run automatically. No research/source table changes.
CREATE TABLE IF NOT EXISTS shadow_trading_v1.node_hourly_reports (
  report_hour TIMESTAMPTZ PRIMARY KEY,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  status TEXT NOT NULL DEFAULT 'CLAIMED' CHECK (status = 'CLAIMED')
);
CREATE TRIGGER node_hourly_reports_reject_mutation
  BEFORE UPDATE OR DELETE ON shadow_trading_v1.node_hourly_reports
  FOR EACH ROW EXECUTE FUNCTION shadow_trading_v1.reject_mutation();
GRANT SELECT, INSERT ON shadow_trading_v1.node_hourly_reports TO bybit_shadow;
-- Intentionally no UPDATE/DELETE grant.
