import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRanges, coveredBytes, isComplete, safeName, isSha256Hex, type Range } from "../src/protocol.js";

test("mergeRanges merges overlapping and adjacent ranges", () => {
  assert.deepEqual(mergeRanges([[0, 4], [5, 9]]), [[0, 9]]);        // adjacent
  assert.deepEqual(mergeRanges([[0, 5], [3, 9]]), [[0, 9]]);        // overlapping
  assert.deepEqual(mergeRanges([[10, 19], [0, 4]]), [[0, 4], [10, 19]]); // disjoint, sorted
  assert.deepEqual(mergeRanges([]), []);
});

test("coveredBytes sums merged coverage without double counting", () => {
  assert.equal(coveredBytes([[0, 4], [5, 9]]), 10);
  assert.equal(coveredBytes([[0, 5], [3, 9]]), 10);
  assert.equal(coveredBytes([]), 0);
});

test("isComplete only true when [0,size) is fully covered", () => {
  assert.equal(isComplete([[0, 9]], 10), true);
  assert.equal(isComplete([[0, 8]], 10), false);
  assert.equal(isComplete([[1, 9]], 10), false);
  assert.equal(isComplete([[0, 4], [5, 9]], 10), true);
  assert.equal(isComplete([], 0), true); // empty file
});

test("safeName strips path traversal and control chars", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("C:\\Windows\\evil.exe"), "evil.exe");
  assert.equal(safeName("plain.md"), "plain.md");
  assert.equal(safeName(".."), "download.bin");
  assert.equal(safeName(""), "download.bin");
});

test("isSha256Hex validates 64-char lowercase hex", () => {
  assert.equal(isSha256Hex("a".repeat(64)), true);
  assert.equal(isSha256Hex("A".repeat(64)), false); // uppercase
  assert.equal(isSha256Hex("a".repeat(63)), false);
  assert.equal(isSha256Hex("xyz"), false);
});
