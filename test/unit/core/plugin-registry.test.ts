import { describe, it, expect } from "bun:test";
import { PluginRegistry } from "@core/plugin-registry";
import type { Accumulator } from "@core/accumulator";
import type { Input, Processor } from "@core/plugin-types";

// Mock input plugin for testing
class MockInput implements Input {
  gatherCount = 0;
  async gather(acc: Accumulator): Promise<void> {
    this.gatherCount++;
    acc.addFields("mock", { value: 1 });
  }
}

// Mock processor plugin for testing
class MockProcessor implements Processor {
  async process(): Promise<void> {
    // no-op
  }
}

describe("PluginRegistry", () => {
  it("register a mock input plugin, retrieve by name", () => {
    const registry = new PluginRegistry();

    registry.registerPlugin(
      { name: "mock-input", type: "input", description: "A mock input for testing" },
      () => new MockInput(),
    );

    const entry = registry.getPlugin("mock-input");
    expect(entry).toBeDefined();
    expect(entry!.metadata.name).toBe("mock-input");
    expect(entry!.metadata.type).toBe("input");
    expect(entry!.metadata.description).toBe("A mock input for testing");

    const instance = entry!.factory() as MockInput;
    expect(instance).toBeInstanceOf(MockInput);
  });

  it("register multiple plugins, listPlugins returns all", () => {
    const registry = new PluginRegistry();

    registry.registerPlugin(
      { name: "modbus", type: "input", description: "Modbus TCP input" },
      () => new MockInput(),
    );
    registry.registerPlugin(
      { name: "rename", type: "processor", description: "Rename fields" },
      () => new MockProcessor(),
    );
    registry.registerPlugin(
      { name: "opcua", type: "input", description: "OPC-UA input" },
      () => new MockInput(),
    );

    const all = registry.listPlugins();
    expect(all.length).toBe(3);

    const names = all.map((p) => p.metadata.name).sort();
    expect(names).toEqual(["modbus", "opcua", "rename"]);
  });

  it("getPlugin() returns undefined for unregistered name", () => {
    const registry = new PluginRegistry();

    expect(registry.getPlugin("nonexistent")).toBeUndefined();
    expect(registry.getPlugin("")).toBeUndefined();
  });

  it("factory creates new instance each call (not singleton)", () => {
    const registry = new PluginRegistry();

    registry.registerPlugin(
      { name: "mock-input", type: "input", description: "Mock" },
      () => new MockInput(),
    );

    const entry = registry.getPlugin("mock-input")!;

    const instance1 = entry.factory() as MockInput;
    const instance2 = entry.factory() as MockInput;

    // Different object references
    expect(instance1).not.toBe(instance2);

    // Independent state — mutating one doesn't affect the other
    instance1.gatherCount = 42;
    expect(instance2.gatherCount).toBe(0);
  });

  it("register same name twice throws error", () => {
    const registry = new PluginRegistry();

    registry.registerPlugin(
      { name: "modbus", type: "input", description: "First" },
      () => new MockInput(),
    );

    expect(() =>
      registry.registerPlugin(
        { name: "modbus", type: "input", description: "Second" },
        () => new MockInput(),
      ),
    ).toThrow('Plugin "modbus" is already registered');
  });
});
