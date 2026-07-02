import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';
import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';

interface HueConfig {
  bridgeIp?: string;
  username?: string;
}

function hueHttp(method: string, ip: string, path: string, body?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: ip, port: 80, path, method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(buf); } });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

const hueGet    = (ip: string, u: string, p: string)             => hueHttp('GET',    ip, `/api/${u}${p}`);
const huePut    = (ip: string, u: string, p: string, b: object)  => hueHttp('PUT',    ip, `/api/${u}${p}`, b);
const huePost   = (ip: string, u: string, p: string, b: object)  => hueHttp('POST',   ip, `/api/${u}${p}`, b);
const hueDelete = (ip: string, u: string, p: string)             => hueHttp('DELETE', ip, `/api/${u}${p}`);

function readDnsName(msg: Buffer, offset: number): { name: string; end: number } {
  const parts: string[] = [];
  let jumped = false, end = -1;
  for (let g = 0; g < 128; g++) {
    if (offset >= msg.length) break;
    const len = msg[offset];
    if (len === 0) { if (!jumped) end = offset + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = offset + 2;
      offset = ((len & 0x3f) << 8) | msg[offset + 1];
      jumped = true; continue;
    }
    offset++;
    parts.push(msg.toString('utf8', offset, offset + len));
    offset += len;
  }
  return { name: parts.join('.'), end: end === -1 ? offset : end };
}

function discoverBridgeIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let found: string | null = null;
    const finish = () => { try { sock.close(); } catch (_) {} resolve(found); };
    sock.on('error', () => finish());
    sock.on('message', (msg) => {
      try {
        if (msg.length < 12) return;
        const qd = msg.readUInt16BE(4);
        const total = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
        let off = 12;
        for (let i = 0; i < qd; i++) { const { end } = readDnsName(msg, off); off = end + 4; }
        const aRecords = new Map<string, string>();
        let hasHue = false;
        for (let i = 0; i < total; i++) {
          if (off + 2 > msg.length) break;
          const { name, end: ne } = readDnsName(msg, off); off = ne;
          if (off + 10 > msg.length) break;
          const type = msg.readUInt16BE(off); off += 2;
          off += 6;
          const rdlen = msg.readUInt16BE(off); off += 2;
          const rds = off;
          if (type === 12) {
            const { name: target } = readDnsName(msg, off);
            if (target.toLowerCase().includes('hue') || name.toLowerCase().includes('hue')) hasHue = true;
          } else if (type === 1 && rdlen === 4) {
            aRecords.set(name, `${msg[off]}.${msg[off+1]}.${msg[off+2]}.${msg[off+3]}`);
          }
          off = rds + rdlen;
        }
        if (hasHue && aRecords.size && !found) found = [...aRecords.values()][0];
      } catch (_) {}
    });
    sock.bind({ port: 5353, address: '0.0.0.0' }, async () => {
      sock.setMulticastTTL(255);
      sock.setMulticastLoopback(true);
      const lanAddrs: string[] = [];
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces ?? []) {
          if (!iface.internal && iface.family === 'IPv4') {
            const prefix = iface.cidr ? parseInt(iface.cidr.split('/')[1], 10) : 32;
            if (prefix < 31) lanAddrs.push(iface.address);
          }
        }
      }
      for (const addr of lanAddrs) { try { sock.addMembership('224.0.0.251', addr); } catch (_) {} }
      const buf = Buffer.alloc(33);
      buf.writeUInt16BE(1, 4);
      let off = 12;
      for (const lbl of ['_hue', '_tcp', 'local']) {
        buf.writeUInt8(lbl.length, off++); buf.write(lbl, off); off += lbl.length;
      }
      buf.writeUInt8(0, off++); buf.writeUInt16BE(12, off); off += 2; buf.writeUInt16BE(1, off);
      const query = buf.slice(0, off + 2);
      for (const addr of (lanAddrs.length ? lanAddrs : [undefined])) {
        await new Promise<void>((res) => {
          try {
            if (addr) sock.setMulticastInterface(addr);
            sock.send(query, 0, query.length, 5353, '224.0.0.251', () => res());
          } catch (_) { res(); }
        });
      }
      setTimeout(finish, 3000);
    });
  });
}

