/**
 * Executable decision model for the `sfoa-record-change` business Skill.
 *
 * Purpose: turn the Skill's Hard Rules into a runnable reference implementation so the machine gate
 * asserts *behaviour* instead of only asserting that doctrine text exists. This module is a test
 * oracle, never a Runtime component: the business Agent reasons with the Skill and the live MCP
 * Tools, not with this file. It must therefore stay free of any Salesforce truth (no object names,
 * no Record Type IDs, no Picklist API values, no field API names) and take every such fact as input.
 *
 * The authoritative behaviour remains Salesforce and the live MCP Runtime. Where this model and the
 * current runtime contract disagree, the runtime contract wins and this file is the thing to fix.
 */

export const MUTATION_OPERATIONS = Object.freeze(['CREATE', 'UPDATE']);

/** Batch size bound published by the current `create_records` / `update_records` schema. */
export const BATCH_RECORD_LIMIT = 200;

/** Per-record logical outcome, mirroring `batchDmlOutputSchema.results[].status`. */
export const RECORD_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  UNKNOWN: 'OUTCOME_UNKNOWN',
});

/** Batch-level status, mirroring `batchDmlOutputSchema.status`. */
export const BATCH_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  PARTIAL_SUCCESS: 'PARTIAL_SUCCESS',
  FAILED: 'FAILED',
  UNKNOWN: 'OUTCOME_UNKNOWN',
});

/** How one field appears in the Agent's reasoning about a pending mutation. */
export const FIELD_FACT = Object.freeze({
  OMITTED: 'OMITTED',
  NULL: 'NULL',
  VALUE: 'VALUE',
});

// ---------------------------------------------------------------------------
// Target resolution (UPDATE Gate 1)
// ---------------------------------------------------------------------------

export const TARGET_RESOLUTION = Object.freeze({
  RESOLVED: 'TARGET_RESOLVED',
  BLOCK: 'TARGET_BLOCKED',
  CLARIFY: 'TARGET_CLARIFICATION_REQUIRED',
});

/**
 * Resolve the Salesforce record(s) an UPDATE intent applies to.
 *
 * `intent` is `SINGLE` unless the user's own words asked for every matching record. A single-record
 * intent never picks a winner out of several matches; the caller must ask the user instead.
 */
export function resolveUpdateTarget({ matches = [], intent = 'SINGLE' } = {}) {
  const targetIds = [...new Set(matches.map((match) => match?.recordId).filter(Boolean))];
  if (intent === 'POPULATION') {
    if (targetIds.length === 0) {
      return Object.freeze({ resolution: TARGET_RESOLUTION.BLOCK, targets: Object.freeze([]), reason: 'NO_TARGET_IN_POPULATION' });
    }
    // A population intent is only dispatchable once the caller has proven the query was complete.
    const complete = matches.every((match) => match?.scopeComplete !== false);
    return Object.freeze({
      resolution: complete ? TARGET_RESOLUTION.RESOLVED : TARGET_RESOLUTION.BLOCK,
      targets: Object.freeze(targetIds),
      reason: complete ? 'POPULATION_RESOLVED' : 'POPULATION_SCOPE_UNPROVEN',
    });
  }
  if (targetIds.length === 0) {
    return Object.freeze({ resolution: TARGET_RESOLUTION.BLOCK, targets: Object.freeze([]), reason: 'NO_TARGET' });
  }
  if (targetIds.length > 1) {
    return Object.freeze({ resolution: TARGET_RESOLUTION.CLARIFY, targets: Object.freeze(targetIds), reason: 'AMBIGUOUS_TARGET' });
  }
  return Object.freeze({ resolution: TARGET_RESOLUTION.RESOLVED, targets: Object.freeze(targetIds), reason: 'UNIQUE_TARGET' });
}

/**
 * Canonical identity of a Salesforce record ID.
 *
 * 15- and 18-character forms of the same record differ only in the trailing checksum, so the first
 * 15 characters are the durable identity. Mirrors the runtime's own duplicate detection.
 */
