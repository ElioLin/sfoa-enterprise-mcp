/**
 * Recorded org object usage inventory (maintainer-verified, dated).
 *
 * The maintainer diagnostics (`yarn ai:doctor` / `yarn ai:snapshot`) never
 * authenticate to Salesforce, so they cannot re-verify object existence against
 * the live org. This file therefore records the objects the org is known to
 * have: the Salesforce standard objects it does NOT use, and the custom objects
 * that carry those business records. It is the "existence" ground truth the
 * doctor gate cross-checks `ORG_OBJECT_SUBSTITUTIONS` against.
 *
 * Maintenance rule: when the org's object set or usage changes, update BOTH this
 * inventory and the substitution registry (org-object-usage.ts). `@sfoa/agent-playbook`
 * refuses to load when the two drift apart, so the runtime guard, the prose, and
 * this recorded inventory can never silently disagree. Verify names in the org
 * (Setup > Object Manager) before editing; a typo here that matches the registry
 * is exactly the failure this gate cannot see, so confirm against the org.
 */

import {
  ORG_OBJECT_SUBSTITUTIONS,
  type OrgObjectSubstitution,
} from './org-object-usage.js';

/** Date (ISO) the current inventory was verified against the org by a maintainer. */
export const ORG_OBJECT_INVENTORY_RECORDED_ON = '2026-09-02';

export type OrgObjectInventoryEntry = Readonly<{
  objectApiName: string;
  usage: 'NOT_IN_USE_STANDARD' | 'IN_USE_CUSTOM';
  labelZh: string;
}>;

function inventoryEntry(
  objectApiName: string,
  usage: OrgObjectInventoryEntry['usage'],
  labelZh: string,
): OrgObjectInventoryEntry {
  return Object.freeze({ objectApiName, usage, labelZh });
}

/**
 * Org objects involved in substitutions, recorded independently of the registry.
 * NOT_IN_USE_STANDARD entries are the standard objects the org replaced;
 * IN_USE_CUSTOM entries are the custom objects that actually exist in the org
 * and carry those records.
 */
export const ORG_OBJECT_INVENTORY: readonly OrgObjectInventoryEntry[] = Object.freeze([
  inventoryEntry('Quote', 'NOT_IN_USE_STANDARD', '报价单'),
  inventoryEntry('Quote__c', 'IN_USE_CUSTOM', '报价单'),
  inventoryEntry('QuoteLineItem', 'NOT_IN_USE_STANDARD', '报价产品'),
  inventoryEntry('Quote_Product__c', 'IN_USE_CUSTOM', '报价产品'),
  inventoryEntry('Order', 'NOT_IN_USE_STANDARD', '订单信息'),
  inventoryEntry('Order__c', 'IN_USE_CUSTOM', '订单信息'),
  inventoryEntry('OrderItem', 'NOT_IN_USE_STANDARD', '订单行'),
  inventoryEntry('Order_Product__c', 'IN_USE_CUSTOM', '订单行'),
  inventoryEntry('Pricebook2', 'NOT_IN_USE_STANDARD', '价格手册'),
  inventoryEntry('Pricebook__c', 'IN_USE_CUSTOM', '价格手册'),
  inventoryEntry('PricebookEntry', 'NOT_IN_USE_STANDARD', '价格手册条目'),
  inventoryEntry('Pricebook_Entry__c', 'IN_USE_CUSTOM', '价格手册条目'),
  inventoryEntry('Contract', 'NOT_IN_USE_STANDARD', '合同信息'),
  inventoryEntry('Contract__c', 'IN_USE_CUSTOM', '合同信息'),
]);

/**
 * Cross-checks the substitution registry against the recorded inventory. Both
 * required directions must hold: every declared unused standard must be recorded
 * NOT_IN_USE_STANDARD, and every declared replacement custom object must be
 * recorded IN_USE_CUSTOM. An inventory entry marking a standard NOT_IN_USE with
 * no registry substitution is a prose gap (agents are not told about it) and is
 * also a problem. IN_USE_CUSTOM entries are only checked one way so the inventory
 * may list other in-use custom objects beyond the substitution set.
 */
export function findOrgObjectInventoryProblems(
  inventory: readonly OrgObjectInventoryEntry[] = ORG_OBJECT_INVENTORY,
  substitutions: readonly OrgObjectSubstitution[] = ORG_OBJECT_SUBSTITUTIONS,
): string[] {
  const problems: string[] = [];
  const recordedUnused = new Set(
    inventory.filter((entry) => entry.usage === 'NOT_IN_USE_STANDARD').map((entry) => entry.objectApiName),
  );
  const recordedInUseCustom = new Set(
    inventory.filter((entry) => entry.usage === 'IN_USE_CUSTOM').map((entry) => entry.objectApiName),
  );
  const declaredUnused = new Set(substitutions.map((entry) => entry.standardObjectApiName));
  const declaredCustom = new Set(substitutions.map((entry) => entry.customObjectApiName));

  for (const standard of declaredUnused) {
    if (!recordedUnused.has(standard)) {
      problems.push(`registry declares standard ${standard} unused but the org inventory does not record it NOT_IN_USE_STANDARD.`);
    }
  }
  for (const custom of declaredCustom) {
    if (!recordedInUseCustom.has(custom)) {
      problems.push(`registry targets custom ${custom} but the org inventory does not record it IN_USE_CUSTOM.`);
    }
  }
  for (const unused of recordedUnused) {
    if (!declaredUnused.has(unused)) {
      problems.push(`org inventory records standard ${unused} NOT_IN_USE_STANDARD but the registry has no substitution for it.`);
    }
  }
  return problems;
}

function assertOrgObjectInventoryValid(): void {
  const problems = findOrgObjectInventoryProblems();
  if (problems.length > 0) {
    throw new Error(`Org object inventory is out of sync with the substitution registry:\n- ${problems.join('\n- ')}`);
  }
}

// Keep the recorded inventory and the substitution registry in lockstep: a drift
// between ORG_OBJECT_INVENTORY and ORG_OBJECT_SUBSTITUTIONS becomes a load error
// rather than a silent prose/runtime divergence.
assertOrgObjectInventoryValid();