function hexToXy(hex: string): { x: number; y: number; bri: number } | null {
  const h = hex.replace(/^#/, '');
  let r: number, g: number, b: number;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
  } else if (h.length === 6) {
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else return null;
  const lin = (v: number) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.072310 + B * 0.986039;
  const s = X + Y + Z;
  if (s === 0) return { x: 0, y: 0, bri: 0 };
  return { x: X / s, y: Y / s, bri: Math.round(Y * 254) };
}

const CSS_COLOURS: Record<string, string> = {
  red: '#ff0000', green: '#00ff00', blue: '#0000ff', white: '#ffffff',
  yellow: '#ffff00', orange: '#ff8800', purple: '#8800ff', pink: '#ff00aa',
  cyan: '#00ffff', warm: '#ffaa44', cool: '#aaccff', off: '#000000',
};

function parseColour(colour: string): { xy?: [number, number]; bri?: number; ct?: number } | null {
  const lc = colour.toLowerCase().trim();
  if (lc === 'warm white' || lc === 'warm') return { ct: 370, bri: 200 };
  if (lc === 'cool white' || lc === 'cool') return { ct: 200, bri: 220 };
  if (lc === 'daylight')                    return { ct: 156, bri: 254 };
  const hex = CSS_COLOURS[lc] ?? (lc.startsWith('#') ? lc : null);
  if (!hex) return null;
  const xy = hexToXy(hex);
  if (!xy) return null;
  return { xy: [xy.x, xy.y], bri: Math.max(1, xy.bri) };
}

export const defaultConfig: HueConfig = {
  bridgeIp: '',
  username: '',
};

export function setup(cfg: PluginConfig<HueConfig>) {
  async function requireBridge(): Promise<{ bridgeIp: string; username: string } | string> {
    const { bridgeIp, username } = await cfg.get();
    if (!bridgeIp || !username) return 'ERROR: Configure pluginConfig.hue.bridgeIp and run hue_pair first.';
    return { bridgeIp, username };
  }

  registerNativeTool({
    name: 'hue_discover_bridge',
    description: 'Scan the local network via mDNS to find the Philips Hue bridge IP address.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const ip = await discoverBridgeIp();
      if (!ip) return 'No Hue bridge found. Make sure the bridge is on the same network.';
      return `Found Hue bridge at ${ip}. Add "hue": { "bridgeIp": "${ip}" } to pluginConfig in config.json, then call hue_pair.`;
    },
  });

  registerNativeTool({
    name: 'hue_pair',
    description: 'Register with the Hue bridge. Tell the user to press the physical link button on the bridge, then call this tool immediately — it will wait up to 30 seconds for the button press automatically. Saves the API username to config and verifies it works.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      let { bridgeIp } = await cfg.get();
      if (!bridgeIp) {
        bridgeIp = (await discoverBridgeIp()) ?? undefined;
        if (!bridgeIp) return 'ERROR: No bridge IP configured and mDNS discovery found nothing. Set pluginConfig.hue.bridgeIp in config.json.';
      }

      // Poll for up to 30 seconds (15 attempts × 2 s) waiting for button press
      const deadline = Date.now() + 30_000;
      let username: string | undefined;
      let lastError = 'link button not pressed';
      while (Date.now() < deadline) {
        const result = await hueHttp('POST', bridgeIp, '/api', { devicetype: 'leatherHarness#harness' }) as Array<{ success?: { username: string }; error?: { description: string; type?: number } }>;
        if (result[0]?.success?.username) {
          username = result[0].success.username;
          break;
        }
        const err = result[0]?.error;
        if (err && err.type !== 101) {
          // type 101 = link button not pressed; anything else is a hard error
          return `ERROR: ${err.description}`;
        }
        lastError = err?.description ?? 'unknown error';
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!username) return `ERROR: Timed out waiting for bridge button press. ${lastError}`;

      await cfg.set({ username });

      // Verify the username actually works
      try {
        const test = await hueGet(bridgeIp, username, '/lights');
        if (Array.isArray(test) && (test[0] as any)?.error) {
          return `ERROR: Paired but username was rejected by bridge: ${(test[0] as any).error.description}`;
        }
      } catch (_) {}

      return `Paired successfully. Username "${username}" saved to config.json.`;
    },
  });

  registerNativeTool({
    name: 'hue_list_lights',
    description: 'List all Hue lights with their current state (on/off, brightness, colour).',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const lights = await hueGet(conn.bridgeIp, conn.username, '/lights') as Record<string, { name: string; state: { on: boolean; bri?: number; ct?: number; hue?: number; sat?: number; colormode?: string } }>;
      const rows = Object.entries(lights).map(([id, l]) => {
        const s = l.state;
        const col = s.colormode === 'ct' ? `ct:${s.ct}` : s.hue !== undefined ? `hue:${s.hue} sat:${s.sat}` : '';
        return `${id}: ${l.name} — ${s.on ? `ON bri:${s.bri} ${col}` : 'OFF'}`;
      });
      return rows.join('\n') || 'No lights found.';
    },
  });

  registerNativeTool({
    name: 'hue_set_light',
    description: 'Control a single Hue light. Specify light id (from hue_list_lights) and desired state.',
    parameters: {
      type: 'object',
      properties: {
        id:         { type: 'string',  description: 'Light ID from hue_list_lights' },
        on:         { type: 'boolean', description: 'Turn light on (true) or off (false)' },
        brightness: { type: 'number',  description: 'Brightness 1–254' },
        colour:     { type: 'string',  description: 'Colour name (red, blue, warm white, cool white, daylight) or hex #rrggbb' },
        transition: { type: 'number',  description: 'Transition time in tenths of a second (default 4 = 0.4s)' },
      },
      required: ['id'],
    },
    execute: async ({ id, on, brightness, colour, transition }: { id: string; on?: boolean; brightness?: number; colour?: string; transition?: number }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const state: Record<string, unknown> = {};
      if (on !== undefined)         state['on'] = on;
      if (brightness !== undefined) state['bri'] = Math.min(254, Math.max(1, Math.round(brightness)));
      if (colour) {
        const c = parseColour(colour);
        if (!c) return `ERROR: Unrecognised colour "${colour}". Use a name (red, blue, warm white…) or #rrggbb hex.`;
        if (c.xy) state['xy'] = c.xy;
        if (c.ct) state['ct'] = c.ct;
        if (c.bri && brightness === undefined) state['bri'] = c.bri;
      }
      if (transition !== undefined) state['transitiontime'] = transition;
      if (Object.keys(state).length === 0) return 'ERROR: Provide at least one of on, brightness, colour.';
      return JSON.stringify(await huePut(conn.bridgeIp, conn.username, `/lights/${id}/state`, state));
    },
  });

  registerNativeTool({
    name: 'hue_list_rooms',
    description: 'List all rooms/groups with their current state.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const groups = await hueGet(conn.bridgeIp, conn.username, '/groups') as Record<string, { name: string; type: string; action: { on: boolean; bri?: number } }>;
      const rows = Object.entries(groups)
        .filter(([, g]) => g.type === 'Room' || g.type === 'Zone' || g.type === 'LightGroup')
        .map(([id, g]) => `${id}: ${g.name} (${g.type}) — ${g.action.on ? `ON bri:${g.action.bri}` : 'OFF'}`);
      return rows.join('\n') || 'No rooms found.';
    },
  });

  registerNativeTool({
    name: 'hue_set_room',
    description: 'Control all lights in a room/group at once.',
    parameters: {
      type: 'object',
      properties: {
        id:         { type: 'string',  description: 'Room/group ID from hue_list_rooms' },
        on:         { type: 'boolean', description: 'Turn all lights on or off' },
        brightness: { type: 'number',  description: 'Brightness 1–254' },
        colour:     { type: 'string',  description: 'Colour name or #rrggbb hex' },
        transition: { type: 'number',  description: 'Transition time in tenths of a second' },
      },
      required: ['id'],
    },
    execute: async ({ id, on, brightness, colour, transition }: { id: string; on?: boolean; brightness?: number; colour?: string; transition?: number }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const action: Record<string, unknown> = {};
      if (on !== undefined)         action['on'] = on;
      if (brightness !== undefined) action['bri'] = Math.min(254, Math.max(1, Math.round(brightness)));
      if (colour) {
        const c = parseColour(colour);
        if (!c) return `ERROR: Unrecognised colour "${colour}".`;
        if (c.xy) action['xy'] = c.xy;
        if (c.ct) action['ct'] = c.ct;
        if (c.bri && brightness === undefined) action['bri'] = c.bri;
      }
      if (transition !== undefined) action['transitiontime'] = transition;
      if (Object.keys(action).length === 0) return 'ERROR: Provide at least one of on, brightness, colour.';
      return JSON.stringify(await huePut(conn.bridgeIp, conn.username, `/groups/${id}/action`, action));
    },
  });

  registerNativeTool({
    name: 'hue_list_scenes',
    description: 'List all saved scenes. Each scene can be activated in a room.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const scenes = await hueGet(conn.bridgeIp, conn.username, '/scenes') as Record<string, { name: string; group?: string }>;
      const rows = Object.entries(scenes).map(([id, s]) => `${id}: "${s.name}" group:${s.group ?? 'n/a'}`);
      return rows.join('\n') || 'No scenes found.';
    },
  });

  registerNativeTool({
    name: 'hue_activate_scene',
    description: 'Activate a scene in a room/group.',
    parameters: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Scene ID from hue_list_scenes' },
        groupId: { type: 'string', description: 'Room/group ID from hue_list_rooms' },
      },
      required: ['sceneId', 'groupId'],
    },
    execute: async ({ sceneId, groupId }: { sceneId: string; groupId: string }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      return JSON.stringify(await huePut(conn.bridgeIp, conn.username, `/groups/${groupId}/action`, { scene: sceneId }));
    },
  });

  registerNativeTool({
    name: 'hue_create_scene',
    description: 'Create a new scene. Pass a name, the light IDs to include, and optionally a group ID to associate it with a room. If storeCurrent is true the bridge snapshots the lights\' current state into the scene.',
    parameters: {
      type: 'object',
      properties: {
        name:         { type: 'string',  description: 'Scene name' },
        lightIds:     { type: 'array', items: { type: 'string' }, description: 'Light IDs to include (from hue_list_lights)' },
        groupId:      { type: 'string',  description: 'Optional room/group ID to associate the scene with' },
        storeCurrent: { type: 'boolean', description: 'Snapshot the lights\' current state into the scene (default true)' },
      },
      required: ['name', 'lightIds'],
    },
    execute: async ({ name, lightIds, groupId, storeCurrent = true }: { name: string; lightIds: string[]; groupId?: string; storeCurrent?: boolean }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const body: Record<string, unknown> = { name, lights: lightIds, recycle: false };
      if (groupId) body['group'] = groupId;
      const created = await huePost(conn.bridgeIp, conn.username, '/scenes', body) as Array<{ success?: { id: string }; error?: { description: string } }>;
      if (created[0]?.error) return `ERROR: ${created[0].error.description}`;
      const sceneId = created[0]?.success?.id;
      if (!sceneId) return `Unexpected response: ${JSON.stringify(created)}`;
      if (storeCurrent) await huePut(conn.bridgeIp, conn.username, `/scenes/${sceneId}`, { storelightstate: true });
      return `Scene created with id "${sceneId}"${storeCurrent ? ' (current light states stored)' : ''}.`;
    },
  });

  registerNativeTool({
    name: 'hue_update_scene',
    description: 'Rename a scene, change which lights belong to it, or snapshot the current light states into it.',
    parameters: {
      type: 'object',
      properties: {
        sceneId:      { type: 'string', description: 'Scene ID from hue_list_scenes' },
        name:         { type: 'string', description: 'New name for the scene' },
        lightIds:     { type: 'array', items: { type: 'string' }, description: 'Replacement list of light IDs' },
        storeCurrent: { type: 'boolean', description: 'Snapshot current light states into the scene' },
      },
      required: ['sceneId'],
    },
    execute: async ({ sceneId, name, lightIds, storeCurrent }: { sceneId: string; name?: string; lightIds?: string[]; storeCurrent?: boolean }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const body: Record<string, unknown> = {};
      if (name)         body['name']            = name;
      if (lightIds)     body['lights']          = lightIds;
      if (storeCurrent) body['storelightstate'] = true;
      if (Object.keys(body).length === 0) return 'ERROR: Provide at least one of name, lightIds, or storeCurrent.';
      return JSON.stringify(await huePut(conn.bridgeIp, conn.username, `/scenes/${sceneId}`, body));
    },
  });

  registerNativeTool({
    name: 'hue_set_scene_light',
    description: 'Program the state of one light inside a scene. Does not change the live light state.',
    parameters: {
      type: 'object',
      properties: {
        sceneId:    { type: 'string',  description: 'Scene ID' },
        lightId:    { type: 'string',  description: 'Light ID' },
        on:         { type: 'boolean', description: 'Light on or off in this scene' },
        brightness: { type: 'number',  description: 'Brightness 1–254' },
        colour:     { type: 'string',  description: 'Colour name or #rrggbb hex' },
      },
      required: ['sceneId', 'lightId'],
    },
    execute: async ({ sceneId, lightId, on, brightness, colour }: { sceneId: string; lightId: string; on?: boolean; brightness?: number; colour?: string }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const state: Record<string, unknown> = {};
      if (on !== undefined)         state['on']  = on;
      if (brightness !== undefined) state['bri'] = Math.min(254, Math.max(1, Math.round(brightness)));
      if (colour) {
        const c = parseColour(colour);
        if (!c) return `ERROR: Unrecognised colour "${colour}".`;
        if (c.xy) state['xy'] = c.xy;
        if (c.ct) state['ct'] = c.ct;
        if (c.bri && brightness === undefined) state['bri'] = c.bri;
      }
      if (Object.keys(state).length === 0) return 'ERROR: Provide at least one of on, brightness, colour.';
      return JSON.stringify(await huePut(conn.bridgeIp, conn.username, `/scenes/${sceneId}/lightstates/${lightId}`, state));
    },
  });

  registerNativeTool({
    name: 'hue_delete_scene',
    description: 'Permanently delete a scene.',
    parameters: {
      type: 'object',
      properties: { sceneId: { type: 'string', description: 'Scene ID from hue_list_scenes' } },
      required: ['sceneId'],
    },
    execute: async ({ sceneId }: { sceneId: string }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      return JSON.stringify(await hueDelete(conn.bridgeIp, conn.username, `/scenes/${sceneId}`));
    },
  });

  registerNativeTool({
    name: 'hue_create_room',
    description: 'Create a new room (group) and assign lights to it.',
    parameters: {
      type: 'object',
      properties: {
        name:     { type: 'string', description: 'Room name' },
        lightIds: { type: 'array', items: { type: 'string' }, description: 'Light IDs to put in this room' },
        class:    { type: 'string', description: 'Room class, e.g. "Living room", "Bedroom", "Kitchen", "Office", "Bathroom", "Hallway", "Garage", "Other"' },
      },
      required: ['name', 'lightIds'],
    },
    execute: async ({ name, lightIds, class: roomClass }: { name: string; lightIds: string[]; class?: string }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const result = await huePost(conn.bridgeIp, conn.username, '/groups', { name, lights: lightIds, type: 'Room', class: roomClass ?? 'Other' }) as Array<{ success?: { id: string }; error?: { description: string } }>;
      if (result[0]?.error) return `ERROR: ${result[0].error.description}`;
      return `Room created with id "${result[0]?.success?.id}".`;
    },
  });

  registerNativeTool({
    name: 'hue_update_room',
    description: 'Rename a room, change which lights it contains, or change its class (type).',
    parameters: {
      type: 'object',
      properties: {
        id:       { type: 'string', description: 'Room/group ID from hue_list_rooms' },
        name:     { type: 'string', description: 'New name' },
        lightIds: { type: 'array', items: { type: 'string' }, description: 'Replacement list of light IDs' },
        class:    { type: 'string', description: 'New room class, e.g. "Living room", "Bedroom", "Kitchen"' },
      },
      required: ['id'],
    },
    execute: async ({ id, name, lightIds, class: roomClass }: { id: string; name?: string; lightIds?: string[]; class?: string }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      const body: Record<string, unknown> = {};
      if (name)      body['name']   = name;
      if (lightIds)  body['lights'] = lightIds;
      if (roomClass) body['class']  = roomClass;
      if (Object.keys(body).length === 0) return 'ERROR: Provide at least one of name, lightIds, or class.';
      return JSON.stringify(await huePut(conn.bridgeIp, conn.username, `/groups/${id}`, body));
    },
  });

  registerNativeTool({
    name: 'hue_delete_room',
    description: 'Permanently delete a room/group. Lights are not deleted, only the group.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Room/group ID from hue_list_rooms' } },
      required: ['id'],
    },
    execute: async ({ id }: { id: string }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      return JSON.stringify(await hueDelete(conn.bridgeIp, conn.username, `/groups/${id}`));
    },
  });

  registerNativeTool({
    name: 'hue_rename_light',
    description: 'Rename a light.',
    parameters: {
      type: 'object',
      properties: {
        id:   { type: 'string', description: 'Light ID from hue_list_lights' },
        name: { type: 'string', description: 'New name for the light' },
      },
      required: ['id', 'name'],
    },
    execute: async ({ id, name }: { id: string; name: string }) => {
      const conn = await requireBridge();
      if (typeof conn === 'string') return conn;
      return JSON.stringify(await huePut(conn.bridgeIp, conn.username, `/lights/${id}`, { name }));
    },
  });
}
