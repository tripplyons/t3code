import { useEffect, useMemo, useState } from "react";
import type { ThreadActivityPreview } from "@t3tools/contracts";

import {
  BOARD_PREVIEW_TRANSITION_MS,
  advanceBoardPreviewRows,
  boardPreviewSignature,
  buildBoardPreviewIndex,
  initialBoardPreviewRows,
  settleBoardPreviewRows,
} from "./BoardActivityPreviews.logic";

/**
 * The recent agent and thinking previews on a board card. When a new preview
 * lands, the stack reads as scrolling up: the displaced row slides out the top
 * while the arrival rises into the space it leaves.
 */
export function BoardActivityPreviews({
  previews,
}: {
  previews: readonly ThreadActivityPreview[] | undefined;
}) {
  const index = useMemo(() => buildBoardPreviewIndex(previews), [previews]);
  const signature = boardPreviewSignature(index);
  const [rows, setRows] = useState(() => initialBoardPreviewRows(index));
  const [animatedSignature, setAnimatedSignature] = useState(signature);
  if (animatedSignature !== signature) {
    setAnimatedSignature(signature);
    setRows((current) => advanceBoardPreviewRows(current, index));
  }
  // Keyed by signature so a burst restarts the timer instead of settling the
  // newest slide early.
  const settling = rows.some((row) => row.phase !== "steady") ? animatedSignature : null;
  useEffect(() => {
    if (settling === null) return;
    const timer = window.setTimeout(
      () => setRows(settleBoardPreviewRows),
      BOARD_PREVIEW_TRANSITION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settling]);

  return (
    <>
      {rows.map((row) => {
        // Rows hold the preview they arrived with; the live one keeps the
        // newest row current while the agent streams into it.
        const preview = index.get(row.key) ?? row.preview;
        return (
          <div key={row.key} data-phase={row.phase} className="board-preview-row grid">
            <div className="min-h-0 overflow-hidden">
              <div className="board-preview-row-body mt-2 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  {preview.kind === "reasoning" ? "Thinking" : "Agent"}
                </span>
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words">{preview.text}</p>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
