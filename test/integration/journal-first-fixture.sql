\getenv test_password PGPASSWORD
CREATE ROLE bybit_producer LOGIN PASSWORD :'test_password';
CREATE ROLE bybit_shadow LOGIN PASSWORD :'test_password';
CREATE SCHEMA bybit_live;
GRANT USAGE ON SCHEMA bybit_live TO bybit_producer,bybit_shadow;
CREATE FUNCTION bybit_live.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append only'; END $$;
CREATE TABLE bybit_live.node_producer_epochs(epoch_id uuid PRIMARY KEY);
CREATE TABLE bybit_live.node_live_epoch_boundaries(
 approval_id uuid PRIMARY KEY,epoch_id uuid REFERENCES bybit_live.node_producer_epochs,
 recorded_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE bybit_live.bybit_live_trades(
 trade_id text PRIMARY KEY, exchange_timestamp timestamptz,received_at timestamptz,
 side text,price numeric,size numeric,raw_sequence bigint,source text);
CREATE TABLE bybit_live.bybit_live_candles_1m(
 timestamp timestamptz PRIMARY KEY,open numeric,high numeric,low numeric,close numeric,
 volume numeric,trade_count bigint,first_trade_timestamp timestamptz,last_trade_timestamp timestamptz,
 finalized_at timestamptz,source_status text);
CREATE TABLE bybit_live.operational_health_events(state text,reason text);
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA bybit_live TO bybit_producer;
GRANT SELECT ON ALL TABLES IN SCHEMA bybit_live TO bybit_shadow;
INSERT INTO bybit_live.node_producer_epochs VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO bybit_live.node_live_epoch_boundaries(approval_id,epoch_id) VALUES
 ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
CREATE TRIGGER canonical_trade_append_only BEFORE UPDATE OR DELETE ON bybit_live.bybit_live_trades
 FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();
CREATE TRIGGER canonical_candle_append_only BEFORE UPDATE OR DELETE ON bybit_live.bybit_live_candles_1m
 FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();
