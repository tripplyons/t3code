import { useEffect, useState } from "react";
import {
  THREAD_ACTIVITY_PREVIEW_MAX_CHARS,
  type ScopedThreadRef,
  type ThreadActivityPreview,
} from "@t3tools/contracts";

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
  const [overflowing, setOverflowing] = useState(false);
  const observeClip = (clip: HTMLDivElement | null) => {
    const content = clip?.firstElementChild;
    if (!clip || !content) return;
    return observeResize(content, () => setOverflowing(clip.scrollHeight > clip.clientHeight));
  };
  // The server cuts previews at this length, so a full one has more to show.
  const cut = Array.from(preview.text).length >= THREAD_ACTIVITY_PREVIEW_MAX_CHARS;
  return (
    <>
      {expanded ? (
        <BoardPreviewFullText preview={preview} cwd={cwd} threadRef={threadRef} />
      ) : (
        <div ref={observeClip} className="max-h-40 overflow-hidden">
          <div>
            <ChatMarkdown
              text={preview.text}
              cwd={cwd}
              threadRef={threadRef}
              environmentId={threadRef.environmentId}
              parseRawHtml={false}
            />
          </div>
        </div>
      )}
      {expanded || cut || overflowing ? (
        <Button size="micro" variant="ghost-muted" aria-expanded={expanded} onClick={onToggle}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </>
  );
}

/** Subscribes to the streamed thread detail only while a row is expanded. */
function BoardPreviewFullText({
  preview,
  cwd,
  threadRef,
}: {
  preview: ThreadActivityPreview;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}) {
  const rows = useThreadVisibleTurnItems(threadRef);
  return (
    <ChatMarkdown
      text={findBoardPreviewSourceText(rows, preview) ?? preview.text}
      cwd={cwd}
      threadRef={threadRef}
      environmentId={threadRef.environmentId}
      parseRawHtml={false}
    />
  );
}
