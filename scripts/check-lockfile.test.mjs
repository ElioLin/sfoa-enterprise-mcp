import assert from 'node:assert/strict';
import test from 'node:test';
import { lockedSelectors, missingSelectors } from './check-lockfile.mjs';

test('Yarn grouped quoted/unquoted lock keys retain exact selectors', () => {
  const text = '# yarn lockfile v1\n\n"@scope/sdk@1.18.2", "@scope/sdk@^1.18.0":\n  version "1.18.2"\n\nreact@19.2.8, react@^19.2.0:\n  version "19.2.8"\n';
  assert.deepEqual([...lockedSelectors(text)], ['@scope/sdk@1.18.2', '@scope/sdk@^1.18.0', 'react@19.2.8', 'react@^19.2.0']);
});

test('an old satisfying range does not conceal a missing exact workspace selector', () => {
  const manifests = [{ name: 'runtime', manifest: { dependencies: { '@scope/sdk': '1.18.2' } } }];
  assert.deepEqual(missingSelectors(manifests, new Set(['@scope/sdk@^1.18.0'])), ['runtime: @scope/sdk@1.18.2']);
});

test('only Yarn-resolved local dependencies are excluded, published mismatches remain required', () => {
  const manifests = [{ name: 'app', manifest: { dependencies: { local: '0.1.0-p5', published: '0.9.8' } }, localDependencies: ['local'] }];
  assert.deepEqual(missingSelectors(manifests, new Set()), ['app: published@0.9.8']);
  assert.deepEqual(missingSelectors(manifests, new Set(['published@0.9.8'])), []);
});
