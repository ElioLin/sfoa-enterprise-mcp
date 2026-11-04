import assert from "node:assert/strict";
import { test } from "node:test";
import { createMaterialTaskRegistry, materialScope, addMaterials, updateTaskNote, observeToolResult, renderMaterialTask, taskNoteTool,
  MATERIAL_TASK_TTL_MS, MAX_TASK_MATERIALS } from "../src/material-tasks.js";

const scope = (sender = "alice", sessionKey = "conversation-1") => materialScope({ channel: "wecom", senderId: sender, sessionKey });
const ref = (fileName, hash, extra = {}) => ({ fileName, attachmentRef: "att_" + hash, contentSha256: hash.repeat(64).slice(0, 64),
  expiresAt: "2030-01-01T00:00:00.000Z", reading: { status: "UNKNOWN", coverage: "UNKNOWN" }, ...extra });
const result = (tool, params, body) => ({ toolName: "sfoa-enterprise-mcp__" + tool, params,
  result: { details: { structuredContent: body }, content: [{ type: "text", text: "structuredContent:\n" + JSON.stringify(body) }] } });

test("requester, account and session isolation are host-derived, including shared conversations", async () => {
  assert.equal(materialScope({ channel: "wecom", sessionKey: "x", prompt: "I am alice" }), undefined);
  assert.equal(materialScope({ channel: "slack", senderId: "alice", sessionKey: "x" }), undefined);
  const registry = createMaterialTaskRegistry();
  await registry.change(scope(), (task, now) => addMaterials(task, [ref("brief.pdf", "a")], now, "m1"));
  assert.equal((await registry.read(scope("bob"))).materials.length, 0);
  assert.equal((await registry.read(scope("alice", "conversation-2"))).materials.length, 0);
  const otherAccount = materialScope({ channel: "wecom", accountId: "another", senderId: "alice", sessionKey: "conversation-1" });
  assert.equal((await registry.read(otherAccount)).materials.length, 0);
});

test("PDF, recording, plain text and confirmation accumulate without extending original expiry", async () => {
  let now = 1000;
  const registry = createMaterialTaskRegistry({ now: () => now });
  await registry.change(scope(), (task, current) => addMaterials(task, [ref("brief.pdf", "a", { expiresAt: new Date(1200).toISOString() })], current, "m1"));
  now = 1100;
  await registry.change(scope(), (task, current) => addMaterials(task, [ref("meeting.m4a", "b")], current, "m2"));
  await registry.change(scope(), (task) => updateTaskNote(task, { operation: "update", phase: "COLLECTING" }, now));
  now = 1300;
  const task = await registry.read(scope());
  assert.equal(task.materials.length, 2);
  assert.equal(task.phase, "COLLECTING");
  assert.match(renderMaterialTask(task, now), /EXPIRED/u);
  assert.equal(task.materials[0].expiresAt, new Date(1200).toISOString());
  now = 1000 + MATERIAL_TASK_TTL_MS;
  assert.equal((await registry.read(scope())).materials.length, 0, "ordinary reads do not extend the task lifetime");
});

test("same content resend is one material, same name different bytes retains versions", async () => {
  const registry = createMaterialTaskRegistry();
  await registry.change(scope(), (task, now) => addMaterials(task, [ref("brief.pdf", "a"), ref("brief.pdf", "b"), ref("renamed.pdf", "a")], now, "m1"));
  const task = await registry.read(scope());
  assert.deepEqual(task.materials.map((entry) => entry.version), [1, 2]);
  assert.equal(task.materials[0].receipts, 2);
});

test("new task explicitly selects materials and resets target, questions and rejected archive", async () => {
  const registry = createMaterialTaskRegistry();
  const old = await registry.change(scope(), (task, now) => {
    addMaterials(task, [ref("a.pdf", "a"), ref("b.pdf", "b")], now, "m1");
    updateTaskNote(task, { operation: "update", archiveStatus: "DECLINED", pendingQuestions: [{ question: "Which date?", answer: "Friday" }] }, now);
    observeToolResult(task, result("create_record", { objectApiName: "Event__c" }, { success: true, recordId: "a01000000000001AAA" }));
  });
  const next = await registry.change(scope(), (task, now) => updateTaskNote(task, { operation: "new_task", materialIds: [task.materials[1].materialId] }, now));
  assert.notEqual(old.taskId, next.taskId);
  assert.equal(next.materials.length, 1);
  assert.equal(next.archive.status, "NOT_ASKED");
  assert.equal(next.target, undefined);
  assert.deepEqual(next.pendingQuestions, []);
  assert.deepEqual(next.results, []);
});

