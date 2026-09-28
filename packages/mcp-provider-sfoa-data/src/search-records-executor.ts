import type { OrgService } from '@salesforce/mcp-provider-api';
import { DataRuntimeError } from './errors.js';
import { readArray, readField, readIdentifier } from './list-sobjects-executor.js';
import { resolveRequestConnection } from './org-connection.js';
import { isPlainRecord, ORG_LIMITS_TOOL_NAME } from './query-records-executor.js';
import { DATA_MAX_RESPONSE_BYTES, trimToByteBudget } from './response-budget.js';
import { mapDataFailure, type DataFailureMapping } from './salesforce-errors.js';
import { planSoslSearch, type SoslLimitSource, type SoslMode } from './sosl.js';
import {
  SEARCH_RECORDS_DEFAULT_LIMIT,
  type SearchRecordGroup,
  type SearchRecordsInput,
  type SearchRecordsOutput,
  type SearchTruncationReason,
} from './schemas.js';

/** Tools a hint may recommend, by the name they are advertised under. */
export const QUERY_RECORDS_TOOL_NAME = 'query_records';

export type SearchRecordsExecutorOptions = Readonly<{
  /**
   * The SFOA Data Tools currently advertised in this session. A hint may only name a Tool the
   * caller can actually call, so `query_records` is recommended by name only when it is in this
   * set — otherwise the ids-only hint stops short of naming a Tool `tools/list` does not carry.
   */
  enabledToolNames?: readonly string[];
}>;

/** One returned record, with the object SOSL grouped it under. */
export type SearchHit = Readonly<{
  objectApiName: string;
  record: Readonly<Record<string, unknown>>;
}>;

/**
 * Runs one SOSL search and reports what came back, grouped by object.
 *
 * This is the cross-object keyword lookup SOQL structurally cannot do: `query_records` needs an
 * object and a field list up front, so "which records anywhere mention this term" has no SOQL
 * equivalent. The cost of SOSL is that it reports no total match count and hands out no
 * continuation cursor, so this Tool states completeness in terms of the explicit `LIMIT` that bound
 * the search and refuses to claim more than that — an answer that cannot be shown to be the whole
 * set is reported as `complete: false` with the reason, never as a complete-looking slice.
 */
export class SearchRecordsExecutor {
  private readonly enabledToolNames: readonly string[];

  public constructor(
    private readonly orgService: OrgService,
    private readonly options: SearchRecordsExecutorOptions = {},
  ) {
    this.enabledToolNames = options.enabledToolNames ?? [];
  }

