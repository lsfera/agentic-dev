/** Webhook signature validation and the smee.io SSE listener. Extracted from main.ts; re-exported there for existing consumers. */
import * as https from "node:https";
import * as http from "node:http";
import { Effect, Layer } from "effect";
import { Mac, SecureRandom } from "effect/crypto";

/** Web-Crypto-backed HMAC service (Effect's crypto module). */
export const MacLive = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

export const SIGNATURE_RE = /^sha256=([0-9a-fA-F]{64})$/;

export const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/**
 * Constant-time HMAC-SHA256 validation for GitHub webhook signatures.
 * `signature` is the raw X-Hub-Signature-256 header value (`sha256=<hex>`).
 * Malformed signatures (wrong prefix/length/non-hex) are simply `false`, as is
 * any crypto failure — the result is advisory (see classifyDelivery).
 */
export const validateSignatureEffect = (
  secret: string,
  rawBody: string,
  signature: string,
): Effect.Effect<boolean> => {
  const match = SIGNATURE_RE.exec(signature);
  if (!match) return Effect.succeed(false);
  const encoder = new TextEncoder();
  return Effect.gen(function* () {
    const mac = yield* Mac.Mac;
    const key = yield* Mac.key(Mac.hmacSha256, encoder.encode(secret));
    return yield* mac.verify(key, hexToBytes(match[1]), encoder.encode(rawBody));
  }).pipe(Effect.provide(MacLive), Effect.orElseSucceed(() => false));
};

export const validateSignature = (secret: string, rawBody: string, signature: string): Promise<boolean> =>
  Effect.runPromise(validateSignatureEffect(secret, rawBody, signature));

/** Outcome of checking a smee-relayed delivery's signature (#26). */
export type SignatureVerdict = "verified" | "mismatch" | "missing-signature" | "no-secret";

/**
 * Advisory signature check for a smee-relayed webhook delivery.
 *
 * AUTH MODEL (#26): the unguessable smee channel URL is the real trust boundary,
 * NOT the HMAC. smee re-parses and re-serializes the request body before
 * relaying it, so the raw bytes GitHub signed are gone by the time we see it.
 * Re-stringifying the parsed body reproduces GitHub's exact bytes for *most*
 * payloads, but not all: e.g. JSON numbers are reformatted (`1.0`→`1`, `5e2`→
 * `500`), which makes a strict HMAC reject a perfectly genuine delivery. We
 * therefore compute the verdict for observability but NEVER hard-reject on it —
 * the caller logs and proceeds. (To restore strict HMAC as a gate, put a
 * raw-body-preserving relay in front of the orchestrator instead of smee.)
 */
export const classifyDeliveryEffect = (
  secret: string | undefined,
  reserializedBody: string,
  signature: string | undefined,
): Effect.Effect<SignatureVerdict> => {
  if (!secret) return Effect.succeed("no-secret");
  if (!signature) return Effect.succeed("missing-signature");
  return validateSignatureEffect(secret, reserializedBody, signature).pipe(
    Effect.map((ok): SignatureVerdict => (ok ? "verified" : "mismatch")),
  );
};

export const classifyDelivery = (
  secret: string | undefined,
  reserializedBody: string,
  signature: string | undefined,
): Promise<SignatureVerdict> => Effect.runPromise(classifyDeliveryEffect(secret, reserializedBody, signature));

/** Pure: should a delivery with this signature verdict be processed? Advisory mode
 *  always processes; strict mode requires a verified signature. */
export const shouldProcessDelivery = (verdict: SignatureVerdict, strict: boolean): boolean =>
  !strict || verdict === "verified";

export type SmeeHandler = (
  body: unknown,
  headers: Record<string, string>,
  deliveryId: string,
) => void | Promise<void>;

export interface SmeeEvent {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly deliveryId: string;
}

/**
 * Parse one smee.io SSE `data:` JSON payload into body + normalized headers.
 *
 * smee flattens the original webhook headers to the TOP LEVEL of the payload,
 * alongside `body` (and its own `query`/`timestamp` fields) — it does NOT nest
 * them under a `headers` key. Reading headers from a `headers` sub-object
 * therefore finds nothing, so the listener's `x-github-event` check never
 * matches and every delivery is silently dropped — only the reconcile poll
 * fires. Confirmed against a live GitHub→smee delivery (#26).
 *
 * Both shapes are supported: a nested `headers` object when present (some
 * relays), otherwise every top-level key except smee's wrapper fields is taken
 * as a header. Keys are lowercased; array values take the first element.
 */