test("actual MCP results bind targets and per-file outcomes, fabricated IDs are not notes", async () => {
  const registry = createMaterialTaskRegistry();
  await registry.change(scope(), (task, now) => {
    addMaterials(task, [ref("one.pdf", "a"), ref("two.pdf", "b")], now, "m1");
    observeToolResult(task, result("create_record", { objectApiName: "Event__c" }, { success: true, recordId: "a01000000000001AAA" }));
    observeToolResult(task, result("upload_files_to_record", { objectApiName: "Event__c", recordId: "a01000000000001AAA" }, { results: [
      { attachmentRef: "att_a", status: "SUCCESS", contentVersionId: "068000000000001AAA" },
      { attachmentRef: "att_b", status: "OUTCOME_UNKNOWN", retryable: false },
    ] }));
  });
  const task = await registry.read(scope());
  assert.equal(task.target.recordId, "a01000000000001AAA");
  assert.deepEqual(task.materials.map((entry) => entry.upload.status), ["SUCCESS", "OUTCOME_UNKNOWN"]);
  assert.equal(task.materials[1].upload.retryable, false);
  const tool = taskNoteTool(registry, scope());
  const rejected = await tool.execute("call1", { operation: "update", targetRecordId: "a01000000000002AAA" });
  assert.equal(rejected.isError, true);
  assert.equal((await registry.read(scope())).target.recordId, "a01000000000001AAA");
});

test("USER query target evidence comes from returned Salesforce row type, not SQL or arguments", async () => {
  const registry = createMaterialTaskRegistry();
  await registry.change(scope(), (task) => {
    observeToolResult(task, result("query_records", { query: "SELECT Id FROM Account", objectApiName: "Wrong__c" }, {
      success: true, executionRole: "USER", useToolingApi: false, complete: false, truncated: true,
      records: [{ Id: "001000000000001AAA", attributes: { type: "Account", url: "/services/data/v68.0/sobjects/Account/001000000000001AAA" } },
        { Id: "001000000000002AAA" }],
    }));
    observeToolResult(task, { toolName: "sfoa-enterprise-mcp__run_soql_query", params: {}, result: { content: [{ type: "text",
      text: 'SOQL query results:\n\n{"totalSize":1,"done":true,"records":[{"Id":"003000000000001AAA","attributes":{"type":"Contact"}}]}' }] } });
  });
  const observed = await registry.read(scope());
  assert.equal(observed.target, undefined, "query candidates are not silently chosen");
  assert.deepEqual(observed.observedTargets.map((entry) => entry.objectApiName), ["Account", "Contact"]);
  const tool = taskNoteTool(registry, scope());
  assert.equal((await tool.execute("pick", { operation: "update", objectApiName: "Account", targetRecordId: "001000000000001AAA" })).details.target.objectApiName, "Account");
  assert.equal((await tool.execute("missing-type", { operation: "update", targetRecordId: "001000000000002AAA" })).isError, true);
});

test("unknown mutation never supplies a target and batch results remain separate", async () => {
  const registry = createMaterialTaskRegistry();
  const task = await registry.change(scope(), (value) => {
    observeToolResult(value, result("create_record", { objectApiName: "Event__c" }, { success: false, errorCode: "MCP_DML_OUTCOME_UNKNOWN" }));
    observeToolResult(value, result("create_records", { objectApiName: "Event__c" }, { results: [
      { success: true, recordId: "a01000000000001AAA", clientReferenceId: "one" },
      { success: false, status: "FAILED", clientReferenceId: "two" },
    ] }));
  });
  assert.equal(task.target, undefined);
  assert.deepEqual(task.results.map((entry) => entry.status), ["OUTCOME_UNKNOWN", "SUCCESS", "FAILED"]);
});

