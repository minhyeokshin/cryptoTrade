-- DBA review only. Do not apply to production as part of implementation/tests.
-- 005 canonical witnesses retain their FK and are never backfilled or modified.
BEGIN;
CREATE TABLE bybit_live.node_ws_journal_frames (
  connection_id UUID NOT NULL,
  message_ordinal BIGINT NOT NULL CHECK (message_ordinal > 0),
  epoch_id UUID NOT NULL REFERENCES bybit_live.node_producer_epochs(epoch_id),
  first_receive_order BIGINT NOT NULL CHECK (first_receive_order > 0),
  trade_count INTEGER NOT NULL CHECK (trade_count > 0),
  min_timestamp BIGINT NOT NULL,
  max_timestamp BIGINT NOT NULL CHECK (max_timestamp >= min_timestamp),
  -- Complete ordered tuples: ID, timestamp, sequence, price, size, side, index, receive_order.
  witnesses JSONB NOT NULL CHECK (jsonb_typeof(witnesses)='array'
    AND jsonb_array_length(witnesses)=trade_count),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connection_id,message_ordinal),
  FOREIGN KEY (connection_id,message_ordinal)
    REFERENCES bybit_live.node_ws_messages(connection_id,message_ordinal)
);
CREATE INDEX node_ws_journal_epoch_tail_idx
  ON bybit_live.node_ws_journal_frames(epoch_id,max_timestamp);
CREATE TRIGGER node_ws_journal_frames_reject_mutation
  BEFORE UPDATE OR DELETE ON bybit_live.node_ws_journal_frames
  FOR EACH ROW EXECUTE FUNCTION bybit_live.reject_mutation();
REVOKE ALL ON bybit_live.node_ws_journal_frames FROM PUBLIC;
GRANT SELECT,INSERT ON bybit_live.node_ws_journal_frames TO bybit_producer;
GRANT SELECT ON bybit_live.node_ws_journal_frames TO bybit_shadow;
COMMIT;
-- Deliberately non-idempotent: deployment ledger/review required for a second apply.
