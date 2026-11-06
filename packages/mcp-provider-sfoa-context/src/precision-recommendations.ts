import type { Connection } from '@salesforce/core';
import { z } from 'zod';
import { boundedRead } from './create-initial-state.js';
import { type ObjectInfo, requestJson, sameSalesforceId, withQuery } from './ui-api.js';

const nameSchema = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u);
const policySchema = z.object({
  windowDays: z.number().int().min(1).max(90).default(30),
  minimumSamples: z.number().int().min(20).max(200).default(20),
  minimumNonEmptyRatio: z.number().min(0.5).max(1).default(0.8),
  maximumSuggestions: z.number().int().min(1).max(3).default(3),
  sampleLimit: z.number().int().min(20).max(200).default(200),
  timeoutMs: z.number().int().min(100).max(3000).default(2000),
}).strict();
export type RecentFieldPolicy = z.input<typeof policySchema>;
export type RecommendationCandidate = Readonly<{
  apiName: string; label: string; visible: boolean; writable: boolean;
  optional: boolean; taskRelevant: boolean;
}>;
export type RecentFieldRecommendation = Readonly<{
  apiName: string; label: string; nonEmptyCount: number; sampleCount: number; nonEmptyRatio: number;
}>;
export type RecentFieldRecommendations = Readonly<{
  status: 'AVAILABLE' | 'INSUFFICIENT_SAMPLE' | 'UNAVAILABLE' | 'NO_CANDIDATES';
  reason?: string; objectApiName: string; recordTypeId: string;
  scope: 'CURRENT_USER_READABLE'; measure: 'CURRENT_NONEMPTY_ON_RECENTLY_CREATED_RECORDS';
  population: 'BOUNDED_RECENT_SAMPLE'; windowStart: string; windowEnd: string;
  sampleCount: number; sampleLimit: number; truncated: boolean; apiCallCount: number;
  minimumSamples: number; minimumNonEmptyRatio: number;
  recommendations: readonly RecentFieldRecommendation[];
}>;

