import { useEffect, useEffectEvent } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";

const BOARD_KEYS = new Set([
  "j",
  "k",
  "arrowdown",
  "arrowup",
  "enter",
  "e",
  "l",
  "r",
  "z",
  ..."123456789",
]);

/** Board keys apply only while focus rests on the board itself or on nothing at all. */
function boardShortcutKey(event: KeyboardEvent): string | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (!BOARD_KEYS.has(key) || isCommandPaletteOpen()) return null;
  const target = event.target;
  if (target === document.body) return key;
  if (!(target instanceof HTMLElement) || !target.closest("[data-board-root]")) return null;
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))
    return null;
  if (target.closest("[role='dialog'], [role='menu']")) return null;
  // Enter and digits keep their meaning on the card's own buttons and links.
  if ((key === "enter" || /^[1-9]$/.test(key)) && !target.closest("[data-board-row]")) {
    if (target.closest("button, a")) return null;
  }
  return key;
}

export function useBoardShortcuts(handler: (key: string, event: KeyboardEvent) => void) {
  const onKey = useEffectEvent(handler);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Board keys listen on the window only while the board is mounted.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const key = boardShortcutKey(event);
      if (key !== null) onKey(key, event);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
