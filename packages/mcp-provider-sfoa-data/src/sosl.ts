/**
 * Deterministic SOSL inspection and composition for `search_records`.
 *
 * The module has two jobs, and they are deliberately kept in one place so the schema's
 * `superRefine` and the executor cannot drift apart: decide whether a `search` input is a bare
 * keyword or a complete `FIND` clause, and compose (or pass through) the statement that is
 * actually sent to Salesforce.
 *
 * Two structural facts about SOSL drive every rule here:
 *
 * 1. **The search term lives in a brace group.** `FIND {term} IN ALL FIELDS` is the shape, and a
 *    clause has exactly one group. That is why a bare keyword refusing `{` and `}` is the whole
 *    injection argument for keyword mode: those are the only two characters that could end the
 *    group this module creates.
 * 2. **`LIMIT` means two different things at two different depths.** At depth 0 it caps the whole
 *    result set; inside `RETURNING Obj(...)` it caps that object alone. Reading the inner one as
 *    the outer one would misreport completeness, so the parser tracks depth rather than taking
 *    the first or last `LIMIT` it sees.
 */

import { stripSoqlStringLiterals } from './soql.js';

export const SOSL_MODES = ['KEYWORD', 'STATEMENT'] as const;
export type SoslMode = (typeof SOSL_MODES)[number];

/** A refusal, shared by both result types so a refusal can be returned from either one. */
export type SoslRefusal = Readonly<{ usable: false; message: string }>;

export type SoslSearchInspection =
  | SoslRefusal
  | Readonly<{ usable: true; mode: SoslMode; statementLimit: number | null }>;

/** Where the cap on the returned result set came from, or that there is none. */
export const SOSL_LIMIT_SOURCES = ['REQUEST', 'STATEMENT', 'UNSPECIFIED'] as const;
export type SoslLimitSource = (typeof SOSL_LIMIT_SOURCES)[number];

export type SoslPlan =
  | SoslRefusal
  | Readonly<{
      usable: true;
      mode: SoslMode;
      /** The exact SOSL sent to Salesforce. */
      statement: string;
      limitSource: SoslLimitSource;
      effectiveLimit: number | null;
      /** Per-object caps written inside `RETURNING Obj(... LIMIT n)`, keyed by object name. */
      perObjectLimits: Readonly<Record<string, number>>;
    }>;

/**
 * The characters SOSL reserves inside a search term. A bare keyword is escaped against this
 * table, so it can never be read as syntax: it stays a literal substitution inside the braces
 * this module writes. `{` and `}` are absent because keyword mode refuses them outright rather
 * than escaping them — a brace in a bare term is overwhelmingly an attempt to escape the group.
 */
const SOSL_RESERVED_IN_KEYWORD = '?&|![]()^~*:\\"\'+-';

/** A clause is recognised by its leading keyword, matching how `inspectSoqlQuery` reads `SELECT`. */
const SOSL_STATEMENT_HEAD = /^\s*find\b/iu;

/**
 * The field list written for an object the caller scoped the search to, when the caller named no
 * fields of its own.
 *
 * `Id` alone would make the Tool a locator, so `Name` is added: the gap this Tool closes is the
 * "which customer is called something like this" lookup, and that answer is unreadable without it.
 */
export const SEARCH_RECORDS_DEFAULT_FIELDS: readonly string[] = Object.freeze(['Id', 'Name']);

/**
 * The longest composed statement this module will produce.
 *
 * The field list is repeated for every scoped object, so the assembled statement is not bounded by
 * any single input's length: 20 objects each listing 25 fields of up to 128 characters is a hundred
 * kilobytes of SOSL, which the response budget could not then bound. The bound is stated here and
 * enforced where the statement is composed, so the size the Tool promises and the size it sends are
 * the same fact.
 */
export const SOSL_MAX_STATEMENT_LENGTH = 20_000;

