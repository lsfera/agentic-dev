/**
 * Unit tests for context-compressor — the headroom-ai wrapper that shrinks
 * compiled prompts before they reach the agent.
 *
 * All tests set / restore process.env.HEADROOM_MODE around each assertion so
 * they are order-independent (getHeadroomMode() reads the env var at call time,
 * not at module load time, which is what makes this possible).
 *
 * Run: npm test (picks up all *.test.ts files listed in the test script)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getHeadroomMode,
  getCompressionCallback,
  isCompressionActive,
} from "./context-compressor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withMode(mode: string | undefined, fn: () => void): void {
  const orig = process.env.HEADROOM_MODE;
  if (mode === undefined) {
    delete process.env.HEADROOM_MODE;
  } else {
    process.env.HEADROOM_MODE = mode;
  }
  try {
    fn();
  } finally {
    if (orig === undefined) {
      delete process.env.HEADROOM_MODE;
    } else {
      process.env.HEADROOM_MODE = orig;
    }
  }
}

// ---------------------------------------------------------------------------
// getHeadroomMode
// ---------------------------------------------------------------------------

test("getHeadroomMode returns 'off' when HEADROOM_MODE is unset", () => {
  withMode(undefined, () => {
    assert.equal(getHeadroomMode(), "off");
  });
});

test("getHeadroomMode returns 'conservative' when HEADROOM_MODE=conservative", () => {
  withMode("conservative", () => {
    assert.equal(getHeadroomMode(), "conservative");
  });
});

test("getHeadroomMode returns 'aggressive' when HEADROOM_MODE=aggressive", () => {
  withMode("aggressive", () => {
    assert.equal(getHeadroomMode(), "aggressive");
  });
});

// ---------------------------------------------------------------------------
// isCompressionActive
// ---------------------------------------------------------------------------

test("isCompressionActive returns false when HEADROOM_MODE is unset (default off)", () => {
  withMode(undefined, () => {
    assert.equal(isCompressionActive(), false);
  });
});

test("isCompressionActive returns true when HEADROOM_MODE=conservative", () => {
  withMode("conservative", () => {
    assert.equal(isCompressionActive(), true);
  });
});

test("isCompressionActive returns true when HEADROOM_MODE=aggressive", () => {
  withMode("aggressive", () => {
    assert.equal(isCompressionActive(), true);
  });
});

// ---------------------------------------------------------------------------
// getCompressionCallback — structural shape tests (no live headroom-ai call)
// ---------------------------------------------------------------------------

test("getCompressionCallback returns undefined when HEADROOM_MODE is off (default off)", () => {
  withMode(undefined, () => {
    assert.equal(getCompressionCallback(), undefined);
  });
});

test("getCompressionCallback returns a function when HEADROOM_MODE=conservative", () => {
  withMode("conservative", () => {
    const cb = getCompressionCallback();
    assert.equal(typeof cb, "function");
  });
});

test("getCompressionCallback returns a function when HEADROOM_MODE=aggressive", () => {
  withMode("aggressive", () => {
    const cb = getCompressionCallback();
    assert.equal(typeof cb, "function");
  });
});

test("getCompressionCallback returns an async function (returns a Promise)", () => {
  withMode("conservative", () => {
    const cb = getCompressionCallback();
    assert.ok(cb !== undefined);
    // An async function always returns a Promise synchronously, before any
    // `await` inside it (here, the dynamic `import("headroom-ai")`) resolves
    // or rejects — so this holds regardless of whether headroom-ai succeeds.
    const result = cb("test prompt");
    assert.ok(result instanceof Promise, "callback must return a Promise");
    // Consume any rejection so node:test doesn't treat it as an unhandled error.
    result.catch(() => {});
  });
});
