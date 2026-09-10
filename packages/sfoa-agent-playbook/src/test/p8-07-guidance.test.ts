import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentCapabilities, renderWorkflow, renderFullPlaybook, renderDifyInstruction,
  renderWorkBuddySystemPrompt, renderWorkflowReference, renderWeComRoleSetting, renderServerInstructions } from '../index.js';

test('all client surfaces propagate canonical batch, compound and label rules', () => {
  for (const render of [renderFullPlaybook, renderDifyInstruction, renderWorkBuddySystemPrompt, renderWorkflowReference, renderWeComRoleSetting]) {
    const text = render();
    for (const expected of ['create_records', 'update_records', 'allOrNone', 'PARTIAL_SUCCESS', 'OUTCOME_UNKNOWN',
      'clientReferenceId', 'get_record_relationship_context', 'resolve_field_display_values', 'API Value', 'Salesforce Label']) assert.ok(text.includes(expected), expected);
    assert.match(text, /root success|Root success/u); assert.match(text, /do not automatically retry/u);
    assert.doesNotMatch(text, /Call `create_record` once|Call `update_record` once/u);
  }
  assert.match(renderServerInstructions(), /root success alone is not business intent completion/u);
});
test('batch-only capabilities still advertise CREATE/UPDATE authority', () => {
  const capabilities = createAgentCapabilities({ enabledTools: ['create_records', 'update_records'],
    createAllowedObjects: ['Root__c'], updateAllowedObjects: ['Root__c'] });
  assert.deepEqual(capabilities.createAllowedObjects, ['Root__c']);
  assert.match(renderWorkflow('CREATE', capabilities), /Status: available for `Root__c`/u);
});
test('UPDATE guidance requires complete scope and no second batch confirmation', () => {
  const text = renderWorkflow('UPDATE');
  assert.match(text, /A\/B\/C.*each target uniquely.*B is ambiguous/su);
  assert.match(text, /LIMIT, truncation, timeout, pagination/u);
  assert.match(text, /Never silently mutate a subset/u);
  assert.match(text, /500 becomes 200 \+ 200 \+ 100/u);
  assert.match(text, /Stop automatic continuation on any OUTCOME_UNKNOWN/u);
  assert.match(text, /Do not add confirmation merely because a batch/u);
});
test('compound fixture acceptance matrix requires proven parent mapping and complete intent evidence', () => {
  const text = renderWorkflow('CREATE');
  const scenarios = [
    { roots: ['Root__c'], children: [] },
    { roots: ['Root__c'], children: ['InternalParticipant__c'] },
    { roots: ['Root__c'], children: ['InternalParticipant__c', 'CustomerParticipant__c'] },
    { roots: Array.from({ length: 5 }, () => 'Root__c'), children: ['InternalParticipant__c', 'CustomerParticipant__c'] },
  ];
  for (const scenario of scenarios) {
    assert.ok(scenario.roots.length > 0);
    assert.match(text, /exactly the requested roots, child records and Lookup references/u);
    if (scenario.children.length) assert.match(text, /set each child parent Lookup to the proven corresponding ID/u);
    if (scenario.roots.length > 1) assert.match(text, /unique clientReferenceIds.*explicit returned mapping/u);
  }
  assert.match(text, /failed or unknown root must not get children/u);
  assert.match(text, /No automatic DELETE or rollback/u);
  assert.match(text, /child failure does not erase a successful root/u);
  assert.match(text, /Do not create associated records the user did not request/u);
  assert.match(text, /only if every requested component succeeded/u);
  assert.doesNotMatch(text, /InternalParticipant__c|CustomerParticipant__c|客户拜访/u);
});
/**
 * HF05. The rendered capability facts and the canonical matrix must agree for every enable
 * combination, so the Agent is never sent to a Tool that is absent from the advertised set.
 */
for (const [label, tools, expected, expectedZh] of [
  ['both enabled', ['create_record', 'create_records', 'update_record', 'update_records'],
    /1 record uses `create_record`; 2\.\.200 records use `create_records`/u,
    /单条用 `create_record`，多条（2\.\.200）用 `create_records`。/u],
  ['singular only', ['create_record', 'update_record'],
    /`create_records` is disabled — 1 record uses `create_record`; 2\.\.200 records use bounded `create_record` calls/u,
    /`create_records` 未启用：单条用 `create_record`，多条改用有界的单条循环调用。/u],
  ['plural only', ['create_records', 'update_records'],
    /`create_record` is disabled — 1 record uses `create_records` with exactly 1 item; 2\.\.200 records use `create_records`/u,
    /`create_record` 未启用：单条用 `create_records` 且仅含 1 条记录，多条正常使用 `create_records`。/u],
] as const) {
  test(`tool selection matrix (${label}) is rendered consistently on every client surface`, () => {
    const capabilities = createAgentCapabilities({ enabledTools: [...tools],
      createAllowedObjects: ['Root__c'], updateAllowedObjects: ['Root__c'] });
    assert.match(renderWorkflow('CREATE', capabilities), expected);
    assert.match(renderFullPlaybook(capabilities), expected);
    assert.match(renderWeComRoleSetting(capabilities), expectedZh);
    for (const text of [renderWorkBuddySystemPrompt(capabilities), renderFullPlaybook(capabilities)]) {
      assert.doesNotMatch(text, /`create_records` is disabled — 1 record uses `create_records`/u);
      assert.match(text, /Never call a Tool that the current connection does not advertise as enabled/u);
    }
  });
}
test('neither mutation Tool enabled renders the operation as unavailable', () => {
  const capabilities = createAgentCapabilities({ enabledTools: ['run_soql_query'], createAllowedObjects: [], updateAllowedObjects: [] });
  for (const text of [renderWorkflow('CREATE', capabilities), renderWorkflow('UPDATE', capabilities),
    renderFullPlaybook(capabilities)]) {
    assert.match(text, /Status: unavailable/u);
  }
  assert.match(renderWeComRoleSetting(capabilities), /新建：不可用/u);
  assert.match(renderWeComRoleSetting(capabilities), /更新：不可用/u);
});
/**
 * HF01/HF11. Guidance must deterministically forbid the whole-batch retry that duplicates
 * already-committed rows, and must never offer an automatic retry after OUTCOME_UNKNOWN.
 */
test('partial success guidance deterministically forbids resubmitting committed items', () => {
  for (const render of [renderFullPlaybook, renderDifyInstruction, renderWorkBuddySystemPrompt,
    renderWorkflowReference, renderWeComRoleSetting]) {
    const text = render();
    assert.match(text, /Never resubmit the original batch after PARTIAL_SUCCESS/u);
    assert.match(text, /Only when the user intent still requires the remaining work and the failure cause is fixable/u);
    assert.match(text, /new batch containing exactly the FAILED items/u);
    assert.match(text, /do not automatically retry anything/u);
    assert.match(text, /clientReferenceId is only correlation, never a Salesforce business field or idempotency key/u);
  }
});
test('bounded relationship evidence is never treated as exhaustive absence', () => {
  for (const render of [renderFullPlaybook, renderDifyInstruction, renderWorkBuddySystemPrompt, renderWorkflowReference]) {
    const text = render();
    assert.match(text, /`truncated=true` or `resolutionStatus=PARTIAL`/u);
    assert.match(text, /never conclude that a relationship the user named does not exist/u);
    assert.match(text, /ask the user once/u);
    assert.match(text, /Never widen recall by exposing or enumerating the whole Org Schema/u);
  }
});
