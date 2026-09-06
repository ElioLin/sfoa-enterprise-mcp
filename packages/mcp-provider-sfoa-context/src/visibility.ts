import type { VisibilityRule, VisibilityState, FormFactor } from './effective-ui-contracts.js';

export type VisibilityFacts = Readonly<{
  draftFields: Readonly<Record<string, unknown>>;
  fieldTypes: Readonly<Record<string, string>>;
  user: Readonly<Record<string, unknown>>;
  permissions?: Readonly<Record<string, boolean>>;
  formFactor: FormFactor;
}>;
export type VisibilityDecision = Readonly<{
  state: VisibilityState; dependsOn: string[]; kinds: string[];
}>;

export function combineVisibility(states: readonly VisibilityState[], operator: 'AND' | 'OR'): VisibilityState {
  if (operator === 'AND' && states.includes('HIDDEN')) return 'HIDDEN';
  if (operator === 'OR' && states.includes('VISIBLE')) return 'VISIBLE';
  if (states.includes('UNKNOWN')) return 'UNKNOWN';
  if (states.includes('PENDING')) return 'PENDING';
  return operator === 'AND' ? 'VISIBLE' : 'HIDDEN';
}

/** Four-state evaluation; no eval(), coercive truthiness, record queries or LLM. */
export function evaluateVisibility(rule: VisibilityRule, facts: VisibilityFacts, scope: 'FIELD' | 'CONTAINER' = 'FIELD'): VisibilityDecision {
  if (rule.unsupported || rule.criteria.length === 0) return { state: 'UNKNOWN', dependsOn: [], kinds: ['UNSUPPORTED'] };
  const decisions = rule.criteria.map((criterion): VisibilityDecision => {
    if (!['EQUAL', 'EQ', 'NE', 'NOT_EQUAL', 'GT', 'GE', 'LT', 'LE', 'CONTAINS', 'IS_NULL', 'IS_NOT_NULL', 'NOT_NULL'].includes(criterion.operator.toUpperCase())) {
      return { state: 'UNKNOWN', dependsOn: [], kinds: ['UNSUPPORTED_OPERATOR'] };
    }
    const path = criterion.leftValue.replace(/^\{!|\}$/gu, '');
    let value: unknown;
    let kind = 'UNSUPPORTED';
    let type: string | undefined;
    const record = /^(?:\$?Record)\.([A-Za-z][A-Za-z0-9_]*)$/u.exec(path);
    if (record?.[1]) {
      const field = record[1];
      kind = 'RECORD_FIELD';
      if (!Object.hasOwn(facts.fieldTypes, field)) return { state: 'UNKNOWN', dependsOn: [], kinds: [kind] };
      // Section/tab visibility is evaluated on page load, not on unsaved field edits.
      // Until a CREATE initial-container contract is proved, do not reuse field draft semantics.
      if (scope === 'CONTAINER') return { state: 'UNKNOWN', dependsOn: [field], kinds: ['CONTAINER_RECORD_UNSUPPORTED'] };
      if (!Object.hasOwn(facts.draftFields, field)) return { state: 'PENDING', dependsOn: [field], kinds: [kind] };
      value = facts.draftFields[field];
      type = facts.fieldTypes[field];
    } else if (/^(?:\$?User)\.(?:Id|ProfileId|Profile\.Id|Profile\.Name|UserType|LanguageLocaleKey)$/u.test(path)) {
      kind = 'USER';
      const key = path.replace(/^\$?User\./u, '');
      if (!Object.hasOwn(facts.user, key)) return { state: 'UNKNOWN', dependsOn: [], kinds: [kind] };
      value = facts.user[key];
    } else if (/^(?:\$?Permission)\.[A-Za-z][A-Za-z0-9_]*$/u.test(path)) {
      kind = 'PERMISSION';
      const key = path.replace(/^\$?Permission\./u, '');
      if (!facts.permissions || !Object.hasOwn(facts.permissions, key)) return { state: 'UNKNOWN', dependsOn: [], kinds: [kind] };
      value = facts.permissions[key]; type = 'Boolean';
    } else if (['$Browser.formFactor', '$Client.formFactor', '$FormFactor'].includes(path)) {
      kind = 'FORM_FACTOR'; value = facts.formFactor;
    } else return { state: 'UNKNOWN', dependsOn: [], kinds: [kind] };
    return { state: compare(value, criterion.rightValue, criterion.operator, type), dependsOn: record?.[1] ? [record[1]] : [], kinds: [kind] };
  });
  let state: VisibilityState;
  try {
    state = rule.booleanFilter
      ? booleanFilter(rule.booleanFilter, decisions.map((decision) => decision.state))
      : combineVisibility(decisions.map((decision) => decision.state), 'AND');
  } catch { state = 'UNKNOWN'; }
  return {
    state,
    dependsOn: [...new Set(decisions.flatMap((decision) => decision.dependsOn))],
    kinds: [...new Set(decisions.flatMap((decision) => decision.kinds))],
  };
}