  public async execute(input: SearchRecordsInput): Promise<SearchRecordsOutput> {
    const objectsSupplied = (input.objects?.length ?? 0) > 0;
    try {
      // Re-planned here rather than trusted from the caller: the registered wire schema is a raw
      // shape whose JSON Schema cannot express the keyword/clause rules (see ADR-0024), so a caller
      // that reaches this class without the Tool's own parse must still not be able to hand
      // Salesforce a statement this Tool refuses to send.
      const plan = planSoslSearch(input.search, {
        ...(input.objects === undefined ? {} : { objects: input.objects }),
        ...(input.fields === undefined ? {} : { fields: input.fields }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        defaultLimit: SEARCH_RECORDS_DEFAULT_LIMIT,
      });
      if (!plan.usable) {
        throw new DataRuntimeError('MCP_DATA_INVALID_INPUT', `Invalid Data Tool input: search: ${plan.message}`);
      }
      const connection = await resolveRequestConnection(this.orgService);
      const payload: unknown = await connection.search(plan.statement);
      const { hits, unreadable } = readSearchRecords(payload);
      const state: SearchState = {
        hits,
        unreadable,
        objectsSupplied,
        mode: plan.mode,
        statement: plan.statement,
        limitSource: plan.limitSource,
        effectiveLimit: plan.effectiveLimit,
        perObjectLimits: plan.perObjectLimits,
      };
      // The byte budget is applied to the flat record list, in group order, and the prefix is
      // re-grouped afterwards. Cutting a flat prefix rather than nested arrays is what makes the
      // per-object counts honest: a group is kept whole, kept partly, or dropped, and never has a
      // hole in the middle.
      return this.build(state, trimToByteBudget(hits, DATA_MAX_RESPONSE_BYTES, (kept) => this.build(state, kept)).kept);
    } catch (error) {
      throw mapDataFailure(error, searchFailureMapping(this.enabledToolNames.includes(ORG_LIMITS_TOOL_NAME)));
    }
  }

  private build(state: SearchState, kept: readonly SearchHit[]): SearchRecordsOutput {
    const groups = groupHits(state.hits);
    const included = new Map<string, Readonly<Record<string, unknown>>[]>();
    for (const hit of kept) {
      const list = included.get(hit.objectApiName);
      if (list === undefined) included.set(hit.objectApiName, [hit.record]);
      else list.push(hit.record);
    }

    const resultsByObject: Record<string, SearchRecordGroup> = {};
    let anyObjectAtLimit = false;
    for (const group of groups) {
      const cap = state.perObjectLimits[group.objectApiName];
      // Only a cap that could be read out of the statement is compared against. Where the caller's
      // clause carries a per-object LIMIT this Tool cannot see, `atLimit` stays false: guessing a
      // cap would turn an incomplete answer into a confident one.
      const atLimit = cap !== undefined && group.records.length >= cap;
      if (atLimit) anyObjectAtLimit = true;
      const records = included.get(group.objectApiName) ?? [];
      resultsByObject[group.objectApiName] = Object.freeze({
        objectApiName: group.objectApiName,
        count: group.records.length,
        returnedCount: records.length,
        atLimit,
        records: Object.freeze(records),
      });
    }

    const totalReturned = state.hits.length + state.unreadable;
    const returnedCount = kept.length;
    const budgetCut = returnedCount < state.hits.length;
    const limitReached = state.effectiveLimit !== null && totalReturned >= state.effectiveLimit;
    const truncated = limitReached || anyObjectAtLimit || budgetCut;
    // The enum carries the constraint that bound the *returned* slice, because that is what the
    // caller holding these records has to work around; the hint still names every binding.
    const truncatedReason: SearchTruncationReason | null = budgetCut
      ? 'RESPONSE_BUDGET'
      : limitReached
        ? 'LIMIT_REACHED'
        : anyObjectAtLimit
          ? 'PER_OBJECT_LIMIT'
          : null;
    // Completeness is claimed only against an explicit cap that was not reached. With no readable
    // LIMIT there is nothing to compare against, and a record this Tool could not classify is not
    // returned at all — so neither case may report a complete answer.
    const complete = !truncated && state.unreadable === 0 && state.effectiveLimit !== null
      && totalReturned < state.effectiveLimit;

    return {
      success: true,
      executionRole: 'USER',
      api: 'REST',
      mode: state.mode,
      statement: state.statement,
      resultsByObject,
      totalReturned,
      returnedCount,
      unreadableRecords: state.unreadable,
      objectsReturned: groups.length,
      effectiveLimit: state.effectiveLimit,
      limitSource: state.limitSource,
      truncated,
      truncatedReason,
      complete,
      hint: searchHint(
        { ...state, totalReturned, returnedCount, truncated, truncatedReason, complete },
        this.enabledToolNames,
      ),
    };
  }
}

/**
 * Reads the records out of a `SearchResult` payload.
 *
 * The payload has exactly one key, `searchRecords`, and no total and no cursor — verified live, see
 * `docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md` §2 — so nothing about completeness can be read off it.
 *
 * A record's object comes from `attributes.type`, with `attributes.sobjectType` as the only
 * fallback. A record-level `Type` or `type` field is deliberately **not** consulted: on Case and
 * Account those are ordinary picklist fields holding a business value, so reading one as an object
 * name would invent an object and file the record under it. A record whose type cannot be read is
 * counted, never guessed at.
 */
export function readSearchRecords(
  value: unknown,
): Readonly<{ hits: readonly SearchHit[]; unreadable: number }> {
  const entries = readArray(readField(value, 'searchRecords'));
  const hits: SearchHit[] = [];
  let unreadable = 0;
  for (const entry of entries) {
    if (!isPlainRecord(entry)) {
      unreadable += 1;
      continue;
    }
    const objectApiName = readRecordObjectType(entry);
    if (objectApiName === null) {
      unreadable += 1;
      continue;
    }
    hits.push(Object.freeze({ objectApiName, record: entry }));
  }
  return Object.freeze({ hits: Object.freeze(hits), unreadable });
}

function readRecordObjectType(record: Readonly<Record<string, unknown>>): string | null {
  const attributes = readField(record, 'attributes');
  return readIdentifier(readField(attributes, 'type')) ?? readIdentifier(readField(attributes, 'sobjectType'));
}

/**
 * Groups records by object, keeping the order Salesforce ranked the objects in.
 *
 * The first record seen for an object fixes its position, so the reading order still carries the
 * relevance ordering the platform produced. Sorting alphabetically would be equally deterministic
 * but would throw that away, and it is the one signal SOSL gives about which match is strongest.
 */
function groupHits(hits: readonly SearchHit[]): readonly Readonly<{
  objectApiName: string;
  records: readonly Readonly<Record<string, unknown>>[];
}>[] {
  const order: string[] = [];
  const byObject = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const hit of hits) {
    const list = byObject.get(hit.objectApiName);
    if (list === undefined) {
      byObject.set(hit.objectApiName, [hit.record]);
      order.push(hit.objectApiName);
    } else {
      list.push(hit.record);
    }
  }
  return order.map((objectApiName) => Object.freeze({
    objectApiName,
    records: Object.freeze(byObject.get(objectApiName) ?? []),
  }));
}

