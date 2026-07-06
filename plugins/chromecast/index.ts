import { registerNativeTool } from '../../src/registry.ts';
import type { PluginConfig } from '../../src/plugin-loader.ts';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { stat, mkdir, rm } from 'node:fs/promises';
import { resolve as resolvePath, extname } from 'node:path';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import tls from 'node:tls';
import os from 'node:os';

interface ChromecastConfig {
  allowedDirs: string[];
}

export const defaultConfig: ChromecastConfig = {
  allowedDirs: ['/path/to/your/media'],
};

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
};

// Video containers → remux/transcode to fragmented MP4 (video + audio)
const TRANSCODE_VIDEO = new Set(['.mkv', '.avi', '.mov', '.ts']);
// Audio formats the Default Media Receiver can't play → transcode to MP3
const TRANSCODE_AUDIO = new Set(['.flac']);

function fetchFriendlyName(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}:8008/setup/eureka_info`, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve((JSON.parse(data) as { name?: string }).name ?? null); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function createMdnsQuery(): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeUInt16BE(1, 4);
  let off = 12;
  for (const label of ['_googlecast', '_tcp', 'local']) {
    buf.writeUInt8(label.length, off++);
    buf.write(label, off);
    off += label.length;
  }
  buf.writeUInt8(0, off++);
  buf.writeUInt16BE(12, off); off += 2;
  buf.writeUInt16BE(1, off);
  return buf;
}

function readDnsName(msg: Buffer, offset: number): { name: string; end: number } {
  const parts: string[] = [];
  let jumped = false;
  let end = -1;
  for (let guard = 0; guard < 128; guard++) {
    if (offset >= msg.length) break;
    const len = msg[offset];
    if (len === 0) { if (!jumped) end = offset + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = offset + 2;
      offset = ((len & 0x3f) << 8) | msg[offset + 1];
      jumped = true;
      continue;
    }
    offset++;
    parts.push(msg.toString('utf8', offset, offset + len));
    offset += len;
  }
  return { name: parts.join('.'), end: end === -1 ? offset : end };
}

function parseMdnsResponse(msg: Buffer): { name: string; address: string }[] {
  if (msg.length < 12) return [];
  const qdcount = msg.readUInt16BE(4);
  const total = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    if (offset >= msg.length) return [];
    const { end } = readDnsName(msg, offset);
    offset = end + 4;
  }
  const ptrRecords: string[] = [];
  const srvTargets = new Map<string, string>();
  const aRecords = new Map<string, string>();
  for (let i = 0; i < total; i++) {
    if (offset + 2 > msg.length) break;
    const { name, end: nameEnd } = readDnsName(msg, offset);
    offset = nameEnd;
    if (offset + 10 > msg.length) break;
    const type = msg.readUInt16BE(offset); offset += 2;
    offset += 6;
    const rdlen = msg.readUInt16BE(offset); offset += 2;
    const rds = offset;
    if (type === 12 && rdlen > 0) {
      const { name: target } = readDnsName(msg, offset);
      if (target.endsWith('._googlecast._tcp.local')) ptrRecords.push(target);
    } else if (type === 33 && rdlen > 6) {
      const { name: target } = readDnsName(msg, offset + 6);
      srvTargets.set(name, target);
    } else if (type === 1 && rdlen === 4) {
      aRecords.set(name, `${msg[offset]}.${msg[offset+1]}.${msg[offset+2]}.${msg[offset+3]}`);
    }
    offset = rds + rdlen;
  }
  return ptrRecords.map((instance) => {
    const hn = srvTargets.get(instance) ?? '';
    const ip = (hn && aRecords.get(hn)) ?? aRecords.get(instance) ?? [...aRecords.values()][0] ?? '';
    return { name: instance, address: ip };
  });
}

function localIpFor(targetIp: string): string {
  const tParts = targetIp.split('.').map(Number);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal && iface.family === 'IPv4' && iface.cidr) {
        const prefix = parseInt(iface.cidr.split('/')[1], 10);
        if (prefix >= 31) continue;
        const lParts = iface.address.split('.').map(Number);
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        const lNet = (lParts[0] << 24 | lParts[1] << 16 | lParts[2] << 8 | lParts[3]) & mask;
        const tNet = (tParts[0] << 24 | tParts[1] << 16 | tParts[2] << 8 | tParts[3]) & mask;
        if ((lNet >>> 0) === (tNet >>> 0)) return iface.address;
      }
    }
  }
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (!iface.internal && iface.family === 'IPv4') {
        const prefix = parseInt((iface.cidr ?? '/32').split('/')[1], 10);
        if (prefix < 31) return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const TEXT_SUB_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text']);

interface VideoStreams {
  videoCodec: string;
  audioIndex: number;
  subtitleIndex: number | null;
  subtitleCodec: string | null;
}

interface AudioTrack {
  index: number;          // absolute ffmpeg stream index (use as 0:index)
  language: string;
  codec: string;
  channels: number;
  channelLayout: string;
  title: string | null;
  isDefault: boolean;
}

function describeAudioTrack(t: AudioTrack): string {
  const parts = [`#${t.index}`, t.language, t.codec];
  if (t.channelLayout) parts.push(t.channelLayout);
  else if (t.channels) parts.push(`${t.channels}ch`);
  if (t.title) parts.push(`"${t.title}"`);
  if (t.isDefault) parts.push('(default)');
  return parts.join(' ');
}