/**
 * Decides whether the input is a bare keyword or a complete clause, and whether the three optional
 * narrowing parameters are legal alongside it.
 *
 * `objects`, `fields` and `limit` are refused — not ignored — when a complete clause is supplied.
 * The clause is the caller's own text: applying `objects` to it would mean rewriting the caller's
 * `RETURNING` list, and `fields` and `limit` are inert when the clause carries its own. A
 * recognised parameter that does nothing is worse than a refusal, because the caller cannot tell
 * which of them applied.
 */
export function inspectSoslSearch(
  search: string,
  scope: Readonly<{ objectsSupplied: boolean; limitSupplied: boolean; fieldsSupplied: boolean }>,
): SoslSearchInspection {
  if (!SOSL_STATEMENT_HEAD.test(search)) {
    return inspectKeyword(search, scope);
  }

  const { code, unterminated } = stripSoqlStringLiterals(search);
  if (unterminated) {
    return refuse(
      'The FIND clause has an unterminated string literal: every opening \' needs a closing \' before the end of the statement.',
    );
  }
  if (code.includes(';')) {
    return refuse(
      'The search must be a single SOSL statement. A semicolon outside a string literal is not accepted.',
    );
  }
  const openBraces = countOccurrences(code, '{');
  const closeBraces = countOccurrences(code, '}');
  if (openBraces !== 1 || closeBraces !== 1 || code.indexOf('{') > code.indexOf('}')) {
    return refuse(
      'A complete FIND clause must contain exactly one search term group, for example '
      + 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name) LIMIT 20. If you meant to search for '
      + 'this text as a keyword, remove the leading FIND so the term can be escaped and wrapped for you.',
    );
  }
  if (scope.objectsSupplied) {
    return refuse(
      'objects cannot be combined with a complete FIND clause: the RETURNING list already selects the '
      + 'objects. Pass a bare keyword with objects, or a complete clause without them.',
    );
  }
  if (scope.limitSupplied) {
    return refuse(
      'limit cannot be combined with a complete FIND clause: the clause carries its own LIMIT. Either add '
      + 'a LIMIT to the clause, or pass a bare keyword with limit.',
    );
  }
  if (scope.fieldsSupplied) {
    return refuse(
      'fields cannot be combined with a complete FIND clause: the clause carries its own RETURNING field list. '
      + 'Pass a bare keyword with objects and fields, or a complete clause without them.',
    );
  }
  return Object.freeze({
    usable: true,
    mode: 'STATEMENT',
    statementLimit: findGlobalSoslLimit(code),
  });
}

/**
 * Keyword mode. The term is not SOSL syntax, so it is never blanked as one: running the literal
 * scanner over `O'Brien` would read the apostrophe as an opening quote and refuse a perfectly
 * ordinary search term. Only two structural characters are refused, and everything else is escaped.
 */
function inspectKeyword(
  search: string,
  scope: Readonly<{ objectsSupplied: boolean; fieldsSupplied: boolean }>,
): SoslSearchInspection {
  if (search.includes(';')) {
    return refuse(
      'The search term must not contain a semicolon: this Tool accepts a single search only. Pass the term '
      + 'without it, or a complete FIND clause if you meant to write SOSL.',
    );
  }
  if (search.includes('{') || search.includes('}')) {
    return refuse(
      'The search term must not contain { or } because a bare term is placed inside FIND {…}. Pass a '
      + 'complete FIND clause instead if the braces are part of the SOSL you meant to write.',
    );
  }
  if (scope.fieldsSupplied && !scope.objectsSupplied) {
    return refuse(
      'fields cannot be used without objects: a field list describes the objects named in RETURNING, and a search '
      + 'with no objects returns each record\'s Id and object type only. Name the objects whose fields you want, or '
      + 'drop fields.',
    );
  }
  return Object.freeze({ usable: true, mode: 'KEYWORD', statementLimit: null });
}

