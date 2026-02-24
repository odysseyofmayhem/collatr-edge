// CollatrEdge — Shared MQTT client types
// Extracted from mqtt-consumer.ts for reuse by Hub link and MQTT output.
// ──────────────────────────────────────────────────────────────────────

export interface MqttMessageEvent {
  topic: string;
  payload: Buffer;
  qos: number;
  retain: boolean;
}

export interface MqttClientOptions {
  clientId?: string;
  username?: string;
  password?: string;
  reconnectPeriod?: number;
  maxReconnectDelay?: number;
  maxReconnectAttempts?: number;
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
  /** Clean session flag (default: true) */
  clean?: boolean;
}

export interface MqttPublishOptions {
  qos?: 0 | 1;
  retain?: boolean;
}

export interface MqttWillOptions {
  topic: string;
  payload: Buffer;
  qos: 0 | 1;
  retain: boolean;
}

export interface MqttClientInterface {
  connect(servers: string[], options: MqttClientOptions): void;
  subscribe(topics: string[], qos: number): Promise<void>;
  unsubscribe(topics: string[]): Promise<void>;
  publish(topic: string, payload: Buffer, options?: MqttPublishOptions): Promise<void>;
  setWill(topic: string, payload: Buffer, qos?: 0 | 1, retain?: boolean): void;
  onMessage(handler: (event: MqttMessageEvent) => void): void;
  onConnect(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  onReconnect(handler: () => void): void;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
}
