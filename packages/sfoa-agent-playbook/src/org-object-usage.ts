/**
 * Org-declared Salesforce object substitutions.
 *
 * SFoA's Salesforce org does not use several Salesforce standard objects; the
 * business records those objects would hold live in org custom objects instead
 * (for example the standard Quote object is unused and `Quote__c` is the real
 * 报价单). Salesforce describe cannot express that substitution, so it is
 * declared here once and rendered into every Agent guidance surface and into the
 * runtime SOQL guard. Treat this file as the single source of truth: the prose
 * (playbook / Dify / WorkBuddy / tool descriptions) and the `run_soql_query`
 * guard both read from `ORG_OBJECT_SUBSTITUTIONS`, so they cannot drift.
 */

export type OrgObjectSubstitution = Readonly<{
  /** Salesforce standard object API name that this org does not use (no `__c` suffix). */
  standardObjectApiName: string;
  /** Org custom object API name that carries the substituted business records. */
  customObjectApiName: string;
  /** Primary Chinese business label for the substituted concept. */
  labelZh: string;
  /** Additional Chinese terms agents/users may use for the same concept. */
  aliasesZh?: readonly string[];
}>;

const OBJECT_API_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const CUSTOM_OBJECT_SUFFIX = '__c';

export const ORG_OBJECT_SUBSTITUTIONS: readonly OrgObjectSubstitution[] = Object.freeze(
  buildSortedSubstitutions([
    Object.freeze({
      standardObjectApiName: 'Quote',
      customObjectApiName: 'Quote__c',
      labelZh: '报价单',
      aliasesZh: Object.freeze(['报价']),
    }),
    Object.freeze({
      standardObjectApiName: 'QuoteLineItem',
      customObjectApiName: 'Quote_Product__c',
      labelZh: '报价产品',
      aliasesZh: Object.freeze(['报价行', '报价行项目']),
    }),
    Object.freeze({
      standardObjectApiName: 'Order',
      customObjectApiName: 'Order__c',
      labelZh: '订单信息',
      aliasesZh: Object.freeze(['订单']),
    }),
    Object.freeze({
      standardObjectApiName: 'OrderItem',
      customObjectApiName: 'Order_Product__c',
      labelZh: '订单行',
      aliasesZh: Object.freeze(['订单产品']),
    }),
    Object.freeze({
      standardObjectApiName: 'Pricebook2',
      customObjectApiName: 'Pricebook__c',
      labelZh: '价格手册',
    }),
    Object.freeze({
      standardObjectApiName: 'PricebookEntry',
      customObjectApiName: 'Pricebook_Entry__c',
      labelZh: '价格手册条目',
      aliasesZh: Object.freeze(['价格本条目']),
    }),
    Object.freeze({
      standardObjectApiName: 'Contract',
      customObjectApiName: 'Contract__c',
      labelZh: '合同信息',
      aliasesZh: Object.freeze(['合同']),
    }),
  ]),
);

assertOrgObjectUsageValid(ORG_OBJECT_SUBSTITUTIONS);

export function substitutionByStandardObject(): ReadonlyMap<string, OrgObjectSubstitution> {
  return new Map(ORG_OBJECT_SUBSTITUTIONS.map((entry) => [entry.standardObjectApiName, entry]));
}

export function notInUseStandardObjectApiNames(): readonly string[] {
  return ORG_OBJECT_SUBSTITUTIONS.map((entry) => entry.standardObjectApiName);
}

export function customObjectApiNames(): readonly string[] {
  return ORG_OBJECT_SUBSTITUTIONS.map((entry) => entry.customObjectApiName);
}

/** Chinese terms (primary plus aliases) used to describe one substituted concept. */
export function zhTerms(entry: OrgObjectSubstitution): string {
  const aliases = entry.aliasesZh !== undefined && entry.aliasesZh.length > 0
    ? ` / ${entry.aliasesZh.join(' / ')}`
    : '';
  return `${entry.labelZh}${aliases}`;
}

/** One bullet per substitution for the Playbook ORG_OBJECT_USAGE section. */
export function renderOrgObjectUsageRuleLines(): readonly string[] {
  return ORG_OBJECT_SUBSTITUTIONS.map((entry) =>
    `- Standard \`${entry.standardObjectApiName}\` (${zhTerms(entry)}) is not used in this org — query custom object \`${entry.customObjectApiName}\` (${zhTerms(entry)}) instead.`);
}

/** Compact API-name pairs used to keep tool descriptions short. */
export function orgObjectUsageToolPairs(): string {
  return ORG_OBJECT_SUBSTITUTIONS.map((entry) =>
    `\`${entry.standardObjectApiName}\`→\`${entry.customObjectApiName}\``).join(', ');
}

/** Single-sentence summary for the MCP server instructions pointer. */
export function orgObjectUsageServerPointer(): string | null {
  if (ORG_OBJECT_SUBSTITUTIONS.length === 0) return null;
  return `This org declares the standard Salesforce objects ${notInUseStandardObjectApiNames().join(', ')} not in use; review the ORG_OBJECT_USAGE playbook section and use the custom replacement object for the business concept.`;
}

function buildSortedSubstitutions(values: readonly OrgObjectSubstitution[]): readonly OrgObjectSubstitution[] {
  return Object.freeze([...values].sort((left, right) =>
    left.standardObjectApiName.localeCompare(right.standardObjectApiName, 'en-US')));
}

/**
 * Validates the declared substitutions. A malformed entry is a compile-time
 * configuration error: this module is the single source that both the prose and
 * the runtime guard consume, so it fails fast rather than drifting.
 */
export function findOrgObjectSubstitutionProblems(
  values: readonly OrgObjectSubstitution[] = ORG_OBJECT_SUBSTITUTIONS,
): string[] {
  const problems: string[] = [];
  const seenStandard = new Set<string>();
  const seenCustom = new Set<string>();
  for (const entry of values) {
    const { standardObjectApiName: standard, customObjectApiName: custom } = entry;
    if (!OBJECT_API_NAME_PATTERN.test(standard)) {
      problems.push(`standardObjectApiName "${standard}" is not a valid Salesforce object API name.`);
    } else if (standard.endsWith(CUSTOM_OBJECT_SUFFIX)) {
      problems.push(`standardObjectApiName "${standard}" looks like a custom object; a substitution must start from a standard object.`);
    } else if (seenStandard.has(standard)) {
      problems.push(`duplicate standardObjectApiName "${standard}".`);
    }
    if (!OBJECT_API_NAME_PATTERN.test(custom)) {
      problems.push(`customObjectApiName "${custom}" is not a valid Salesforce object API name.`);
    } else if (!custom.endsWith(CUSTOM_OBJECT_SUFFIX)) {
      problems.push(`customObjectApiName "${custom}" must end with "${CUSTOM_OBJECT_SUFFIX}".`);
    } else if (seenCustom.has(custom)) {
      problems.push(`duplicate customObjectApiName "${custom}".`);
    }
    if (standard === custom) {
      problems.push(`standardObjectApiName and customObjectApiName must differ for "${standard}".`);
    }
    if (entry.labelZh.trim().length === 0) {
      problems.push(`labelZh must not be empty for "${standard}".`);
    }
    seenStandard.add(standard);
    seenCustom.add(custom);
  }
  return problems;
}

function assertOrgObjectUsageValid(values: readonly OrgObjectSubstitution[]): void {
  const problems = findOrgObjectSubstitutionProblems(values);
  if (problems.length > 0) {
    throw new Error(`Invalid org object substitution registry:\n- ${problems.join('\n- ')}`);
  }
}
