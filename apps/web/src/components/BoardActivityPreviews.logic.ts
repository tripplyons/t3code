import type { ThreadActivityPreview } from "@t3tools/contracts";

/** Matches the enter/exit pair on .board-preview-row in index.css. */
export const BOARD_PREVIEW_TRANSITION_MS = 260;

export type BoardPreviewRow = {
  readonly key: string;
  readonly preview: ThreadActivityPreview;
  readonly phase: "steady" | "entering" | "exiting";
};

/**
 * The previews a board card shows, oldest first, keyed by identity rather than
 * position. Tool previews have no card treatment. A key ignores the text so the
 * newest row keeps its identity while the agent streams into it, and repeated
 * timestamps take a suffix so a burst still yields distinct keys.
 */
export function buildBoardPreviewIndex(
  previews: readonly ThreadActivityPreview[] | undefined,
): ReadonlyMap<string, ThreadActivityPreview> {
  const index = new Map<string, ThreadActivityPreview>();
  for (const preview of (previews ?? []).filter((entry) => entry.kind !== "tool").toReversed()) {
    const base = `${preview.createdAt}|${preview.kind}`;
    let key = base;
    for (let repeat = 1; index.has(key); repeat += 1) key = `${base}|${repeat}`;
    index.set(key, preview);
  }
  return index;
}

export function boardPreviewSignature(index: ReadonlyMap<string, ThreadActivityPreview>) {
  return [...index.keys()].join("\n");
}

/** First paint of a card is not an arrival, so nothing animates. */
export function initialBoardPreviewRows(
  index: ReadonlyMap<string, ThreadActivityPreview>,
): readonly BoardPreviewRow[] {
  return [...index].map(([key, preview]) => ({ key, preview, phase: "steady" }));
}

/**
 * Keeps displaced rows at the top of the stack for one beat, so they can slide
 * up and collapse while the arrivals open below them.
 */
export function advanceBoardPreviewRows(
  rows: readonly BoardPreviewRow[],
  index: ReadonlyMap<string, ThreadActivityPreview>,
): readonly BoardPreviewRow[] {
  const held = rows.filter((row) => row.phase !== "exiting");
  const heldKeys = new Set(held.map((row) => row.key));
  const leaving = held
    .filter((row) => !index.has(row.key))
    .map((row): BoardPreviewRow => ({ ...row, phase: "exiting" }));
  const arriving = [...index].map(([key, preview]): BoardPreviewRow => ({
    key,
    preview,
    phase: heldKeys.has(key) ? "steady" : "entering",
  }));
  return [...leaving, ...arriving];
}

/** Drops finished exits and stops arrivals animating, leaving a static stack. */
export function settleBoardPreviewRows(
  rows: readonly BoardPreviewRow[],
): readonly BoardPreviewRow[] {
  if (rows.every((row) => row.phase === "steady")) return rows;
  return rows
    .filter((row) => row.phase !== "exiting")
    .map((row): BoardPreviewRow => (row.phase === "steady" ? row : { ...row, phase: "steady" }));
}