async function probeAudioTracks(filePath: string): Promise<AudioTrack[]> {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ff.stdout.on('data', (d: Buffer) => { out += d; });
    ff.on('error', () => resolve([]));
    ff.on('close', () => {
      try {
        const streams: any[] = (JSON.parse(out) as any).streams ?? [];
        const tracks = streams
          .filter((s) => s.codec_type === 'audio')
          .map((s) => ({
            index: s.index,
            language: s.tags?.language ?? 'und',
            codec: s.codec_name ?? '?',
            channels: s.channels ?? 0,
            channelLayout: s.channel_layout ?? '',
            title: s.tags?.title ?? null,
            isDefault: s.disposition?.default === 1,
          }));
        console.log(`[chromecast] probe audio: ${tracks.map(describeAudioTrack).join(' | ') || 'none'}`);
        resolve(tracks);
      } catch {
        resolve([]);
      }
    });
  });
}

async function probeVideoStreams(filePath: string): Promise<VideoStreams> {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ff.stdout.on('data', (d: Buffer) => { out += d; });
    ff.on('error', () => resolve({ videoCodec: 'h264', audioIndex: 1, subtitleIndex: null, subtitleCodec: null }));
    ff.on('close', () => {
      try {
        const streams: any[] = (JSON.parse(out) as any).streams ?? [];
        const isEng = (s: any) => s.tags?.language === 'eng' || s.tags?.language === 'en';

        const videoStream  = streams.find(s => s.codec_type === 'video');
        const audioStreams = streams.filter(s => s.codec_type === 'audio');
        const audio = audioStreams.find(isEng) ?? audioStreams[0];

        const subStreams = streams.filter(s => s.codec_type === 'subtitle' && TEXT_SUB_CODECS.has(s.codec_name));
        const sub = subStreams.find(isEng) ?? null;

        const videoCodec = videoStream?.codec_name ?? 'h264';
        console.log(`[chromecast] probe: video=${videoCodec} audio=${audio?.index}(${audio?.tags?.language ?? '?'}) sub=${sub?.index ?? 'none'}(${sub?.codec_name ?? '-'})`);
        resolve({
          videoCodec,
          audioIndex:    audio?.index ?? 1,
          subtitleIndex: sub?.index   ?? null,
          subtitleCodec: sub?.codec_name ?? null,
        });
      } catch {
        resolve({ videoCodec: 'h264', audioIndex: 1, subtitleIndex: null, subtitleCodec: null });
      }
    });
  });
}

async function extractSubtitles(filePath: string, streamIndex: number): Promise<string | null> {
  const tmp = `/tmp/cast_sub_${Date.now()}.vtt`;
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', filePath,
      '-map', `0:${streamIndex}`,
      '-y', tmp,
    ], { stdio: 'ignore' });
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => resolve(code === 0 ? tmp : null));
  });
}

const NATIVE_VIDEO = new Set(['.mp4', '.m4v', '.webm']);

