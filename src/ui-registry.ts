// Lets any plugin contribute clickable icons to the web UI. Each icon carries a
// server-side function that runs when the user clicks it; its return value tells
// the UI what to do next (open a URL, navigate, or show a message).

export interface UiActionResult {
  /** Open this URL in a new browser tab. */
  open?: string;
  /** Open this URL in a full-screen overlay (iframe) inside the SPA. */
  overlay?: string;
  /** Navigate the current tab to this URL. */
  navigate?: string;
  /** Show this text to the user (toast). */
  message?: string;
}

export interface UiIcon {
  /** Stable unique id (used in the action endpoint). */
  id: string;
  /** Tooltip / accessible label. */
  title: string;
  /** Emoji or short glyph shown in the toolbar. */
  icon: string;
  /** Runs on click. */
  run: () => UiActionResult | Promise<UiActionResult>;
}

const icons = new Map<string, UiIcon>();

export function registerUiIcon(icon: UiIcon): void {
  if (!icon.id) throw new Error('UI icon requires an id');
  if (icons.has(icon.id)) throw new Error(`UI icon already registered: ${icon.id}`);
  if (typeof icon.run !== 'function') throw new Error(`UI icon "${icon.id}" run must be a function`);
  icons.set(icon.id, icon);
}

/** Metadata for the UI to render (no functions). */
export function uiIconList(): { id: string; title: string; icon: string }[] {
  return [...icons.values()].map(({ id, title, icon }) => ({ id, title, icon }));
}

/** Invoke a registered icon's function and return what the UI should do. */
export async function runUiIcon(id: string): Promise<UiActionResult> {
  const entry = icons.get(id);
  if (!entry) throw new Error(`No such UI icon: ${id}`);
  return await entry.run();
}

export default { registerUiIcon, uiIconList, runUiIcon };