/**
 * Builds the statement for a bare keyword. The term is escaped and wrapped, the optional object
 * scope becomes the `RETURNING` list, and the caller's row budget becomes the global `LIMIT` —
 * always, so that keyword mode always has a stated cap and truncation is decidable.
 *
 * A field list is not optional in practice. `RETURNING <Object>` is legal SOSL and is accepted,
 * but it returns each record with nothing except `attributes` and `Id` — verified live, and a
 * clause with no `RETURNING` at all behaves the same way (see
 * `docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md` §4). A search that answers with opaque ids is a locator,
 * not the "which record is called something like this" lookup this Tool exists for, so a field list
 * is always written: the caller's, or `Id, Name`. The cost is that an object with no `Name` field
 * (Case, Task) needs an explicit list — which fails loudly as `INVALID_FIELD`, mapped to
 * `MCP_SEARCH_FIELD_INVALID`, rather than quietly returning a shape the caller did not ask for.
 */
export function composeSoslKeywordStatement(options: Readonly<{
  keyword: string;
  objects?: readonly string[];
  fields?: readonly string[];
  limit: number;
}>): string {
  const { keyword, objects, fields, limit } = options;
  const scope = objects === undefined || objects.length === 0
    ? ''
    : ` RETURNING ${objects.map((name) => renderReturningObject(name, fields)).join(', ')}`;
  return `FIND {${escapeSoslKeyword(keyword)}} IN ALL FIELDS${scope} LIMIT ${limit}`;
}

/**
 * One `RETURNING` entry. The same field list is written for every object, because the caller names
 * one list: SOSL allows a per-object list, but nothing in the request distinguishes between them,
 * and inventing a per-object split would be guessing at the caller's intent.
 */
function renderReturningObject(objectApiName: string, fields: readonly string[] | undefined): string {
  const requested = fields === undefined || fields.length === 0 ? SEARCH_RECORDS_DEFAULT_FIELDS : fields;
  return `${objectApiName}(${requested.join(', ')})`;
}

/**
 * Resolves the whole plan for one call: the statement to send and the facts needed to describe
 * how complete its result can be. The executor uses this; the input schema uses `inspectSoslSearch`
 * on the same rules.
 *
 * `limit` is what the caller actually supplied and `defaultLimit` is what to use in its place, kept
 * separate because the two are not interchangeable: a clause may not be combined with a limit the
 * caller *supplied*, while a keyword always needs one to be composed.
 */
export function planSoslSearch(
  search: string,
  options: Readonly<{
    objects?: readonly string[];
    fields?: readonly string[];
    limit?: number;
    defaultLimit: number;
  }>,
): SoslPlan {
  const objects = options.objects;
  const inspection = inspectSoslSearch(search, {
    objectsSupplied: objects !== undefined && objects.length > 0,
    limitSupplied: options.limit !== undefined,
    fieldsSupplied: options.fields !== undefined && options.fields.length > 0,
  });
  if (!inspection.usable) {
    return inspection;
  }
  if (inspection.mode === 'KEYWORD') {
    const limit = options.limit ?? options.defaultLimit;
    const statement = composeSoslKeywordStatement({
      keyword: search,
      ...(objects === undefined ? {} : { objects }),
      ...(options.fields === undefined ? {} : { fields: options.fields }),
      limit,
    });
    if (statement.length > SOSL_MAX_STATEMENT_LENGTH) {
      return refuse(
        `The composed search would be ${statement.length} characters, above the ${SOSL_MAX_STATEMENT_LENGTH}-character `
        + 'limit for a single SOSL statement. Shorten the search term, name fewer objects, or ask for fewer fields, and '
        + 'search the remaining objects in a second call.',
      );
    }
    return Object.freeze({
      usable: true,
      mode: 'KEYWORD',
      statement,
      limitSource: 'REQUEST',
      effectiveLimit: limit,
      perObjectLimits: Object.freeze({}),
    });
  }
  const { code } = stripSoqlStringLiterals(search);
  return Object.freeze({
    usable: true,
    mode: 'STATEMENT',
    statement: search,
    limitSource: inspection.statementLimit === null ? 'UNSPECIFIED' : 'STATEMENT',
    effectiveLimit: inspection.statementLimit,
    perObjectLimits: findSoslReturningLimits(code),
  });
}

