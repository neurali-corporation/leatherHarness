import { registerNativeTool } from './registry.ts';

export async function loadMcpServers(servers: Record<string, unknown>) {
  if (!servers || typeof servers !== 'object') return;
  for (const [name, spec] of Object.entries(servers)) {
    const toolName = `${name}_info`;
    registerNativeTool({
      name: toolName,
      description: `Dummy MCP tool for ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => JSON.stringify(spec),
    });
  }
}
