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
