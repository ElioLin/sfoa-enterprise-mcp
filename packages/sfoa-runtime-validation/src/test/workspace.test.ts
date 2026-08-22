import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { createMetadataWorkspace } from '../workspace.js';

test('temporary metadata workspace creates a minimal project and cleans it up', async () => {
  const workspace = await createMetadataWorkspace('66.0', 'CustomObject', 'Example&Object__c');
  const root = workspace.root;
  const manifest = await readFile(workspace.manifestPath, 'utf8');

  assert.match(manifest, /<name>CustomObject<\/name>/);
  assert.match(manifest, /<members>Example&amp;Object__c<\/members>/);
  assert.equal(await workspace.countRetrievedFiles(), 0);

  await workspace.cleanup();
  await assert.rejects(stat(root), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT');
});
