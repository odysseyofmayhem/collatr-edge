// Integration test: MQTT consumer input → pipeline → mock output
// PRD refs: §6 Plugin System, §19 MVP Plugin Inventory

import { describe, it, expect } from "bun:test";
import { PipelineRuntime } from "@pipeline/runtime";
import {
  MqttConsumerInput,
  MqttConsumerConfigSchema,
  type MqttClientInterface,
  type MqttClientOptions,
  type MqttMessageEvent,
} from "@plugins/inputs/mqtt-consumer";
import type { Metric } from "@core/metric";
import type { Output } from "@core/plugin-types";

// ---------------------------------------------------------------------------
// Mock MQTT client (minimal for integration — emits messages on demand)
// ---------------------------------------------------------------------------

class MockMqttClient implements MqttClientInterface {
  private _isConnected = false;
  private messageHandler: ((event: MqttMessageEvent) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private reconnectHandler: (() => void) | null = null;

  get isConnected(): boolean { return this._isConnected; }

  connect(_brokerUrl: string, _options: MqttClientOptions): void {
    // Connection events triggered explicitly via emitConnect()
  }
  async subscribe(_topics: string[], _qos: number): Promise<void> {}
  async unsubscribe(_topics: string[]): Promise<void> {}
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
  }

  /** Simulate broker connection established. */
  emitConnect(): void {
    this._isConnected = true;
    if (this.connectHandler) this.connectHandler();
  }

  /** Simulate receiving a message from the broker. */
  emitMessage(topic: string, payload: string): void {
    if (this.messageHandler) {
      this.messageHandler({
        topic,
        payload: Buffer.from(payload),
        qos: 0,
        retain: false,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Mock output (captures metrics for verification)
// ---------------------------------------------------------------------------

class MockOutput implements Output {
  written: Metric[] = [];
  connected = false;
  closed = false;

  async connect(): Promise<void> { this.connected = true; }
  async write(batch: Metric[]): Promise<void> { this.written.push(...batch); }
  async close(): Promise<void> { this.closed = true; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: MQTT consumer → pipeline → output", () => {
  it("MQTT message → pipeline → output: JSON fields preserved", async () => {
    const mockClient = new MockMqttClient();
    const config = MqttConsumerConfigSchema.parse({
      servers: ["tcp://192.168.10.50:1883"],
      topics: ["sensors/env/#"],
      data_format: "json",
    });

    const mqttInput = new MqttConsumerInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mqttInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();

    // Simulate broker connection → triggers subscribe
    mockClient.emitConnect();
    await Bun.sleep(10);

    // Simulate receiving JSON messages from MQTT broker
    mockClient.emitMessage(
      "sensors/env/temperature",
      JSON.stringify({ temperature: 23.5, humidity: 45.2 }),
    );
    mockClient.emitMessage(
      "sensors/env/pressure",
      JSON.stringify({ pressure: 101.3, altitude: 150 }),
    );

    // Wait for flush cycle to deliver metrics to output
    await Bun.sleep(200);
    await pipeline.stop();

    expect(output.connected).toBe(true);
    expect(output.written.length).toBeGreaterThanOrEqual(2);

    const temps = output.written.filter((m) => m.name === "sensors/env/temperature");
    const pressures = output.written.filter((m) => m.name === "sensors/env/pressure");
    expect(temps.length).toBeGreaterThanOrEqual(1);
    expect(pressures.length).toBeGreaterThanOrEqual(1);

    // JSON fields preserved through full pipeline
    expect(temps[0]!.getField("temperature")).toBe(23.5);
    expect(temps[0]!.getField("humidity")).toBe(45.2);
    expect(pressures[0]!.getField("pressure")).toBe(101.3);
    expect(pressures[0]!.getField("altitude")).toBe(150);
  });

  it("topic tags present on output metrics", async () => {
    const mockClient = new MockMqttClient();
    const config = MqttConsumerConfigSchema.parse({
      servers: ["tcp://192.168.10.50:1883"],
      topics: ["factory/+/line/+"],
      data_format: "json",
      topic_tag: "topic",
      topic_tags: [
        {
          topic_pattern: "factory/+fid/line/+lid",
          tags: ["factory_id", "line_id"],
        },
      ],
      tags: { sensor_type: "environmental" },
    });

    const mqttInput = new MqttConsumerInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mqttInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
    });

    await pipeline.start();
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage(
      "factory/A/line/1",
      JSON.stringify({ temperature: 22.5 }),
    );

    await Bun.sleep(200);
    await pipeline.stop();

    expect(output.written.length).toBeGreaterThanOrEqual(1);
    const m = output.written[0]!;

    // Topic tag from topic_tag config
    expect(m.getTag("topic")).toBe("factory/A/line/1");

    // Tags extracted from topic segments via topic_tags
    expect(m.getTag("factory_id")).toBe("A");
    expect(m.getTag("line_id")).toBe("1");

    // Static tags from config
    expect(m.getTag("sensor_type")).toBe("environmental");
  });

  it("global tags applied to MQTT metrics", async () => {
    const mockClient = new MockMqttClient();
    const config = MqttConsumerConfigSchema.parse({
      servers: ["tcp://192.168.10.50:1883"],
      topics: ["sensors/temp"],
      data_format: "json",
    });

    const mqttInput = new MqttConsumerInput(config, mockClient);
    const output = new MockOutput();

    const pipeline = new PipelineRuntime({
      inputs: [{ plugin: mqttInput }],
      processors: [],
      aggregators: [],
      outputs: [{ plugin: output }],
      gatherIntervalMs: 50,
      flushIntervalMs: 50,
      globalTags: { site: "factory_a", line: "3" },
    });

    await pipeline.start();
    mockClient.emitConnect();
    await Bun.sleep(10);

    mockClient.emitMessage(
      "sensors/temp",
      JSON.stringify({ value: 25.0 }),
    );

    await Bun.sleep(200);
    await pipeline.stop();

    expect(output.written.length).toBeGreaterThanOrEqual(1);
    const m = output.written[0]!;

    // Global tags applied by pipeline
    expect(m.getTag("site")).toBe("factory_a");
    expect(m.getTag("line")).toBe("3");

    // MQTT topic tag also present
    expect(m.getTag("topic")).toBe("sensors/temp");
  });
});
