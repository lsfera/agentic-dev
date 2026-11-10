import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_FAILED_MARKER, RETRIES_EXHAUSTED_MARKER, countPriorFailures, attemptFailedComment, exhaustedComment,
} from "./attempts.ts";

test("no comments → 0", () => assert.equal(countPriorFailures([]), 0));

test("counts attempt-failed markers, ignores other comments", () => {
  assert.equal(countPriorFailures(["hi", attemptFailedComment(1, 2), "note"]), 1);
  assert.equal(countPriorFailures([attemptFailedComment(1, 2), attemptFailedComment(2, 2)]), 2);
});

test("an exhausted marker resets the count (human re-queue starts fresh)", () => {
  assert.equal(
    countPriorFailures([attemptFailedComment(1, 2), exhaustedComment("gave up"), attemptFailedComment(1, 2)]),
    1,
  );
  assert.equal(countPriorFailures([attemptFailedComment(1, 2), exhaustedComment("gave up")]), 0);
});

test("markers are hidden HTML comments embedded in the body", () => {
  assert.ok(attemptFailedComment(1, 2).startsWith(ATTEMPT_FAILED_MARKER));
  assert.ok(exhaustedComment("x").endsWith(RETRIES_EXHAUSTED_MARKER));
});
