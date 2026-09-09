import type { Connection } from '@salesforce/core';
import type { UiPage } from './effective-ui-contracts.js';
import { asObject } from './flexipage-parser.js';

export type InitialFact = Readonly<{
  path: string; value?: string | number | boolean | null;
  source: 'USER_EXPLICIT' | 'SALESFORCE_CREATE_DEFAULT' | 'CURRENT_USER_FACT' | 'TRUSTED_RUNTIME_DEFAULT' | 'UNRESOLVED';
  trustedForVisibility: boolean;
  resolutionStatus: 'RESOLVED' | 'UNKNOWN';
  reason?: string;
}>;
export type EffectiveCreateInitialState = Readonly<{
  facts: readonly InitialFact[];
  record: Readonly<Record<string, unknown>>;
  user: Readonly<Record<string, unknown>>;
}>;

export function createInitialState(defaults: Readonly<Record<string, { value?: unknown }>>,
  explicit: Readonly<Record<string, unknown>>, user: readonly InitialFact[], runtime: readonly InitialFact[] = []): EffectiveCreateInitialState {
  const selected = new Map<string, InitialFact>();
  for (const fact of runtime) selected.set(fact.path, fact);
  for (const [name, entry] of Object.entries(defaults)) if (entry.value !== undefined) {
    selected.set(`Record.${name}`, initialFact(`Record.${name}`, entry.value, 'SALESFORCE_CREATE_DEFAULT'));
  }
  for (const [name, value] of Object.entries(explicit)) selected.set(`Record.${name}`, initialFact(`Record.${name}`, value, 'USER_EXPLICIT'));
  for (const fact of user) selected.set(fact.path, fact);
  const facts = [...selected.values()];
  const values = (prefix: string) => Object.fromEntries(facts.filter((fact) => fact.path.startsWith(prefix)
    && fact.trustedForVisibility && fact.resolutionStatus === 'RESOLVED').map((fact) => [fact.path.slice(prefix.length), fact.value]));
  return { facts, record: values('Record.'), user: values('$User.') };
}

export function initialFact(path: string, value: unknown, source: InitialFact['source']): InitialFact {
  const valid = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= 4096);
  return valid ? { path, value: value as string | number | boolean | null, source, trustedForVisibility: true, resolutionStatus: 'RESOLVED' }
    : { path, source, trustedForVisibility: false, resolutionStatus: 'UNKNOWN', reason: 'VALUE_MISSING_OR_BOUND' };
}

export function userDependencies(page: UiPage): string[] {
  return [...new Set(page.fields.flatMap((field) => field.rules.flatMap(({ rule }) => rule.criteria.flatMap((criterion) => {
    const path = criterion.leftValue.replace(/^\{!|\}$/gu, '');
    const match = /^\$?User\.([A-Za-z][A-Za-z0-9_]{0,127})$/u.exec(path);
    return match?.[1] ? [match[1]] : [];
  }))))];
}

/** Current USER UI API optionalFields respects FLS and omits inaccessible values. */
export async function resolveUserFacts(connection: Connection, userId: string, fields: readonly string[],
  known: Readonly<Record<string, unknown>>, deadline: number): Promise<{ facts: InitialFact[]; apiCalls: number; reason?: string }> {
  const needed = fields.filter((name) => !Object.hasOwn(known, name) || known[name] === undefined);
  const facts = Object.entries(known).map(([name, value]) => initialFact(`$User.${name}`, value, 'CURRENT_USER_FACT'));
  if (!needed.length) return { facts, apiCalls: 0 };
  let apiCalls = 0;
  try {
    if (needed.length > 25) throw new Error('USER_FACT_FIELD_BOUND');
    if (!/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u.test(userId)) throw new Error('USER_FACT_ID_INVALID');
    const response = await boundedRead(() => {
      apiCalls++;
      const query = new URLSearchParams({ fields: 'User.Id', optionalFields: needed.map((name) => `User.${name}`).join(',') });
      return connection.request<unknown>({ method: 'GET', url: `/services/data/v${connection.getApiVersion()}/ui-api/records/${userId}?${query}` });
    }, deadline);
    if (Buffer.byteLength(JSON.stringify(response)) > 32768) throw new Error('USER_FACT_RESPONSE_BOUND');
    const values = asObject(asObject(response).fields);
    if (asObject(response).id !== userId && String(asObject(response).id).slice(0, 15) !== userId.slice(0, 15)) throw new Error('USER_FACT_SCOPE_MISMATCH');
    for (const name of needed) facts.push(initialFact(`$User.${name}`, asObject(values[name]).value, 'CURRENT_USER_FACT'));
    return { facts, apiCalls };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = /^USER_FACT_|^UI_CONTEXT_READ_TIMEOUT$/u.test(message) ? message : 'USER_FACT_READ_FAILED';
    for (const name of needed.slice(0, 200)) facts.push({ path: `$User.${name}`, source: 'CURRENT_USER_FACT',
      trustedForVisibility: false, resolutionStatus: 'UNKNOWN', reason });
    return { facts, apiCalls, reason };
  }
}

export async function boundedRead<T>(operation: () => PromiseLike<T>, deadline: number): Promise<T> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error('UI_CONTEXT_READ_TIMEOUT');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('UI_CONTEXT_READ_TIMEOUT')), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
