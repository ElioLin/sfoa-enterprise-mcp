import type { FormFactor, UiAssignment, UiContext, UiSnapshot } from './effective-ui-contracts.js';
import { sameSalesforceId } from './ui-api.js';

/**
 * Profile names that contain a slash are returned URL-encoded (`%2F`) by the
 * Metadata `Profile.fullName` read but unencoded in FlexiPage assignments.
 * Comparing the raw strings silently drops every Record Type specific page for
 * those profiles, which then falls back to the org default page. Decode both
 * sides before comparing; a malformed escape keeps its literal value.
 */
export function profileNameKey(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type ActivePageResult = Pick<UiContext, 'formSource' | 'resolutionStatus' | 'page' | 'app' | 'assignmentSource' | 'fallbackReason'> & Readonly<{
  /**
   * The snapshot carries a Record Type specific FlexiPage assignment for this
   * Record Type. When it is available but not the page this request resolved,
   * the effective requiredness may be missing fields only that page requires.
   */
  recordTypePageAvailable: boolean;
  /** The assignment actually used is the Record Type specific one. */
  recordTypePageMatched: boolean;
}>;

export function resolveActivePage(snapshot: UiSnapshot, facts: Readonly<{
  profileId: string; recordTypeId: string; formFactor: FormFactor;
  apps: readonly { appId: string; developerName: string }[]; appDeveloperName?: string;
  action?: 'CREATE' | 'UPDATE';
}>): ActivePageResult {
  const failed = (reason: string, ambiguous = false): ActivePageResult => ({
    formSource: ambiguous ? 'AMBIGUOUS' : 'UNRESOLVED', resolutionStatus: ambiguous ? 'AMBIGUOUS' : 'UNRESOLVED',
    page: null, app: facts.appDeveloperName ?? null, assignmentSource: null, fallbackReason: reason,
    recordTypePageAvailable: false, recordTypePageMatched: false,
  });
  if (facts.formFactor !== 'Large') return failed('UNSUPPORTED_FORM_FACTOR');
  const profiles = snapshot.profiles.filter((profile) => sameSalesforceId(profile.id, facts.profileId));
  const recordTypes = snapshot.recordTypes.filter((type) => sameSalesforceId(type.id, facts.recordTypeId));
  if (profiles.length !== 1) return failed('USER_CONTEXT_ERROR');
  const recordType = facts.recordTypeId.slice(0, 15) === '012000000000000' ? `${snapshot.objectApiName}.Master` : recordTypes[0]?.fullName;
  if (!recordType || recordTypes.length > 1) return failed('RECORD_TYPE_CONTEXT_ERROR');
  const profile = profiles[0]!;
  const profileFullName = profile.fullName;
  const profileDisplayName = profile.name;
  const profileFullKey = profileNameKey(profileFullName);
  const matchesProfile = (value: string | null): boolean => value === null
    || value === profileFullName
    || value === profileDisplayName
    || profileNameKey(value) === profileFullKey
    || profileNameKey(value) === profileDisplayName;
  const recordTypePageAvailable = snapshot.assignments.some((assignment) =>
    assignment.type === 'Flexipage' && assignment.page !== null && assignment.recordType === recordType);
  const available = facts.apps.map((app) => snapshot.apps.filter((entry) =>
    entry.appId === app.appId && entry.developerName === app.developerName));
  const selected = facts.appDeveloperName ? available.filter((matches) => matches.some((app) =>
    app.developerName === facts.appDeveloperName || app.fullName === facts.appDeveloperName)) : available;
  if (!selected.length) return failed('APP_CONTEXT_INVALID');
  if (selected.some((matches) => matches.length !== 1) || (facts.appDeveloperName && selected.length !== 1)) return failed('APP_CONTEXT_ERROR');
  const outcomes = selected.map(([app]): ActivePageResult => {
    if (!app) return failed('APP_CONTEXT_ERROR');
    const matches = snapshot.assignments.filter((assignment) =>
      (assignment.app === null || assignment.app === app.fullName)
      && matchesProfile(assignment.profile)
      && (assignment.recordType === null || assignment.recordType === recordType)
      && (assignment.formFactor === null || assignment.formFactor === facts.formFactor));
    const choose = (action: 'New' | 'Edit' | 'View'): UiAssignment[] => {
      const rows = matches.filter((row) => row.action === action);
      const priority = (row: UiAssignment): number => (row.app ? 4 : 0) + (row.profile ? 2 : 0) + (row.recordType ? 1 : 0) + (row.formFactor ? 0.5 : 0);
      const highest = Math.max(...rows.map(priority));
      return rows.filter((row) => priority(row) === highest);
    };
    const operationAction = facts.action === 'UPDATE' ? 'Edit' : 'New';
    const fresh = choose(operationAction);
    if (fresh.length > 1) return failed('ASSIGNMENT_RESOLUTION_ERROR', true);
    const override = fresh[0];
    if (override?.type === 'Default' && matches.some((row) => row.action === operationAction && !['Default', 'Standard'].includes(row.type))) {
      return failed('ASSIGNMENT_DEFAULT_INHERITANCE_UNKNOWN');
    }
    if (override && !['Default', 'Standard'].includes(override.type)) return {
      formSource: 'CUSTOM_OVERRIDE', resolutionStatus: 'RESOLVED', app: app.fullName,
      page: null, assignmentSource: override.source, fallbackReason: 'CUSTOM_OVERRIDE_NOT_EVALUATED',
      recordTypePageAvailable, recordTypePageMatched: false,
    };
    const view = choose('View');
    if (view.length > 1) return failed('ASSIGNMENT_RESOLUTION_ERROR', true);
    const assignment = view[0];
    if (assignment?.type === 'Default' && matches.some((row) => row.action === 'View' && !['Default', 'Standard'].includes(row.type))) {
      return failed('ASSIGNMENT_DEFAULT_INHERITANCE_UNKNOWN');
    }
    if (!assignment || ['Default', 'Standard'].includes(assignment.type)) return {
      formSource: 'PAGE_LAYOUT', resolutionStatus: 'RESOLVED', page: null,
      app: app.fullName, assignmentSource: assignment?.source ?? 'SALESFORCE_STANDARD', fallbackReason: null,
      recordTypePageAvailable, recordTypePageMatched: false,
    };
    if (assignment.type !== 'Flexipage' || !assignment.page) return failed('UNSUPPORTED_PAGE');
    const pages = snapshot.pages.filter((page) => page.fullName === assignment.page);
    const page = pages[0];
    if (!page || pages.length !== 1) return failed('SNAPSHOT_MISSING');
    if (page.unsupported.length || page.formSource === 'UNRESOLVED') return failed(page.unsupported[0] ?? 'UNSUPPORTED_PAGE');
    return { formSource: page.formSource, resolutionStatus: 'RESOLVED', page: page.fullName,
      app: app.fullName, assignmentSource: assignment.source, fallbackReason: null,
      recordTypePageAvailable, recordTypePageMatched: assignment.recordType === recordType };
  });
  if (outcomes.some((outcome) => outcome.resolutionStatus !== 'RESOLVED')) return outcomes.find((outcome) => outcome.resolutionStatus !== 'RESOLVED') as ActivePageResult;
  const keys = new Set(outcomes.map((outcome) => JSON.stringify([outcome.formSource, outcome.page, outcome.fallbackReason])));
  if (keys.size !== 1) return failed('APP_CONTEXT_REQUIRED', true);
  const first = outcomes[0] as ActivePageResult;
  return { ...first, app: outcomes.length === 1 ? first.app : null,
    assignmentSource: outcomes.length === 1 ? first.assignmentSource : 'APPLICABLE_APPS_CONVERGED',
    recordTypePageMatched: outcomes.every((outcome) => outcome.recordTypePageMatched) };
}