/**
 * The next step for a search result, worded around what actually bounded it.
 *
 * Three things are always worth saying when they are true, and they are independent: the result was
 * cut, some records could not be classified, or no object was named so every row is an opaque id.
 * The last one matters even for a complete result — a complete list of ids still does not answer
 * "which customer is called something like this".
 */
function searchHint(state: HintState, enabledToolNames: readonly string[]): string {
  const parts: string[] = [];
  if (state.truncated) {
    parts.push(
      `Truncated by ${state.truncatedReason ?? 'LIMIT_REACHED'}: Salesforce returned ${state.totalReturned} record(s) `
      + `and ${state.returnedCount} are included in resultsByObject.`,
    );
    parts.push(bindingFix(state));
  } else if (state.complete) {
    parts.push(
      `Complete: all ${state.totalReturned} matching record(s) are included, fewer than the ${state.effectiveLimit} `
      + 'record limit this search was held to.',
    );
  } else {
    parts.push(
      'Completeness could not be established: SOSL reports no total match count, and this search carried no LIMIT this '
      + 'Tool could read, so the result may be a slice of a larger set.',
    );
    parts.push('Add a LIMIT to the clause, or pass a bare keyword so this Tool composes one.');
  }
  if (state.unreadable > 0) {
    parts.push(
      `${state.unreadable} returned record(s) carried no readable object type and are counted in totalReturned but not `
      + 'listed; read them individually with query_records by Id if they matter.',
    );
  }
  if (!state.objectsSupplied) {
    const readableRows = enabledToolNames.includes(QUERY_RECORDS_TOOL_NAME)
      ? ` Name objects and fields for readable rows, or read these Ids with ${QUERY_RECORDS_TOOL_NAME} using a WHERE Id IN (…) clause.`
      : ' Name objects and fields for readable rows.';
    parts.push(`No objects were named, so each record carries only its Id and object type.${readableRows}`);
  }
  return parts.join(' ');
}

function bindingFix(state: HintState): string {
  if (state.truncatedReason === 'RESPONSE_BUDGET') {
    return 'The response budget cut the payload, not the search: ask for fewer fields, or name fewer objects, to see '
      + 'everything this search returned.';
  }
  if (state.truncatedReason === 'PER_OBJECT_LIMIT') {
    return 'A per-object LIMIT inside the clause capped at least one object, so that object has more matches than are '
      + 'listed here. Raise or remove it to see them.';
  }
  return 'Raise limit (up to 200) for more records in one call, narrow the search term, or search one object at a time. '
    + 'SOSL reports no total match count, so a number at the limit is not evidence that exactly that many records exist.';
}

