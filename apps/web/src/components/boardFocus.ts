/**
 * The board's keyboard home is the selected row. A board command that finishes, a popup that
 * closes, and focus that is lost all return here, so the next key acts on the row on screen.
 */
export const boardHomeRow = () =>
  document.querySelector<HTMLElement>("[data-board-row][aria-current]");

export function focusBoardHome() {
  const row = boardHomeRow();
  row?.focus({ preventScroll: true });
  return row !== null;
}
