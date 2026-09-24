import assert from 'node:assert/strict';
import test from 'node:test';
import { DataRuntimeError } from '../errors.js';
import { ListSobjectsExecutor } from '../list-sobjects-executor.js';
import {
  createFixture,
  describeGlobalPayload,
  salesforceError,
  sobjectEntry,
} from './data-fixtures.js';

test('lists the org object inventory sorted by API name with honest counts', async () => {
  const fixture = createFixture({
    handler: () => describeGlobalPayload([
      sobjectEntry('Contact', { label: 'Contact', labelPlural: 'Contacts' }),
      sobjectEntry('Account', { custom: false }),
      sobjectEntry('MyObject__c', { custom: true, keyPrefix: 'a01', queryable: false }),
    ]),
  });
  const output = await new ListSobjectsExecutor(fixture.orgService).execute({});

  assert.equal(output.success, true);
  assert.equal(output.executionRole, 'USER');
  assert.equal(output.api, 'REST');
  assert.deepEqual(output.sobjects?.map((entry) => entry.name), ['Account', 'Contact', 'MyObject__c']);
  assert.equal(output.totalCount, 3);
  assert.equal(output.returnedCount, 3);
  assert.equal(output.truncated, false);
  assert.equal(output.hint, undefined);
  assert.deepEqual(fixture.calls, [{ operation: 'describeGlobal' }]);

  const custom = output.sobjects?.find((entry) => entry.name === 'MyObject__c');
  assert.equal(custom?.custom, true);
  assert.equal(custom?.keyPrefix, 'a01');
  assert.equal(custom?.queryable, false);
});

test('filter is a case-insensitive API name prefix and totalCount reports matches, not the returned slice', async () => {
  const fixture = createFixture({
    handler: () => describeGlobalPayload([
      sobjectEntry('Account'),
      sobjectEntry('AccountCleanInfo'),
      sobjectEntry('AccountContactRelation'),
      sobjectEntry('Contact'),
    ]),
  });
  const output = await new ListSobjectsExecutor(fixture.orgService).execute({ filter: 'acc', limit: 2 });

  assert.deepEqual(output.sobjects?.map((entry) => entry.name), ['Account', 'AccountCleanInfo']);
  assert.equal(output.totalCount, 3);
  assert.equal(output.returnedCount, 2);
  assert.equal(output.truncated, true);
  assert.match(output.hint ?? '', /3 objects matched but only 2 were returned/u);
  assert.match(output.hint ?? '', /limit=2, maximum 200/u);
});

test('a filter that matches nothing returns an empty list rather than failing', async () => {
  const fixture = createFixture({
    handler: () => describeGlobalPayload([sobjectEntry('Account')]),
  });
  const output = await new ListSobjectsExecutor(fixture.orgService).execute({ filter: 'Zzz' });

  assert.deepEqual(output.sobjects, []);
  assert.equal(output.totalCount, 0);
  assert.equal(output.returnedCount, 0);
  assert.equal(output.truncated, false);
});

test('the default limit is 50 and it is the limit that truncates, not the org size', async () => {
  const entries = Array.from({ length: 60 }, (_unused, index) => sobjectEntry(`Object${String(index).padStart(3, '0')}__c`));
  const fixture = createFixture({ handler: () => describeGlobalPayload(entries) });
  const output = await new ListSobjectsExecutor(fixture.orgService).execute({});

  assert.equal(output.totalCount, 60);
  assert.equal(output.returnedCount, 50);
  assert.equal(output.truncated, true);
  assert.match(output.hint ?? '', /limit=50/u);
});

test('entries without a usable API name are dropped instead of surfaced as unnameable objects', async () => {
  const fixture = createFixture({
    handler: () => describeGlobalPayload([
      sobjectEntry('Account'),
      { label: 'Nameless', labelPlural: 'Nameless' },
      { name: '   ' },
      { name: 'Contact', label: 'Contact', labelPlural: 'Contacts' },
    ]),
  });
  const output = await new ListSobjectsExecutor(fixture.orgService).execute({});

  assert.deepEqual(output.sobjects?.map((entry) => entry.name), ['Account', 'Contact']);
  assert.equal(output.totalCount, 2);
});

test('a describeGlobal payload without an sobjects array degrades to an empty inventory', async () => {
  const fixture = createFixture({ handler: () => ({ encoding: 'UTF-8' }) });
  const output = await new ListSobjectsExecutor(fixture.orgService).execute({});

  assert.deepEqual(output.sobjects, []);
  assert.equal(output.totalCount, 0);
});

test('zero or several allowed usernames is refused before any Salesforce call is made', async () => {
  for (const usernames of [[], ['first@example.test', 'second@example.test']]) {
    const fixture = createFixture({ usernames, handler: () => describeGlobalPayload([]) });
    await assert.rejects(
      () => new ListSobjectsExecutor(fixture.orgService).execute({}),
      (error: unknown) => {
        assert.ok(error instanceof DataRuntimeError);
        assert.equal(error.code, 'MCP_DATA_IDENTITY_UNAVAILABLE');
        assert.match(error.message, /exactly one request-scoped USER/u);
        assert.ok(error.suggestion !== undefined);
        return true;
      },
    );
    assert.deepEqual(fixture.calls, []);
  }
});

test('a Salesforce permission failure maps to MCP_SOBJECT_ACCESS_DENIED and keeps the provider code', async () => {
  const fixture = createFixture({
    handler: () => {
      throw salesforceError('INSUFFICIENT_ACCESS', 'user does not have access to this org');
    },
  });

  await assert.rejects(
    () => new ListSobjectsExecutor(fixture.orgService).execute({}),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, 'MCP_SOBJECT_ACCESS_DENIED');
      assert.match(error.message, /may not read the org object inventory/u);
      assert.match(error.message, /Salesforce reported: user does not have access to this org/u);
      assert.match(error.suggestion ?? '', /Report the missing Salesforce permission/u);
      return true;
    },
  );
});

test('an unrecognized provider failure falls back to MCP_SOBJECT_LIST_FAILED without leaking the thrown error', async () => {
  const fixture = createFixture({
    handler: () => {
      throw new Error('socket hang up at /services/data/v67.0/sobjects');
    },
  });

  await assert.rejects(
    () => new ListSobjectsExecutor(fixture.orgService).execute({}),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, 'MCP_SOBJECT_LIST_FAILED');
      assert.equal(error.message, 'Salesforce could not return the org object inventory for this request.');
      assert.doesNotMatch(error.message, /socket hang up/u);
      return true;
    },
  );
});

test('a session id echoed by Salesforce is redacted out of the mapped message', async () => {
  const sessionId = '00D000000000001!AQ4AQJmFakeSessionIdValue1234';
  const fixture = createFixture({
    handler: () => {
      throw salesforceError('INSUFFICIENT_ACCESS', `invalid session for ${sessionId}`);
    },
  });

  await assert.rejects(
    () => new ListSobjectsExecutor(fixture.orgService).execute({}),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.doesNotMatch(error.message, /00D000000000001!/u);
      assert.match(error.message, /\[REDACTED_SESSION_ID\]/u);
      return true;
    },
  );
});
