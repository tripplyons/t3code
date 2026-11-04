import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScopedThreadRef, ThreadActivityPreview } from "@t3tools/contracts";

import { observeResize } from "../lib/observeResize";
import { useThreadVisibleTurnItems } from "../state/entities";
import ChatMarkdown from "./ChatMarkdown";
import {
  BOARD_PREVIEW_TRANSITION_MS,
  advanceBoardPreviewRows,
  boardPreviewSignature,
  buildBoardPreviewIndex,
  findBoardPreviewSourceText,
  initialBoardPreviewRows,
  settleBoardPreviewRows,
} from "./BoardActivityPreviews.logic";
import { Button } from "./ui/button";

/**
 * The recent agent and thinking previews on a board card. When a new preview
 * lands, the stack reads as scrolling up: the displaced row slides out the top
 * while the arrival rises into the space it leaves.
 */
export function BoardActivityPreviews({
  previews,
  cwd,
  threadRef,
}: {
  previews: readonly ThreadActivityPreview[] | undefined;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const index = buildBoardPreviewIndex(previews);
  const signature = boardPreviewSignature(index);
  const [rows, setRows] = useState(() => initialBoardPreviewRows(index));
  const [animatedSignature, setAnimatedSignature] = useState(signature);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  if (animatedSignature !== signature) {
    setAnimatedSignature(signature);
    setRows((current) => advanceBoardPreviewRows(current, index));
  }
  // Keyed by signature so a burst restarts the timer instead of settling the
  // newest slide early.
  const settling = rows.some((row) => row.phase !== "steady") ? animatedSignature : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the transition timer so interrupted animations settle only after the latest arrival.
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
              <div className="board-preview-row-body mt-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {preview.kind === "reasoning" ? "Thinking" : "Agent"}
                </p>
                <BoardPreviewBody
                  preview={preview}
                  expanded={expandedKeys.has(row.key)}
                  onToggle={() =>
                    setExpandedKeys((current) => {
                      const next = new Set(current);
                      if (!next.delete(row.key)) next.add(row.key);
                      return next;
                    })
                  }
                  cwd={cwd}
                  threadRef={threadRef}
                />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

// Far past three lines at any card width, so a long message stops reparsing once it is clipped.
const COLLAPSED_TEXT_LIMIT = 2000;

const isClipped = (clip: HTMLElement) => clip.scrollHeight > clip.clientHeight;

function BoardPreviewBody({
  preview,
  expanded,
  onToggle,
  cwd,
  threadRef,
}: {
  preview: ThreadActivityPreview;
  expanded: boolean;
  onToggle: () => void;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const rows = useThreadVisibleTurnItems(threadRef);
  const text = findBoardPreviewSourceText(rows, preview) ?? preview.text;
  const displayedText = expanded ? text : text.slice(0, COLLAPSED_TEXT_LIMIT);
  const clipRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Width changes rewrap the text, which only the DOM can measure.
  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (clip) return observeResize(clip, () => setOverflowing(isClipped(clip)));
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A clamped box keeps its height as text grows, so a resize observer misses it; measure after each render.
  useLayoutEffect(() => {
    if (clipRef.current) setOverflowing(isClipped(clipRef.current));
  });
  return (
    <>
      {/* Clamping skips code blocks and tables, so the height cap bounds those. */}
      <div ref={clipRef} className={expanded ? undefined : "line-clamp-3 max-h-28"}>
        <ChatMarkdown
          text={displayedText}
          cwd={cwd}
          threadRef={threadRef}
          environmentId={threadRef.environmentId}
          parseRawHtml={false}
        />
      </div>
      {expanded || overflowing ? (
        <Button size="micro" variant="ghost-muted" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </>
  );
}
