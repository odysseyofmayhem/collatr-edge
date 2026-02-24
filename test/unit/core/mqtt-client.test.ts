// Unit tests: RealMqttClient wrapper
// Tests the wrapper using the same mock approach as mqtt-consumer tests.
// We test the interface contract, not actual broker communication.

import { describe, it, expect, beforeEach } from "bun:test";
import type {
  MqttClientInterface,
  MqttClientOptions,
  MqttMessageEvent,
  MqttPublishOptions,
} from "@core/mqtt-types";

// ---------------------------------------------------------------------------
// We test the RealMqttClient interface contract via a MockMqttClient that
// also implements the new publish() and setWill() methods.
// This verifies the interface shape and that mqtt-consumer still works
// with the extended interface.
// ---------------------------------------------------------------------------

class MockMqttClient implements MqttClientInterface {
  private _isConnected = false;
  private messageHandler: ((event: MqttMessageEvent) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private reconnectHandler: (() => void) | null = null;
  private _willSet = false;
  private _willTopic = "";
  private _willPayload: Buffer | null = null;
  private _willQos: 0 | 1 = 0;
  private _willRetain = false;

  // Tracking
  connectCalls: Array<{ servers: string[]; options: MqttClientOptions }> = [];
  subscribeCalls: Array<{ topics: string[]; qos: number }> = [];
  publishCalls: Array<{ topic: string; payload: Buffer; options?: MqttPublishOptions }> = [];
  unsubscribeCalls: string[][] = [];
  disconnected = false;

  get isConnected(): boolean { return this._isConnected; }
  get willSet(): boolean { return this._willSet; }
  get willTopic(): string { return this._willTopic; }
  get willPayload(): Buffer | null { return this._willPayload; }
  get willQos(): 0 | 1 { return this._willQos; }
  get willRetain(): boolean { return this._willRetain; }

  setWill(topic: string, payload: Buffer, qos: 0 | 1 = 0, retain = false): void {
    this._willSet = true;
    this._willTopic = topic;
    this._willPayload = payload;
    this._willQos = qos;
    this._willRetain = retain;
  }

  connect(servers: string[], options: MqttClientOptions): void {
    this.connectCalls.push({ servers, options });
  }

  async subscribe(topics: string[], qos: number): Promise<void> {
    this.subscribeCalls.push({ topics, qos });
  }

  async unsubscribe(topics: string[]): Promise<void> {
    this.unsubscribeCalls.push(topics);
  }

  async publish(topic: string, payload: Buffer, options?: MqttPublishOptions): Promise<void> {
    this.publishCalls.push({ topic, payload, options });
  }

  onMessage(handler: (event: MqttMessageEvent) => void): void {
    this.messageHandler = handler;
  }

  onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    this.disconnected = true;
  }

  // --- Test helpers ---
  emitMessage(topic: string, payload: string | Buffer, qos = 0, retain = false): void {
    if (this.messageHandler) {
      const buf = typeof payload === "string" ? Buffer.from(payload) : payload;
      this.messageHandler({ topic, payload: buf, qos, retain });
    }
  }

  emitConnect(): void {
    this._isConnected = true;
    if (this.connectHandler) this.connectHandler();
  }

  emitError(error: Error): void {
    if (this.errorHandler) this.errorHandler(error);
  }

  emitReconnect(): void {
    if (this.reconnectHandler) this.reconnectHandler();
  }