/** Optional, separately requested observation; callers must not await it before an otherwise ready write. */
export async function collectRecentFieldRecommendations(connection: Connection, input: Readonly<{
  objectInfo: ObjectInfo; recordTypeId: string; action: 'CREATE' | 'UPDATE';
  candidates: readonly RecommendationCandidate[]; policy?: RecentFieldPolicy; now?: Date;
}>): Promise<RecentFieldRecommendations> {
  const policy = policySchema.parse(input.policy ?? {});
  const objectApiName = nameSchema.parse(input.objectInfo.apiName);
  const recordTypeId = idSchema.parse(input.recordTypeId);
  const now = input.now ?? new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.valueOf() - policy.windowDays * 86400000).toISOString();
  const initial: RecentFieldRecommendations = {
    status: 'NO_CANDIDATES', objectApiName, recordTypeId,
    scope: 'CURRENT_USER_READABLE', measure: 'CURRENT_NONEMPTY_ON_RECENTLY_CREATED_RECORDS',
    population: 'BOUNDED_RECENT_SAMPLE', windowStart, windowEnd,
    sampleCount: 0, sampleLimit: policy.sampleLimit, truncated: false, apiCallCount: 0,
    minimumSamples: policy.minimumSamples, minimumNonEmptyRatio: policy.minimumNonEmptyRatio,
    recommendations: [],
  };
  const unique = new Set<string>();
  const candidates = input.candidates.filter((candidate) => {
    const field = input.objectInfo.fields[candidate.apiName];
    if (!nameSchema.safeParse(candidate.apiName).success || unique.has(candidate.apiName)
      || !field || !candidate.visible || !candidate.writable || !candidate.optional || !candidate.taskRelevant
      || field.required || field.calculated === true || field.autoNumber === true
      || !(input.action === 'CREATE' ? field.createable : field.updateable)) return false;
    unique.add(candidate.apiName); return true;
  });
  if (candidates.length === 0) return initial;
  if (candidates.length > 25) return { ...initial, status: 'UNAVAILABLE', reason: 'RECOMMENDATION_FIELD_BOUND' };
  if (!input.objectInfo.fields.CreatedDate) return { ...initial, status: 'UNAVAILABLE', reason: 'CREATED_DATE_UNAVAILABLE' };
  const type = Object.values(input.objectInfo.recordTypeInfos).find((entry) => sameSalesforceId(entry.recordTypeId, recordTypeId));
  if (!type) return { ...initial, status: 'UNAVAILABLE', reason: 'RECORD_TYPE_UNRESOLVED' };
  const hasRecordTypeField = Boolean(input.objectInfo.fields.RecordTypeId);
  const isMaster = type.master === true || recordTypeId.slice(0, 15) === '012000000000000';
  // Objects without a RecordTypeId field have one implicit Master type. Never
  // silently drop a real Record Type predicate just because the field is unreadable.
  if (!hasRecordTypeField && (!isMaster || Object.values(input.objectInfo.recordTypeInfos)
    .some((entry) => entry.master !== true && entry.recordTypeId.slice(0, 15) !== '012000000000000'))) {
    return { ...initial, status: 'UNAVAILABLE', reason: 'RECORD_TYPE_FILTER_UNAVAILABLE' };
  }
  const selectedNames = [...new Set(['Id', 'CreatedDate', ...(hasRecordTypeField ? ['RecordTypeId'] : []), ...candidates.map((field) => field.apiName)])];
  const where = [`CreatedDate >= ${windowStart}`, `CreatedDate <= ${windowEnd}`,
    ...(hasRecordTypeField ? [isMaster ? 'RecordTypeId = null' : `RecordTypeId = '${recordTypeId}'`] : [])].join(' AND ');
  const query = `SELECT ${selectedNames.join(', ')} FROM ${objectApiName} WHERE ${where} ORDER BY CreatedDate DESC, Id DESC LIMIT ${policy.sampleLimit + 1}`;
  const metrics = { apiCallCount: 0, responseBytes: 0 };
  try {
    const raw = await boundedRead(() => requestJson(connection,
      withQuery(`/services/data/v${encodeURIComponent(connection.getApiVersion())}/query`, { q: query }), metrics),
    performance.now() + policy.timeoutMs);
    if (metrics.responseBytes > 262144) return { ...initial, ...metricsForOutput(metrics), status: 'UNAVAILABLE', reason: 'RECOMMENDATION_RESPONSE_BOUND' };
    const result = z.object({ records: z.array(z.record(z.unknown())).max(201), done: z.boolean(),
      totalSize: z.number().int().nonnegative(), }).passthrough().parse(raw);
    // Missing data is not empty data: every selected field must be represented.
    const seen = new Set<string>();
    const usable = result.records.every((record) => {
      if (!idSchema.safeParse(record.Id).success || seen.has(String(record.Id).slice(0, 15))) return false;
      seen.add(String(record.Id).slice(0, 15));
      const created = typeof record.CreatedDate === 'string' ? Date.parse(record.CreatedDate) : Number.NaN;
      return Number.isFinite(created) && created >= Date.parse(windowStart) && created <= now.valueOf()
        && (!hasRecordTypeField || (isMaster ? record.RecordTypeId === null
          : typeof record.RecordTypeId === 'string' && sameSalesforceId(record.RecordTypeId, recordTypeId)))
        && candidates.every(({ apiName }) => Object.hasOwn(record, apiName) && isScalar(record[apiName]));
    });
    if (!usable) return { ...initial, ...metricsForOutput(metrics), status: 'UNAVAILABLE', reason: 'RECOMMENDATION_ROWS_INCOMPLETE' };
    const rows = result.records.slice(0, policy.sampleLimit);
    const sampleCount = rows.length;
    const truncated = !result.done || result.records.length > policy.sampleLimit || result.totalSize > policy.sampleLimit;
    const base = { ...initial, ...metricsForOutput(metrics), sampleCount, truncated };
    if (sampleCount < policy.minimumSamples) return { ...base, status: 'INSUFFICIENT_SAMPLE' };
    const recommendations = candidates.map(({ apiName, label }): RecentFieldRecommendation => {
      const nonEmptyCount = rows.filter((record) => record[apiName] !== null && record[apiName] !== '').length;
      return { apiName, label, nonEmptyCount, sampleCount, nonEmptyRatio: nonEmptyCount / sampleCount };
    }).filter((entry) => entry.nonEmptyRatio >= policy.minimumNonEmptyRatio)
      .sort((a, b) => b.nonEmptyRatio - a.nonEmptyRatio || a.apiName.localeCompare(b.apiName, 'en-US'))
      .slice(0, policy.maximumSuggestions);
    return { ...base, status: 'AVAILABLE', recommendations };
  } catch {
    return { ...initial, ...metricsForOutput(metrics), status: 'UNAVAILABLE', reason: 'RECOMMENDATION_READ_UNAVAILABLE' };
  }
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
}
function metricsForOutput(metrics: { apiCallCount: number }): { apiCallCount: number } {
  return { apiCallCount: metrics.apiCallCount };
}
