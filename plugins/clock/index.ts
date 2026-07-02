import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';

export const defaultConfig = {};

export function setup(_cfg: PluginConfig) {
  registerNativeTool({
    name: 'clock',
    description: 'Current date and time in ISO format',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => new Date().toISOString(),
  });
}
