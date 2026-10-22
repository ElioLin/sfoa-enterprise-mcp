import assert from "node:assert/strict";
import test from "node:test";
import {
  CrmProtocolError,
  constantTimeEqual,
  encodeSseEvent,
  normalizeMessage,
  normalizePlatformUserId,
  parseAbortRequest,
  parseHistoryRequest,
  parseTurnRequest,
  projectHistory,
  readPartialPayload,
  withRecordContext,
} from "../src/protocol.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

test("platform user ids are single printable header values", () => {
  assert.equal(normalizePlatformUserId(" 61979 "), "61979");
  for (const value of ["", "a b", "a\tb", "a\u0000b", "a".repeat(129), 42]) {
    assert.throws(() => normalizePlatformUserId(value), (error) => error instanceof CrmProtocolError);
  }
});

test("a turn request accepts only bounded, well-formed fields", () => {
  const parsed = parseTurnRequest({
    platformUserId: "61979",
    conversationId: CONVERSATION_ID,
    runId: RUN_ID,
    message: "  查询我负责的商机  ",
    recordContext: { objectApiName: "Opportunity", recordId: "006000000000001AAA" },
  });
  assert.equal(parsed.message, "查询我负责的商机");
  assert.equal(parsed.platformUserId, "61979");
  assert.equal(parsed.recordContext.objectApiName, "Opportunity");

  for (const bad of [
    { ...parsed, runId: "not-a-uuid" },
    { ...parsed, conversationId: "not-a-uuid" },
    { ...parsed, message: "   " },
    { ...parsed, message: "x".repeat(16_001) },
    { ...parsed, message: "a\u0000b" },
    { ...parsed, recordContext: { objectApiName: "Opportunity", recordId: "bad" } },
    { ...parsed, recordContext: "Opportunity/006000000000001AAA" },
  ]) {
    assert.throws(() => parseTurnRequest(bad), (error) => error instanceof CrmProtocolError);
  }
});

test("message normalization permits newlines and tabs but no other control characters", () => {
  assert.equal(normalizeMessage("第一行\n第二行\tend"), "第一行\n第二行\tend");
  assert.throws(() => normalizeMessage("a\u0007b"), (error) => error.code === "CRM_MESSAGE_INVALID");
});

test("abort and history requests are strict", () => {
  assert.deepEqual(parseAbortRequest({ conversationId: CONVERSATION_ID, runId: RUN_ID }), {
    conversationId: CONVERSATION_ID,
    runId: RUN_ID,
  });
  assert.deepEqual(parseHistoryRequest({ sessionKey: " agent:main:sfoa-crm:x ", limit: 20 }), {
    sessionKey: "agent:main:sfoa-crm:x",
    limit: 20,
  });
  assert.throws(() => parseHistoryRequest({ sessionKey: "", limit: 20 }), CrmProtocolError);
  assert.throws(() => parseHistoryRequest({ sessionKey: "x", limit: 201 }), CrmProtocolError);
});

test("record context is an explicit business prefix, never an authorization input", () => {
  assert.equal(
    withRecordContext({ objectApiName: "Opportunity", recordId: "006000000000001AAA" }, "查一下"),
    "[当前记录上下文] 对象: Opportunity, 记录 Id: 006000000000001AAA\n\n查一下",
  );
  assert.equal(withRecordContext(undefined, "查一下"), "查一下");
});

test("SSE frames are JSON and event names are bounded", () => {
  assert.equal(encodeSseEvent("message.delta", { text: "a\nb" }), 'event: message.delta\ndata: {"text":"a\\nb"}\n\n');
  assert.throws(() => encodeSseEvent("bad event", {}), /Invalid SSE event type/u);
});

test("partial payloads prefer a replace snapshot, then delta, then cumulative text", () => {
  assert.deepEqual(readPartialPayload({ text: "abc", replace: true, delta: "c" }), { text: "abc", replace: true });
  assert.deepEqual(readPartialPayload({ text: "abc", delta: "c" }), { text: "c", replace: false });
  assert.deepEqual(readPartialPayload({ text: "abc" }), { text: "abc", replace: false });
  assert.equal(readPartialPayload({ text: "" }), undefined);
  assert.equal(readPartialPayload(null), undefined);
});

test("history projection keeps only bounded user/assistant text", () => {
  const history = projectHistory({
    messages: [
      { id: "m1", role: "system", text: "ignore" },
      { id: "m2", role: "user", text: "查商机" },
      { id: "m3", role: "assistant", content: [{ type: "text", text: "有 3 条" }], timestamp: 1_700_000_000_000 },
      { id: "m4", role: "tool", text: "tool output" },
      { id: "m5", role: "assistant", text: "" },
    ],
  }, 10);
  assert.equal(history.messages.length, 2);
  assert.deepEqual(history.messages[0], { id: "m2", role: "user", text: "查商机", timestamp: null });
  assert.equal(history.messages[1].role, "assistant");
  assert.equal(history.messages[1].text, "有 3 条");
  assert.equal(history.messages[1].timestamp, 1_700_000_000_000);
  assert.equal(history.hasMore, false);

  const limited = projectHistory({ messages: [
    { id: "1", role: "user", text: "a" },
    { id: "2", role: "user", text: "b" },
    { id: "3", role: "user", text: "c" },
  ] }, 2);
  assert.equal(limited.messages.length, 2);
  assert.equal(limited.hasMore, true);
});

test("constant-time comparison handles different lengths", () => {
  assert.equal(constantTimeEqual("same-token", "same-token"), true);
  assert.equal(constantTimeEqual("same-token", "other-token"), false);
  assert.equal(constantTimeEqual("short", "a-much-longer-token"), false);
});