type SearchState = Readonly<{
  hits: readonly SearchHit[];
  unreadable: number;
  objectsSupplied: boolean;
  mode: SoslMode;
  statement: string;
  limitSource: SoslLimitSource;
  effectiveLimit: number | null;
  perObjectLimits: Readonly<Record<string, number>>;
}>;

type HintState = SearchState & Readonly<{
  totalReturned: number;
  returnedCount: number;
  truncated: boolean;
  truncatedReason: SearchTruncationReason | null;
  complete: boolean;
}>;

/**
 * Error mapping for `search_records`.
 *
 * SOSL's failure codes overlap SOQL's but not exactly: `INVALID_SEARCH` covers a term the platform
 * will not search for (a single character, verified live — see the findings doc §6) alongside
 * syntax it rejects, and both belong to the malformed branch because the caller can fix either from
 * the message. A transient `SERVER_UNAVAILABLE` is deliberately absent from every branch, so it
 * falls to the retry-worded default rather than being reported as a malformed search.
 */
function searchFailureMapping(hasOrgLimitsTool: boolean): DataFailureMapping {
  return {
    fallbackCode: 'MCP_SEARCH_RECORDS_FAILED',
    fallbackMessage: 'Salesforce could not run the search for this request.',
    fallbackSuggestion: 'Retry once — a search can fail transiently. If it fails again, verify the object and field names with '
      + 'describe_sobject before rewriting the search.',
    rules: [
      {
        codes: ['MALFORMED_SEARCH', 'INVALID_SEARCH', 'MALFORMED_QUERY', 'INVALID_QUERY'],
        code: 'MCP_SEARCH_MALFORMED',
        message: 'Salesforce rejected the SOSL as malformed.',
        suggestion: 'Fix the search and retry. A complete clause reads FIND {term} IN ALL FIELDS RETURNING Account(Id, Name) '
          + 'LIMIT 20: the term goes in braces, at most one RETURNING and one LIMIT are allowed, and the term must be longer '
          + 'than one character. Passing a bare keyword instead lets this Tool compose the statement for you.',
      },
      {
        codes: ['INVALID_FIELD', 'INVALID_TYPE', 'INVALID_SOBJECT', 'INVALID_ENTITY', 'NOT_FOUND'],
        code: 'MCP_SEARCH_FIELD_INVALID',
        message: 'The search names an object or field that Salesforce does not expose to this request\'s identity.',
        suggestion: 'Call describe_sobject for the object to read its real field names, and list_sobjects to confirm the object '
          + 'API name, then retry. A field list applies to the searched object itself, so Case and Task need fields such as Id '
          + 'and Subject rather than Name.',
      },
      {
        codes: ['REQUEST_LIMIT_EXCEEDED', 'API_DISABLED_FOR_ORG', 'TOTAL_REQUESTS_LIMIT_EXCEEDED', 'REQUEST_RUNNING_TOO_LONG'],
        code: 'MCP_SEARCH_LIMIT_EXCEEDED',
        message: hasOrgLimitsTool
          ? `Salesforce refused the request because the org's API allowance is exhausted. Call ${ORG_LIMITS_TOOL_NAME} to read the remaining allowance.`
          : 'Salesforce refused the request because the org\'s API allowance is exhausted.',
        suggestion: hasOrgLimitsTool
          ? `Read ${ORG_LIMITS_TOOL_NAME} to see when the allowance resets, and reduce the number of calls: one search across several objects is cheaper than one search per object.`
          : 'Reduce the number of calls (one search across several objects is cheaper than one per object) and retry once the 24-hour rolling allowance resets.',
      },
      {
        codes: ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_PRIVILEGES'],
        code: 'MCP_SEARCH_ACCESS_DENIED',
        message: 'The Salesforce user for this request may not search one of the objects or fields involved.',
        suggestion: 'Report the missing Salesforce permission instead of retrying; drop an unreadable object from the search only '
          + 'if it is not needed, and do not work around the org\'s sharing rules.',
      },
    ],
  };
}
