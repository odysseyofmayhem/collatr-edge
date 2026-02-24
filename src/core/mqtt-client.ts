// CollatrEdge — Real MQTT client wrapper
// Wraps the `mqtt` npm package, implementing MqttClientInterface.
// Shared by mqtt-consumer input and Hub link / MQTT output.
// ──────────────────────────────────────────────────────────────────────

import mqtt from "mqtt";
import type {
  MqttClientInterface,
  MqttClientOptions,
  MqttMessageEvent,
  MqttPublishOptions,
} from "./mqtt-types.ts";

export class RealMqttClient implements MqttClientInterface {
  private client: mqtt.MqttClient | null = null;
  private _isConnected = false;

  // Will message — must be set before connect()
  private willTopic: string | null = null;
  private willPayload: Buffer | null = null;
  private willQos: 0 | 1 = 0;
  private willRetain = false;

  // Deferred event handlers — registered before connect() is called.
  // The mqtt-consumer calls on*() before connect(). We store handlers
  // and attach them once connect() creates the underlying client.
  private _deferredMessage: ((event: MqttMessageEvent) => void) | null = null;
  private _deferredConnect: (() => void) | null = null;
  private _deferredError: ((error: Error) => void) | null = null;
  private _deferredClose: (() => void) | null = null;
  private _deferredReconnect: (() => void) | null = null;

  get isConnected(): boolean {
    return this._isConnected;
  }

  setWill(topic: string, payload: Buffer, qos: 0 | 1 = 0, retain = false): void {
    if (this.client) throw new Error("setWill() must be called before connect()");
    this.willTopic = topic;
    this.willPayload = payload;
    this.willQos = qos;
    this.willRetain = retain;
  }

  connect(servers: string[], options: MqttClientOptions): void {
    const brokerUrl = servers[0]!;

    const mqttOptions: mqtt.IClientOptions = {
      clientId: options.clientId,
      username: options.username,
      password: options.password,
      reconnectPeriod: options.reconnectPeriod ?? 1000,
      clean: options.clean ?? true,
      servers: servers.map((s) => {
        const url = new URL(s);
        return {
          host: url.hostname,
          port: Number(url.port) || (url.protocol === "mqtts:" || url.protocol === "ssl:" ? 8883 : 1883),
          protocol: url.protocol.replace(":", "") as mqtt.MqttProtocol,
        };
      }),
    };

    // TLS options
    if (options.ca) mqttOptions.ca = options.ca;
    if (options.cert) mqttOptions.cert = options.cert;
    if (options.key) mqttOptions.key = options.key;
    if (options.rejectUnauthorized !== undefined) {
      mqttOptions.rejectUnauthorized = options.rejectUnauthorized;
    }

    // Will message (NDEATH for Hub link)
    if (this.willTopic && this.willPayload) {
      mqttOptions.will = {
        topic: this.willTopic,
        payload: this.willPayload as Buffer,
        qos: this.willQos,
        retain: this.willRetain,
      };
    }

    this.client = mqtt.connect(brokerUrl, mqttOptions);

    // Wire deferred handlers
    if (this._deferredMessage) this.onMessage(this._deferredMessage);
    if (this._deferredConnect) this.onConnect(this._deferredConnect);
    if (this._deferredError) this.onError(this._deferredError);
    if (this._deferredClose) this.onClose(this._deferredClose);
    if (this._deferredReconnect) this.onReconnect(this._deferredReconnect);

    // Clear deferred references
    this._deferredMessage = null;
    this._deferredConnect = null;
    this._deferredError = null;
    this._deferredClose = null;
    this._deferredReconnect = null;
  }

  async subscribe(topics: string[], qos: number): Promise<void> {
    if (!this.client) throw new Error("MQTT client not connected");
    const subMap: Record<string, { qos: number }> = {};
    for (const t of topics) {
      subMap[t] = { qos };
    }
    await this.client.subscribeAsync(subMap);
  }

  async unsubscribe(topics: string[]): Promise<void> {
    if (!this.client) throw new Error("MQTT client not connected");
    await this.client.unsubscribeAsync(topics);
  }

  async publish(topic: string, payload: Buffer, options?: MqttPublishOptions): Promise<void> {
    if (!this.client) throw new Error("MQTT client not connected");
    await this.client.publishAsync(topic, payload, {
      qos: options?.qos ?? 0,
      retain: options?.retain ?? false,
    });
  }

  onMessage(handler: (event: MqttMessageEvent) => void): void {
    if (!this.client) {
      this._deferredMessage = handler;
      return;
    }
    this.client.on("message", (topic, payload, packet) => {
      handler({
        topic,
        payload: Buffer.from(payload),
        qos: packet.qos,
        retain: packet.retain,
      });
    });
  }

  onConnect(handler: () => void): void {
    if (!this.client) {
      this._deferredConnect = handler;
      return;
    }
    // Remove existing listeners to prevent duplicates when re-registering (F-5)
    this.client.removeAllListeners("connect");
    this.client.on("connect", () => {
      this._isConnected = true;
      handler();
    });
  }

  onError(handler: (error: Error) => void): void {
    if (!this.client) {
      this._deferredError = handler;
      return;
    }
    this.client.removeAllListeners("error");
    this.client.on("error", handler);
  }

  onClose(handler: () => void): void {
    if (!this.client) {
      this._deferredClose = handler;
      return;
    }
    this.client.removeAllListeners("close");
    this.client.on("close", () => {
      this._isConnected = false;
      handler();
    });
  }

  onReconnect(handler: () => void): void {
    if (!this.client) {
      this._deferredReconnect = handler;
      return;
    }
    this.client.removeAllListeners("reconnect");
    this.client.on("reconnect", handler);
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    this._isConnected = false;
    await this.client.endAsync();
    this.client = null;
  }
}
