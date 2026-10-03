import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";

export const THREAD_ACTIVITY_PREVIEW_MAX_CHARS = 240;
export const THREAD_ACTIVITY_PREVIEW_COUNT = 3;
export const ThreadActivityPreview = Schema.Struct({
  kind: Schema.Literals(["agent", "reasoning", "tool"]),
  text: Schema.String.check(Schema.isMaxLength(THREAD_ACTIVITY_PREVIEW_MAX_CHARS * 2)),
  createdAt: IsoDateTime,
});
export type ThreadActivityPreview = typeof ThreadActivityPreview.Type;
