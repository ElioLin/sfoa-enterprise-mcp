import assert from "node:assert/strict";
import { test } from "node:test";
import { createMaterialTaskRegistry, materialScope, addMaterials, observeToolResult, updateTaskNote, renderMaterialTask } from "../src/material-tasks.js";

const scope = materialScope({ channel: "wecom", senderId: "alice", sessionKey: "hotfix" });
const target = { objectApiName: "Event__c", recordId: "a01000000000001AAA" };
const receipt = (extra = {}) => ({ fileName: "brief.docx", contentSha256: "a".repeat(64), attachmentRef: "old",
  expiresAt: new Date(2000).toISOString(), reading: { status: "FAILED" }, ...extra });
const observe = (task, row, params = target) => observeToolResult(task, { toolName: "sfoa-enterprise-mcp__upload_files_to_record",
  params: { ...params, attachmentRefs: [row.attachmentRef] }, result: { structuredContent: { ...params, results: [row] } } });
async function setup() {
  const registry = createMaterialTaskRegistry({ now: () => 1000 });
  return registry.change(scope, (task) => addMaterials(task, [receipt()], 1000, "first"));
}

test("same hash improves failed reading, retains successful text after later failures and partial reads", async () => {
  const task = await setup();
  addMaterials(task, [receipt({ reading: { status: "READ", text: "客户尚未承诺采购，数量未定。", source: "OFFICE_BASIC_READER" } })], 1100, "second");
  assert.equal(task.materials.length, 1);
  assert.equal(task.materials[0].reading.status, "READ");
  assert.equal(task.materials[0].reading.sourceMessageId, "second");
  addMaterials(task, [receipt({ reading: { status: "FAILED" } }), receipt({ reading: { status: "PARTIAL", text: "客户" } })], 1200, "third");
  assert.equal(task.materials[0].reading.status, "READ");
  assert.match(task.materials[0].reading.text, /尚未承诺/u);
  assert.equal(task.materials[0].upload.status, "NOT_ATTEMPTED");
});

test("a fuller trusted reread can insert previously omitted content between existing paragraphs", async () => {
  const task = await setup();
  task.materials[0].reading = { status: "READ", source: "OFFICE_BASIC_READER", text: "来访资料\n结尾" };
  addMaterials(task, [receipt({ reading: { status: "READ", source: "OFFICE_BASIC_READER", text: "来访资料\n尚未承诺采购\n结尾" } })], 1100, "reread");
  assert.match(task.materials[0].reading.text, /尚未承诺采购/u);
});

test("genuine resend replaces an expired retryable ref without changing the proven rejection or archive choice", async () => {
  const task = await setup();
  updateTaskNote(task, { operation: "update", archiveStatus: "ACCEPTED", materialIds: [task.materials[0].materialId] }, 1000);
  observe(task, { attachmentRef: "old", status: "FAILED", retryable: true, errorCode: "MCP_ATTACHMENT_UPLOAD_FAILED" });
  addMaterials(task, [receipt({ attachmentRef: "new", expiresAt: new Date(5000).toISOString(), ownerRequester: "alice" })], 2500, "resent");
  assert.equal(task.materials[0].attachmentRef, "new");
  assert.equal(task.materials[0].expiresAt, new Date(5000).toISOString());
  assert.equal(task.materials[0].upload.status, "FAILED");
  assert.equal(task.archive.status, "ACCEPTED");
  assert.equal(task.materials[0].originals.at(-1).sourceMessageId, "resent");
  assert.equal(task.materials[0].originals.at(-1).ownerRequester, "alice");
});

test("a repeated ref cannot extend the known original TTL", async () => {
  const task = await setup();
  addMaterials(task, [receipt({ expiresAt: new Date(9000).toISOString() })], 3000, "repeated-reference");
  assert.equal(task.materials[0].expiresAt, new Date(2000).toISOString());
  assert.equal(task.materials[0].originals[0].expiresAt, new Date(2000).toISOString());
});

test("a consumed ref remains unavailable after selecting another target", async () => {
  const task = await setup();
  observe(task, { attachmentRef: "old", status: "SUCCESS", contentVersionId: "068000000000001AAA" });
  const other = { ...target, recordId: "a01000000000002AAA" };
  task.observedTargets.push(other);
  updateTaskNote(task, { operation: "update", targetRecordId: other.recordId }, 1000);
  const view = JSON.parse(renderMaterialTask(task, 1100).split("\n")[1]);
  assert.equal(view.materials[0].currentUpload.status, "NOT_ATTEMPTED");
  assert.equal(view.materials[0].original, "CONSUMED_UPLOAD_REF");
});

