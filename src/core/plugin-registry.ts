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
