-- DBA review/apply only; never run from the application. No existing canonical mutation.
-- A local connection UUID + message ordinal identifies a received public WS frame.
-- Bybit's futures trade `seq` is NOT a per-trade ordinal.
CREATE TABLE IF NOT EXISTS bybit_live.node_ws_messages (
  connection_id UUID NOT NULL,
  message_ordinal BIGINT NOT NULL CHECK (message_ordinal > 0),
  received_at TIMESTAMPTZ NOT NULL,
  exchange_message_id TEXT,
  message_sha256 TEXT NOT NULL CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload TEXT NOT NULL,
  PRIMARY KEY (connection_id, message_ordinal)
);
CREATE TRIGGER node_ws_messages_reject_mutation
  BEFORE UPDATE OR DELETE ON bybit_live.node_ws_messages
  FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();

CREATE TABLE IF NOT EXISTS bybit_live.node_ws_trade_witnesses (
  trade_id TEXT PRIMARY KEY REFERENCES bybit_live.bybit_live_trades(trade_id),
  connection_id UUID NOT NULL,
  message_ordinal BIGINT NOT NULL,
  message_index INTEGER NOT NULL CHECK (message_index >= 0),
  receive_order BIGINT NOT NULL CHECK (receive_order > 0),
  exchange_timestamp TIMESTAMPTZ NOT NULL,
  exchange_sequence BIGINT,
  price NUMERIC NOT NULL CHECK (price > 0),
  size NUMERIC NOT NULL CHECK (size > 0),
  side TEXT NOT NULL CHECK (side IN ('Buy','Sell')),
  UNIQUE (connection_id, message_ordinal, message_index),
  UNIQUE (connection_id, receive_order),
  FOREIGN KEY (connection_id, message_ordinal)
    REFERENCES bybit_live.node_ws_messages(connection_id, message_ordinal)
);
CREATE INDEX IF NOT EXISTS node_ws_trade_witnesses_timestamp_sequence_idx
  ON bybit_live.node_ws_trade_witnesses(exchange_timestamp, exchange_sequence);
CREATE TRIGGER node_ws_trade_witnesses_reject_mutation
  BEFORE UPDATE OR DELETE ON bybit_live.node_ws_trade_witnesses
  FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();

GRANT SELECT, INSERT ON bybit_live.node_ws_messages TO bybit_producer;
GRANT SELECT, INSERT ON bybit_live.node_ws_trade_witnesses TO bybit_producer;
GRANT SELECT ON bybit_live.node_ws_messages,bybit_live.node_ws_trade_witnesses TO bybit_shadow;
-- No UPDATE/DELETE grants. No Shadow INSERT. No change to existing rows.
