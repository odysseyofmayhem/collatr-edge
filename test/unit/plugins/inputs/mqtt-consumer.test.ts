// Unit tests: MQTT consumer input plugin
// PRD refs: §6 Plugin System, §19 MVP Plugin Inventory

import { describe, it, expect, beforeEach } from "bun:test";
import {
  MqttConsumerInput,
  MqttConsumerConfigSchema,
  flattenJson,
  extractTopicTags,
  type MqttConsumerConfig,
  type MqttClientInterface,
  type MqttClientOptions,
  type MqttMessageEvent,
} from "@plugins/inputs/mqtt-consumer";
import type { Accumulator } from "@core/accumulator";
import type { FieldValue } from "@core/metric";

// ---------------------------------------------------------------------------
// Mock MQTT client
// ---------------------------------------------------------------------------

class MockMqttClient implements MqttClientInterface {
  private _isConnected = false;
  private messageHandler: ((event: MqttMessageEvent) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private reconnectHandler: (() => void) | null = null;

  // Tracking for assertions
  connectCalls: Array<{ servers: string[]; options: MqttClientOptions }> = [];
  subscribeCalls: Array<{ topics: string[]; qos: number }> = [];
  unsubscribeCalls: string[][] = [];
  disconnected = false;

  // Error injection
  connectError: Error | null = null;
  subscribeError: Error | null = null;

  get isConnected(): boolean { return this._isConnected; }

  connect(servers: string[], options: MqttClientOptions): void {
    this.connectCalls.push({ servers, options });
    // Connection events are triggered explicitly via emitConnect()/emitError()
    // to give tests full control over timing.
  }

  async subscribe(topics: string[], qos: number): Promise<void> {
    this.subscribeCalls.push({ topics, qos });
    if (this.subscribeError) throw this.subscribeError;
  }

  async unsubscribe(topics: string[]): Promise<void> {
    this.unsubscribeCalls.push(topics);
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

  /** Simulate receiving a message from the broker. */
  emitMessage(topic: string, payload: string | Buffer, qos = 0, retain = false): void {
    if (this.messageHandler) {
      const buf = typeof payload === "string" ? Buffer.from(payload) : payload;
      this.messageHandler({ topic, payload: buf, qos, retain });
    }
  }

  /** Simulate a connection event (used to trigger subscribe). */
  emitConnect(): void {
    this._isConnected = true;
    if (this.connectHandler) this.connectHandler();
  }

  /** Simulate an error event. */
  emitError(error: Error): void {
    if (this.errorHandler) this.errorHandler(error);
  }

  /** Simulate a reconnect event. */
  emitReconnect(): void {
    if (this.reconnectHandler) this.reconnectHandler();
  }

  /** Simulate a close event. */
  emitClose(): void {
    this._isConnected = false;
    if (this.closeHandler) this.closeHandler();
  }
}

// ---------------------------------------------------------------------------
// Collecting accumulator (captures metrics for assertions)
// ---------------------------------------------------------------------------

interface CollectedMetric {
  measurement: string;
  fields: Record<string, FieldValue>;
  tags: Record<string, string>;
}

class CollectingAcc implements Accumulator {
  metrics: CollectedMetric[] = [];
  errors: Error[] = [];

  addFields(
    measurement: string,
    fields: Record<string, FieldValue>,
    tags?: Record<string, string>,
  ): void {
    this.metrics.push({ measurement, fields, tags: tags ?? {} });
  }

  addMetric(): void {
    // Not used in this test
  }

  addError(error: Error): void {
    this.errors.push(error);
  }
}

// ---------------------------------------------------------------------------
// Helper: create a default config
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): MqttConsumerConfig {
  return MqttConsumerConfigSchema.parse({
    servers: ["tcp://192.168.10.50:1883"],
    topics: ["sensors/#"],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MQTT Consumer Input Plugin", () => {
  let mockClient: MockMqttClient;
  let acc: CollectingAcc;

  beforeEach(() => {
    mockClient = new MockMqttClient();
    acc = new CollectingAcc();
  });

  // =========================================================================
  // Task spec test 1: Connect to mock broker, subscribe, receive JSON → metric
  // =========================================================================

  it("connect, subscribe, receive JSON message → metric with correct fields", async () => {
    const config = makeConfig({
      topics: ["sensors/temperature"],
      data_format: "json",
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);

    // Simulate broker connect → triggers subscribe
    mockClient.emitConnect();
    await Bun.sleep(10);

    expect(mockClient.subscribeCalls.length).toBe(1);
    expect(mockClient.subscribeCalls[0]!.topics).toEqual(["sensors/temperature"]);
    expect(mockClient.subscribeCalls[0]!.qos).toBe(1); // F-13: default QoS is 1

    // Simulate receiving a JSON message
    mockClient.emitMessage(
      "sensors/temperature",
      JSON.stringify({ temperature: 23.5, humidity: 45.2 }),
    );

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.measurement).toBe("sensors/temperature");
    expect(acc.metrics[0]!.fields.temperature).toBe(23.5);
    expect(acc.metrics[0]!.fields.humidity).toBe(45.2);

    await input.stop();
  });

  // =========================================================================
  // Task spec test 2: JSON payload with multiple fields → single metric
  // =========================================================================

  it("JSON payload with multiple fields → single metric with all fields", async () => {
    const config = makeConfig({ topics: ["machine/status"] });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("machine/status", JSON.stringify({
      rpm: 1485,
      voltage: 230.1,
      running: true,
      status: "normal",
    }));

    expect(acc.metrics.length).toBe(1);
    const m = acc.metrics[0]!;
    expect(m.fields.rpm).toBe(1485);
    expect(m.fields.voltage).toBe(230.1);
    expect(m.fields.running).toBe(true);
    expect(m.fields.status).toBe("normal");

    await input.stop();
  });

  // =========================================================================
  // Task spec test 3: Nested JSON → dot-notation flattened fields
  // =========================================================================

  it("nested JSON → dot-notation flattened fields", async () => {
    const config = makeConfig({ topics: ["data/complex"] });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("data/complex", JSON.stringify({
      sensor: {
        temperature: 25.5,
        location: {
          building: "A",
          floor: 3,
        },
      },
      active: true,
    }));

    expect(acc.metrics.length).toBe(1);
    const fields = acc.metrics[0]!.fields;
    expect(fields["sensor.temperature"]).toBe(25.5);
    expect(fields["sensor.location.building"]).toBe("A");
    expect(fields["sensor.location.floor"]).toBe(3);
    expect(fields["active"]).toBe(true);

    await input.stop();
  });

  // =========================================================================
  // Task spec test 4: Plain string payload → single 'value' field
  // =========================================================================

  it("plain string payload → metric with single 'value' field", async () => {
    const config = makeConfig({
      topics: ["alerts/message"],
      data_format: "value",
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // Non-numeric string → string value
    mockClient.emitMessage("alerts/message", "motor overheating");

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.fields.value).toBe("motor overheating");

    // Numeric string → number value
    mockClient.emitMessage("alerts/message", "42.5");

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[1]!.fields.value).toBe(42.5);

    await input.stop();
  });

  // =========================================================================
  // Task spec test 5: Topic tag extraction
  // =========================================================================

  it("topic tag extraction: topic 'factory/A/line/1' with topic_tags → correct tags", async () => {
    const config = makeConfig({
      topics: ["factory/+/line/+"],
      topic_tag: "topic",
      topic_tags: [
        {
          topic_pattern: "+factory_id/+line_id",
          tags: ["factory_id", "line_id"],
        },
      ],
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage(
      "factory/A/line/1",
      JSON.stringify({ temperature: 22 }),
    );

    // Direct extractTopicTags test (the pattern in config uses unnamed +)
    // For full topic pattern matching:
    const extracted = extractTopicTags("factory/A/line/1", [
      { topic_pattern: "+factory_id/+line_id", tags: ["factory_id", "line_id"] },
    ]);
    expect(extracted).toEqual({});  // 4 segments vs 2 pattern segments → no match

    // Correct pattern with 4 segments:
    const extracted2 = extractTopicTags("factory/A/line/1", [
      { topic_pattern: "factory/+factory_id/line/+line_id", tags: ["factory_id", "line_id"] },
    ]);
    expect(extracted2.factory_id).toBe("A");
    expect(extracted2.line_id).toBe("1");

    await input.stop();
  });

  // =========================================================================
  // Task spec test 6: Wildcard subscription
  // =========================================================================

  it("wildcard subscription: subscribe to 'sensors/#' → receives from sub-topics", async () => {
    const config = makeConfig({
      topics: ["sensors/#"],
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // Simulate messages arriving from different sub-topics (wildcard matched by broker)
    mockClient.emitMessage("sensors/temp/zone1", JSON.stringify({ value: 23.5 }));
    mockClient.emitMessage("sensors/pressure/zone2", JSON.stringify({ value: 101.3 }));
    mockClient.emitMessage("sensors/humidity", JSON.stringify({ value: 65 }));

    expect(acc.metrics.length).toBe(3);

    // Each metric uses the topic as measurement name
    expect(acc.metrics[0]!.measurement).toBe("sensors/temp/zone1");
    expect(acc.metrics[1]!.measurement).toBe("sensors/pressure/zone2");
    expect(acc.metrics[2]!.measurement).toBe("sensors/humidity");

    // Values correct
    expect(acc.metrics[0]!.fields.value).toBe(23.5);
    expect(acc.metrics[1]!.fields.value).toBe(101.3);
    expect(acc.metrics[2]!.fields.value).toBe(65);

    await input.stop();
  });

  // =========================================================================
  // Task spec test 7: QoS 1 — message delivery confirmed
  // =========================================================================

  it("QoS 1: subscription uses configured QoS level", async () => {
    const config = makeConfig({
      topics: ["critical/data"],
      qos: 1,
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    expect(mockClient.subscribeCalls.length).toBe(1);
    expect(mockClient.subscribeCalls[0]!.qos).toBe(1);

    // QoS 1 message received
    mockClient.emitMessage("critical/data", JSON.stringify({ value: 100 }));
    expect(acc.metrics.length).toBe(1);

    await input.stop();
  });

  // =========================================================================
  // Task spec test 8: Reconnection — auto-reconnect → resubscribe
  // =========================================================================

  it("reconnection: broker disconnect → auto-reconnect → resubscribe", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      reconnect: {
        initial_delay: "100ms",
        max_delay: "1s",
        max_retry: 3,
      },
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);

    // First connect
    mockClient.emitConnect();
    await Bun.sleep(10);
    expect(mockClient.subscribeCalls.length).toBe(1);

    // Simulate disconnect
    mockClient.emitClose();

    // Simulate reconnect
    mockClient.emitReconnect();

    // Simulate re-connect event — should trigger re-subscribe
    mockClient.emitConnect();
    await Bun.sleep(10);

    expect(mockClient.subscribeCalls.length).toBe(2);
    expect(mockClient.subscribeCalls[1]!.topics).toEqual(["sensors/temp"]);

    // Verify messages still flow after reconnection
    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 42 }));
    expect(acc.metrics.length).toBe(1);

    await input.stop();
  });

  // =========================================================================
  // Task spec test 9: Connection failure → retry, no crash
  // =========================================================================

  it("connection failure → error reported, no crash", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);

    // Simulate connection error
    mockClient.emitError(new Error("Connection refused: ECONNREFUSED"));

    expect(acc.errors.length).toBe(1);
    expect(acc.errors[0]!.message).toBe("Connection refused: ECONNREFUSED");

    // Plugin should still be alive — subsequent connect should work
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 25 }));
    expect(acc.metrics.length).toBe(1);

    await input.stop();
  });

  // =========================================================================
  // Task spec test 10: Multiple topics
  // =========================================================================

  it("multiple topics: subscribe to 3 topics, metrics from all arrive", async () => {
    const config = makeConfig({
      topics: ["sensors/temp", "sensors/pressure", "sensors/humidity"],
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // Verify all topics subscribed in one call
    expect(mockClient.subscribeCalls.length).toBe(1);
    expect(mockClient.subscribeCalls[0]!.topics).toEqual([
      "sensors/temp", "sensors/pressure", "sensors/humidity",
    ]);

    // Messages from each topic
    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 22.5 }));
    mockClient.emitMessage("sensors/pressure", JSON.stringify({ value: 101.3 }));
    mockClient.emitMessage("sensors/humidity", JSON.stringify({ value: 65 }));

    expect(acc.metrics.length).toBe(3);
    expect(acc.metrics[0]!.measurement).toBe("sensors/temp");
    expect(acc.metrics[1]!.measurement).toBe("sensors/pressure");
    expect(acc.metrics[2]!.measurement).toBe("sensors/humidity");

    await input.stop();
  });

  // =========================================================================
  // Task spec test 11: Measurement name override
  // =========================================================================

  it("measurement name override from config", async () => {
    const config = makeConfig({
      topics: ["sensors/temperature"],
      measurement: "factory_temp",
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("sensors/temperature", JSON.stringify({ value: 23.5 }));

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.measurement).toBe("factory_temp");

    await input.stop();
  });

  // =========================================================================
  // Task spec test 12: Config validation
  // =========================================================================

  it("config validation: missing servers → error, missing topics → error", () => {
    // Missing servers
    expect(() => MqttConsumerConfigSchema.parse({
      topics: ["sensors/#"],
    })).toThrow();

    // Empty servers
    expect(() => MqttConsumerConfigSchema.parse({
      servers: [],
      topics: ["sensors/#"],
    })).toThrow();

    // Missing topics
    expect(() => MqttConsumerConfigSchema.parse({
      servers: ["tcp://localhost:1883"],
    })).toThrow();

    // Empty topics
    expect(() => MqttConsumerConfigSchema.parse({
      servers: ["tcp://localhost:1883"],
      topics: [],
    })).toThrow();

    // Invalid QoS
    expect(() => MqttConsumerConfigSchema.parse({
      servers: ["tcp://localhost:1883"],
      topics: ["sensors/#"],
      qos: 3,
    })).toThrow();

    // Valid config
    const valid = MqttConsumerConfigSchema.parse({
      servers: ["tcp://localhost:1883"],
      topics: ["sensors/#"],
    });
    expect(valid.servers).toEqual(["tcp://localhost:1883"]);
    expect(valid.qos).toBe(1); // F-13: default QoS is 1
    expect(valid.data_format).toBe("json");
    expect(valid.topic_tag).toBe("topic");
  });

  // =========================================================================
  // Additional edge case tests
  // =========================================================================

  it("static tags from config are applied to all metrics", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      tags: { sensor_type: "environmental", location: "factory_a" },
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 22 }));

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.tags.sensor_type).toBe("environmental");
    expect(acc.metrics[0]!.tags.location).toBe("factory_a");

    await input.stop();
  });

  it("topic tag disabled when topic_tag is empty string", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      topic_tag: "",
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 22 }));

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.tags.topic).toBeUndefined();

    await input.stop();
  });

  it("default topic_tag 'topic' adds topic as tag", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 22 }));

    expect(acc.metrics.length).toBe(1);
    expect(acc.metrics[0]!.tags.topic).toBe("sensors/temp");

    await input.stop();
  });

  it("stop() disconnects client and suppresses further messages", async () => {
    const config = makeConfig({ topics: ["sensors/temp"] });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // Message before stop
    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 1 }));
    expect(acc.metrics.length).toBe(1);

    await input.stop();
    expect(mockClient.disconnected).toBe(true);

    // Message after stop — should be suppressed
    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 2 }));
    expect(acc.metrics.length).toBe(1);  // Still 1
  });

  // Phase 10: parse errors now logged at warn level (not error).
  // First error still calls acc.addError() (within verbose limit of 5).
  it("invalid JSON payload → parse error at warn level, no crash", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      data_format: "json",
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // Invalid JSON
    mockClient.emitMessage("sensors/temp", "not valid json {{{");

    expect(acc.metrics.length).toBe(0);  // No metric emitted
    expect(acc.errors.length).toBe(1);   // Error reported

    // Plugin still works — valid message after error
    mockClient.emitMessage("sensors/temp", JSON.stringify({ value: 42 }));
    expect(acc.metrics.length).toBe(1);

    await input.stop();
  });

  it("auth: username/password passed to client options", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      username: "mqtt_user",
      password: "mqtt_pass",
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);

    expect(mockClient.connectCalls.length).toBe(1);
    expect(mockClient.connectCalls[0]!.options.username).toBe("mqtt_user");
    expect(mockClient.connectCalls[0]!.options.password).toBe("mqtt_pass");

    await input.stop();
  });

  it("TLS config passed to client options", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      tls: {
        ca_file: "/path/to/ca.pem",
        cert_file: "/path/to/cert.pem",
        key_file: "/path/to/key.pem",
        insecure_skip_verify: false,
      },
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);

    expect(mockClient.connectCalls.length).toBe(1);
    const opts = mockClient.connectCalls[0]!.options;
    expect(opts.ca).toBe("/path/to/ca.pem");
    expect(opts.cert).toBe("/path/to/cert.pem");
    expect(opts.key).toBe("/path/to/key.pem");
    expect(opts.rejectUnauthorized).toBe(true);

    await input.stop();
  });

  it("reconnect config: all reconnect params passed to client options", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      reconnect: {
        initial_delay: "500ms",
        max_delay: "10s",
        max_retry: 5,
      },
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);

    expect(mockClient.connectCalls.length).toBe(1);
    const opts = mockClient.connectCalls[0]!.options;
    expect(opts.reconnectPeriod).toBe(500);
    expect(opts.maxReconnectDelay).toBe(10_000);
    expect(opts.maxReconnectAttempts).toBe(5);

    await input.stop();
  });

  // =========================================================================
  // F-02: Server failover — full servers list passed to client
  // =========================================================================

  it("server failover: full servers list passed to client", async () => {
    const config = makeConfig({
      servers: ["tcp://broker1:1883", "tcp://broker2:1883", "tcp://broker3:1883"],
      topics: ["sensors/temp"],
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);

    expect(mockClient.connectCalls.length).toBe(1);
    expect(mockClient.connectCalls[0]!.servers).toEqual([
      "tcp://broker1:1883",
      "tcp://broker2:1883",
      "tcp://broker3:1883",
    ]);

    await input.stop();
  });

  // =========================================================================
  // F-05: max_retry limits reconnection attempts
  // =========================================================================

  it("max_retry exceeded: disconnects after limit reached", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      reconnect: {
        initial_delay: "100ms",
        max_delay: "1s",
        max_retry: 2,
      },
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // 2 reconnect attempts within limit
    mockClient.emitReconnect(); // attempt 1
    mockClient.emitReconnect(); // attempt 2
    expect(mockClient.disconnected).toBe(false);

    // 3rd attempt exceeds max_retry of 2 → disconnect called
    mockClient.emitReconnect(); // attempt 3
    await Bun.sleep(10);
    expect(mockClient.disconnected).toBe(true);

    await input.stop();
  });

  it("reconnect attempts reset on successful connect", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      reconnect: {
        initial_delay: "100ms",
        max_delay: "1s",
        max_retry: 2,
      },
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // 2 reconnect attempts (within limit)
    mockClient.emitReconnect();
    mockClient.emitReconnect();
    expect(mockClient.disconnected).toBe(false);

    // Successful re-connect resets the counter
    mockClient.emitConnect();
    await Bun.sleep(10);

    // Can tolerate 2 more reconnect attempts
    mockClient.emitReconnect();
    mockClient.emitReconnect();
    expect(mockClient.disconnected).toBe(false);

    // 3rd exceeds again
    mockClient.emitReconnect();
    await Bun.sleep(10);
    expect(mockClient.disconnected).toBe(true);

    await input.stop();
  });

  it("max_retry=0: unlimited reconnection (never disconnects)", async () => {
    const config = makeConfig({
      topics: ["sensors/temp"],
      reconnect: {
        initial_delay: "100ms",
        max_delay: "1s",
        max_retry: 0,
      },
    });
    const input = new MqttConsumerInput(config, mockClient);

    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    // maxReconnectAttempts should be undefined (unlimited)
    expect(mockClient.connectCalls[0]!.options.maxReconnectAttempts).toBeUndefined();

    // Many reconnects — never disconnects
    for (let i = 0; i < 10; i++) {
      mockClient.emitReconnect();
    }
    expect(mockClient.disconnected).toBe(false);

    await input.stop();
  });

  // =========================================================================
  // Phase 10: data_format = "auto" tests (task 10.3)
  // =========================================================================

  describe("data_format = 'auto'", () => {
    it("valid JSON object → fields extracted via flattenJson", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      mockClient.emitMessage("t", JSON.stringify({ temperature: 23.5, humidity: 45.2 }));

      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.temperature).toBe(23.5);
      expect(acc.metrics[0]!.fields.humidity).toBe(45.2);
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("valid JSON primitive (number) → { value: 42 }", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      mockClient.emitMessage("t", "42");

      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.value).toBe(42);
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("non-JSON string (NMEA sentence) → silent fallback to string value", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      const nmea = "$GNRMC,180045.820,A,4029.09,N,07436.62,W,0.52,360.93,230120,,,A";
      mockClient.emitMessage("t", nmea);

      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.value).toBe(nmea);
      // Silent fallback — no errors reported
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("non-JSON numeric string → falls back to numeric value", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      // "+42" is not valid JSON but Number("+42") = 42
      mockClient.emitMessage("t", "+42");

      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.value).toBe(42);
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("binary payload (non-UTF8 bytes) → falls back to string value", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      // Invalid UTF-8 bytes → \uFFFD replacement characters
      const binaryBuf = Buffer.from([0x48, 0x65, 0x6C, 0x80, 0xFF]);
      mockClient.emitMessage("t", binaryBuf);

      expect(acc.metrics.length).toBe(1);
      expect(typeof acc.metrics[0]!.fields.value).toBe("string");
      expect((acc.metrics[0]!.fields.value as string).includes("\uFFFD")).toBe(true);
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("Infinity payload → falls back to string, not number (Y-1)", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      mockClient.emitMessage("t", "Infinity");
      mockClient.emitMessage("t", "-Infinity");

      expect(acc.metrics.length).toBe(2);
      // Both should be strings, not numbers — Infinity corrupts aggregations
      expect(acc.metrics[0]!.fields.value).toBe("Infinity");
      expect(typeof acc.metrics[0]!.fields.value).toBe("string");
      expect(acc.metrics[1]!.fields.value).toBe("-Infinity");
      expect(typeof acc.metrics[1]!.fields.value).toBe("string");
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("does NOT call acc.addError() on JSON parse failure (silent fallback)", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      // Multiple non-JSON payloads — all should produce metrics, zero errors
      mockClient.emitMessage("t", "not json at all");
      mockClient.emitMessage("t", "{broken");
      mockClient.emitMessage("t", "NMEA $GPGGA sentence");

      expect(acc.metrics.length).toBe(3);
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });
  });

  // =========================================================================
  // Y-1: Infinity/hex rejected in value mode
  // =========================================================================

  it("value mode: Infinity and -Infinity → stored as strings, not numbers (Y-1)", async () => {
    const config = makeConfig({ topics: ["t"], data_format: "value" });
    const input = new MqttConsumerInput(config, mockClient);
    await input.start(acc);
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage("t", "Infinity");
    mockClient.emitMessage("t", "-Infinity");

    expect(acc.metrics.length).toBe(2);
    expect(acc.metrics[0]!.fields.value).toBe("Infinity");
    expect(typeof acc.metrics[0]!.fields.value).toBe("string");
    expect(acc.metrics[1]!.fields.value).toBe("-Infinity");
    expect(typeof acc.metrics[1]!.fields.value).toBe("string");

    await input.stop();
  });

  // =========================================================================
  // Phase 10: data_format = "string" tests (task 10.3)
  // =========================================================================

  describe("data_format = 'string'", () => {
    it("text payload → { value: 'hello' }", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "string" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      mockClient.emitMessage("t", "hello");

      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.value).toBe("hello");

      await input.stop();
    });

    it("numeric text → { value: '123.45' } (no coercion to number)", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "string" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      mockClient.emitMessage("t", "123.45");

      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.value).toBe("123.45");
      expect(typeof acc.metrics[0]!.fields.value).toBe("string");

      await input.stop();
    });

    it("empty string → { value: '' }", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "string" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      mockClient.emitMessage("t", "");

      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.value).toBe("");

      await input.stop();
    });
  });

  // =========================================================================
  // Phase 10: Parse error throttling tests (task 10.3)
  // =========================================================================

  describe("parse error throttling (data_format = 'json')", () => {
    it("first 5 invalid JSON messages → 5 acc.addError() calls", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "json" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      for (let i = 0; i < 5; i++) {
        mockClient.emitMessage("t", `bad json ${i}`);
      }

      expect(acc.errors.length).toBe(5);
      for (const err of acc.errors) {
        expect(err.message).toContain("Payload parse error");
      }

      await input.stop();
    });

    it("6th error triggers summary, 7th-10th silent (between summaries)", async () => {
      const origDateNow = Date.now;
      try {
        let mockTime = 100_000;
        Date.now = () => mockTime;

        const config = makeConfig({ topics: ["t"], data_format: "json" });
        const input = new MqttConsumerInput(config, mockClient);
        await input.start(acc);
        mockClient.emitConnect();
        await Bun.sleep(10);

        // 5 verbose errors
        for (let i = 0; i < 5; i++) {
          mockClient.emitMessage("t", `bad ${i}`);
        }
        expect(acc.errors.length).toBe(5);

        // 6th error: Date.now() - lastParseErrorLogTime(0) = 100000 >= 60000 → summary
        mockClient.emitMessage("t", "bad 5");
        expect(acc.errors.length).toBe(6);
        expect(acc.errors[5]!.message).toContain("total (throttled)");

        // 7th-10th: within 60s of summary → silent
        for (let i = 0; i < 4; i++) {
          mockClient.emitMessage("t", `bad ${7 + i}`);
        }
        expect(acc.errors.length).toBe(6); // Unchanged

        await input.stop();
      } finally {
        Date.now = origDateNow;
      }
    });

    it("after 60s interval → new summary with total count", async () => {
      const origDateNow = Date.now;
      try {
        let mockTime = 100_000;
        Date.now = () => mockTime;

        const config = makeConfig({ topics: ["t"], data_format: "json" });
        const input = new MqttConsumerInput(config, mockClient);
        await input.start(acc);
        mockClient.emitConnect();
        await Bun.sleep(10);

        // 5 verbose + 1 summary = 6 acc.addError() calls
        for (let i = 0; i < 6; i++) {
          mockClient.emitMessage("t", `bad ${i}`);
        }
        expect(acc.errors.length).toBe(6);

        // 4 more silent errors (within 60s)
        for (let i = 0; i < 4; i++) {
          mockClient.emitMessage("t", `bad ${6 + i}`);
        }
        expect(acc.errors.length).toBe(6); // Unchanged

        // Advance time past 60s interval
        mockTime += 61_000;

        // 11th error → triggers new summary
        mockClient.emitMessage("t", "bad 10");
        expect(acc.errors.length).toBe(7);
        expect(acc.errors[6]!.message).toContain("11 total");

        await input.stop();
      } finally {
        Date.now = origDateNow;
      }
    });

    it("valid messages still processed after throttled errors", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "json" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      // Send 10 invalid JSON messages
      for (let i = 0; i < 10; i++) {
        mockClient.emitMessage("t", `bad ${i}`);
      }
      expect(acc.metrics.length).toBe(0);

      // Valid JSON still produces a metric
      mockClient.emitMessage("t", JSON.stringify({ value: 42 }));
      expect(acc.metrics.length).toBe(1);
      expect(acc.metrics[0]!.fields.value).toBe(42);

      await input.stop();
    });

    it("error counter resets on reconnect — fresh verbose errors (Y-2)", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "json" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      // Exhaust verbose limit (5 errors)
      for (let i = 0; i < 5; i++) {
        mockClient.emitMessage("t", `bad ${i}`);
      }
      expect(acc.errors.length).toBe(5);

      // Simulate disconnect + reconnect
      mockClient.emitClose();
      mockClient.emitReconnect();
      mockClient.emitConnect();
      await Bun.sleep(10);

      // After reconnect, counter should be reset — next errors should be verbose again
      acc.errors = [];
      for (let i = 0; i < 3; i++) {
        mockClient.emitMessage("t", `bad after reconnect ${i}`);
      }
      expect(acc.errors.length).toBe(3);
      for (const err of acc.errors) {
        expect(err.message).toContain("Payload parse error");
        // Verbose errors, not throttled summary
        expect(err.message).not.toContain("throttled");
      }

      await input.stop();
    });

    it("error counter is per-instance (two instances have independent counters)", async () => {
      const client1 = new MockMqttClient();
      const client2 = new MockMqttClient();
      const acc1 = new CollectingAcc();
      const acc2 = new CollectingAcc();

      const config1 = makeConfig({ topics: ["t"], data_format: "json" });
      const config2 = makeConfig({ topics: ["t"], data_format: "json" });

      const input1 = new MqttConsumerInput(config1, client1);
      const input2 = new MqttConsumerInput(config2, client2);

      await input1.start(acc1);
      await input2.start(acc2);
      client1.emitConnect();
      client2.emitConnect();
      await Bun.sleep(10);

      // Instance 1: 7 errors (5 verbose + 1 summary + 1 silent)
      for (let i = 0; i < 7; i++) {
        client1.emitMessage("t", `bad ${i}`);
      }

      // Instance 2: 3 errors (all within verbose limit)
      for (let i = 0; i < 3; i++) {
        client2.emitMessage("t", `bad ${i}`);
      }

      // Instance 1: 5 verbose + 1 summary = 6 (7th is silent)
      expect(acc1.errors.length).toBe(6);
      // Instance 2: only 3 verbose (independent counter, still within limit)
      expect(acc2.errors.length).toBe(3);

      await input1.stop();
      await input2.stop();
    });
  });

  // =========================================================================
  // Phase 10: Binary payload handling (task 10.3)
  // =========================================================================

  describe("binary payload handling", () => {
    it("binary in json mode → parse error (binary detected before JSON.parse)", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "json" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      // Buffer with null byte → detected as binary
      const binaryBuf = Buffer.from([0x7B, 0x00, 0x80, 0x7D]);
      mockClient.emitMessage("t", binaryBuf);

      expect(acc.metrics.length).toBe(0);
      expect(acc.errors.length).toBe(1);
      expect(acc.errors[0]!.message).toContain("Binary payload");

      await input.stop();
    });

    it("binary in auto mode → falls back to string value (no error)", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "auto" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      const binaryBuf = Buffer.from([0x48, 0x65, 0x6C, 0x80, 0xFF]);
      mockClient.emitMessage("t", binaryBuf);

      expect(acc.metrics.length).toBe(1);
      expect(typeof acc.metrics[0]!.fields.value).toBe("string");
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("binary in string mode → string value with \\uFFFD replacement chars", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "string" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      const binaryBuf = Buffer.from([0x48, 0x80, 0xFF]);
      mockClient.emitMessage("t", binaryBuf);

      expect(acc.metrics.length).toBe(1);
      const val = acc.metrics[0]!.fields.value as string;
      expect(typeof val).toBe("string");
      expect(val).toContain("\uFFFD");
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });

    it("binary in value mode → string value (Number() returns NaN)", async () => {
      const config = makeConfig({ topics: ["t"], data_format: "value" });
      const input = new MqttConsumerInput(config, mockClient);
      await input.start(acc);
      mockClient.emitConnect();
      await Bun.sleep(10);

      const binaryBuf = Buffer.from([0x80, 0xFF, 0x00]);
      mockClient.emitMessage("t", binaryBuf);

      expect(acc.metrics.length).toBe(1);
      // Number() of string with replacement chars → NaN → falls back to string
      expect(typeof acc.metrics[0]!.fields.value).toBe("string");
      expect(acc.errors.length).toBe(0);

      await input.stop();
    });
  });

  // =========================================================================
  // Phase 10: Config validation for new formats (task 10.3)
  // =========================================================================

  it("config validation: data_format accepts all valid options", () => {
    for (const fmt of ["json", "value", "string", "auto"]) {
      const config = MqttConsumerConfigSchema.parse({
        servers: ["tcp://localhost:1883"],
        topics: ["t"],
        data_format: fmt,
      });
      expect(config.data_format).toBe(fmt);
    }

    // Invalid format rejected
    expect(() => MqttConsumerConfigSchema.parse({
      servers: ["tcp://localhost:1883"],
      topics: ["t"],
      data_format: "csv",
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for flattenJson utility
// ---------------------------------------------------------------------------

describe("flattenJson", () => {
  it("flat object → same keys", () => {
    const result = flattenJson({ a: 1, b: "hello", c: true });
    expect(result).toEqual({ a: 1, b: "hello", c: true });
  });

  it("nested object → dot-notation", () => {
    const result = flattenJson({ x: { y: { z: 42 } } });
    expect(result["x.y.z"]).toBe(42);
  });

  it("array → indexed + length", () => {
    const result = flattenJson({ temps: [20, 21, 22] });
    expect(result["temps[0]"]).toBe(20);
    expect(result["temps[1]"]).toBe(21);
    expect(result["temps[2]"]).toBe(22);
    expect(result["temps.length"]).toBe(3);
  });

  it("null/undefined → empty", () => {
    expect(flattenJson(null)).toEqual({});
    expect(flattenJson(undefined)).toEqual({});
  });

  it("mixed nested + array", () => {
    const result = flattenJson({
      sensor: { readings: [10, 20], name: "temp" },
    });
    expect(result["sensor.readings[0]"]).toBe(10);
    expect(result["sensor.readings[1]"]).toBe(20);
    expect(result["sensor.readings.length"]).toBe(2);
    expect(result["sensor.name"]).toBe("temp");
  });
});

// ---------------------------------------------------------------------------
// Unit tests for extractTopicTags utility
// ---------------------------------------------------------------------------

describe("extractTopicTags", () => {
  it("extracts tags from matching pattern", () => {
    const result = extractTopicTags("factory/A/line/1", [
      { topic_pattern: "factory/+fid/line/+lid", tags: ["factory_id", "line_id"] },
    ]);
    expect(result.factory_id).toBe("A");
    expect(result.line_id).toBe("1");
  });

  it("returns empty for non-matching pattern", () => {
    const result = extractTopicTags("other/topic", [
      { topic_pattern: "factory/+fid/line/+lid", tags: ["factory_id", "line_id"] },
    ]);
    expect(result).toEqual({});
  });

  it("no topic_tags config → empty", () => {
    expect(extractTopicTags("any/topic")).toEqual({});
    expect(extractTopicTags("any/topic", [])).toEqual({});
  });

  it("pattern with # wildcard at end", () => {
    const result = extractTopicTags("factory/A/anything/else", [
      { topic_pattern: "factory/+fid/#", tags: ["factory_id"] },
    ]);
    expect(result.factory_id).toBe("A");
  });
});