/**
 * Escapes a bare term so it stays a literal inside the brace group. A trailing backslash becomes
 * `\\` by the same table, so it cannot escape the closing brace this module writes.
 */
export function escapeSoslKeyword(term: string): string {
  let escaped = '';
  for (const char of term) {
    escaped += SOSL_RESERVED_IN_KEYWORD.includes(char) ? `\\${char}` : char;
  }
  return escaped;
}

/**
 * The whole-result cap: the last `LIMIT <n>` written at depth 0. A `LIMIT` inside
 * `RETURNING Obj(...)` sits at depth 1 and caps that object alone, so taking the outermost one is
 * what makes `effectiveLimit` describe the size of the result set rather than one slice of it.
 */
export function findGlobalSoslLimit(code: string): number | null {
  const depths = parenDepths(code);
  const pattern = /\blimit\s+(\d+)\b/giu;
  let found: number | null = null;
  let match = pattern.exec(code);
  while (match !== null) {
    if (depths[match.index] === 0) {
      const value = Number.parseInt(match[1] as string, 10);
      if (Number.isSafeInteger(value)) {
        found = value;
      }
    }
    match = pattern.exec(code);
  }
  return found;
}

/**
 * Per-object caps written as `RETURNING Account(Id, Name LIMIT 5)`. An object spec's opening
 * parenthesis sits at depth 0 and its contents at depth 1, which is what distinguishes it from a
 * function call inside a `WHERE` clause (those open at depth 1 or deeper).
 */
export function findSoslReturningLimits(code: string): Readonly<Record<string, number>> {
  const depths = parenDepths(code);
  const returningIndex = findTopLevelKeyword(code, depths, 'returning');
  if (returningIndex === null) {
    return Object.freeze({});
  }
  const opener = /([A-Za-z][A-Za-z0-9_]*)\s*\(/gu;
  const limits: Record<string, number> = {};
  let match = opener.exec(code);
  while (match !== null) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchingParen(code, openIndex);
    if (depths[openIndex] === 0 && openIndex > returningIndex && closeIndex !== null) {
      const scope = findGlobalSoslLimit(code.slice(openIndex + 1, closeIndex));
      if (scope !== null) {
        limits[match[1] as string] = scope;
      }
    }
    match = opener.exec(code);
  }
  return Object.freeze(limits);
}

/**
 * The nesting depth of every index, so a rule can ask "is this token at the top level?" rather than
 * pattern-matching the statement's shape. Length-preserving, so indices describe the original.
 */
function parenDepths(code: string): readonly number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    const current = code[index] as string;
    depths.push(depth);
    if (current === '(') {
      depth += 1;
    } else if (current === ')') {
      depth = Math.max(0, depth - 1);
    }
  }
  return depths;
}

function findTopLevelKeyword(code: string, depths: readonly number[], keyword: string): number | null {
  const pattern = new RegExp(`\\b${keyword}\\b`, 'giu');
  let match = pattern.exec(code);
  while (match !== null) {
    if (depths[match.index] === 0) {
      return match.index;
    }
    match = pattern.exec(code);
  }
  return null;
}

function matchingParen(code: string, openIndex: number): number | null {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    const current = code[index] as string;
    if (current === '(') {
      depth += 1;
    } else if (current === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function countOccurrences(code: string, character: string): number {
  let count = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === character) {
      count += 1;
    }
  }
  return count;
}

function refuse(message: string): SoslRefusal {
  return Object.freeze({ usable: false, message });
}