function compare(left: unknown, right: unknown, operator: string, type?: string): VisibilityState {
  const op = operator.toUpperCase();
  if (left === undefined) return 'UNKNOWN';
  if (op === 'IS_NULL') return left === null ? 'VISIBLE' : 'HIDDEN';
  if (op === 'IS_NOT_NULL' || op === 'NOT_NULL') return left === null ? 'HIDDEN' : 'VISIBLE';
  if (right === undefined || left === undefined) return 'UNKNOWN';
  let expected = right;
  if (type === 'Boolean' && typeof right === 'string') {
    if (!['true', 'false'].includes(right.toLowerCase())) return 'UNKNOWN';
    expected = right.toLowerCase() === 'true';
  }
  if (type && ['Currency', 'Double', 'Int', 'Integer', 'Long', 'Percent'].includes(type) && typeof right === 'string') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(right)) return 'UNKNOWN';
    expected = Number(right);
  }
  if (['EQUAL', 'EQ', 'NE', 'NOT_EQUAL'].includes(op)) {
    if (left !== null && expected !== null && typeof left !== typeof expected) return 'UNKNOWN';
    const equal = left === expected;
    return (op === 'NE' || op === 'NOT_EQUAL' ? !equal : equal) ? 'VISIBLE' : 'HIDDEN';
  }
  if (op === 'CONTAINS') return typeof left === 'string' && typeof expected === 'string'
    ? left.includes(expected) ? 'VISIBLE' : 'HIDDEN' : 'UNKNOWN';
  if (typeof left !== 'number' || typeof expected !== 'number') return 'UNKNOWN';
  const value = op === 'GT' ? left > expected : op === 'GE' ? left >= expected
    : op === 'LT' ? left < expected : op === 'LE' ? left <= expected : undefined;
  return value === undefined ? 'UNKNOWN' : value ? 'VISIBLE' : 'HIDDEN';
}

function booleanFilter(source: string, states: readonly VisibilityState[]): VisibilityState {
  const tokens = source.toUpperCase().match(/\d+|AND|OR|[()]/gu) ?? [];
  if (tokens.join('') !== source.toUpperCase().replace(/\s/gu, '') || tokens.length > 150) throw new Error('FILTER');
  let offset = 0;
  function term(depth: number): VisibilityState {
    if (depth > 25) throw new Error('FILTER_DEPTH');
    const token = tokens[offset++];
    if (token === '(') {
      const value = expression(depth + 1);
      if (tokens[offset++] !== ')') throw new Error('FILTER_PAREN');
      return value;
    }
    if (!token || !/^[1-9]\d*$/u.test(token) || !states[Number(token) - 1]) throw new Error('FILTER_INDEX');
    return states[Number(token) - 1] as VisibilityState;
  }
  function conjunction(depth: number): VisibilityState {
    let value = term(depth);
    while (tokens[offset] === 'AND') { offset++; value = combineVisibility([value, term(depth)], 'AND'); }
    return value;
  }
  function expression(depth: number): VisibilityState {
    let value = conjunction(depth);
    while (tokens[offset] === 'OR') { offset++; value = combineVisibility([value, conjunction(depth)], 'OR'); }
    return value;
  }
  const result = expression(0);
  if (offset !== tokens.length) throw new Error('FILTER_TRAILING');
  return result;
}