export function canonicalRecordIdentity(recordId) {
  return typeof recordId === 'string' ? recordId.trim().slice(0, 15).toUpperCase() : '';
}

/** Duplicate UPDATE targets inside one batch, in first-seen order. */
export function findDuplicateUpdateTargets(records = []) {
  const seen = new Set();
  const duplicates = [];
  for (const record of records) {
    const identity = canonicalRecordIdentity(record?.recordId);
    if (identity.length !== 15) continue;
    if (seen.has(identity)) {
      if (!duplicates.includes(identity)) duplicates.push(identity);
      continue;
    }
    seen.add(identity);
  }
  return Object.freeze(duplicates);
}

// ---------------------------------------------------------------------------
// Minimal Patch (UPDATE Gate 2)
// ---------------------------------------------------------------------------

/**
 * Classify how a field appears in the mutation intent.
 *
 * `present: false` must stay `OMITTED` — never rewritten to `NULL`. `false`, `0` and `""` are
 * explicit values and must survive as `VALUE`.
 */
export function classifyFieldFact(entry) {
  if (!entry || entry.present !== true) return FIELD_FACT.OMITTED;
  return entry.value === null ? FIELD_FACT.NULL : FIELD_FACT.VALUE;
}

/**
 * Build the minimal UPDATE patch.
 *
 * Only fields the user asked to change, plus fields the runtime itself proved necessary for this
 * mutation, may enter the patch. Fields that were merely *read* never enter it. An explicit clear
 * is the only way a field is sent as null; omitted fields are simply absent.
 */
export function buildMinimalPatch({
  requestedFields = [],
  runtimeRequiredFields = [],
  readFacts = {},
  explicitClearFields = [],
} = {}) {
  const clearSet = new Set(explicitClearFields);
  const requested = new Set(requestedFields);
  const runtimeRequired = new Set(runtimeRequiredFields);
  const patch = {};
  const preserved = [];
  const rejected = [];

  for (const name of Object.keys(readFacts)) {
    const fact = classifyFieldFact(readFacts[name]);
    if (fact === FIELD_FACT.OMITTED) continue;
    if (!requested.has(name) && !runtimeRequired.has(name)) {
      // Reading a value is not permission to rewrite it.
      preserved.push(name);
    }
  }

  const intended = [...new Set([...requestedFields, ...runtimeRequiredFields])];
  for (const name of intended) {
    const clearRequested = clearSet.has(name);
    const entry = readFacts[name];
    if (clearRequested) {
      patch[name] = null;
      continue;
    }
    if (!entry || entry.present !== true) {
      // The user asked to change a field but supplied no value in this reasoning pass.
      rejected.push({ field: name, reason: 'NO_VALUE_SUPPLIED' });
      continue;
    }
    if (entry.value === null && !clearRequested) {
      rejected.push({ field: name, reason: 'NULL_WITHOUT_EXPLICIT_CLEAR' });
      continue;
    }
    patch[name] = entry.value;
  }

  return Object.freeze({
    patch: Object.freeze(patch),
    preserved: Object.freeze([...new Set(preserved)]),
    rejected: Object.freeze(rejected),
  });
}

/** Assert that a patch contains no field outside the user's intent (plus proven runtime necessity). */
export function assertMinimalPatch({ patch, intendedFields = [], runtimeRequiredFields = [] }) {
  const allowed = new Set([...intendedFields, ...runtimeRequiredFields]);
  const unexpected = Object.keys(patch).filter((name) => !allowed.has(name));
  return Object.freeze({ minimal: unexpected.length === 0, unexpected: Object.freeze(unexpected) });
}

// ---------------------------------------------------------------------------
// Record Type intent (UPDATE Gate 3)
// ---------------------------------------------------------------------------

/**
 * Record Type handling for UPDATE.
 *
 * No request means no mutation. An explicit request still requires live candidate resolution and
 * statement of the runtime's verification capability — the Skill never simulates the post-change
 * Dynamic Forms state.
 */