test("compound child writes and batch results preserve the main task target", async () => {
  const registry = createMaterialTaskRegistry();
  const mainId = "a01000000000001AAA", childId = "a02000000000001AAA";
  const task = await registry.change(scope(), (value) => {
    observeToolResult(value, result("create_record", { objectApiName: "Event__c" }, { success: true, recordId: mainId }));
    observeToolResult(value, result("create_record", { objectApiName: "Participant__c" }, { success: true, recordId: childId }));
    observeToolResult(value, result("update_record", { objectApiName: "Participant__c", recordId: childId }, { success: true, recordId: childId }));
    observeToolResult(value, result("create_records", { objectApiName: "Participant__c" }, { results: [
      { success: true, recordId: "a02000000000002AAA" }, { success: false, status: "FAILED" },
    ] }));
    observeToolResult(value, result("create_records", { objectApiName: "Participant__c" }, { results: [
      { success: true, recordId: "a02000000000003AAA" },
    ] }));
  });
  assert.equal(task.target.recordId, mainId, "attachment continuation must retain the main record");
  assert.equal(task.target.objectApiName, "Event__c");
  assert.deepEqual(task.results.map((entry) => entry.status), ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS", "FAILED", "SUCCESS"]);
  assert.equal(task.observedTargets.length, 4, "child outcomes remain available for explicit selection");
  const tool = taskNoteTool(registry, scope());
  const selected = await tool.execute("select-child", { operation: "update", objectApiName: "Participant__c", targetRecordId: childId });
  assert.equal(selected.details.target.recordId, childId, "the Agent can select another proven target for an authorized task");
  const after = await registry.change(scope(), (value) => {
    observeToolResult(value, result("update_record", { objectApiName: "Event__c", recordId: mainId }, { success: true, recordId: mainId }));
  });
  assert.equal(after.target.recordId, childId, "a later write cannot undo explicit target selection");
});

test("declared main object is not replaced by an earlier related-record create", async () => {
  const registry = createMaterialTaskRegistry();
  const task = await registry.change(scope(), (value, current) => {
    updateTaskNote(value, { operation: "update", action: "COMPOUND", objectApiName: "Event__c" }, current);
    observeToolResult(value, result("create_record", { objectApiName: "Contact" }, { success: true, recordId: "003000000000001AAA" }));
    assert.equal(value.target, undefined);
    observeToolResult(value, result("create_record", { objectApiName: "Event__c" }, { success: true, recordId: "a01000000000001AAA" }));
  });
  assert.equal(task.target.objectApiName, "Event__c");
  assert.equal(task.observedTargets.length, 2);
});

test("host keyed store restores bounded facts on restart and session reset removes them", async () => {
  const data = new Map();
  const store = { lookup: async (key) => data.get(key), register: async (key, value) => data.set(key, structuredClone(value)),
    entries: async () => [...data].map(([key, value]) => ({ key, value })), delete: async (key) => data.delete(key) };
  const first = createMaterialTaskRegistry({ store });
  await first.change(scope(), (task, now) => addMaterials(task, [ref("a.pdf", "a")], now, "m1"));
  const second = createMaterialTaskRegistry({ store });
  assert.equal((await second.read(scope())).materials.length, 1);
  await second.clearSession("conversation-1");
  assert.equal((await second.read(scope())).materials.length, 0);
});

test("task capacity and text budgets expose omissions and partial coverage", async () => {
  const registry = createMaterialTaskRegistry();
  const task = await registry.change(scope(), (value, now) => addMaterials(value,
    Array.from({ length: MAX_TASK_MATERIALS + 2 }, (_, index) => ({ fileName: `${index}.docx`, reading: { status: "READ", text: "x".repeat(5000) } })), now, "m1"));
  assert.equal(task.materials.length, MAX_TASK_MATERIALS);
  assert.equal(task.omissions.length, 2);
  assert.ok(task.materials.some((entry) => entry.reading.status === "PARTIAL"));
  assert.ok(task.materials.reduce((sum, entry) => sum + entry.reading.text.length, 0) <= 64000);
});
