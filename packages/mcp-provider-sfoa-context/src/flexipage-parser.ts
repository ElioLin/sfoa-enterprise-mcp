import { uiPageSchema, visibilityRuleSchema, type UiFieldInstance, type UiPage } from './effective-ui-contracts.js';

export function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function asArray(value: unknown): unknown[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
export function textValue(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }

/** Parse only structural current facts; raw SDK metadata never enters the snapshot. */
export function parseFlexiPage(raw: unknown, objectApiName: string): UiPage {
  const page = asObject(raw);
  const regions = asArray(page.flexiPageRegions).map(asObject);
  const byName = new Map(regions.map((region) => [textValue(region.name), region]));
  const fields: UiFieldInstance[] = [];
  const unsupported = new Set<string>();
  const visitedFields = new Set<unknown>();
  let sectionCounter = 0;
  let desktopDetail = false;
  let steps = 0;
  if (regions.length > 500 || byName.size !== regions.length) throw new Error('FLEXIPAGE_REGION_BOUND');
  if (page.parentFlexiPage) unsupported.add('INHERITED_PAGE_UNSUPPORTED');
  if (page.type !== 'RecordPage' || page.sobjectType !== objectApiName) unsupported.add('UNSUPPORTED_PAGE');
  function visit(name: string, ancestry: string[], section: string | null, sectionOrder: number, column: number,
    inherited: UiFieldInstance['rules']): void {
    if (++steps > 3000 || ancestry.length > 25 || ancestry.includes(name)) throw new Error('FLEXIPAGE_CYCLE_OR_BOUND');
    const region = byName.get(name);
    if (!region) throw new Error('FLEXIPAGE_MISSING_REGION');
    const path = [...ancestry, name];
    for (const [itemIndex, item] of asArray(region.itemInstances).map(asObject).entries()) {
      if (item.fieldInstance) {
        visitedFields.add(item.fieldInstance);
        const field = asObject(item.fieldInstance);
        const apiName = /^Record\.([A-Za-z][A-Za-z0-9_]*)$/u.exec(String(field.fieldItem))?.[1];
        if (!apiName || !section) { unsupported.add('UNSUPPORTED_FIELD_PLACEMENT'); continue; }
        const behavior = properties(field.fieldInstanceProperties).get('uiBehavior');
        if (behavior && !['none', 'required', 'readonly'].includes(String(behavior).toLowerCase())) unsupported.add('UNSUPPORTED_UI_BEHAVIOR');
        fields.push({ apiName, instanceId: textValue(field.identifier) ?? `${apiName}_${fields.length}`,
          section, sectionOrder, column, order: fields.length, ancestry: path,
          required: String(behavior).toLowerCase() === 'required', readOnly: String(behavior).toLowerCase() === 'readonly',
          rules: [...inherited, ...ruleOf(field.visibilityRule, 'FIELD')],
        });
      }
      if (!item.componentInstance) continue;
      const component = asObject(item.componentInstance);
      const kind = String(component.componentName);
      // This mobile-only fallback is not a desktop Record Detail component.
      if (kind === 'force:recordDetailPanelMobile') continue;
      if (kind === 'force:detailPanel' || kind === 'force:recordDetail') desktopDetail = true;
      const props = properties(component.componentInstanceProperties);
      const refs = [...props.entries()].flatMap(([key, value]) =>
        ['body', 'columns', 'tabs', 'left', 'right'].includes(key) ? references(value) : []);
      const isSection = kind === 'flexipage:fieldSection';
      const nextSection = isSection ? String(props.get('label') ?? component.identifier ?? `Section ${sectionCounter + 1}`) : section;
      const nextSectionOrder = isSection ? sectionCounter++ : sectionOrder;
      const knownContainer = ['flexipage:fieldSection', 'flexipage:column', 'flexipage:tab', 'flexipage:tabset', 'flexipage:accordion', 'flexipage:accordionSection'].includes(kind);
      const rules = [...inherited, ...ruleOf(component.visibilityRule, 'CONTAINER')];
      if (refs.length && !knownContainer) rules.push({ scope: 'CONTAINER', rule: { criteria: [], unsupported: true } });
      refs.forEach((ref, index) => visit(ref, path, nextSection, nextSectionOrder,
        kind === 'flexipage:column' ? itemIndex : isSection ? index : column, rules));
    }
  }
  for (const region of regions.filter((entry) => entry.type === 'Region')) {
    if (typeof region.name === 'string') visit(region.name, [], null, 0, 0, []);
  }
  const rawFieldCount = regions.flatMap((region) => asArray(region.itemInstances)).filter((item) => asObject(item).fieldInstance).length;
  if (rawFieldCount !== visitedFields.size) unsupported.add('UNREACHABLE_FIELDS');
  return uiPageSchema.parse({ fullName: page.fullName, objectApiName, type: page.type,
    formSource: fields.length ? desktopDetail ? 'MIXED' : 'DYNAMIC_FORMS' : desktopDetail ? 'PAGE_LAYOUT' : 'UNRESOLVED',
    fields, unsupported: [...unsupported],
  });
}

function properties(raw: unknown): Map<string, unknown> {
  return new Map(asArray(raw).map(asObject).map((property) => [String(property.name), property.value ?? property.valueList]));
}
function references(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.flatMap(references);
  const value = asObject(raw);
  return value.value !== undefined ? references(value.value) : value.valueListItems !== undefined ? references(value.valueListItems) : [];
}
function ruleOf(raw: unknown, scope: 'FIELD' | 'CONTAINER'): UiFieldInstance['rules'] {
  if (raw == null) return [];
  const value = asObject(raw);
  const parsed = visibilityRuleSchema.safeParse({
    criteria: asArray(value.criteria).map(asObject).map((criterion) => ({
      leftValue: criterion.leftValue, operator: criterion.operator,
      ...(criterion.rightValue !== undefined ? { rightValue: criterion.rightValue } : {}),
    })),
    ...(value.booleanFilter ? { booleanFilter: value.booleanFilter } : {}),
  });
  return [{ scope, rule: parsed.success ? parsed.data : { criteria: [], unsupported: true } }];
}