async function startMediaServer(
  filePath: string,
  localIp: string,
  audioIndex?: number,
): Promise<{ url: string; subtitleUrl: string | null; contentType: string; needsTranscode: boolean; close: () => void }> {
  const ext = extname(filePath).toLowerCase();
  let transcodeVideo = TRANSCODE_VIDEO.has(ext);
  const transcodeAudio = TRANSCODE_AUDIO.has(ext);

  // Selecting a specific audio track for a natively-played video container requires us to
  // remux/transcode so we can map the chosen track — the Default Media Receiver always plays
  // the file's default track otherwise.
  if (audioIndex !== undefined && !transcodeVideo && NATIVE_VIDEO.has(ext)) {
    console.log(`[chromecast] audio track ${audioIndex} requested for ${ext} → forcing HLS transcode`);
    transcodeVideo = true;
  }

  const needsTranscode = transcodeVideo || transcodeAudio;

  if (transcodeVideo) console.log(`[chromecast] ${ext} → HLS transcode via ffmpeg`);
  if (transcodeAudio) console.log(`[chromecast] ${ext} → transcoding to MP3 via ffmpeg`);

  // Probe video for codec and default audio track
  let videoStreams: VideoStreams | null = null;
  if (transcodeVideo) {
    videoStreams = await probeVideoStreams(filePath);
  }

  const fileStat = await stat(filePath);
  const total = fileStat.size;

  // For video: run ffmpeg writing HLS segments to a temp directory, wait for the first segment
  // before starting the HTTP server. HLS is natively supported by the Chromecast and avoids all
  // the fragmented-MP4 MSE SourceBuffer issues we hit with frag_keyframe+dash.
  let tmpHlsDir: string | null = null;
  let hlsM3u8: string | null = null;
  let hlsFf: ReturnType<typeof spawn> | null = null;

  if (transcodeVideo) {
    tmpHlsDir = `/tmp/cast_hls_${Date.now()}`;
    await mkdir(tmpHlsDir, { recursive: true });
    hlsM3u8 = `${tmpHlsDir}/index.m3u8`;

    const audioIdx = audioIndex ?? videoStreams?.audioIndex ?? 1;
    console.log(`[chromecast] mapping audio stream 0:${audioIdx}${audioIndex !== undefined ? ' (user-selected)' : ' (auto)'}`);
    const hlsArgs = [
      '-loglevel', 'warning',
      '-probesize', '100M', '-analyzeduration', '10M',
      '-i', filePath,
      '-map', '0:v:0', '-map', `0:${audioIdx}`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
      '-g', '48', '-sc_threshold', '0',
      // Chromecast Default Media Receiver only supports stereo AAC — downmix 5.1 to stereo,
      // otherwise multichannel AAC is rejected with error 104 (MEDIA_SRC_NOT_SUPPORTED).
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_segment_filename', `${tmpHlsDir}/seg%05d.ts`,
      hlsM3u8,
    ];
    console.log(`[chromecast] HLS ffmpeg: ${hlsArgs.join(' ')}`);
    hlsFf = spawn('ffmpeg', hlsArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    hlsFf.stderr.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim();
        if (t) console.log(`[chromecast:ffmpeg] ${t}`);
      }
    });
    hlsFf.on('close', (code) => console.log(`[chromecast] ffmpeg exited ${code}`));

    // Log each new segment as it appears
    let lastSeg = -1;
    const segMonitor = setInterval(() => {
      for (let i = lastSeg + 1; i < lastSeg + 20; i++) {
        const name = `seg${String(i).padStart(5, '0')}.ts`;
        try { statSync(`${tmpHlsDir}/${name}`); console.log(`[chromecast] segment ready: ${name}`); lastSeg = i; }
        catch { break; }
      }
    }, 500);
    hlsFf.on('close', () => clearInterval(segMonitor));

    // Wait for 2 segments before the Chromecast connects
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const check = setInterval(() => {
        try { statSync(`${tmpHlsDir}/seg00001.ts`); clearInterval(check); console.log('[chromecast] HLS 2 segments ready'); resolve(); }
        catch { if (Date.now() - started > 60000) { clearInterval(check); reject(new Error('HLS: second segment not ready after 60s')); } }
      }, 200);
      hlsFf!.on('close', (code) => { clearInterval(check); if (code) reject(new Error(`ffmpeg exited ${code} before segments were ready`)); });
    });
  }

  const contentType = transcodeVideo ? 'application/x-mpegURL'
    : transcodeAudio ? 'audio/mpeg'
    : (MIME[ext] ?? 'application/octet-stream');

  console.log(`[chromecast] media server: file="${filePath}" size=${total} contentType=${contentType}`);

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
  };

  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    const filename = urlPath.replace(/^\//, '');
    console.log(`[chromecast] HTTP ${req.method} ${urlPath} range=${req.headers['range'] ?? 'none'}`);

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    // HLS playlist
    if (filename.endsWith('.m3u8') && hlsM3u8) {
      try {
        const content = readFileSync(hlsM3u8, 'utf8');
        console.log(`[chromecast] m3u8 content:\n${content}`);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/x-mpegURL', 'Cache-Control': 'no-cache' });
        res.end(content);
      } catch (e) { console.error(`[chromecast] m3u8 read error: ${e}`); res.writeHead(404); res.end(); }
      return;
    }

    // HLS segments
    if (filename.endsWith('.ts') && tmpHlsDir) {
      const segPath = `${tmpHlsDir}/${filename}`;
      try {
        const segStat = statSync(segPath);
        console.log(`[chromecast] serving segment ${filename} size=${segStat.size}`);
        res.writeHead(200, { ...cors, 'Content-Type': 'video/mp2t', 'Content-Length': String(segStat.size) });
        createReadStream(segPath).pipe(res);
      } catch {
        console.error(`[chromecast] 404 segment not found: ${filename} (available: ${tmpHlsDir ? require('fs').readdirSync(tmpHlsDir).filter((f: string) => f.endsWith('.ts')).join(', ') : 'n/a'})`);
        res.writeHead(404); res.end();
      }
      return;
    }

    // Audio transcode (FLAC → MP3)
    if (transcodeAudio) {
      res.writeHead(200, { ...cors, 'Content-Type': contentType });
      const ffArgs = [
        '-loglevel', 'warning', '-probesize', '100M', '-analyzeduration', '10M',
        ...(ext === '.flac' ? ['-f', 'flac'] : []),
        '-i', filePath, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', 'pipe:1',
      ];
      console.log(`[chromecast] ffmpeg: ${ffArgs.join(' ')}`);
      const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      ff.stderr.on('data', (d: Buffer) => console.error(`[chromecast] ffmpeg: ${d.toString().trimEnd()}`));
      ff.stdout.pipe(res);
      ff.on('error', (e) => { console.error(`[chromecast] ffmpeg spawn error: ${e.message}`); res.destroy(); });
      ff.on('close', (code) => console.log(`[chromecast] ffmpeg exited ${code}`));
      req.on('close', () => ff.kill());
      return;
    }

    // Native file with range requests
    const range = req.headers['range'];
    if (range) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = parseInt(s, 10);
      const end = e ? parseInt(e, 10) : total - 1;
      res.writeHead(206, { ...cors, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': contentType });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...cors, 'Content-Length': String(total), 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
      createReadStream(filePath).pipe(res);
    }
  });

  server.on('error', (e) => console.error(`[chromecast] media server error: ${e.message}`));
  await new Promise<void>((res) => server.listen(0, '0.0.0.0', res));
  const { port } = server.address() as { port: number };
  const baseName = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'media';
  const servedFilename = transcodeVideo ? 'index.m3u8' : encodeURIComponent(baseName) + (transcodeAudio ? '.mp3' : ext);
  const url = `http://${localIp}:${port}/${servedFilename}`;
  console.log(`[chromecast] media server at ${url}`);

  return {
    url, subtitleUrl: null, contentType, needsTranscode,
    close: () => {
      console.log('[chromecast] media server closing');
      server.close();
      if (hlsFf) {
        hlsFf.kill();
        hlsFf.on('close', () => {
          if (tmpHlsDir) rm(tmpHlsDir, { recursive: true, force: true }).catch(() => {});
        });
      } else if (tmpHlsDir) {
        rm(tmpHlsDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function varint(value: number): Buffer {
  const b: number[] = [];
  while (value > 0x7f) { b.push((value & 0x7f) | 0x80); value >>>= 7; }
  b.push(value & 0x7f);
  return Buffer.from(b);
}

function castField(num: number, data: Buffer): Buffer {
  return Buffer.concat([varint((num << 3) | 2), varint(data.length), data]);
}

function castVarintField(num: number, value: number): Buffer {
  return Buffer.concat([varint((num << 3) | 0), varint(value)]);
}

function encodeCastMsg(src: string, dst: string, ns: string, payload: string): Buffer {
  const body = Buffer.concat([
    castVarintField(1, 0),
    castField(2, Buffer.from(src, 'utf8')),
    castField(3, Buffer.from(dst, 'utf8')),
    castField(4, Buffer.from(ns, 'utf8')),
    castVarintField(5, 0),
    castField(6, Buffer.from(payload, 'utf8')),
  ]);
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length, 0);
  return Buffer.concat([hdr, body]);
}

function decodeCastMsg(buf: Buffer): { namespace: string; payload: string } | null {
  let offset = 0;
  let namespace = '';
  let payload = '';
  while (offset < buf.length) {
    let tag = 0, shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const wireType = tag & 0x7;
    const fieldNum = tag >> 3;
    if (wireType === 0) {
      while (offset < buf.length && (buf[offset++] & 0x80)) {}
    } else if (wireType === 2) {
      let len = 0; shift = 0;
      while (offset < buf.length) {
        const b = buf[offset++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      const data = buf.slice(offset, offset + len);
      offset += len;
      if (fieldNum === 4) namespace = data.toString('utf8');
      if (fieldNum === 6) payload = data.toString('utf8');
    } else break;
  }
  return namespace ? { namespace, payload } : null;
}

interface ActiveSession {
  ip: string;
  sessionId: string;
  closeServer: () => void;
}

export const activeSessions = new Map<string, ActiveSession>(); // keyed by absolute file path

function castStream(
  ip: string, mediaUrl: string, contentType: string, streamType = 'BUFFERED', subtitleUrl: string | null = null,
): Promise<{ message: string; sessionId: string }> {
  const NS_CONN  = 'urn:x-cast:com.google.cast.tp.connection';
  const NS_HEART = 'urn:x-cast:com.google.cast.tp.heartbeat';
  const NS_RECV  = 'urn:x-cast:com.google.cast.receiver';
  const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

  return new Promise((resolve, reject) => {
    console.log(`[chromecast] connecting TLS to ${ip}:8009`);
    const socket = tls.connect({ host: ip, port: 8009, rejectUnauthorized: false });
    let rxBuf = Buffer.alloc(0);
    let heartbeat: NodeJS.Timeout;
    let requestId = 1;
    let appTransportId = '';
    let appSessionId = '';
    let resolved = false;

    const send = (src: string, dst: string, ns: string, msg: object) => {
      const short = ns.split(':').pop();
      console.log(`[chromecast] → ${short} ${JSON.stringify(msg)}`);
      try { socket.write(encodeCastMsg(src, dst, ns, JSON.stringify(msg))); }
      catch (e: unknown) { console.error(`[chromecast] send error: ${(e as Error).message}`); }
    };

    const fail = (reason: string) => {
      if (resolved) return;
      resolved = true;
      clearInterval(heartbeat);
      console.error(`[chromecast] FAIL: ${reason}`);
      socket.destroy();
      reject(new Error(reason));
    };

    socket.on('close', () => { console.log('[chromecast] TLS socket closed'); clearInterval(heartbeat); });
    socket.on('error', (e) => { console.error(`[chromecast] TLS error: ${e.message}`); fail(`Cast error: ${e.message}`); });

    socket.on('data', (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 4) {
        const msgLen = rxBuf.readUInt32BE(0);
        if (rxBuf.length < 4 + msgLen) break;
        const raw = rxBuf.slice(4, 4 + msgLen);
        rxBuf = rxBuf.slice(4 + msgLen);
        const msg = decodeCastMsg(raw);
        if (!msg) { console.warn('[chromecast] could not decode message'); continue; }

        const short = msg.namespace.split(':').pop();
        console.log(`[chromecast] ← ${short} ${msg.payload}`);

        try {
          const p = JSON.parse(msg.payload) as Record<string, unknown>;

          if (msg.namespace === NS_HEART && p['type'] === 'PING') {
            send('sender-0', 'receiver-0', NS_HEART, { type: 'PONG' });
          }

          if (msg.namespace === NS_RECV && p['type'] === 'RECEIVER_STATUS') {
            const apps = ((p['status'] as Record<string, unknown>)?.['applications'] as Record<string, unknown>[]);
            console.log(`[chromecast] receiver status — apps: ${JSON.stringify(apps?.map(a => a['appId']))}`);
            if (apps?.length && !appTransportId) {
              appTransportId = apps[0]['transportId'] as string;
              appSessionId   = apps[0]['sessionId']   as string ?? '';
              console.log(`[chromecast] app launched, transportId=${appTransportId} sessionId=${appSessionId}`);
              send('sender-0', appTransportId, NS_CONN, { type: 'CONNECT' });
              const tracks = subtitleUrl
                ? [{ trackId: 1, type: 'TEXT', trackContentId: subtitleUrl, trackContentType: 'text/vtt', name: 'English', language: 'en-US', subtype: 'SUBTITLES' }]
                : undefined;
              send('sender-0', appTransportId, NS_MEDIA, {
                type: 'LOAD', requestId: requestId++,
                media: { contentId: mediaUrl, streamType, contentType, ...(tracks ? { tracks } : {}) },
                activeTrackIds: tracks ? [1] : undefined,
                autoplay: true,
              });
            }
          }

          if (msg.namespace === NS_MEDIA && p['type'] === 'MEDIA_STATUS') {
            const statuses = p['status'] as Record<string, unknown>[];
            const state = statuses?.[0]?.['playerState'];
            console.log(`[chromecast] media playerState=${state}`);
            if (state === 'PLAYING' && !resolved) {
              console.log(`[chromecast] playback started, confirming in 3s...`);
              // Delay resolve so that immediate post-PLAYING errors (e.g. SOURCE_BUFFER_FAILURE)
              // are caught and returned as errors instead of false success.
              setTimeout(() => {
if (!resolved) {
                      resolved = true;
                      console.log(`[chromecast] playback confirmed`);
                      clearInterval(heartbeat);
                      resolve({ message: `Streaming started → ${mediaUrl}`, sessionId: appSessionId });
                    }
              }, 3000);
            }
            if (state === 'ERROR' && !resolved) {
              fail(`Chromecast player error: ${JSON.stringify(statuses?.[0]?.['extendedStatus'] ?? 'unknown')}`);
            }
          }

          if (msg.namespace === NS_MEDIA && p['type'] === 'ERROR') {
            const code = p['detailedErrorCode'];
            console.error(`[chromecast] media ERROR detailedErrorCode=${code}`);
            fail(`Chromecast media error code ${code} (stream rejected by player)`);
          }

          if (msg.namespace === NS_MEDIA && p['type'] === 'LOAD_FAILED') {
            console.error(`[chromecast] LOAD_FAILED`);
            fail('LOAD_FAILED: Chromecast could not load the media. The format may be unsupported or the file is incomplete.');
          }

          if (msg.namespace === NS_RECV && p['type'] === 'LAUNCH_ERROR') {
            fail(`Launch error: ${JSON.stringify(p['reason'])}`);
          }
        } catch (e: unknown) {
          console.error(`[chromecast] message parse error: ${(e as Error).message}`);
        }
      }
    });

    socket.on('secureConnect', () => {
      console.log(`[chromecast] TLS connected, launching Default Media Receiver`);
      send('sender-0', 'receiver-0', NS_CONN, { type: 'CONNECT' });
      send('sender-0', 'receiver-0', NS_RECV, { type: 'LAUNCH', requestId: requestId++, appId: 'CC1AD845' });
      heartbeat = setInterval(() => send('sender-0', 'receiver-0', NS_HEART, { type: 'PING' }), 5000);
      setTimeout(() => fail('Timed out waiting for Chromecast to begin playback'), 15000);
    });
  });
}

function castStop(ip: string, sessionId: string): Promise<void> {
  const NS_CONN = 'urn:x-cast:com.google.cast.tp.connection';
  const NS_RECV = 'urn:x-cast:com.google.cast.receiver';
  return new Promise((resolve) => {
    const socket = tls.connect({ host: ip, port: 8009, rejectUnauthorized: false });
    const send = (src: string, dst: string, ns: string, msg: object) => {
      try { socket.write(encodeCastMsg(src, dst, ns, JSON.stringify(msg))); } catch {}
    };
    socket.on('error', () => resolve());
    socket.on('secureConnect', () => {
      send('sender-0', 'receiver-0', NS_CONN, { type: 'CONNECT' });
      if (sessionId) {
        send('sender-0', 'receiver-0', NS_RECV, { type: 'STOP', requestId: 1, sessionId });
      }
      setTimeout(() => { socket.destroy(); resolve(); }, 1000);
    });
  });
}

function castGetStatus(ip: string): Promise<Record<string, unknown>> {
  const NS_CONN = 'urn:x-cast:com.google.cast.tp.connection';
  const NS_HEART = 'urn:x-cast:com.google.cast.tp.heartbeat';
  const NS_RECV = 'urn:x-cast:com.google.cast.receiver';
  const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 8009, rejectUnauthorized: false });
    let rxBuf = Buffer.alloc(0);
    let heartbeat: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    let resolved = false;
    let receiverStatus: Record<string, unknown> | null = null;
    let mediaStatus: Record<string, unknown> | null = null;

    const send = (src: string, dst: string, ns: string, msg: object) => {
      try { socket.write(encodeCastMsg(src, dst, ns, JSON.stringify(msg))); }
      catch (e: unknown) { console.error(`[chromecast] send error: ${(e as Error).message}`); }
    };

    const finish = (status: Record<string, unknown>) => {
      if (resolved) return;
      resolved = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      socket.destroy();
      resolve(status);
    };

    const fail = (reason: string) => {
      if (resolved) return;
      resolved = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error(reason));
    };

    socket.on('error', (e) => fail(`Cast error: ${e.message}`));
    socket.on('close', () => {
      if (!resolved) fail('Connection closed before status received');
    });

    socket.on('data', (chunk: Buffer) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 4) {
        const msgLen = rxBuf.readUInt32BE(0);
        if (rxBuf.length < 4 + msgLen) break;
        const raw = rxBuf.slice(4, 4 + msgLen);
        rxBuf = rxBuf.slice(4 + msgLen);
        const msg = decodeCastMsg(raw);
        if (!msg) { console.warn('[chromecast] could not decode message'); continue; }

        const short = msg.namespace.split(':').pop();
        console.log(`[chromecast] ← ${short} ${msg.payload}`);

        try {
          const p = JSON.parse(msg.payload) as Record<string, unknown>;

          if (msg.namespace === NS_HEART && p['type'] === 'PING') {
            send('sender-0', 'receiver-0', NS_HEART, { type: 'PONG' });
          }

          if (msg.namespace === NS_RECV && p['type'] === 'RECEIVER_STATUS') {
            receiverStatus = p;
            console.log(`[chromecast] receiver status received, requesting media status`);
            // Request media status if there's an active app
            const apps = ((p['status'] as Record<string, unknown>)?.['applications'] as Record<string, unknown>[]);
            if (apps?.length) {
              const app = apps[0];
              const transportId = app['transportId'] as string;
              send('sender-0', transportId, NS_MEDIA, { type: 'GET_STATUS', requestId: 1 });
            } else {
              // No active app, finish with receiver status only
              finish(receiverStatus);
            }
          }

          if (msg.namespace === NS_MEDIA && p['type'] === 'STATUS') {
            mediaStatus = p;
            console.log(`[chromecast] media status received, finishing`);
            finish({
              ...(receiverStatus ?? {}),
              mediaStatus,
            });
          }
        } catch (e: unknown) {
          console.error(`[chromecast] message parse error: ${(e as Error).message}`);
        }
      }
    });

    socket.on('secureConnect', () => {
      console.log(`[chromecast] TLS connected, requesting status`);
      send('sender-0', 'receiver-0', NS_CONN, { type: 'CONNECT' });
      send('sender-0', 'receiver-0', NS_RECV, { type: 'GET_STATUS', requestId: 1 });
      heartbeat = setInterval(() => send('sender-0', 'receiver-0', NS_HEART, { type: 'PING' }), 5000);
      timeout = setTimeout(() => {
        if (!resolved) fail('Timed out waiting for Chromecast status response');
      }, 10000);
    });
  });
}