export function evaluateRecordTypeIntent({ recordTypeRequested = false, candidatesResolved = false } = {}) {
  if (!recordTypeRequested) {
    return Object.freeze({ mutateRecordType: false, requiresRuntimeValidation: false, blocked: false, reason: 'NOT_REQUESTED' });
  }
  if (!candidatesResolved) {
    return Object.freeze({ mutateRecordType: false, requiresRuntimeValidation: true, blocked: true, reason: 'CANDIDATES_UNRESOLVED' });
  }
  return Object.freeze({
    mutateRecordType: true,
    requiresRuntimeValidation: true,
    blocked: false,
    reason: 'RUNTIME_VALIDATION_REQUIRED',
  });
}

// ---------------------------------------------------------------------------
// Readiness (shared concept, different conditions)
// ---------------------------------------------------------------------------

/**
 * CREATE readiness: "is this new record complete enough to exist?"
 *
 * `visibilityState` uses the Dynamic Forms vocabulary. `apiRequired` survives independently of UI
 * visibility. A PENDING field is only stable once every `dependsOn` fact is known.
 */
export function evaluateCreateReadiness({
  intentIsCreate = true,
  objectResolved = true,
  recordTypeResolved = true,
  fields = [],
  knownValues = {},
  lookupAmbiguity = false,
  picklistNormalized = true,
  managedPolicySatisfied = true,
  evidenceComplete = true,
} = {}) {
  const blockers = [];
  if (!intentIsCreate) blockers.push('INTENT_NOT_CREATE');
  if (!objectResolved) blockers.push('OBJECT_UNRESOLVED');
  if (!recordTypeResolved) blockers.push('RECORD_TYPE_UNRESOLVED');

  for (const field of fields) {
    const { apiName, visibilityState = 'VISIBLE', apiRequired = false, effectiveRequired = false,
      effectiveEditable, dependsOn = [] } = field;
    if (apiName === undefined) continue;
    if (visibilityState === 'PENDING') {
      const unresolved = dependsOn.filter((name) => !(name in knownValues));
      if (unresolved.length > 0) blockers.push(`PENDING_DEPENDENCY_UNRESOLVED:${apiName}`);
      continue;
    }
    if (visibilityState === 'HIDDEN') continue;
    if (visibilityState === 'UNKNOWN') {
      if (apiRequired || effectiveRequired) blockers.push(`UNKNOWN_REQUIRED:${apiName}`);
      continue;
    }
    const required = apiRequired || effectiveRequired;
    if (required && !(apiName in knownValues)) blockers.push(`MISSING_REQUIRED:${apiName}`);
    // `effectiveEditable` is the CREATE Dynamic Forms editability signal. A value the Agent intends
    // to submit must not be submitted through a field that context proves non-editable.
    if (effectiveEditable === false && apiName in knownValues) blockers.push(`FIELD_NOT_EDITABLE:${apiName}`);
  }

  if (lookupAmbiguity) blockers.push('LOOKUP_AMBIGUOUS');
  if (!picklistNormalized) blockers.push('PICKLIST_NOT_NORMALIZED');
  if (!managedPolicySatisfied) blockers.push('MANAGED_POLICY_UNSATISFIED');
  if (!evidenceComplete) blockers.push('EVIDENCE_INCOMPLETE');

  return Object.freeze({ changeReady: blockers.length === 0, action: 'CREATE', blockers: Object.freeze(blockers) });
}

/**
 * UPDATE readiness: "do we know exactly what record to change, exactly what the user intends to
 * change, and only those fields?"
 *
 * Deliberately does NOT accept a CREATE required-field list: create-time requiredness is not an
 * UPDATE blocker. It also does not consult `effectiveEditable`: that flag is produced only on the
 * CREATE Dynamic Forms path, while the current UPDATE action context exposes `fieldUpdateable` and
 * `layoutEditableForUpdate`. Where the runtime and this model disagree, the runtime wins.
 */
