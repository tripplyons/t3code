import { describe, expect, it } from "vite-plus/test";
import type { ThreadActivityPreview } from "@t3tools/contracts";

import {
  advanceBoardPreviewRows,
  boardPreviewSignature,
  buildBoardPreviewIndex,
  initialBoardPreviewRows,
  settleBoardPreviewRows,
} from "./BoardActivityPreviews.logic";

function preview(
  createdAt: string,
  text: string,
  kind: ThreadActivityPreview["kind"] = "agent",
): ThreadActivityPreview {
  return { kind, text, createdAt };
}

// The server sends previews newest first; cards render them oldest first.
const newestFirst = [
  preview("2026-09-19T12:00:02.000Z", "third"),
  preview("2026-09-19T12:00:01.000Z", "second"),
  preview("2026-09-19T12:00:00.000Z", "first"),
];

describe("buildBoardPreviewIndex", () => {
  it("orders previews oldest first and drops tool previews", () => {
    const index = buildBoardPreviewIndex([
      preview("2026-09-19T12:00:02.000Z", "ran tests", "tool"),
      ...newestFirst,
    ]);
    expect([...index.values()].map((entry) => entry.text)).toEqual(["first", "second", "third"]);
  });

  it("keys a preview by arrival so streaming text does not change its identity", () => {
    const streaming = [preview("2026-09-19T12:00:02.000Z", "thir"), ...newestFirst.slice(1)];
    expect(boardPreviewSignature(buildBoardPreviewIndex(streaming))).toBe(
      boardPreviewSignature(buildBoardPreviewIndex(newestFirst)),
    );
  });

  it("separates previews that share a timestamp and kind", () => {
    const index = buildBoardPreviewIndex([
      preview("2026-09-19T12:00:00.000Z", "b"),
      preview("2026-09-19T12:00:00.000Z", "a"),
    ]);
    expect(index.size).toBe(2);
  });
});

describe("advanceBoardPreviewRows", () => {
  it("holds the displaced row above the arrival for one beat", () => {
    const rows = initialBoardPreviewRows(buildBoardPreviewIndex(newestFirst));
    expect(rows.map((row) => row.phase)).toEqual(["steady", "steady", "steady"]);

    const next = [preview("2026-09-19T12:00:03.000Z", "fourth"), ...newestFirst.slice(0, 2)];
    const advanced = advanceBoardPreviewRows(rows, buildBoardPreviewIndex(next));
    expect(advanced.map((row) => [row.preview.text, row.phase] as const)).toEqual([
      ["first", "exiting"],
      ["second", "steady"],
      ["third", "steady"],
      ["fourth", "entering"],
    ]);
  });

  it("drops a row still exiting when the next preview arrives", () => {
    const rows = advanceBoardPreviewRows(
      initialBoardPreviewRows(buildBoardPreviewIndex(newestFirst)),
      buildBoardPreviewIndex([
        preview("2026-09-19T12:00:03.000Z", "fourth"),
        ...newestFirst.slice(0, 2),
      ]),
    );
    const next = [
      preview("2026-09-19T12:00:04.000Z", "fifth"),
      preview("2026-09-19T12:00:03.000Z", "fourth"),
      preview("2026-09-19T12:00:02.000Z", "third"),
    ];
    const advanced = advanceBoardPreviewRows(rows, buildBoardPreviewIndex(next));
    expect(advanced.map((row) => [row.preview.text, row.phase] as const)).toEqual([
      ["second", "exiting"],
      ["third", "steady"],
      ["fourth", "steady"],
      ["fifth", "entering"],
    ]);
  });

  it("collapses the oldest row when an unrendered tool preview pushes it out", () => {
    const rows = initialBoardPreviewRows(buildBoardPreviewIndex(newestFirst));
    const next = [
      preview("2026-09-19T12:00:03.000Z", "ran tests", "tool"),
      ...newestFirst.slice(0, 2),
    ];
    const advanced = advanceBoardPreviewRows(rows, buildBoardPreviewIndex(next));
    expect(advanced.map((row) => [row.preview.text, row.phase] as const)).toEqual([
      ["first", "exiting"],
      ["second", "steady"],
      ["third", "steady"],
    ]);
  });
});

describe("settleBoardPreviewRows", () => {
  it("drops finished exits and stops arrivals animating", () => {
    const rows = advanceBoardPreviewRows(
      initialBoardPreviewRows(buildBoardPreviewIndex(newestFirst)),
      buildBoardPreviewIndex([
        preview("2026-09-19T12:00:03.000Z", "fourth"),
        ...newestFirst.slice(0, 2),
      ]),
    );
    const settled = settleBoardPreviewRows(rows);
    expect(settled.map((row) => [row.preview.text, row.phase] as const)).toEqual([
      ["second", "steady"],
      ["third", "steady"],
      ["fourth", "steady"],
    ]);
  });

  it("keeps a settled stack identical so the timer cannot loop", () => {
    const rows = initialBoardPreviewRows(buildBoardPreviewIndex(newestFirst));
    expect(settleBoardPreviewRows(rows)).toBe(rows);
  });
});
