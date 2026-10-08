export type Side = 'LONG' | 'SHORT';
export type TradeSide = 'Buy' | 'Sell';
export interface WsOrderingWitness {
  connectionId: string;
  messageOrdinal: number;
  messageIndex: number;
  receiveOrder: number;
  receivedAt: number;
  messageHash: string;
  rawMessage: string;
  exchangeMessageId: string | null;
}
export interface CanonicalTrade {
  id: string; timestamp: number; receivedAt: number; side: TradeSide;
  price: string; size: string; sequence: number | null; source: 'WEBSOCKET' | 'REST_RECENT';
  witness?: WsOrderingWitness;
}
export interface CanonicalCandle {
  end: number; open: string; high: string; low: string; close: string;
  volume: string; tradeCount: number; firstTradeTimestamp: number | null;
  lastTradeTimestamp: number | null;
}
export interface FrozenPrediction {
  decisionTimestamp: number; featureCutoff: number; side: Side | 'NO_ACTION';
  confidence: number; actionable: boolean; flipActionable: boolean;
  modelHash: string; featureSchemaHash: string;
}