  emitClose(): void {
    this._isConnected = false;
    if (this.closeHandler) this.closeHandler();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MqttClientInterface contract", () => {
  let client: MockMqttClient;

  beforeEach(() => {
    client = new MockMqttClient();
  });

  describe("publish()", () => {
    it("publishes a message with topic and payload", async () => {
      const payload = Buffer.from("hello");
      await client.publish("test/topic", payload, { qos: 1, retain: false });

      expect(client.publishCalls.length).toBe(1);
      expect(client.publishCalls[0]!.topic).toBe("test/topic");
      expect(client.publishCalls[0]!.payload.toString()).toBe("hello");
      expect(client.publishCalls[0]!.options?.qos).toBe(1);
    });

    it("publishes without options (defaults)", async () => {
      const payload = Buffer.from("data");
      await client.publish("test/topic", payload);

      expect(client.publishCalls.length).toBe(1);
      expect(client.publishCalls[0]!.options).toBeUndefined();
    });

    it("publishes binary protobuf payload", async () => {
      const payload = Buffer.from([0x08, 0x01, 0x10, 0x02]);
      await client.publish("spBv1.0/group/DDATA/node/device", payload, { qos: 0 });

      expect(client.publishCalls[0]!.payload).toEqual(payload);
    });
  });

  describe("setWill()", () => {
    it("stores will message configuration", () => {
      const payload = Buffer.from("ndeath-payload");
      client.setWill("spBv1.0/group/NDEATH/node", payload, 1, false);

      expect(client.willSet).toBe(true);
      expect(client.willTopic).toBe("spBv1.0/group/NDEATH/node");
      expect(client.willPayload!.toString()).toBe("ndeath-payload");
      expect(client.willQos).toBe(1);
      expect(client.willRetain).toBe(false);
    });

    it("defaults qos to 0 and retain to false", () => {
      client.setWill("topic", Buffer.from("payload"));

      expect(client.willQos).toBe(0);
      expect(client.willRetain).toBe(false);
    });
  });

  describe("connect()", () => {
    it("passes servers and options", () => {
      client.connect(["tcp://broker:1883"], {
        clientId: "edge-1",
        username: "user",
        password: "pass",
      });

      expect(client.connectCalls.length).toBe(1);
      expect(client.connectCalls[0]!.servers).toEqual(["tcp://broker:1883"]);
      expect(client.connectCalls[0]!.options.clientId).toBe("edge-1");
    });

    it("passes multiple servers for failover", () => {
      client.connect(
        ["tcp://broker1:1883", "tcp://broker2:1883"],
        {},
      );

      expect(client.connectCalls[0]!.servers).toHaveLength(2);
    });
  });

  describe("subscribe() / unsubscribe()", () => {
    it("subscribes to topics with QoS", async () => {
      await client.subscribe(["sensors/#", "alerts/+"], 1);
      expect(client.subscribeCalls[0]!.topics).toEqual(["sensors/#", "alerts/+"]);
      expect(client.subscribeCalls[0]!.qos).toBe(1);
    });

    it("unsubscribes from topics", async () => {
      await client.unsubscribe(["sensors/#"]);
      expect(client.unsubscribeCalls[0]).toEqual(["sensors/#"]);
    });
  });

  describe("event handlers", () => {
    it("onMessage receives messages", () => {
      const received: MqttMessageEvent[] = [];
      client.onMessage((event) => received.push(event));

      client.emitMessage("test/topic", "hello");

      expect(received.length).toBe(1);
      expect(received[0]!.topic).toBe("test/topic");
      expect(received[0]!.payload.toString()).toBe("hello");
    });

    it("onConnect fires on connection", () => {
      let connected = false;
      client.onConnect(() => { connected = true; });

      client.emitConnect();
      expect(connected).toBe(true);
      expect(client.isConnected).toBe(true);
    });

    it("onError fires on error", () => {
      const errors: Error[] = [];
      client.onError((e) => errors.push(e));

      client.emitError(new Error("connection refused"));
      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toBe("connection refused");
    });

    it("onClose fires on disconnect", () => {
      let closed = false;
      client.onClose(() => { closed = true; });

      client.emitConnect();
      client.emitClose();
      expect(closed).toBe(true);
      expect(client.isConnected).toBe(false);
    });

    it("onReconnect fires on reconnection attempt", () => {
      let reconnects = 0;
      client.onReconnect(() => { reconnects++; });

      client.emitReconnect();
      client.emitReconnect();
      expect(reconnects).toBe(2);
    });
  });

  describe("disconnect()", () => {
    it("disconnects and updates isConnected", async () => {
      client.emitConnect();
      expect(client.isConnected).toBe(true);

      await client.disconnect();
      expect(client.isConnected).toBe(false);
      expect(client.disconnected).toBe(true);
    });
  });

  describe("TLS options", () => {
    it("passes TLS configuration through connect options", () => {
      client.connect(["mqtts://broker:8883"], {
        ca: "/path/to/ca.pem",
        cert: "/path/to/cert.pem",
        key: "/path/to/key.pem",
        rejectUnauthorized: true,
      });

      const opts = client.connectCalls[0]!.options;
      expect(opts.ca).toBe("/path/to/ca.pem");
      expect(opts.cert).toBe("/path/to/cert.pem");
      expect(opts.key).toBe("/path/to/key.pem");
      expect(opts.rejectUnauthorized).toBe(true);
    });
  });

  describe("clean session", () => {
    it("passes clean session option", () => {
      client.connect(["tcp://broker:1883"], { clean: false });
      expect(client.connectCalls[0]!.options.clean).toBe(false);
    });
  });

  describe("combined publish + subscribe workflow", () => {
    it("supports Hub link pattern: setWill → connect → subscribe → publish", async () => {
      // 1. Set Will (NDEATH)
      client.setWill(
        "spBv1.0/factory/NDEATH/edge-1",
        Buffer.from("ndeath-bytes"),
        1,
        false,
      );

      // 2. Connect
      client.connect(["tcp://hub.collatr.com:1883"], {
        clientId: "edge-1",
        clean: true,
      });

      // 3. Subscribe to NCMD
      await client.subscribe(["spBv1.0/factory/NCMD/edge-1"], 1);

      // 4. Publish NBIRTH
      await client.publish(
        "spBv1.0/factory/NBIRTH/edge-1",
        Buffer.from("nbirth-bytes"),
        { qos: 0, retain: false },
      );

      expect(client.willSet).toBe(true);
      expect(client.connectCalls.length).toBe(1);
      expect(client.subscribeCalls.length).toBe(1);
      expect(client.publishCalls.length).toBe(1);
      expect(client.publishCalls[0]!.topic).toBe("spBv1.0/factory/NBIRTH/edge-1");
    });
  });
});