export function evaluateUpdateReadiness({
  intentIsUpdate = true,
  objectResolved = true,
  targetResolution = TARGET_RESOLUTION.RESOLVED,
  mutationScopeResolved = true,
  patchFields = [],
  intendedFields = [],
  runtimeRequiredFields = [],
  fieldEvidence = {},
  lookupAmbiguity = false,
  picklistNormalized = true,
  managedPolicySatisfied = true,
  recordTypeIntentResolved = true,
  evidenceComplete = true,
} = {}) {
  const blockers = [];
  if (!intentIsUpdate) blockers.push('INTENT_NOT_UPDATE');
  if (!objectResolved) blockers.push('OBJECT_UNRESOLVED');
  if (targetResolution === TARGET_RESOLUTION.BLOCK) blockers.push('TARGET_UNRESOLVED');
  if (targetResolution === TARGET_RESOLUTION.CLARIFY) blockers.push('TARGET_AMBIGUOUS');
  if (!mutationScopeResolved) blockers.push('MUTATION_SCOPE_UNRESOLVED');

  const minimal = assertMinimalPatch({ patch: Object.fromEntries(patchFields.map((name) => [name, true])), intendedFields, runtimeRequiredFields });
  if (!minimal.minimal) for (const name of minimal.unexpected) blockers.push(`PATCH_OUTSIDE_INTENT:${name}`);

  for (const name of patchFields) {
    const evidence = fieldEvidence[name];
    if (!evidence) continue;
    // UPDATE editability evidence: the two flags the UPDATE action context actually publishes.
    const updateable = evidence.fieldUpdateable !== false && evidence.layoutEditableForUpdate !== false;
    if (!updateable) blockers.push(`FIELD_NOT_UPDATEABLE:${name}`);
  }

  if (lookupAmbiguity) blockers.push('LOOKUP_AMBIGUOUS');
  if (!picklistNormalized) blockers.push('PICKLIST_NOT_NORMALIZED');
  if (!managedPolicySatisfied) blockers.push('MANAGED_POLICY_UNSATISFIED');
  if (!recordTypeIntentResolved) blockers.push('RECORD_TYPE_INTENT_UNRESOLVED');
  if (!evidenceComplete) blockers.push('EVIDENCE_INCOMPLETE');

  return Object.freeze({ changeReady: blockers.length === 0, action: 'UPDATE', blockers: Object.freeze(blockers) });
}

/**
 * Owner handling.
 *
 * No request means no injection and no CREATE-style fallback. An explicit request must resolve to
 * exactly one proven ID; zero or several matches block, and an explicit failure never falls back.
 */
export function evaluateOwnerIntent({ requested = false, matchCount = null } = {}) {
  if (!requested) {
    return Object.freeze({ inject: false, askRequired: false, blocked: false, resolution: 'PRESERVE', fallbackAllowed: false });
  }
  if (matchCount === 1) return Object.freeze({ inject: true, askRequired: false, blocked: false, resolution: 'RESOLVED', fallbackAllowed: false });
  if (matchCount === 0) return Object.freeze({ inject: false, askRequired: false, blocked: true, resolution: 'NO_MATCH', fallbackAllowed: false });
  return Object.freeze({ inject: false, askRequired: true, blocked: true, resolution: 'MULTIPLE_MATCH', fallbackAllowed: false });
}

// ---------------------------------------------------------------------------
// Picklist resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a business Label to the live API Value.
 *
 * The mapping must be supplied by current Salesforce evidence. A controller-aware field can only
 * use values whose `validFor` admits the current controller index.
 */
export function resolvePicklistValue({ label, options = [], controllerName = null, controllerValueIndex = null } = {}) {
  if (typeof label !== 'string' || label.length === 0) return Object.freeze({ resolved: false, reason: 'NO_LABEL' });
  const matches = options.filter((option) => option?.label === label);
  if (matches.length !== 1) {
    return Object.freeze({ resolved: false, reason: matches.length === 0 ? 'LABEL_NOT_FOUND' : 'LABEL_NOT_UNIQUE' });
  }
  const option = matches[0];
  if (controllerName !== null) {
    if (controllerValueIndex === null) return Object.freeze({ resolved: false, reason: 'CONTROLLER_UNRESOLVED' });
    const validFor = Array.isArray(option.validFor) ? option.validFor : [];
    if (!validFor.includes(controllerValueIndex)) return Object.freeze({ resolved: false, reason: 'VALUE_INVALID_FOR_CONTROLLER' });
  }
  return Object.freeze({ resolved: true, apiValue: option.value, controllerName });
}

