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
  connectCalls: Array<{ brokerUrl: string; options: MqttClientOptions }> = [];
  subscribeCalls: Array<{ topics: string[]; qos: number }> = [];
  unsubscribeCalls: string[][] = [];
  disconnected = false;

  // Error injection
  connectError: Error | null = null;
  subscribeError: Error | null = null;

  get isConnected(): boolean { return this._isConnected; }

  connect(brokerUrl: string, options: MqttClientOptions): void {
    this.connectCalls.push({ brokerUrl, options });
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
    expect(mockClient.subscribeCalls[0]!.qos).toBe(0);

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
    expect(valid.qos).toBe(0);
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

  it("invalid JSON payload → error logged, no crash", async () => {
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

  it("reconnect config: initial_delay passed as reconnectPeriod", async () => {
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
    expect(mockClient.connectCalls[0]!.options.reconnectPeriod).toBe(500);

    await input.stop();
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
