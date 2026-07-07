// test/e2e_music.js — end-to-end test for the browser music streaming plugin.
// Tests the real library-walking / playlist / streaming logic in-code against a
// temporary on-disk library. No server is started, per house rules — requests are
// driven through the route registry exactly as the main server dispatches them.

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
  // The plugin persists playlists under cfg.dir/playlists, so the stub must
  // supply a real directory (the app assigns one from the plugin's name).
  const pluginDir = await mkdtemp(resolvePath(tmpdir(), 'music-plugin-'));
  const cfgStub = {
    get: async () => ({ allowedDirs: [lib] }),
    set: async () => {},
    dir: pluginDir,
    ensureDir: async () => { await mkdir(pluginDir, { recursive: true }); return pluginDir; },
  };
  setup(cfgStub);
  for (const t of [
    'music_list_dirs', 'music_info', 'music_play', 'music_player_ui',
    'music_playlists', 'music_playlist_show', 'music_playlist_create', 'music_playlist_delete',
    'music_playlist_add', 'music_playlist_remove', 'music_playlist_clear', 'music_playlist_play',
  ]) {
    assert.ok(hasTool('hx__' + t), `tool ${t} registered`);
  }
  // No queue tools — playback is always a playlist.
  for (const t of ['music_queue_add', 'music_queue_show', 'music_queue_clear']) {
    assert.ok(!hasTool('hx__' + t), `queue tool ${t} removed`);
  }

  // ── route registry: /music is mounted, unrelated paths are not ──
  assert.ok(matchRoute('/api/plugin/music'), '/api/plugin/music is mounted');
  assert.ok(matchRoute('/api/plugin/music/player'), '/api/plugin/music subpaths are mounted');
  assert.equal(matchRoute('/v1/models'), undefined, 'unrelated paths are not hijacked');
  assert.equal(matchRoute('/api/plugin/musicology'), undefined, 'prefix collisions avoided');

  // ── HTTP routes (driven through the registry, mount-prefixed) ──
  const dirsRes = await callRoute('/api/plugin/music/api/dirs');
  assert.equal(dirsRes.statusCode, 200);
  assert.equal(JSON.parse(dirsRes.body).length, 1, '/api/plugin/music/api/dirs returns allowed dirs');

  const plRes = await callRoute('/api/plugin/music/api/playlist?path=' + encodeURIComponent(lib));
  assert.equal(JSON.parse(plRes.body).tracks.length, 4, '/api/plugin/music/api/playlist returns 4 tracks');

  const searchRes = await callRoute('/api/plugin/music/api/search?q=funk');
  assert.equal(JSON.parse(searchRes.body).tracks.length, 1, '/api/plugin/music/api/search works over HTTP');

  const playerRes = await callRoute('/api/plugin/music/player');
  assert.equal(playerRes.statusCode, 200);
  assert.match(playerRes.body, /<audio/, 'player page has an <audio> element');
  assert.match(playerRes.body, /api\/player/, 'player page is wired to server-side playback');
  assert.match(playerRes.body, /location\.pathname\.replace/, 'player derives its base from the URL it was loaded at');

  // stream of a disallowed path → 403
  const badStream = await callRoute('/api/plugin/music/stream?path=' + encodeURIComponent('/etc/passwd'));
  assert.equal(badStream.statusCode, 403, 'disallowed stream blocked');

  // stream a real file (no range) → 200 with audio content-type
  const okStream = await callRoute('/api/plugin/music/stream?path=' + encodeURIComponent(oneFile));
  assert.equal(okStream.statusCode, 200, 'allowed stream serves');
  assert.equal(okStream.headers['Content-Type'], 'audio/mpeg', 'mp3 mime');
  assert.equal(okStream.headers['Accept-Ranges'], 'bytes', 'advertises range support');

  // stream with a range header → 206 partial
  const rangeStream = await callRoute(
    '/api/plugin/music/stream?path=' + encodeURIComponent(oneFile), { range: 'bytes=0-0' },
  );
  assert.equal(rangeStream.statusCode, 206, 'range request → 206');
  assert.match(rangeStream.headers['Content-Range'], /bytes 0-0\//, 'content-range header set');

  const notFound = await callRoute('/api/plugin/music/nope');
  assert.equal(notFound.statusCode, 404, 'unknown subpath → 404');

  // ── playback is always a playlist (no queue) ──
  // Nothing playing initially.
  let pbState = JSON.parse((await callRoute('/api/plugin/music/api/player')).body);
  assert.equal(pbState.playlist, null, 'nothing playing at first');
  const basePlaySerial = pbState.playSerial;

  // music_play adds a track to the "default" playlist and starts playing it.
  const oneFlac = resolvePath(lib, 'Daft Punk/Discovery/02 - Aerodynamic.flac');
  const playTool = await getTool('hx__music_play').execute({ path: oneFlac });
  assert.match(playTool, /started playing it/, 'music_play adds to a playlist + plays');

  pbState = JSON.parse((await callRoute('/api/plugin/music/api/player')).body);
  assert.equal(pbState.playlist, 'default', 'playing the default playlist');
  assert.equal(pbState.tracks.length, 1, 'default playlist has the one track');
  assert.equal(pbState.current, 0, 'and made it current');
  assert.equal(pbState.playSerial, basePlaySerial + 1, 'play issued a play command');

  // Starting playback of another playlist switches what is playing (no accumulation).
  await getTool('hx__music_playlist_create').execute({ playlist: 'mix' });
  await getTool('hx__music_playlist_add').execute({ path: lib, playlist: 'mix' }); // 4 tracks
  const playMix = JSON.parse((await callRoute('/api/plugin/music/api/player/play?name=mix&index=2')).body);
  assert.equal(playMix.playlist, 'mix', 'now playing the "mix" playlist');
  assert.equal(playMix.tracks.length, 4, 'playing playlist swapped in (not appended)');
  assert.equal(playMix.current, 2, 'started from the requested index');

  // Jump within the playing playlist without changing which playlist plays.
  const jumped = JSON.parse((await callRoute('/api/plugin/music/api/player/index?index=0')).body);
  assert.equal(jumped.playlist, 'mix', 'still the same playing playlist');
  assert.equal(jumped.current, 0, '/api/player/index jumps within it');

  // Editing the PLAYING playlist reflects live: removing a track updates playback.
  const removed = JSON.parse((await callRoute('/api/plugin/music/api/playlist/remove?name=mix&index=3')).body);
  assert.equal(removed.tracks.length, 3, 'playlist file now has 3 paths');
  pbState = JSON.parse((await callRoute('/api/plugin/music/api/player')).body);
  assert.equal(pbState.tracks.length, 3, 'playing snapshot picked up the removal');

  // Playing a playlist with only disallowed paths yields nothing playable.
  const empty = JSON.parse((await callRoute('/api/plugin/music/api/player/play?name=nope-empty')).body);
  assert.equal(empty.tracks.length, 0, 'empty playlist → nothing to play');

  // ── tools return same-origin harness URLs (no separate port) ──
  const uiTool = await getTool('hx__music_player_ui').execute({});
  assert.equal(uiTool, 'http://127.0.0.1:9001/api/plugin/music/player', 'music_player_ui bare URL');

  // ── tool URLs follow the host the browser actually reached us at ──
  noteHost('192.168.1.50:9001');
  const remoteUrl = await getTool('hx__music_player_ui').execute({});
  assert.equal(remoteUrl, 'http://192.168.1.50:9001/api/plugin/music/player',
    'tool URL uses the observed Host, not the loopback bind address');

  // ── player page has the normal transport controls, no tap-to-play gate ──
  const playerPage = (await callRoute('/api/plugin/music/player')).body;
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
  // playlists as tabs in the standalone player
  assert.match(playerPage, /id="tabs"/, 'player has a playlist tab bar');
  assert.match(playerPage, /id="tracklist"/, 'player shows the viewed playlist tracks');
  assert.match(playerPage, /api\/player\/play/, 'player plays a playlist via the playback route');
  assert.match(playerPage, /addToViewed/, 'player adds library tracks to the viewed playlist');
  assert.doesNotMatch(playerPage, /api\/queue/, 'no queue routes remain in the player');

  // music_browse / music_search are intentionally NOT exposed as model tools
  // (models misused them); the UI still reaches the same logic over HTTP.
  assert.ok(!hasTool('hx__music_browse'), 'music_browse tool not registered');
  assert.ok(!hasTool('hx__music_search'), 'music_search tool not registered');
  assert.equal((await callRoute('/api/plugin/music/api/search?q=1969')).statusCode, 200,
    '/api/search still works for the UI');

  // ── named, persisted playlists ────────────────────────────────────────────
  // "default" always exists; names carry no .json extension.
  let names = JSON.parse((await callRoute('/api/plugin/music/api/playlists')).body);
  assert.ok(names.includes('default'), '/api/playlists includes default');
  assert.ok(!names.some((n) => n.endsWith('.json')), 'names have no .json extension');

  // Start default clean (the playback tests above played into it).
  await getTool('hx__music_playlist_clear').execute({});

  // Adding without a name targets "default", creating + persisting it.
  const daFunk = resolvePath(lib, 'Daft Punk/Homework/01 - Da Funk.ogg');
  const addMsg = await getTool('hx__music_playlist_add').execute({ path: daFunk });
  assert.match(addMsg, /playlist "default"/, 'add with no name targets default');
  let shownPl = JSON.parse(await getTool('hx__music_playlist_show').execute({}));
  assert.equal(shownPl.playlist, 'default', 'add with no name uses default');
  assert.equal(shownPl.count, 1, 'default playlist has the added track');

  // The playlist file is persisted on disk under the plugin dir.
  const onDisk = JSON.parse(await readFile(resolvePath(pluginDir, 'playlists/default.json'), 'utf8'));
  assert.equal(onDisk.tracks.length, 1, 'default playlist persisted to plugin dir');

  // Create a named playlist and add a whole folder to it.
  await getTool('hx__music_playlist_create').execute({ playlist: 'road trip' });
  names = JSON.parse((await callRoute('/api/plugin/music/api/playlists')).body);
  assert.ok(names.includes('road trip'), 'created playlist appears in the list');
  await getTool('hx__music_playlist_add').execute({ path: resolvePath(lib, 'Daft Punk/Discovery'), playlist: 'road trip' });
  shownPl = JSON.parse(await getTool('hx__music_playlist_show').execute({ playlist: 'road trip' }));
  assert.equal(shownPl.count, 2, 'folder added its 2 audio tracks to the named playlist');

  // Remove a track by index, then clear.
  await getTool('hx__music_playlist_remove').execute({ playlist: 'road trip', index: 0 });
  shownPl = JSON.parse(await getTool('hx__music_playlist_show').execute({ playlist: 'road trip' }));
  assert.equal(shownPl.count, 1, 'remove drops one track');

  // Play a playlist → it becomes the playing playlist.
  const playPl = await getTool('hx__music_playlist_play').execute({ playlist: 'road trip' });
  assert.match(playPl, /Playing playlist "road trip"/, 'playlist_play reports playback');
  const pbAfter = JSON.parse((await callRoute('/api/plugin/music/api/player')).body);
  assert.equal(pbAfter.playlist, 'road trip', 'playing playlist is now "road trip"');
  assert.equal(pbAfter.tracks.length, 1, 'playing its single track');

  // HTTP routes the UI uses: name-based add/get/delete.
  const addRes = JSON.parse((await callRoute(
    '/api/plugin/music/api/playlist/add?name=ui-test&path=' + encodeURIComponent(daFunk),
  )).body);
  assert.equal(addRes.name, 'ui-test', '/api/playlist/add creates + names the playlist');
  assert.equal(addRes.tracks.length, 1, '/api/playlist/add appended a track');
  const getRes = JSON.parse((await callRoute('/api/plugin/music/api/playlist/get?name=ui-test')).body);
  assert.equal(getRes.tracks.length, 1, '/api/playlist/get reads it back');

  // "default" is protected from deletion; others delete fine.
  const delDefault = JSON.parse((await callRoute('/api/plugin/music/api/playlist/delete?name=default')).body);
  assert.equal(delDefault.deleted, false, 'default playlist cannot be deleted');
  const delUi = JSON.parse((await callRoute('/api/plugin/music/api/playlist/delete?name=ui-test')).body);
  assert.equal(delUi.deleted, true, 'named playlist deletes');
  names = JSON.parse((await callRoute('/api/plugin/music/api/playlists')).body);
  assert.ok(!names.includes('ui-test'), 'deleted playlist is gone');

  // Path-traversal names are sanitized to a safe file base.
  await getTool('hx__music_playlist_create').execute({ playlist: '../evil' });
  const evilExists = await readFile(resolvePath(pluginDir, 'playlists/_evil.json'), 'utf8').then(() => true).catch(() => false);
  const escaped = await readFile(resolvePath(pluginDir, '../evil.json'), 'utf8').then(() => true).catch(() => false);
  assert.ok(evilExists, 'traversal name sanitized into the playlists dir');
  assert.ok(!escaped, 'traversal name did not escape the plugin dir');

  await rm(pluginDir, { recursive: true, force: true });
  await rm(lib, { recursive: true, force: true });
  console.log('All music plugin tests passed');
}

run().catch((e) => { console.error(e); process.exit(1); });
