import {
  substitutionByStandardObject,
  zhTerms,
  type OrgObjectSubstitution,
} from '@sfoa/agent-playbook';

/**
 * Deterministic object-usage guard for USER `run_soql_query`.
 *
 * The org declares several Salesforce standard objects unused (see
 * @sfoa/agent-playbook ORG_OBJECT_SUBSTITUTIONS). Salesforce cannot express that
 * substitution, and an unused standard object commonly returns zero rows, which
 * an agent would misreport as "none exists". This guard rejects such a query
 * before any Salesforce call so the agent is told the replacement object instead
 * of silently receiving an empty result. It never rewrites the query.
 */

export type SoqlObjectUsageVerdict =
  | Readonly<{ blocked: false }>
  | Readonly<{ blocked: true; substitution: OrgObjectSubstitution }>;

/**
 * Extracts the top-level SOQL object name. Only the outermost FROM is matched:
 * sub-queries in the SELECT list or WHERE clause are inside parentheses, and
 * string literals are skipped, so `SELECT (SELECT Id FROM QuoteLineItem) FROM Quote`
 * yields `Quote`, not `QuoteLineItem`. Returns undefined when the object cannot be
 * determined, in which case the caller must not block.
 */
export function extractSoqlTopLevelObject(query: string): string | undefined {
  let depth = 0;
  let inString = false;
  let index = 0;
  while (index < query.length) {
    const current = query[index];
    if (inString) {
      // SOQL string literals are single-quoted; '' is an escaped quote.
      if (current === "'") {
        if (query[index + 1] === "'") {
          index += 2;
          continue;
        }
        inString = false;
      }
      index += 1;
      continue;
    }
    if (current === "'") {
      inString = true;
      index += 1;
      continue;
    }
    if (current === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (current === ')') {
      depth = depth > 0 ? depth - 1 : 0;
      index += 1;
      continue;
    }
    if (current === '/' && query[index + 1] === '*') {
      const end = query.indexOf('*/', index + 2);
      if (end === -1) return undefined;
      index = end + 2;
      continue;
    }
    if (depth === 0 && (current === 'F' || current === 'f') && isFromKeywordAt(query, index)) {
      index += 4;
      while (index < query.length && isSpace(query[index])) index += 1;
      const start = index;
      while (index < query.length && isObjectNameChar(query[index])) index += 1;
      const objectName = query.slice(start, index);
      return objectName.length > 0 ? objectName : undefined;
    }
    index += 1;
  }
  return undefined;
}

export function evaluateSoqlObjectUsageGuard(input: Readonly<{
  query?: unknown;
  useToolingApi?: unknown;
}>): SoqlObjectUsageVerdict {
  if (input.useToolingApi === true) return { blocked: false };
  if (typeof input.query !== 'string' || input.query.trim().length === 0) return { blocked: false };
  const objectName = extractSoqlTopLevelObject(input.query);
  if (objectName === undefined) return { blocked: false };
  const substitution = substitutionByStandardObject().get(objectName);
  return substitution === undefined ? { blocked: false } : { blocked: true, substitution };
}

export function describeSoqlObjectUsageBlock(substitution: OrgObjectSubstitution): string {
  return `The Salesforce standard object ${substitution.standardObjectApiName} is declared not in use in this org; business data lives in the custom object ${substitution.customObjectApiName} (${zhTerms(substitution)}). Query ${substitution.customObjectApiName} instead and do not target ${substitution.standardObjectApiName}.`;
}

function isFromKeywordAt(query: string, index: number): boolean {
  if (query.slice(index, index + 4).toUpperCase() !== 'FROM') return false;
  const before = index > 0 ? query[index - 1] : ' ';
  const after = index + 4 < query.length ? query[index + 4] : ' ';
  return !isObjectNameChar(before) && !isObjectNameChar(after);
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /[\s]/u.test(character);
}

function isObjectNameChar(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}