// ---------------------------------------------------------------------------
// Batch planning and dispatch
// ---------------------------------------------------------------------------

/**
 * Per-record batch readiness.
 *
 * Universal quantification — one unready record withholds the whole planned batch unless the user
 * explicitly allowed progressive execution.
 */
export function evaluateBatchReadiness(readinessList = [], { progressiveAllowed = false } = {}) {
  const notReady = readinessList.filter((entry) => entry?.changeReady !== true);
  if (notReady.length === 0) {
    return Object.freeze({ dispatch: true, progressive: false, withheld: Object.freeze([]), reason: 'ALL_READY' });
  }
  if (progressiveAllowed) {
    const ready = readinessList.filter((entry) => entry?.changeReady === true);
    return Object.freeze({
      dispatch: ready.length > 0,
      progressive: true,
      withheld: Object.freeze(notReady.map((entry) => entry?.recordId ?? 'unknown')),
      reason: 'PROGRESSIVE_EXECUTION_ALLOWED',
    });
  }
  return Object.freeze({
    dispatch: false,
    progressive: false,
    withheld: Object.freeze(notReady.map((entry) => entry?.recordId ?? 'unknown')),
    reason: 'NOT_ALL_READY',
  });
}

/** Group records by object because one batch request carries exactly one `objectApiName`. */
export function groupByObject(records = []) {
  const groups = new Map();
  for (const record of records) {
    const object = record?.objectApiName ?? '';
    if (!groups.has(object)) groups.set(object, []);
    groups.get(object).push(record);
  }
  return Object.freeze([...groups.entries()].map(([objectApiName, items]) => Object.freeze({ objectApiName, items: Object.freeze(items) })));
}

/** Split one object group into bounded sequential batches, e.g. 500 -> 200 + 200 + 100. */
export function planMutationBatches(records = [], { limit = BATCH_RECORD_LIMIT } = {}) {
  const batches = [];
  for (let index = 0; index < records.length; index += limit) {
    batches.push(Object.freeze(records.slice(index, index + limit)));
  }
  return Object.freeze({
    batches: Object.freeze(batches),
    count: batches.length,
    oversized: records.length > limit,
    sequentialRequired: batches.length > 1,
  });
}

/**
 * Dispatch bounded batches sequentially.
 *
 * Never sends every batch in one pass, and permanently stops at the first batch whose outcome is
 * unknown so the unknown side-effect range cannot grow. `execute` is injected by the caller so this
 * model performs no I/O of its own.
 */
export function dispatchSequentialBatches(plan, execute) {
  const outcomes = [];
  let stopped = false;
  let stoppedAt = null;
  for (const [index, batch] of plan.batches.entries()) {
    if (stopped) {
      outcomes.push(Object.freeze({ index, status: 'NOT_SENT', results: Object.freeze([]) }));
      continue;
    }
    const outcome = execute(batch, index) ?? { status: BATCH_STATUS.UNKNOWN, results: [] };
    outcomes.push(Object.freeze({ index, ...outcome }));
    if (shouldStopSubsequentBatches(outcome.status)) {
      stopped = true;
      stoppedAt = index;
    }
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes), stopped, stoppedAt });
}