export function parseSmeeEvent(rawData: string): SmeeEvent {
  const parsed = JSON.parse(rawData) as Record<string, unknown>;
  const body = parsed["body"] ?? parsed;

  const WRAPPER_KEYS = new Set(["body", "query", "timestamp"]);
  const nested = parsed["headers"];
  const rawHdrs: Record<string, unknown> =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : Object.fromEntries(Object.entries(parsed).filter(([k]) => !WRAPPER_KEYS.has(k)));

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHdrs)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? String((v as unknown[])[0]) : String(v);
  }
  return { body, headers, deliveryId: headers["x-github-delivery"] ?? "" };
}

/**
 * Subscribe to a smee.io (or compatible) SSE channel and invoke the handler
 * on each webhook delivery. Reconnects automatically on disconnect.
 *
 * The caller is responsible for HMAC de-dupe; this function only parses the
 * SSE stream and validates the signature when `secret` is provided.
 */
export function startSmeeListener(
  smeeUrl: string,
  secret: string | undefined,
  handler: SmeeHandler,
  opts: { strict?: boolean } = {},
): void {
  const connect = () => {
    const lib = smeeUrl.startsWith("https://") ? https : (http as unknown as typeof https);
    const req = lib.get(
      smeeUrl,
      {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
      (res) => {
        console.log(`[smee] connected (HTTP ${res.statusCode})`);
        let buf = "";
        let dataLines: string[] = [];
        let eventType = "message";

        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.length > 5 && line[5] === " " ? line.slice(6) : line.slice(5));
            } else if (line.trim() === "") {
              if (dataLines.length > 0 && eventType === "message") {
                const rawData = dataLines.join("\n");
                try {
                  const { body, headers, deliveryId } = parseSmeeEvent(rawData);

                  // Signature policy (ADR-0008): advisory by default — the secret
                  // channel URL is the trust boundary and smee's body
                  // re-serialization means a strict HMAC can drop genuine
                  // deliveries (#26). With opts.strict (WEBHOOK_SIGNATURE_STRICT=1)
                  // anything but a verified signature is dropped; the periodic
                  // reconcile poll recovers any genuine delivery lost this way.
                  void Effect.runPromise(
                    classifyDeliveryEffect(secret, JSON.stringify(body), headers["x-hub-signature-256"]),
                  ).then((verdict) => {
                    if (!shouldProcessDelivery(verdict, opts.strict === true)) {
                      console.warn(
                        `[smee] dropping delivery ${deliveryId || "(no id)"}: signature ${verdict} ` +
                          "(strict mode; the reconcile poll will pick up genuine merges)",
                      );
                      return;
                    }
                    if (verdict === "mismatch") {
                      console.warn(
                        "[smee] HMAC mismatch — likely smee body re-serialization, " +
                          "not forgery; processing anyway (channel URL is the trust boundary, #26)",
                      );
                    } else if (verdict === "missing-signature") {
                      console.warn(
                        "[smee] no X-Hub-Signature-256 header; processing anyway " +
                          "(channel URL is the trust boundary, #26)",
                      );
                    }
                    void handler(body, headers, deliveryId);
                  });
                } catch (e) {
                  console.error("[smee] failed to parse event:", e);
                }
              }
              dataLines = [];
              eventType = "message";
            }
          }
        });

        res.on("end", () => {
          console.log("[smee] connection closed — reconnecting in 5s");
          setTimeout(connect, 5_000);
        });

        res.on("error", (err: Error) => {
          console.error(`[smee] stream error: ${err.message}`);
          setTimeout(connect, 5_000);
        });
      },
    );

    req.on("error", (err: Error) => {
      console.error(`[smee] connection error: ${err.message}`);
      setTimeout(connect, 5_000);
    });

    req.setTimeout(0);
  };

  console.log(`[smee] connecting to ${smeeUrl}`);
  connect();
}

