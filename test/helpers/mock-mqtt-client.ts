// Shared mock MQTT client for Hub link, MQTT output, and Sparkplug lifecycle tests.
// Implements MqttClientInterface with synchronous connect (fires onConnect handler).

import type {
  MqttClientInterface,
  MqttClientOptions,
  MqttMessageEvent,
  MqttPublishOptions,
} from "@core/mqtt-types";

export class MockMqttClient implements MqttClientInterface {
  private _isConnected = false;
  private messageHandler: ((event: MqttMessageEvent) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private reconnectHandler: (() => void) | null = null;

  connectCalls: Array<{ servers: string[]; options: MqttClientOptions }> = [];
  subscribeCalls: Array<{ topics: string[]; qos: number }> = [];
  publishCalls: Array<{ topic: string; payload: Buffer; options?: MqttPublishOptions }> = [];
  disconnected = false;
  willConfig: { topic: string; payload: Buffer; qos: 0 | 1; retain: boolean } | null = null;

  get isConnected(): boolean { return this._isConnected; }

  setWill(topic: string, payload: Buffer, qos: 0 | 1 = 0, retain = false): void {
    this.willConfig = { topic, payload, qos, retain };
  }

  connect(servers: string[], options: MqttClientOptions): void {
    this.connectCalls.push({ servers, options });
    this._isConnected = true;
    // Fire onConnect synchronously to match real client's CONNACK pattern
    if (this.connectHandler) this.connectHandler();
  }

  async subscribe(topics: string[], qos: number): Promise<void> {
    this.subscribeCalls.push({ topics, qos });
  }

  async unsubscribe(_topics: string[]): Promise<void> {}

  async publish(topic: string, payload: Buffer, options?: MqttPublishOptions): Promise<void> {
    this.publishCalls.push({ topic, payload, options });
  }

  onMessage(handler: (event: MqttMessageEvent) => void): void { this.messageHandler = handler; }
  onConnect(handler: () => void): void { this.connectHandler = handler; }
  onError(handler: (error: Error) => void): void { this.errorHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  onReconnect(handler: () => void): void { this.reconnectHandler = handler; }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    this.disconnected = true;
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Simulate an incoming MQTT message */
  emitMessage(topic: string, payload: Buffer): void {
    if (this.messageHandler) {
      this.messageHandler({ topic, payload, qos: 0, retain: false });
    }
  }

  /** Simulate a connection error */
  emitError(error: Error): void {
    if (this.errorHandler) this.errorHandler(error);
  }

  /** Find first published message by topic substring */
  findPublished(topicSubstring: string): { topic: string; payload: Buffer; options?: MqttPublishOptions } | undefined {
    return this.publishCalls.find((p) => p.topic.includes(topicSubstring));
  }

  /** Find all published messages by topic substring */
  findAllPublished(topicSubstring: string): Array<{ topic: string; payload: Buffer; options?: MqttPublishOptions }> {
    return this.publishCalls.filter((p) => p.topic.includes(topicSubstring));
  }
}