/** Only an unknown outcome halts subsequent batches; a proven failure does not. */
export function shouldStopSubsequentBatches(status) {
  return status === BATCH_STATUS.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Outcome and reconciliation
// ---------------------------------------------------------------------------

/** Derive the batch-level status from per-record statuses, keeping UNKNOWN distinct from FAILED. */
export function summariseBatchOutcome(results = []) {
  if (results.length === 0) return BATCH_STATUS.SUCCESS;
  const counts = { [RECORD_STATUS.SUCCESS]: 0, [RECORD_STATUS.FAILED]: 0, [RECORD_STATUS.UNKNOWN]: 0 };
  for (const result of results) counts[result?.status] = (counts[result?.status] ?? 0) + 1;
  if (counts[RECORD_STATUS.UNKNOWN] > 0) {
    return counts[RECORD_STATUS.SUCCESS] > 0 || counts[RECORD_STATUS.FAILED] > 0 ? BATCH_STATUS.PARTIAL_SUCCESS : BATCH_STATUS.UNKNOWN;
  }
  if (counts[RECORD_STATUS.FAILED] === 0) return BATCH_STATUS.SUCCESS;
  return counts[RECORD_STATUS.SUCCESS] > 0 ? BATCH_STATUS.PARTIAL_SUCCESS : BATCH_STATUS.FAILED;
}

/**
 * Decide whether a record may be written again.
 *
 * Successful records are never replayed. Unknown records are never replayed. Only a proven failure
 * with a fixable cause and a still-valid intent becomes eligible.
 */
export function retryEligibility({ status, causeFixable = false, intentStillValid = false } = {}) {
  if (status === RECORD_STATUS.SUCCESS) return Object.freeze({ retry: false, reason: 'ALREADY_COMMITTED' });
  if (status === RECORD_STATUS.UNKNOWN) return Object.freeze({ retry: false, reason: 'OUTCOME_UNKNOWN' });
  if (!intentStillValid) return Object.freeze({ retry: false, reason: 'INTENT_NO_LONGER_VALID' });
  if (!causeFixable) return Object.freeze({ retry: false, reason: 'CAUSE_NOT_FIXABLE' });
  return Object.freeze({ retry: true, reason: 'FAILED_AND_FIXABLE' });
}

/** Select exactly the failed records for a recovery batch; successful and unknown records stay out. */
export function selectRetrySubset(results = []) {
  return Object.freeze(results.filter((result) => retryEligibility({ status: result?.status, causeFixable: true, intentStillValid: true }).retry));
}

/**
 * Reconcile an unknown outcome.
 *
 * A satisfied current state is evidence about the *state*, not about the transaction that was
 * supposed to produce it. Only independent, sufficient evidence may promote UNKNOWN.
 */
export function reconcileUnknown({ desiredStateSatisfied = false, independentEvidence = 'INSUFFICIENT' } = {}) {
  if (independentEvidence === 'PROVES_COMMITTED') return Object.freeze({ status: RECORD_STATUS.SUCCESS, reason: 'INDEPENDENT_EVIDENCE_COMMITTED' });
  if (independentEvidence === 'PROVES_NOT_COMMITTED') return Object.freeze({ status: RECORD_STATUS.FAILED, reason: 'INDEPENDENT_EVIDENCE_NOT_COMMITTED' });
  return Object.freeze({
    status: RECORD_STATUS.UNKNOWN,
    reason: desiredStateSatisfied ? 'CURRENT_STATE_SATISFIED_BUT_TRANSACTION_UNPROVEN' : 'EVIDENCE_INSUFFICIENT',
  });
}

/**
 * What an unknown outcome permits.
 *
 * `desiredStateSatisfied` never authorises a replay on its own, and `clientReferenceId` is
 * correlation only, never an idempotency guarantee.
 */
export function unknownOutcomePolicy({ desiredStateSatisfied = false, clientReferenceId = null } = {}) {
  return Object.freeze({
    automaticReplay: false,
    mayReadBack: true,
    mayReportSuccess: false,
    currentStateIsTransactionProof: false,
    clientReferenceIdIsIdempotencyKey: Boolean(clientReferenceId) && false,
    note: desiredStateSatisfied ? 'STATE_SATISFIED_BUT_UNPROVEN_TRANSACTION' : 'STATE_UNKNOWN',
  });
}
