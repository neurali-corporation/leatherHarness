interface ToolEntry {
  name: string;
  description: string;
  parameters: object;
  execute: (args: any) => Promise<string>;
}

const registry = new Map<string, ToolEntry>();

export function registerNativeTool({ name, description, parameters, execute }: {
  name: string;
  description: string;
  parameters: object;
  execute: (args: any) => Promise<string>;
}) {
  const full = `hx__${name}`;
  if (registry.has(full)) throw new Error(`Tool already registered: ${full}`);
  if (typeof execute !== 'function') throw new Error(`execute must be a function: ${full}`);
  registry.set(full, { name: full, description, parameters, execute });
}

export function toolSchemas() {
  return [...registry.values()].map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

export function getTool(name: string) {
  return registry.get(name);
}

export function hasTool(name: string) {
  return registry.has(name);
}

export default {
  registerNativeTool,
  toolSchemas,
  getTool,
  hasTool,
  _registry: registry
};
