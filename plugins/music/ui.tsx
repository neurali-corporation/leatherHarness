import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { UiPlugin, UiPluginProps } from '../../src/ui/plugin-registry';

interface Track {
  path: string;
  name: string;
  title: string;
  album: string;
}

interface QueueState {
  tracks: Track[];
  current: number;
  serial: number;
  playSerial: number;
  paused: boolean;
  pauseTime: number;
}

// The player UI + streaming routes are mounted here on the main harness server
// (see MOUNT in plugins/music/index.ts).
const BASE = '/api/plugin/music';

const C = {
  bg: '#0a0a0a',
  panel: '#141414',
  panel2: '#1c1c1c',
  accent: '#00cc88',
  accentDim: '#003d29',
  accentBorder: '#005540',
  text: '#e0e0e0',
  muted: '#888',
  border: '#252525',
  danger: '#cc3344',
};

function fmt(s: number): string {
  if (!isFinite(s)) return '0:00';
  const sec = Math.floor(s);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c),
  );
}

function MusicPlayer({ open, onClose }: UiPluginProps) {
  const [queue, setQueue] = useState<QueueState>({
    tracks: [],
    current: -1,
    serial: 0,
    playSerial: 0,
    paused: true,
    pauseTime: 0,
  });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(100);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [browsePath, setBrowsePath] = useState('root');
  const [browseDirs, setBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [browseFiles, setBrowseFiles] = useState<Track[]>([]);
  const [crumbStack, setCrumbStack] = useState<string[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seekRef = useRef<HTMLInputElement | null>(null);
  const volRef = useRef<HTMLInputElement | null>(null);

  const refreshQueue = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/api/queue`);
      const data = await res.json();
      setQueue((prev) => (data.serial !== prev.serial ? data : prev));
    } catch (e) {
      console.error('Failed to refresh queue:', e);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshQueue();
    const interval = setInterval(refreshQueue, 2000);
    return () => clearInterval(interval);
  }, [open, refreshQueue]);

  const playTrack = async (index: number) => {
    try {
      const res = await fetch(`${BASE}/api/queue/play?index=${index}`);
      const data = await res.json();
      setQueue(data);
      if (data.current >= 0 && data.current < data.tracks.length) {
        if (audioRef.current) {
          audioRef.current.src = `${BASE}/stream?path=${encodeURIComponent(data.tracks[data.current].path)}`;
          audioRef.current.play().catch(() => {});
        }
      }
    } catch (e) {
      console.error('Failed to play:', e);
    }
  };

  const removeTrack = async (index: number) => {
    try {
      const res = await fetch(`${BASE}/api/queue/remove?index=${index}`);
      const data = await res.json();
      setQueue(data);
    } catch (e) {
      console.error('Failed to remove:', e);
    }
  };

  const clearQueue = async () => {
    try {
      const res = await fetch(`${BASE}/api/queue/clear`, { method: 'POST' });
      const data = await res.json();
      setQueue(data);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
      }
    } catch (e) {
      console.error('Failed to clear:', e);
    }
  };

  const pausePlayback = async () => {
    try {
      const time = audioRef.current?.currentTime ?? 0;
      const track = queue.current;
      const res = await fetch(`${BASE}/api/queue/pause?time=${time}&track=${track}`, { method: 'POST' });
      const data = await res.json();
      setQueue(data);
      if (audioRef.current) {
        audioRef.current.pause();
      }
    } catch (e) {
      console.error('Failed to pause:', e);
    }
  };

  const resumePlayback = async () => {
    try {
      const time = queue.pauseTime || 0;
      const track = queue.current;
      const res = await fetch(`${BASE}/api/queue/resume?time=${time}&track=${track}`, { method: 'POST' });
      const data = await res.json();
      setQueue(data);
      if (data.current >= 0 && data.current < data.tracks.length && audioRef.current) {
        audioRef.current.src = `${BASE}/stream?path=${encodeURIComponent(data.tracks[data.current].path)}`;
        audioRef.current.currentTime = time;
        audioRef.current.play().catch(() => {});
      }
    } catch (e) {
      console.error('Failed to resume:', e);
    }
  };

  const togglePlayPause = () => {
    if (queue.paused) {
      resumePlayback();
    } else {
      pausePlayback();
    }
  };

  const buildOrder = (): number[] => {
    const order = queue.tracks.map((_, i) => i);
    if (shuffle) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const at = order.indexOf(queue.current);
      if (at > 0) {
        [order[0], order[at]] = [order[at], order[0]];
      }
    }
    return order;
  };

  const nextTrack = () => {
    if (queue.tracks.length === 0) return;
    const order = buildOrder();
    const currentIndex = order.indexOf(queue.current);
    let nextIndex: number;
    if (currentIndex < order.length - 1) {
      nextIndex = order[currentIndex + 1];
    } else if (repeat) {
      nextIndex = order[0];
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      return;
    }
    playTrack(nextIndex);
  };

  const prevTrack = () => {
    if (queue.tracks.length === 0) return;
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    const order = buildOrder();
    const currentIndex = order.indexOf(queue.current);
    if (currentIndex > 0) {
      playTrack(order[currentIndex - 1]);
    } else {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
      }
    }
  };

  const toggleShuffle = () => setShuffle(!shuffle);
  const toggleRepeat = () => setRepeat(!repeat);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseInt(e.target.value, 10);
    setVolume(vol);
    if (audioRef.current) {
      audioRef.current.volume = vol / 100;
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (audioRef.current && duration > 0) {
      const time = (parseInt(e.target.value, 10) / 1000) * duration;
      audioRef.current.currentTime = time;
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      if (duration > 0) {
        const percent = (audioRef.current.currentTime / duration) * 1000;
        if (seekRef.current) {
          seekRef.current.value = String(percent);
        }
      }
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleEnded = () => {
    if (repeat && queue.tracks.length === 1 && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    } else {
      nextTrack();
    }
  };

  const searchMusic = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setSearchResults(data.tracks || []);
    } catch (e) {
      console.error('Search failed:', e);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    const timer = setTimeout(() => searchMusic(q), 250);
    return () => clearTimeout(timer);
  };

  const browseDir = async (path: string) => {
    try {
      const res = await fetch(`${BASE}/api/browse?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (path !== 'root') {
        setCrumbStack((prev) => [...prev, path]);
      }
      setBrowsePath(data.path);
      setBrowseDirs(data.dirs || []);
      setBrowseFiles(data.files || []);
    } catch (e) {
      console.error('Browse failed:', e);
    }
  };

  const openBrowse = (path: string) => {
    if (crumbStack.length > 0) {
      setCrumbStack((prev) => prev.slice(0, -1));
    }
    browseDir(path);
  };

  const addPath = async (path: string, play: boolean) => {
    try {
      const res = await fetch(`${BASE}/api/queue/add?play=${play ? '1' : '0'}&path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setQueue(data);
    } catch (e) {
      console.error('Failed to add:', e);
    }
  };

  const currentTrack = queue.current >= 0 ? queue.tracks[queue.current] : null;

  const handleClose = () => {
    // Leave playback running — the <audio> element stays mounted (see below),
    // so closing the window just hides the UI while music keeps playing.
    onClose();
  };

  return (
    <>
      {/* Keep the audio element mounted even when the UI is closed so playback
          survives opening/closing the window. */}
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        style={{ display: 'none' }}
      />

      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            background: C.bg,
            color: C.text,
            display: 'flex',
            flexDirection: 'column',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          {/* Header */}
          <header
            style={{
              padding: '14px 20px',
              background: C.panel,
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              borderBottom: `1px solid #222`,
              flex: 'none',
            }}
          >
            <button
              onClick={handleClose}
              style={{
                background: C.panel2,
                border: `1px solid #2a2a2a`,
                color: C.text,
                fontSize: 16,
                lineHeight: 1,
                cursor: 'pointer',
                width: 34,
                height: 34,
                borderRadius: 8,
                flex: 'none',
                transition: 'color .15s, border-color .15s',
              }}
              title="Close"
            >
              ←
            </button>
            <button
              onClick={() => {
                if (crumbStack.length > 0) {
                  openBrowse(crumbStack[crumbStack.length - 1] || 'root');
                } else {
                  browseDir('root');
                }
              }}
              style={{
                background: C.panel2,
                border: `1px solid #2a2a2a`,
                color: C.text,
                fontSize: 16,
                lineHeight: 1,
                cursor: 'pointer',
                width: 34,
                height: 34,
                borderRadius: 8,
                flex: 'none',
                transition: 'color .15s, border-color .15s',
              }}
              title="Library"
            >
              ☰
            </button>
            <h1 style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>
              leather<span style={{ color: C.accent }}>Harness</span> · music
            </h1>
            <input
              type="search"
              value={searchQuery}
              onChange={handleSearchChange}
              placeholder="Search tracks…"
              style={{
                background: C.panel2,
                border: `1px solid #2a2a2a`,
                color: C.text,
                padding: '8px 12px',
                borderRadius: 8,
                width: 220,
                outline: 'none',
              }}
            />
          </header>

          {/* Main content */}
          <main
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: '280px 1fr',
              minHeight: 0,
            }}
          >
            {/* Library sidebar */}
            <div
              style={{
                background: C.panel,
                borderRight: `1px solid #222`,
                overflowY: 'auto',
                padding: 10,
              }}
            >
              <div style={{ fontSize: 12, color: C.muted, padding: '4px 8px 10px', wordBreak: 'break-all' }}>
                {browsePath === 'root' ? 'Library' : browsePath}
              </div>

              {searchResults.length > 0 ? (
                searchResults.map((f, i) => (
                  <div
                    key={i}
                    onClick={() => addPath(f.path, true)}
                    style={{
                      padding: '9px 10px',
                      borderRadius: 7,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      fontSize: 13,
                    }}
                  >
                    <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>♪</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {esc(f.title)}
                    </span>
                    <span style={{ color: C.muted, marginLeft: 'auto', fontSize: 11 }}>{esc(f.album || '')}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        addPath(f.path, false);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: C.muted,
                        cursor: 'pointer',
                        fontSize: 13,
                        padding: '2px 4px',
                        lineHeight: 1,
                      }}
                      title="Queue"
                    >
                      ＋
                    </button>
                  </div>
                ))
              ) : (
                <>
                  {browsePath !== 'root' && (
                    <div
                      onClick={() => openBrowse(crumbStack[crumbStack.length - 1] || 'root')}
                      style={{
                        padding: '9px 10px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>↩</span>
                      <span>..</span>
                    </div>
                  )}
                  {browseDirs.map((d, i) => (
                    <div
                      key={i}
                      onClick={() => browseDir(d.path)}
                      style={{
                        padding: '9px 10px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>📁</span>
                      <span>{esc(d.name)}</span>
                    </div>
                  ))}
                  {browseFiles.map((f, i) => (
                    <div
                      key={i}
                      onClick={() => addPath(f.path, true)}
                      style={{
                        padding: '9px 10px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        fontSize: 13,
                      }}
                    >
                      <span style={{ color: C.accent, width: 16, textAlign: 'center' }}>♪</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {esc(f.title)}
                      </span>
                      <span style={{ color: C.muted, marginLeft: 'auto', fontSize: 11 }}>{esc(f.album || '')}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          addPath(f.path, false);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: C.muted,
                          cursor: 'pointer',
                          fontSize: 13,
                          padding: '2px 4px',
                          lineHeight: 1,
                        }}
                        title="Queue"
                      >
                        ＋
                      </button>
                    </div>
                  ))}
                  {browseDirs.length === 0 && browseFiles.length === 0 && (
                    <div style={{ color: C.muted, padding: 24, textAlign: 'center', fontSize: 13 }}>
                      Empty folder.
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Queue */}
            <div style={{ overflowY: 'auto', padding: 10 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 10px',
                }}
              >
                <h2 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', color: C.muted }}>
                  Queue {queue.tracks.length > 0 && `· ${queue.tracks.length}`}
                </h2>
                <button
                  onClick={clearQueue}
                  style={{
                    background: 'none',
                    border: `1px solid ${C.border}`,
                    color: C.muted,
                    fontSize: 11,
                    padding: '3px 9px',
                    borderRadius: 6,
                    cursor: 'pointer',
                  }}
                  title="Clear queue"
                >
                  Clear
                </button>
              </div>

              {queue.tracks.length === 0 ? (
                <div style={{ color: C.muted, padding: 24, textAlign: 'center', fontSize: 13 }}>
                  Queue is empty. Play something here, or ask the model to.
                </div>
              ) : (
                queue.tracks.map((t, i) => (
                  <div
                    key={i}
                    onClick={() => playTrack(i)}
                    style={{
                      padding: '9px 12px',
                      borderRadius: 7,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 13,
                      background: i === queue.current ? '#0d2035' : 'transparent',
                      boxShadow: i === queue.current ? `inset 3px 0 0 ${C.accent}` : 'none',
                    }}
                  >
                    <span style={{ color: i === queue.current ? C.accent : C.muted, width: 22, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {i + 1}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {esc(t.title)}
                    </span>
                    <span style={{ color: C.muted, marginLeft: 'auto', fontSize: 11, flex: 'none' }}>
                      {esc(t.album)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTrack(i);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: C.muted,
                        cursor: 'pointer',
                        fontSize: 13,
                        padding: '2px 4px',
                        lineHeight: 1,
                      }}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          </main>

          {/* Footer */}
          <footer
            style={{
              background: C.panel,
              borderTop: `1px solid #222`,
              padding: '6px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flex: 'none',
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, color: C.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentTrack?.title || 'Nothing playing'}
              </div>
              <div style={{ fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentTrack?.album || ''}
              </div>
            </div>
            <div style={{ flex: 2, display: 'flex', alignItems: 'center', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 11, color: C.muted }}>{fmt(currentTime)}</span>
              <input
                ref={seekRef}
                type="range"
                min="0"
                max="1000"
                value={duration > 0 ? (currentTime / duration) * 1000 : 0}
                onChange={handleSeek}
                style={{
                  flex: 1,
                  appearance: 'none',
                  height: 4,
                  background: '#2a2a2a',
                  borderRadius: 3,
                  outline: 'none',
                  cursor: 'pointer',
                }}
              />
              <span style={{ fontSize: 11, color: C.muted }}>{fmt(duration)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button
                onClick={toggleShuffle}
                style={{
                  background: 'none',
                  border: 'none',
                  color: shuffle ? C.accent : C.text,
                  fontSize: 15,
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                }}
                title="Shuffle"
              >
                🔀
              </button>
              <button
                onClick={prevTrack}
                style={{
                  background: 'none',
                  border: 'none',
                  color: C.text,
                  fontSize: 15,
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                }}
                title="Previous"
              >
                ⏮
              </button>
              <button
                onClick={togglePlayPause}
                style={{
                  background: C.accent,
                  color: '#08130d',
                  fontSize: 15,
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: '50%',
                  cursor: 'pointer',
                }}
                title="Play/Pause"
              >
                {queue.paused ? '▶' : '⏸'}
              </button>
              <button
                onClick={nextTrack}
                style={{
                  background: 'none',
                  border: 'none',
                  color: C.text,
                  fontSize: 15,
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                }}
                title="Next"
              >
                ⏭
              </button>
              <button
                onClick={toggleRepeat}
                style={{
                  background: 'none',
                  border: 'none',
                  color: repeat ? C.accent : C.text,
                  fontSize: 15,
                  cursor: 'pointer',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                }}
                title="Repeat"
              >
                🔁
              </button>
            </div>
            <input
              ref={volRef}
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={handleVolumeChange}
              style={{ width: 90 }}
              title="Volume"
            />
          </footer>
        </div>
      )}
    </>
  );
}

const plugin: UiPlugin = {
  id: 'music',
  title: 'Music Player',
  icon: '🎵',
  Component: MusicPlayer,
};

export default plugin;
