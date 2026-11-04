import "~/index.css";

import { EnvironmentId, ThreadId, type ThreadActivityPreview } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { makeStreamingTimelineFixture } from "../test-fixtures";
import { BoardActivityPreviews } from "./BoardActivityPreviews";

const state = vi.hoisted(() => ({ rows: [] as readonly unknown[] }));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadVisibleTurnItems: (() => state.rows) as never,
}));

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function card(text: string, createdAt = "2026-01-01T00:00:00.000Z") {
  const previews: ThreadActivityPreview[] = [{ kind: "agent", text, createdAt }];
  return (
    <div style={{ width: 300 }}>
      <BoardActivityPreviews previews={previews} cwd={undefined} threadRef={threadRef} />
    </div>
  );
}

function setup(rows: readonly unknown[] = []) {
  state.rows = rows;
}

const showMore = { name: "Show more" };

it("offers Show more only past three visible lines", async () => {
  setup();
  for (const [text, overflows] of [
    ["word", false],
    ["a\n\nb\n\nc", false],
    ["a\n\nb\n\nc\n\nd", true],
    ["word ".repeat(100), true],
    ["```ts\n1\n2\n3\n4\n5\n6\n7\n8\n```", true],
    ["| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |", true],
  ] as const) {
    await using screen = await render(card(text));
    await vi.waitFor(() => expect(document.querySelector(".chat-markdown")).not.toBeNull());
    if (overflows) await expect.element(screen.getByRole("button", showMore)).toBeVisible();
    else await expect.element(screen.getByRole("button", showMore)).not.toBeInTheDocument();
  }
});

it("clips wrapped text to three lines and expands it", async () => {
  setup();
  await using screen = await render(card("word ".repeat(100)));
  await screen.getByRole("button", showMore).click();
  const markdown = document.querySelector<HTMLElement>(".chat-markdown")!;
  const lineHeight = Number.parseFloat(getComputedStyle(markdown).lineHeight);
  await expect.element(screen.getByRole("button", { name: "Show less" })).toBeVisible();
  expect(markdown.parentElement!.clientHeight).toBeGreaterThan(lineHeight * 3);
  await screen.getByRole("button", { name: "Show less" }).click();
  await expect.element(screen.getByRole("button", showMore)).toBeVisible();
  expect(markdown.parentElement!.clientHeight).toBeLessThan(lineHeight * 3 + 1);
});

it("clips the full message, not the short server preview", async () => {
  const full = "word ".repeat(400);
  const { visibleTurnItems, time } = makeStreamingTimelineFixture(full);
  setup(visibleTurnItems);
  await using screen = await render(card("word", time(7)));
  await expect.element(screen.getByRole("button", showMore)).toBeVisible();
});

it("offers Show more when streaming text grows past three lines", async () => {
  setup();
  await using screen = await render(card("word"));
  await vi.waitFor(() => expect(document.querySelector(".chat-markdown")).not.toBeNull());
  await expect.element(screen.getByRole("button", showMore)).not.toBeInTheDocument();
  await screen.rerender(card("word ".repeat(100)));
  await expect.element(screen.getByRole("button", showMore)).toBeVisible();
});