test("target tracking capacity keeps its confirmed overflow result and never implies untracked means unsent", async () => {
  const task = await setup();
  for (let index = 1; index <= 33; index++) {
    const params = { ...target, recordId: `a01${String(index).padStart(12, "0")}AAA` };
    observe(task, { attachmentRef: "old", status: "SUCCESS", contentVersionId: "068000000000001AAA" }, params);
    task.target = params;
  }
  observe(task, { attachmentRef: "old", status: "FAILED", errorCode: "MCP_ATTACHMENT_EXPIRED" }, task.target);
  let view = JSON.parse(renderMaterialTask(task, 1100).split("\n")[1]);
  assert.equal(view.materials[0].currentUpload.status, "SUCCESS");
  assert.equal(view.materials[0].currentUpload.contentVersionId, "068000000000001AAA");
  assert.equal(task.materials[0].uploads.length, 32);
  task.target = { ...target, recordId: "a01000000000034AAA" };
  observe(task, { attachmentRef: "old", status: "FAILED", errorCode: "MCP_ATTACHMENT_EXPIRED" }, task.target);
  view = JSON.parse(renderMaterialTask(task, 1100).split("\n")[1]);
  assert.equal(view.materials[0].currentUpload.status, "HISTORY_UNAVAILABLE");
  assert.equal(task.materials[0].upload.status, "SUCCESS", "the overflow confirmation is not discarded for another target");
});

test("UNKNOWN or unqualified FAILED cannot activate a new ref; later NOT_ATTEMPTED does not erase UNKNOWN", async () => {
  for (const status of ["OUTCOME_UNKNOWN", "UPLOADING", "FAILED"]) {
    const task = await setup();
    if (status === "UPLOADING") task.materials[0].upload = { status, ...target };
    else observe(task, { attachmentRef: "old", status, retryable: false });
    if (status === "OUTCOME_UNKNOWN") observe(task, { attachmentRef: "old", status: "NOT_ATTEMPTED" });
    addMaterials(task, [receipt({ attachmentRef: "new", expiresAt: new Date(5000).toISOString(), reading: { status: "READ", text: "新的读取证据" } })], 2500, "resent");
    assert.equal(task.materials[0].attachmentRef, "old");
    assert.equal(task.materials[0].upload.status, status);
    assert.equal(task.materials[0].reading.status, "READ");
  }
});

test("confirmed publication survives failed consumed-ref reuse, NOT_ATTEMPTED and UNKNOWN", async () => {
  const task = await setup();
  observe(task, { attachmentRef: "old", status: "SUCCESS", contentVersionId: "068000000000001AAA", contentDocumentId: "069000000000001AAA" });
  for (const status of ["FAILED", "NOT_ATTEMPTED", "OUTCOME_UNKNOWN"]) {
    observe(task, { attachmentRef: "old", status, errorCode: "MCP_ATTACHMENT_EXPIRED", salesforceMessage: "Attachment has expired or is no longer usable.", retryable: false });
    assert.equal(task.materials[0].upload.status, "SUCCESS");
    assert.equal(task.materials[0].upload.contentVersionId, "068000000000001AAA");
    assert.equal(task.materials[0].upload.latestAttempt.status, status);
    assert.equal(task.materials[0].upload.latestAttempt.errorCode, "MCP_ATTACHMENT_EXPIRED");
  }
  assert.match(renderMaterialTask(task, 1000), /068000000000001AAA/u);
  assert.equal(task.archive.status, "NOT_ASKED", "upload success is not archive consent");
});

test("success on a different ref does not resolve the earlier uncertain attempt", async () => {
  const task = await setup();
  observe(task, { attachmentRef: "old", status: "OUTCOME_UNKNOWN" });
  addMaterials(task, [receipt({ attachmentRef: "new", expiresAt: new Date(5000).toISOString() })], 2500, "resent");
  observe(task, { attachmentRef: "new", status: "SUCCESS", contentVersionId: "068000000000002AAA" });
  observe(task, { attachmentRef: "new", status: "FAILED", errorCode: "MCP_ATTACHMENT_EXPIRED" });
  assert.equal(task.materials[0].upload.status, "OUTCOME_UNKNOWN");
  assert.equal(task.materials[0].upload.attachmentRef, "old");
  assert.equal(task.materials[0].upload.confirmedPublication.contentVersionId, "068000000000002AAA");
  assert.equal(task.materials[0].upload.latestAttempt.errorCode, "MCP_ATTACHMENT_EXPIRED");
});

