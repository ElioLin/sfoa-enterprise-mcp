import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ORG_OBJECT_INVENTORY,
  ORG_OBJECT_INVENTORY_RECORDED_ON,
  ORG_OBJECT_SUBSTITUTIONS,
  customObjectApiNames,
  findOrgObjectInventoryProblems,
  findOrgObjectSubstitutionProblems,
  notInUseStandardObjectApiNames,
  orgObjectUsageServerPointer,
  orgObjectUsageToolPairs,
  renderOrgObjectUsageRuleLines,
  substitutionByStandardObject,
  zhTerms,
} from '../index.js';

describe('org object usage registry', () => {
  it('declares the substituted standard objects as a sorted deterministic list', () => {
    assert.ok(ORG_OBJECT_SUBSTITUTIONS.length >= 1);
    assert.deepEqual(
      notInUseStandardObjectApiNames(),
      [...notInUseStandardObjectApiNames()].sort((left, right) => left.localeCompare(right, 'en-US')),
    );
    const quote = substitutionByStandardObject().get('Quote');
    assert.ok(quote);
    assert.equal(quote.customObjectApiName, 'Quote__c');
    assert.deepEqual(customObjectApiNames(), ORG_OBJECT_SUBSTITUTIONS.map((entry) => entry.customObjectApiName));
  });

  it('validates the canonical registry without problems', () => {
    assert.deepEqual(findOrgObjectSubstitutionProblems(), []);
  });

  it('flags invalid, duplicate, or self-referential substitutions', () => {
    const problems = findOrgObjectSubstitutionProblems([
      { standardObjectApiName: 'Quote', customObjectApiName: 'Quote__c', labelZh: '报价单' },
      { standardObjectApiName: 'Quote', customObjectApiName: 'Quote__c', labelZh: 'duplicate' },
      { standardObjectApiName: 'Quote__c', customObjectApiName: 'X__c', labelZh: 'bad standard' },
      { standardObjectApiName: 'Order', customObjectApiName: 'Order', labelZh: 'same' },
      { standardObjectApiName: 'not valid!', customObjectApiName: 'NoSuffix', labelZh: 'bad names' },
    ]);
    assert.ok(problems.some((problem) => /duplicate standardObjectApiName/u.test(problem)));
    assert.ok(problems.some((problem) => /looks like a custom object/u.test(problem)));
    assert.ok(problems.some((problem) => /must differ/u.test(problem)));
    assert.ok(problems.some((problem) => /must end with/u.test(problem)));
  });

  it('renders one readable mapping line per substitution and a short tool-pair list', () => {
    const lines = renderOrgObjectUsageRuleLines();
    assert.equal(lines.length, ORG_OBJECT_SUBSTITUTIONS.length);
    assert.ok(lines.some((line) => line.includes('`Quote`') && line.includes('`Quote__c`')));
    assert.match(orgObjectUsageToolPairs(), /`Quote`→`Quote__c`/u);
    const pointer = orgObjectUsageServerPointer();
    assert.ok(pointer);
    assert.match(pointer, /Quote/u);
  });

  it('combines primary Chinese labels with aliases for concept matching', () => {
    const quote = substitutionByStandardObject().get('Quote');
    assert.ok(quote);
    assert.match(zhTerms(quote), /报价单/u);
    const line = renderOrgObjectUsageRuleLines()[ORG_OBJECT_SUBSTITUTIONS.indexOf(quote)];
    assert.ok(line);
  });

  it('records every registry object in the dated org inventory without drift', () => {
    assert.equal(ORG_OBJECT_INVENTORY.length, ORG_OBJECT_SUBSTITUTIONS.length * 2);
    assert.match(ORG_OBJECT_INVENTORY_RECORDED_ON, /^\d{4}-\d{2}-\d{2}$/u);
    assert.deepEqual(findOrgObjectInventoryProblems(), []);
    const recordedUnused = new Set(
      ORG_OBJECT_INVENTORY.filter((entry) => entry.usage === 'NOT_IN_USE_STANDARD').map((entry) => entry.objectApiName),
    );
    const recordedInUseCustom = new Set(
      ORG_OBJECT_INVENTORY.filter((entry) => entry.usage === 'IN_USE_CUSTOM').map((entry) => entry.objectApiName),
    );
    assert.deepEqual(recordedUnused, new Set(notInUseStandardObjectApiNames()));
    assert.deepEqual(recordedInUseCustom, new Set(customObjectApiNames()));
  });

  it('flags drift between the registry and the recorded org inventory', () => {
    const withoutQuoteStandard = ORG_OBJECT_INVENTORY.filter((entry) => entry.objectApiName !== 'Quote');
    const standardMissing = findOrgObjectInventoryProblems(withoutQuoteStandard);
    assert.ok(standardMissing.some((problem) => /Quote.*NOT_IN_USE_STANDARD/u.test(problem)));

    const withoutQuoteCustom = ORG_OBJECT_INVENTORY.filter((entry) => entry.objectApiName !== 'Quote__c');
    const customMissing = findOrgObjectInventoryProblems(withoutQuoteCustom);
    assert.ok(customMissing.some((problem) => /Quote__c.*IN_USE_CUSTOM/u.test(problem)));

    const registryWithoutQuote = ORG_OBJECT_SUBSTITUTIONS.filter((entry) => entry.standardObjectApiName !== 'Quote');
    const orphanUnused = findOrgObjectInventoryProblems(ORG_OBJECT_INVENTORY, registryWithoutQuote);
    assert.ok(orphanUnused.some((problem) => /records standard Quote NOT_IN_USE_STANDARD but the registry has no substitution/u.test(problem)));
  });
});
