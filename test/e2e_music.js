// test/e2e_music.js — end-to-end test for the browser music streaming plugin.
// Tests the real library-walking / playlist / streaming logic in-code against a
// temporary on-disk library. No server is started, per house rules — requests are
// driven through the route registry exactly as the main server dispatches them.

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import {
  setup,
  buildPlaylist,
  browseDir,
  searchFiles,
  pathAllowed,
  AUDIO_EXTS,
} from '../plugins/music/index.ts';
import { getTool, hasTool } from '../src/registry.ts';
import { matchRoute } from '../src/http-registry.ts';
import { setListen, noteHost } from '../src/runtime.ts';

// ── build a throwaway music library ──────────────────────────────────────────
async function makeLibrary() {
  const root = await mkdtemp(resolvePath(tmpdir(), 'music-test-'));
  const tree = {
    'Daft Punk/Discovery/01 - One More Time.mp3': 'a',
    'Daft Punk/Discovery/02 - Aerodynamic.flac': 'b',
    'Daft Punk/Discovery/cover.jpg': 'notaudio',
    'Daft Punk/Homework/01 - Da Funk.ogg': 'c',
    'Boards of Canada/Geogaddi/10 - 1969.wav': 'd',
    'notes.txt': 'ignore me',
  };
  for (const [rel, body] of Object.entries(tree)) {
    const full = resolvePath(root, rel);
    await mkdir(resolvePath(full, '..'), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

// Minimal fake req/res so we can drive handleMusicRequest without a socket.
function fakeReq(url, headers = {}) {
  const r = new EventEmitter();
  r.url = url;
  r.headers = headers;
  r.method = 'GET';
  return r;
}
function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.statusCode = 0;
  res.headers = null;
  res.writeHead = function (code, headers) { res.statusCode = code; res.headers = headers; return res; };
  res.on('finish', () => { res.body = Buffer.concat(chunks).toString(); res.ended = true; if (res.onend) res.onend(); });
  return res;
}
// Drive a request the same way src/server.ts does: look the path up in the route
// registry and invoke the matched handler (no socket, no listening server).
function callRoute(url, headers) {
  return new Promise(async (resolve) => {
    const res = fakeRes();
    res.onend = () => resolve(res);
    const handler = matchRoute(url.split('?')[0]);
    if (!handler) { res.writeHead(404); res.end(''); resolve(res); return; }
    await handler(fakeReq(url, headers), res);
    if (res.ended) resolve(res);
  });
}

async function run() {
  const lib = await makeLibrary();
  const allowed = [lib];

  // ── pathAllowed ──
  assert.ok(pathAllowed(resolvePath(lib, 'Daft Punk'), allowed), 'inside dir allowed');
  assert.ok(!pathAllowed('/etc/passwd', allowed), 'outside dir blocked');
  assert.ok(!pathAllowed(lib + '-evil', allowed), 'prefix-sibling not allowed');

  // ── buildPlaylist: recursive, audio-only, numerically sorted ──
  const pl = await buildPlaylist(lib, allowed);
  assert.equal(pl.length, 4, 'finds all 4 audio files, skips jpg/txt');
  assert.ok(pl.every((t) => AUDIO_EXTS.has('.' + t.path.split('.').pop())), 'all entries are audio');
  assert.ok(!pl.some((t) => t.path.endsWith('.jpg')), 'jpg excluded');
  const first = pl[0];
  assert.ok(first.title && !/\.\w+$/.test(first.title), 'title strips extension');
  assert.ok(first.album, 'album is parent folder');

  // single-file playlist
  const oneFile = resolvePath(lib, 'Daft Punk/Discovery/01 - One More Time.mp3');
  const single = await buildPlaylist(oneFile, allowed);
  assert.equal(single.length, 1, 'single file → one-track playlist');

  // outside allowed dirs → empty
  assert.equal((await buildPlaylist('/etc', allowed)).length, 0, 'disallowed path → empty playlist');

  // numeric sort within Discovery folder (01 before 02)
  const disco = await buildPlaylist(resolvePath(lib, 'Daft Punk/Discovery'), allowed);
  assert.match(disco[0].name, /^01 /, 'track 01 sorts first');
  assert.match(disco[1].name, /^02 /, 'track 02 sorts second');

  // ── browseDir ──
  const rootBrowse = await browseDir('root', allowed);
  assert.equal(rootBrowse.path, 'root');
  assert.equal(rootBrowse.dirs.length, 1, 'root lists the one allowed dir');

  const top = await browseDir(lib, allowed);
  assert.deepEqual(top.dirs.map((d) => d.name).sort(), ['Boards of Canada', 'Daft Punk'], 'top-level folders');
  assert.equal(top.files.length, 0, 'no audio files at top level');

  const discoBrowse = await browseDir(resolvePath(lib, 'Daft Punk/Discovery'), allowed);
  assert.equal(discoBrowse.files.length, 2, 'Discovery has 2 audio files (jpg excluded)');

  // ── searchFiles ──
  const funk = await searchFiles('funk', allowed);
  assert.equal(funk.length, 1, 'search "funk" matches Da Funk');
  assert.match(funk[0].name, /Da Funk/);
  assert.equal((await searchFiles('zzz-nope', allowed)).length, 0, 'no matches → empty');

  // ── plugin setup: registers tools + mounts /music routes on the main server ──
  setListen('127.0.0.1', 9001);
  const cfgStub = { get: async () => ({ allowedDirs: [lib] }), set: async () => {} };
  setup(cfgStub);
  for (const t of ['music_list_dirs', 'music_info', 'music_browse', 'music_search', 'music_play', 'music_queue_add', 'music_queue_show', 'music_queue_clear', 'music_player_ui']) {
    assert.ok(hasTool('hx__' + t), `tool ${t} registered`);
  }

  // ── route registry: /music is mounted, unrelated paths are not ──
  assert.ok(matchRoute('/music'), '/music is mounted');
  assert.ok(matchRoute('/music/player'), '/music subpaths are mounted');
  assert.equal(matchRoute('/v1/models'), undefined, 'unrelated paths are not hijacked');
  assert.equal(matchRoute('/musicology'), undefined, 'prefix collisions avoided');

  // ── HTTP routes (driven through the registry, mount-prefixed) ──
  const dirsRes = await callRoute('/music/api/dirs');
  assert.equal(dirsRes.statusCode, 200);
  assert.equal(JSON.parse(dirsRes.body).length, 1, '/music/api/dirs returns allowed dirs');

  const plRes = await callRoute('/music/api/playlist?path=' + encodeURIComponent(lib));
  assert.equal(JSON.parse(plRes.body).tracks.length, 4, '/music/api/playlist returns 4 tracks');

  const searchRes = await callRoute('/music/api/search?q=funk');
  assert.equal(JSON.parse(searchRes.body).tracks.length, 1, '/music/api/search works over HTTP');

  const playerRes = await callRoute('/music/player');
  assert.equal(playerRes.statusCode, 200);
  assert.match(playerRes.body, /<audio/, 'player page has an <audio> element');
  assert.match(playerRes.body, /api\/queue/, 'player page is wired to the shared queue');
  assert.match(playerRes.body, /location\.pathname\.replace/, 'player derives its base from the URL it was loaded at');

  // stream of a disallowed path → 403
  const badStream = await callRoute('/music/stream?path=' + encodeURIComponent('/etc/passwd'));
  assert.equal(badStream.statusCode, 403, 'disallowed stream blocked');

  // stream a real file (no range) → 200 with audio content-type
  const okStream = await callRoute('/music/stream?path=' + encodeURIComponent(oneFile));
  assert.equal(okStream.statusCode, 200, 'allowed stream serves');
  assert.equal(okStream.headers['Content-Type'], 'audio/mpeg', 'mp3 mime');
  assert.equal(okStream.headers['Accept-Ranges'], 'bytes', 'advertises range support');

  // stream with a range header → 206 partial
  const rangeStream = await callRoute(
    '/music/stream?path=' + encodeURIComponent(oneFile), { range: 'bytes=0-0' },
  );
  assert.equal(rangeStream.statusCode, 206, 'range request → 206');
  assert.match(rangeStream.headers['Content-Range'], /bytes 0-0\//, 'content-range header set');

  const notFound = await callRoute('/music/nope');
  assert.equal(notFound.statusCode, 404, 'unknown subpath → 404');

  // ── shared queue: play appends + plays from there; add enqueues silently ──
  await getTool('hx__music_queue_clear').execute({});
  let qState = JSON.parse((await callRoute('/music/api/queue')).body);
  assert.equal(qState.tracks.length, 0, 'queue starts empty');
  const basePlaySerial = qState.playSerial;

  const oneFlac = resolvePath(lib, 'Daft Punk/Discovery/02 - Aerodynamic.flac');
  const playTool = await getTool('hx__music_play').execute({ path: oneFlac });
  assert.match(playTool, /Added 1 track\(s\) and started playing/, 'music_play adds + plays');

  qState = JSON.parse((await callRoute('/music/api/queue')).body);
  assert.equal(qState.tracks.length, 1, 'play put one track in the shared queue');
  assert.equal(qState.current, 0, 'and made it current');
  assert.equal(qState.playSerial, basePlaySerial + 1, 'play issued a play command');

  // music_play again → appends and plays from the newly-added track (queue grows)
  await getTool('hx__music_play').execute({ path: lib }); // adds the 4-track library
  qState = JSON.parse((await callRoute('/music/api/queue')).body);
  assert.equal(qState.tracks.length, 5, 'second play appended, did not replace');
  assert.equal(qState.current, 1, 'now playing from the first newly-added track');

  // music_queue_add → enqueues WITHOUT changing what plays
  const before = qState.playSerial;
  await getTool('hx__music_queue_add').execute({ path: oneFile });
  qState = JSON.parse((await callRoute('/music/api/queue')).body);
  assert.equal(qState.tracks.length, 6, 'queue_add appended');
  assert.equal(qState.playSerial, before, 'queue_add did not interrupt playback');

  // music_queue_show reflects the queue
  const shown = JSON.parse(await getTool('hx__music_queue_show').execute({}));
  assert.equal(shown.count, 6, 'queue_show counts tracks');

  // queue HTTP mutations (used by the player UI)
  const afterPlay = JSON.parse((await callRoute('/music/api/queue/play?index=3', undefined)).body);
  assert.equal(afterPlay.current, 3, '/api/queue/play sets current');
  const afterRemove = JSON.parse((await callRoute('/music/api/queue/remove?index=0')).body);
  assert.equal(afterRemove.tracks.length, 5, '/api/queue/remove drops a track');

  // adding outside the allowed dirs is refused (stays empty)
  await getTool('hx__music_queue_clear').execute({});
  const cleared = JSON.parse((await callRoute('/music/api/queue/add?play=1&path=' + encodeURIComponent('/etc/passwd'))).body);
  assert.equal(cleared.tracks.length, 0, 'cannot enqueue a disallowed path');

  // ── tools return same-origin harness URLs (no separate port) ──
  const uiTool = await getTool('hx__music_player_ui').execute({});
  assert.equal(uiTool, 'http://127.0.0.1:9001/music/player', 'music_player_ui bare URL');

  // ── tool URLs follow the host the browser actually reached us at ──
  noteHost('192.168.1.50:9001');
  const remoteUrl = await getTool('hx__music_player_ui').execute({});
  assert.equal(remoteUrl, 'http://192.168.1.50:9001/music/player',
    'tool URL uses the observed Host, not the loopback bind address');

  // ── player page has the normal transport controls, no tap-to-play gate ──
  const playerPage = (await callRoute('/music/player')).body;
  assert.doesNotMatch(playerPage, /Tap to play/, 'no tap-to-play gate');
  assert.doesNotMatch(playerPage, /showGate|hideGate/, 'gate logic removed');
  assert.match(playerPage, /id="play"/, 'play control present');
  assert.match(playerPage, /id="next"/, 'next control present');
  assert.match(playerPage, /id="seek"/, 'seek control present');
  assert.match(playerPage, /@media \(max-width: 680px\)/, 'player has a mobile layout');
  assert.match(playerPage, /100dvh/, 'player uses dynamic viewport height for mobile fit');
  // iOS background / lock-screen playback via the Media Session API
  assert.match(playerPage, /mediaSession/, 'player wires up the Media Session API');
  assert.match(playerPage, /MediaMetadata/, 'player publishes now-playing metadata');
  assert.match(playerPage, /setActionHandler/, 'lock-screen action handlers registered');
  assert.match(playerPage, /previoustrack/, 'lock-screen prev handler registered');
  assert.match(playerPage, /nexttrack/, 'lock-screen next handler registered');

  const searchTool = await getTool('hx__music_search').execute({ query: '1969' });
  assert.match(searchTool, /1969\.wav/, 'music_search tool finds track');

  await rm(lib, { recursive: true, force: true });
  console.log('All music plugin tests passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
