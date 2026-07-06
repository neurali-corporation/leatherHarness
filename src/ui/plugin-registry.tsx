/// <reference types="vite/client" />
// Frontend UI-plugin architecture.
//
// A plugin contributes UI to the single-page app by placing a `ui.tsx` next to
// its server-side `index.ts` that default-exports a `UiPlugin` descriptor. Vite
// discovers every such file at build time (the glob below), so a plugin's UI
// lives with the rest of the plugin code — there is no central import list to
// keep in sync.
//
// Every plugin component is mounted for the whole lifetime of the app and told
// via `open` whether its modal should be visible. That means a plugin can own
// persistent state (e.g. an <audio> element that keeps playing) that survives
// the user opening and closing its window.

import type React from 'react';

export interface UiPluginProps {
  /** Whether the plugin's window/modal should be visible right now. */
  open: boolean;
  /** Ask the app to close this plugin's window (does not unmount the plugin). */
  onClose: () => void;
}

export interface UiPlugin {
  /** Stable unique id (also used as the React key). */
  id: string;
  /** Label for the toolbar button / accessible name. */
  title: string;
  /** Emoji or short glyph shown on the toolbar button. */
  icon: string;
  /** Rendered (always mounted) with the current open state. */
  Component: React.FC<UiPluginProps>;
}

// Eagerly bundle every plugin UI. The path is relative to the Vite project root
// (the repo root), so `/plugins/<name>/ui.tsx` matches each plugin folder.
const modules = import.meta.glob<{ default: UiPlugin }>('/plugins/*/ui.tsx', { eager: true });

export const uiPlugins: UiPlugin[] = Object.values(modules)
  .map((m) => m.default)
  .filter(
    (p): p is UiPlugin =>
      !!p && typeof p.id === 'string' && typeof p.Component === 'function',
  )
  .sort((a, b) => a.title.localeCompare(b.title));
