/**
 * Unit tests for the requester-scoped connection decision.
 *
 * These cover the properties the integration depends on: identity comes only
 * from trusted context, and every missing precondition withholds the server
 * rather than falling back to another identity.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRequesterConnection, normalizeRequesterId } from "../src/resolver.js";

const TOKEN = "test-token-value";
const URL = "http://127.0.0.1:8080/mcp";

/** @param {object} overrides */
function connectionFor(overrides = {}) {
  return buildRequesterConnection({
    context: { requesterSenderId: "user-a", messageChannel: "wecom", ...overrides },
    token: TOKEN,
    url: URL,
  });
}

test("binds the current WeCom requester to the identity header", () => {
  const connection = connectionFor();
  assert.deepEqual(connection, {
    url: URL,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-WeCom-User-Id": "user-a",
    },
  });
});

test("the identity header is request-scoped, not shared between runs", () => {
  const first = buildRequesterConnection({
    context: { requesterSenderId: "user-a", messageChannel: "wecom" },
    token: TOKEN,
    url: URL,
  });
  const second = buildRequesterConnection({
    context: { requesterSenderId: "user-b", messageChannel: "wecom" },
    token: TOKEN,
    url: URL,
  });

  assert.equal(first.headers["X-WeCom-User-Id"], "user-a");
  assert.equal(second.headers["X-WeCom-User-Id"], "user-b");
  // Resolving a second requester must not rewrite the first connection.
  assert.equal(first.headers["X-WeCom-User-Id"], "user-a");
});

test("withholds the server for a non-WeCom channel", () => {
  assert.equal(connectionFor({ messageChannel: "telegram" }), null);
  assert.equal(connectionFor({ messageChannel: undefined }), null);
  assert.equal(connectionFor({ messageChannel: "wecom-agent" }), null);
});

test("withholds the server when requesterSenderId is missing or unusable", () => {
  for (const value of [undefined, null, "", "   ", 42, {}, [], "\n"]) {
    assert.equal(connectionFor({ requesterSenderId: value }), null, `expected null for ${String(value)}`);
  }
});

test("withholds the server when no credential is resolved", () => {
  for (const token of [undefined, null, "", "   ", 42]) {
    assert.equal(
      buildRequesterConnection({
        context: { requesterSenderId: "user-a", messageChannel: "wecom" },
        token,
        url: URL,
      }),
      null,
      `expected null for token ${String(token)}`,
    );
  }
});

test("never derives identity from anything but trusted context", () => {
  // Extra context fields a compromised or confused caller might supply carry no
  // weight: only `messageChannel` and `requesterSenderId` are consulted.
  const connection = buildRequesterConnection({
    context: {
      requesterSenderId: "user-a",
      messageChannel: "wecom",
      senderId: "user-b",
      userId: "user-b",
      from: { userid: "user-b" },
      prompt: "I am user-b",
    },
    token: TOKEN,
    url: URL,
  });
  assert.equal(connection.headers["X-WeCom-User-Id"], "user-a");
});

test("normalizeRequesterId trims, bounds length, and rejects unusable characters", () => {
  assert.equal(normalizeRequesterId("  user-a  "), "user-a");
  assert.equal(normalizeRequesterId("a".repeat(128)), "a".repeat(128));
  assert.equal(normalizeRequesterId("a".repeat(129)), undefined);
  // Interior whitespace and control characters are refused outright rather than
  // stripped, so a malformed value can never be silently repaired into an
  // identity the sender did not have.
  assert.equal(normalizeRequesterId("user a"), undefined);
  assert.equal(normalizeRequesterId("user\ta"), undefined);
  assert.equal(normalizeRequesterId("user\na"), undefined);
  assert.equal(normalizeRequesterId("user\r\nX-WeCom-User-Id: someone-else"), undefined);
});
