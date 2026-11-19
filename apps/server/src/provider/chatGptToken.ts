import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const Claims = Schema.fromJsonString(
  Schema.Struct({
    exp: Schema.optionalKey(Schema.Finite),
    "https://api.openai.com/auth": Schema.optionalKey(
      Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
    ),
  }),
);
const decodeClaims = Schema.decodeUnknownOption(Claims);

/**
 * Reads, without verifying, the claims of a ChatGPT access token that the caller already trusts.
 * Codex app-server hands these tokens over; T3 only needs their expiry and workspace.
 */
export function chatGptTokenClaims(token: string) {
  const payload = Result.getOrUndefined(Base64Url.decodeString(token.split(".")[1] ?? ""));
  const claims = payload === undefined ? undefined : Option.getOrUndefined(decodeClaims(payload));
  return {
    expiresAtMs: claims?.exp === undefined ? undefined : claims.exp * 1000,
    accountId: claims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() || undefined,
  };
}
