// CollatrEdge — Plugin registry
// PRD refs: §6 Plugin System

import type { PluginType } from "./plugin-types";

export interface PluginMetadata {
  name: string;
  type: PluginType;
  description: string;
}

export interface PluginRegistration<T = unknown> {
  metadata: PluginMetadata;
  factory: () => T;
}

// Design decision: Registry uses plugin name (not type/name) as key. This means
// an input named "filter" and a processor named "filter" would collide. The PRD §6
// BUILTIN_PLUGINS table uses type/name keys (e.g., "input/modbus"), but that's
// the lazy-loading map, not the registry. For Phase 1 where plugins are directly
// instantiated from config, name-only keys enforce global uniqueness — simpler and
// sufficient. If Phase 2+ needs type-scoped naming, switch key to `${type}/${name}`.
export class PluginRegistry {
  private plugins = new Map<string, PluginRegistration>();

  registerPlugin<T>(metadata: PluginMetadata, factory: () => T): void {
    if (this.plugins.has(metadata.name)) {
      throw new Error(
        `Plugin "${metadata.name}" is already registered`,
      );
    }
    this.plugins.set(metadata.name, { metadata, factory });
  }

  getPlugin(name: string): PluginRegistration | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): PluginRegistration[] {
    return Array.from(this.plugins.values());
  }
}
