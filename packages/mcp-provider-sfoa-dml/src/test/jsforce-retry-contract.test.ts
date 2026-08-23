import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('pinned JSforce default transport retry excludes CREATE POST and UPDATE PATCH', async () => {
  const packageJsonPath = require.resolve('@jsforce/jsforce-node/package.json');
  const packageJson = await readFile(packageJsonPath, 'utf8');
  const version = /"version"\s*:\s*"([^"]+)"/u.exec(packageJson)?.[1];
  assert.equal(version, '3.10.13');

  const requestSource = await readFile(path.join(path.dirname(packageJsonPath), 'lib', 'request.js'), 'utf8');
  const defaultMethodsSource = /methods:\s*options\.retry\?\.methods\s*\?\?\s*\[([\s\S]*?)\],/u.exec(requestSource)?.[1];
  assert(defaultMethodsSource, 'pinned JSforce retry method source contract must remain inspectable');
  const defaultMethods = [...defaultMethodsSource.matchAll(/'([A-Z]+)'/gu)].map((match) => match[1]);

  assert.deepEqual(defaultMethods, ['GET', 'PUT', 'HEAD', 'OPTIONS', 'DELETE']);
  assert.equal(defaultMethods.includes('POST'), false, 'CREATE transport retry count must be zero');
  assert.equal(defaultMethods.includes('PATCH'), false, 'UPDATE transport retry count must be zero');
});
