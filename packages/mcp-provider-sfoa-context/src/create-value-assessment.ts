import type { CreateValueAssessment, RecordActionContextOutput } from './schemas.js';

type Field = NonNullable<RecordActionContextOutput['fields']>[number];
type AssessmentField = CreateValueAssessment['fields'][number];
type RawDefaults = Readonly<Record<string, Readonly<{ value?: unknown }>>>;

/** Pure observation of a bounded CREATE draft, never a validation or mutation gate. */
export function assessCreateValues(
  context: RecordActionContextOutput,
  draft: Readonly<Record<string, unknown>>,
  defaults: RawDefaults | undefined,
): CreateValueAssessment {
  const source = context.coverage?.requirednessSource ?? 'UNRESOLVED';
  const metadata = new Map((context.fields ?? []).map(field => [field.apiName, field]));
  const names = [...new Set([...metadata.keys(), ...Object.keys(draft)])];
  const fields = names.map((apiName): AssessmentField => {
    const field = metadata.get(apiName);
    const draftState = Object.hasOwn(draft, apiName)
      ? isEmpty(draft[apiName]) ? 'EMPTY' : 'PROVIDED'
      : 'ABSENT';
    // Public defaultValue has already coalesced missing/null. Only raw UI API
    // presence can distinguish them, including a present null or false default.
    const entry = defaults && Object.hasOwn(defaults, apiName) ? defaults[apiName] : undefined;
    const defaultPresent = defaults === undefined ? null : entry !== undefined && Object.hasOwn(entry, 'value');
    const defaultState = defaultPresent === null || (defaultPresent && (entry?.value === undefined || field?.defaultValueTruncated))
      ? 'UNKNOWN' : !defaultPresent ? 'ABSENT' : isEmpty(entry?.value) ? 'EMPTY' : 'VALUE';
    const status = draftState !== 'ABSENT' ? draftState
      : !field || defaultState === 'UNKNOWN' ? 'UNKNOWN'
      : defaultState === 'VALUE' ? 'DEFAULT_AVAILABLE' : 'ABSENT';
    return {
      apiName, required: requiredness(field, source), status,
      source: draftState !== 'ABSENT' ? 'DRAFT' : status === 'DEFAULT_AVAILABLE' ? 'SALESFORCE_CREATE_DEFAULT'
        : status === 'UNKNOWN' ? 'UNKNOWN' : 'NONE',
      draftState, defaultPresent, defaultState,
    };
  });
  const partial = source === 'UNRESOLVED' || source === 'PAGE_LAYOUT_FALLBACK'
    || context.recordTypeSelectionRequired === true
    || (context.coverage !== undefined && context.coverage.totalVisibleFields > context.coverage.returnedFields)
    || fields.some(field => field.required === null || field.defaultState === 'UNKNOWN');
  return {
    coverage: partial ? 'PARTIAL' : 'COMPLETE', requirednessSource: source, fields,
    warnings: [
      'Values describe only this bounded draft: PROVIDED is not business validation; ABSENT does not mean the user never supplied the fact. Defaults are available facts, not submitted values.',
      ...(partial ? ['Some relevant facts or fields are unresolved or omitted; assess the affected scope using task evidence. This result never authorizes or blocks DML.'] : []),
    ],
  };
}

/** Add policy provenance without resolving managed lookups or changing UI facts. */
export function assessManagedCreateValues(
  assessment: CreateValueAssessment,
  rules: readonly Readonly<{ fieldApiName: string; strategy: NonNullable<AssessmentField['managedStrategy']> }>[],
): CreateValueAssessment {
  if (rules.length === 0) return assessment;
  const byName = new Map(rules.map(rule => [rule.fieldApiName.toLowerCase(), rule]));
  const supplied = new Map(assessment.fields.filter(field => field.draftState !== 'ABSENT')
    .map(field => [field.apiName.toLowerCase(), field.draftState]));
  return { ...assessment, fields: assessment.fields.map(field => {
    const rule = byName.get(field.apiName.toLowerCase());
    if (!rule) return field;
    // The existing DML managed-field resolver compares field aliases without
    // case sensitivity. Mirror presence, without validating or resolving values.
    const draftState = supplied.get(field.apiName.toLowerCase()) ?? field.draftState;
    const injects = rule.strategy !== 'PLATFORM_IDENTITY_FALLBACK' || draftState === 'ABSENT';
    return { ...field, draftState, managedStrategy: rule.strategy,
      ...(injects ? { status: 'MANAGED_ON_WRITE' as const, source: 'MANAGED_POLICY' as const }
        : { status: draftState, source: 'DRAFT' as const }),
    };
  }), warnings: [...assessment.warnings,
    'MANAGED_ON_WRITE describes policy injection on a future write, not a resolved value, page initial value or proof that saving will succeed. Fallback preserves every explicitly present draft value, including null and empty values.'],
  };
}

function isEmpty(value: unknown): boolean {
  return value === null || value === '';
}

function requiredness(field: Field | undefined, source: CreateValueAssessment['requirednessSource']): boolean | null {
  if (!field) return null;
  if (field.apiRequired) return true;
  if (source === 'UNRESOLVED') return null;
  if (source !== 'EFFECTIVE_REQUIRED') return field.layoutRequired;
  // Known hidden page-only fields are not required. Pending/unknown visibility
  // can still activate a page requirement and must not become a false absence.
  if (field.visibilityState === 'PENDING' || field.visibilityState === 'UNKNOWN') return null;
  return field.effectiveRequired ?? null;
}