export function setup(cfg: PluginConfig<ChromecastConfig>) {
  function isPathAllowed(target: string, allowedDirs: string[]): boolean {
    const abs = resolvePath(process.cwd(), target);
    return allowedDirs.some((base) => abs === base || abs.startsWith(base + '/'));
  }

  registerNativeTool({
    name: 'discover_chromecasts',
    description: 'Discover Chromecast devices on the local network. Returns a JSON array of { name, ip }.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      console.log('[chromecast] starting mDNS discovery');
      const discovered = await new Promise<{ name: string; address: string }[]>((resolve) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const seen = new Map<string, { name: string; address: string }>();
        const finish = () => {
          console.log(`[chromecast] mDNS done, found ${seen.size} device(s)`);
          try { socket.close(); } catch (_) {}
          resolve([...seen.values()]);
        };
        socket.on('error', (e) => { console.error(`[chromecast] mDNS socket error: ${e.message}`); finish(); });
        socket.on('message', (msg) => {
          try {
            for (const d of parseMdnsResponse(msg)) {
              const ex = seen.get(d.name);
              if (!ex || (!ex.address && d.address)) {
                console.log(`[chromecast] mDNS found: ${d.name} @ ${d.address}`);
                seen.set(d.name, d);
              }
            }
          } catch (_) {}
        });
        socket.bind({ port: 5353, address: '0.0.0.0' }, async () => {
          socket.setMulticastTTL(255);
          socket.setMulticastLoopback(true);
          const lanAddresses: string[] = [];
          for (const ifaces of Object.values(os.networkInterfaces())) {
            for (const iface of ifaces ?? []) {
              if (!iface.internal && iface.family === 'IPv4') {
                const prefix = iface.cidr ? parseInt(iface.cidr.split('/')[1], 10) : 32;
                if (prefix < 31) lanAddresses.push(iface.address);
              }
            }
          }
          console.log(`[chromecast] LAN addresses: ${lanAddresses.join(', ')}`);
          for (const addr of lanAddresses) { try { socket.addMembership('224.0.0.251', addr); } catch (_) {} }
          const query = createMdnsQuery();
          for (const addr of (lanAddresses.length ? lanAddresses : [undefined])) {
            await new Promise<void>((res) => {
              try {
                if (addr) socket.setMulticastInterface(addr);
                socket.send(query, 0, query.length, 5353, '224.0.0.251', () => res());
              } catch (_) { res(); }
            });
          }
          setTimeout(finish, 3000);
        });
      });
      const devices = await Promise.all(
        discovered.map(async (d) => {
          const friendly = d.address ? await fetchFriendlyName(d.address) : null;
          return { name: friendly ?? d.name, ip: d.address };
        })
      );
      console.log(`[chromecast] devices: ${JSON.stringify(devices)}`);
      return JSON.stringify(devices, null, 2);
    },
  });

  registerNativeTool({
    name: 'list_audio_tracks',
    description: 'List the audio tracks available in a local video/audio file (language, codec, channels, title). Returns a JSON array of { index, language, codec, channels, channelLayout, title, isDefault }. Use the "index" value as the audioIndex argument to play_on_chromecast to choose a track.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the local media file (use ls or tree to find the exact path)' },
      },
      required: ['path'],
    },
    execute: async ({ path }: { path: string }) => {
      console.log(`[chromecast] list_audio_tracks path="${path}"`);

      const { allowedDirs = [] } = await cfg.get();
      const resolved = allowedDirs.map((d) => resolvePath(process.cwd(), d));
      if (!isPathAllowed(path, resolved)) {
        return `ERROR: "${path}" is not within an allowed directory. Configure pluginConfig.chromecast.allowedDirs in config.json.`;
      }

      const absPath = resolvePath(process.cwd(), path);
      try { await stat(absPath); }
      catch (e: unknown) {
        return `ERROR: File not found: "${absPath}". Use the ls or tree tool to find the correct path.`;
      }

      const tracks = await probeAudioTracks(absPath);
      if (!tracks.length) return `No audio tracks found in "${absPath}" (ffprobe may be missing or the file has no audio).`;
      return JSON.stringify(tracks, null, 2);
    },
  });

  registerNativeTool({
    name: 'play_on_chromecast',
    description: 'Stream a local media file to a Chromecast. Use the ip from discover_chromecasts. The file must be in an allowed directory (configured in pluginConfig.chromecast.allowedDirs). Optionally pass audioIndex (from list_audio_tracks) to choose which audio track to play.',
    parameters: {
      type: 'object',
      properties: {
        ip:   { type: 'string', description: 'IP address of the Chromecast (from discover_chromecasts)' },
        path: { type: 'string', description: 'Absolute path to the local media file (use ls or tree to find the exact path)' },
        audioIndex: { type: 'number', description: 'Optional. Absolute stream index of the audio track to play (the "index" field from list_audio_tracks). Defaults to the English/first track. Selecting a track on an .mp4/.webm file forces a transcode.' },
      },
      required: ['ip', 'path'],
    },
    execute: async ({ ip, path, audioIndex }: { ip: string; path: string; audioIndex?: number }) => {
      console.log(`[chromecast] play_on_chromecast ip=${ip} path="${path}" audioIndex=${audioIndex ?? 'auto'}`);

      const { allowedDirs = [] } = await cfg.get();
      const resolved = allowedDirs.map((d) => resolvePath(process.cwd(), d));
      console.log(`[chromecast] allowed dirs: ${resolved.join(', ')}`);

      if (!isPathAllowed(path, resolved)) {
        return `ERROR: "${path}" is not within an allowed directory. Configure pluginConfig.chromecast.allowedDirs in config.json.`;
      }

      const absPath = resolvePath(process.cwd(), path);
      console.log(`[chromecast] resolved path: "${absPath}"`);

      try { await stat(absPath); }
      catch (e: unknown) {
        console.error(`[chromecast] file not found: ${(e as Error).message}`);
        return `ERROR: File not found: "${absPath}". Use the ls or tree tool to find the correct path.`;
      }

      const localIp = localIpFor(ip);
      console.log(`[chromecast] local IP for cast: ${localIp}`);

      if (audioIndex !== undefined) {
        const tracks = await probeAudioTracks(absPath);
        if (tracks.length && !tracks.some((t) => t.index === audioIndex)) {
          return `ERROR: audioIndex ${audioIndex} is not an audio track in "${absPath}". Available: ${tracks.map(describeAudioTrack).join(', ')}. Call list_audio_tracks for details.`;
        }
      }

      const { url, subtitleUrl, contentType, needsTranscode, close: closeServer } = await startMediaServer(absPath, localIp, audioIndex);
      console.log(`[chromecast] starting cast to ${ip}, media URL: ${url}`);

      // Close any existing stream for this file before starting a new one
      const existing = activeSessions.get(absPath);
      if (existing) {
        console.log(`[chromecast] replacing existing session for "${absPath}"`);
        await castStop(existing.ip, existing.sessionId).catch(() => {});
        existing.closeServer();
        activeSessions.delete(absPath);
      }

      try {
        const streamType = needsTranscode ? 'LIVE' : 'BUFFERED';
        // External side-loaded subtitle tracks don't work with HLS (application/x-mpegURL);
        // they need to be declared inside the m3u8 playlist. Pass null for HLS to avoid error 104.
        const castSubtitleUrl = contentType === 'application/x-mpegURL' ? null : subtitleUrl;
        const { message, sessionId } = await castStream(ip, url, contentType, streamType, castSubtitleUrl);
        console.log(`[chromecast] cast success: ${message} sessionId=${sessionId}`);
        activeSessions.set(absPath, { ip, sessionId, closeServer });
        return `${message}\nHandle (use to stop): ${absPath}`;
      } catch (e: unknown) {
        console.error(`[chromecast] cast failed: ${(e as Error).message}`);
        closeServer();
        return `ERROR: ${(e as Error).message}`;
      }
    },
  });

  registerNativeTool({
    name: 'chromecast_status',
    description: 'List all currently active Chromecast streams (handles) and their live device state. Returns a JSON array of { path, ip, sessionId, live } for each active session, where `live` is the receiver/media status queried from the device (or `error` if the device could not be reached).',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const entries = [...activeSessions.entries()];
      if (!entries.length) return 'No active Chromecast streams.';
      const sessions = await Promise.all(entries.map(async ([path, s]) => {
        const base = { path, ip: s.ip, sessionId: s.sessionId };
        try {
          return { ...base, live: await castGetStatus(s.ip) };
        } catch (e: unknown) {
          return { ...base, error: (e as Error).message };
        }
      }));
      return JSON.stringify(sessions, null, 2);
    },
  });

  registerNativeTool({
    name: 'stop_chromecast',
    description: 'Stop an active Chromecast stream. Pass the file path returned by play_on_chromecast as the handle.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path that was returned as the handle from play_on_chromecast' },
      },
      required: ['path'],
    },
    execute: async ({ path }: { path: string }) => {
      const session = activeSessions.get(path);
      if (!session) {
        return `ERROR: No active stream for "${path}". Known handles: ${[...activeSessions.keys()].join(', ') || 'none'}`;
      }
      console.log(`[chromecast] stopping stream for "${path}"`);
      await castStop(session.ip, session.sessionId).catch(() => {});
      session.closeServer();
      activeSessions.delete(path);
      return `Stopped stream: ${path}`;
    },
  });
}