test("same file on another explicit target retains independent results, and a new task can receive another original", async () => {
  const task = await setup();
  observe(task, { attachmentRef: "old", status: "SUCCESS", contentVersionId: "068000000000001AAA" });
  const other = { ...target, recordId: "a01000000000002AAA" };
  task.observedTargets.push(other);
  updateTaskNote(task, { operation: "update", targetRecordId: other.recordId }, 1000);
  addMaterials(task, [receipt({ attachmentRef: "another", expiresAt: new Date(5000).toISOString() })], 2500, "other-target");
  assert.equal(task.materials[0].attachmentRef, "another");
  observe(task, { attachmentRef: "another", status: "FAILED", retryable: true }, other);
  assert.equal(task.materials[0].upload.status, "FAILED");
  assert.equal(task.materials[0].uploads.find(row => row.recordId === target.recordId).contentVersionId, "068000000000001AAA");
  assert.doesNotMatch(renderMaterialTask(task, 2600), /"original":"UPLOADED"/u);
  const selected = task.materials[0].materialId;
  updateTaskNote(task, { operation: "new_task", materialIds: [selected] }, 2700);
  addMaterials(task, [receipt({ attachmentRef: "third", expiresAt: new Date(6000).toISOString() })], 2800, "new-task");
  assert.equal(task.materials[0].attachmentRef, "third");
  assert.equal(task.target, undefined);
});

test("duplicate receipts cannot bypass text, material or provenance limits", async () => {
  const task = await setup();
  addMaterials(task, [{ fileName: "big.csv", reading: { status: "READ", text: "x".repeat(63000) } }], 1000, "big");
  for (let n = 0; n < 70; n++) addMaterials(task, [receipt({ attachmentRef: `ref-${n}`, expiresAt: new Date(9000).toISOString(),
    reading: { status: "READ", text: "y".repeat(5000) } })], 1000, `receipt-${n}`);
  const material = task.materials[0];
  assert.equal(task.materials.length, 2);
  assert.equal(material.reading.status, "PARTIAL");
  assert.ok(material.reading.reasons.includes("TASK_TEXT_LIMIT"));
  assert.equal(material.reading.coverage.textCharactersProvided, 1000);
  assert.ok(task.materials.reduce((n, entry) => n + (entry.reading?.text?.length ?? 0), 0) <= 64000);
  assert.ok(material.sourceMessages.length <= 32);
  assert.ok(material.originals.length <= 8);
});

test("legacy stored success migrates without clearing it; COMPLETE retains target and selected archive continuation", async () => {
  const task = await setup();
  task.materials[0].upload = { status: "SUCCESS", ...target, contentVersionId: "068000000000001AAA" };
  task.observedTargets.push(target);
  updateTaskNote(task, { operation: "update", phase: "COMPLETE", targetRecordId: target.recordId }, 1000);
  const id = task.taskId;
  updateTaskNote(task, { operation: "update", archiveStatus: "ACCEPTED", materialIds: [task.materials[0].materialId] }, 1100);
  assert.equal(task.taskId, id);
  assert.equal(task.target.recordId, target.recordId);
  observe(task, { attachmentRef: "old", status: "FAILED", errorCode: "MCP_ATTACHMENT_EXPIRED" });
  assert.equal(task.materials[0].upload.status, "SUCCESS");
  assert.equal(task.materials[0].upload.contentVersionId, "068000000000001AAA");
});

test("collection, one archive invitation and completed record continuation use existing optional notes", async () => {
  const task = await setup();
  addMaterials(task, [receipt({ contentSha256: "b".repeat(64), attachmentRef: "b" })], 1000, "second");
  const ids = task.materials.map(entry => entry.materialId);
  updateTaskNote(task, { operation: "update", phase: "COLLECTING" }, 1000);
  addMaterials(task, [receipt()], 1001, "more");
  assert.equal(task.phase, "COLLECTING");
  observeToolResult(task, { toolName: "sfoa-enterprise-mcp__create_record", params: { objectApiName: target.objectApiName },
    result: { structuredContent: { success: true, recordId: target.recordId } } });
  assert.equal(task.phase, "COLLECTING", "a tool success does not complete the business task");
  updateTaskNote(task, { operation: "update", phase: "ACTIVE", archiveStatus: "ASKED" }, 1002);
  updateTaskNote(task, { operation: "update", phase: "COMPLETE" }, 1003);
  const taskId = task.taskId;
  assert.equal(task.archive.status, "ASKED", "unanswered optional archive choice does not prevent record completion");
  updateTaskNote(task, { operation: "update", archiveStatus: "ACCEPTED", materialIds: [ids[1]], phase: "ACTIVE" }, 1004);
  updateTaskNote(task, { operation: "update", archiveStatus: "ACCEPTED" }, 1005);
  assert.deepEqual(task.archive.materialIds, [ids[1]], "repeating the same choice does not discard its selection");
  assert.equal(task.taskId, taskId);
  assert.equal(task.target.recordId, target.recordId);
  assert.equal(task.results.length, 1, "archive continuation does not create another record");
  updateTaskNote(task, { operation: "update", materialIds: [ids[0], "invalid", ids[0]] }, 1006);
  assert.deepEqual(task.archive.materialIds, [ids[0]]);
  updateTaskNote(task, { operation: "update", phase: "ACTIVE", pendingQuestions: [{ question: "Which date?" }] }, 1007);
  assert.equal(task.phase, "ACTIVE");
});
