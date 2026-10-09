/**
 * The `hint` `list_metadata_components` returns, and the rule that shapes it.
 *
 * The Tool is the listing half of a pair — `list_metadata_components` answers "which components of this
 * type exist", `get_metadata_component_context` answers "what does this one contain" — so the hint names
 * that next step rather than restating the payload.
 *
 * **A hint may only name a Tool `tools/list` advertises.** Same rule as `debug-log-hints.ts`, and the same
 * reason: the two metadata Tools are enabled independently in the Console, so the listing can be on while
 * the reader is off. A hint naming a disabled Tool sends the Agent to a name its own `tools/list` does not
 * carry, which reads as a broken deployment rather than as a Tool that is switched off. The builder takes
 * the advertised set and degrades to a sentence that names no Tool.
 *
 * Pure function of the set and of measured counts, so the gating is unit-testable without a Connection —
 * "the hint named a Tool that was not advertised" is a defect no live run would reliably catch.
 */

const METADATA_CONTEXT_TOOL = 'get_metadata_component_context';

export type MetadataListHintFacts = Readonly<{
  returnedCount: number;
  /** The matched count *after* the prefix and inactive filters — not the type's total. */
  totalCount: number;
  /** True when matched components were dropped to fit the response budget. */
  truncated: boolean;
  /** The effective value, which is `false` when the caller did not ask for anything. */
  includeInactive: boolean;
  /** True when a `developerNamePrefix` filter was supplied and applied. */
  prefixApplied: boolean;
}>;

/**
 * The listing hint carries one instruction that exists for a reason measured on this org rather than for
 * style: component full names round-trip through a screen format the caller will not expect. T0 measured
 * `风控负责`, `WRN业务员%2F业务主管%2F市场开发` and `SHRN工程管理总监%2F项目经理` — localized, and
 * URL-escaped where the name contains a separator. A caller who reads `%2F` as an escape and passes `/`
 * back addresses a *different* component, or none. So the hint says "verbatim" explicitly.
 *
 * The empty case is split the way `apexLogsHint` splits it, because "no component" and "your filter
 * matched nothing" are different answers and only one of them is about the org. An unfiltered empty list
 * is a legitimate fact about that type; a prefix-filtered empty list usually means the prefix was typed in
 * a form the stored name does not use.
 */
export function metadataListHint(advertised: ReadonlySet<string>, facts: MetadataListHintFacts): string {
  const next = advertised.has(METADATA_CONTEXT_TOOL)
    ? `Call ${METADATA_CONTEXT_TOOL} with one of the fullNames above, passed back verbatim, to read that `
      + 'component\'s content.'
    : 'A component\'s content is read separately, by its exact full name.';

  if (facts.truncated) {
    return `Incomplete listing: ${facts.returnedCount} of ${facts.totalCount} matched components are included. `
      + 'The rest were dropped by the requested limit or by the server\'s response budget, and this Tool pages by '
      + 'prefix rather than by offset: raise limit (maximum 200) if the limit is what cut the list, and narrow '
      + 'developerNamePrefix to walk past the cap. '
      + (facts.returnedCount > 0
        ? next
        : 'No entry at all fitted, which is a limit or size problem rather than an empty type.');
  }
  if (facts.returnedCount > 0) {
    const scope = facts.prefixApplied ? ` of ${facts.totalCount} matching this prefix` : '';
    return `${facts.returnedCount} component(s) listed${scope}. ${next}`;
  }
  if (facts.prefixApplied) {
    return `No component of this type matched developerNamePrefix. That is a statement about the prefix and not about `
      + 'the org: component names here are localized and may be URL-escaped, and the match is exact and '
      + 'case-sensitive, so a decoded or translated prefix selects nothing. Re-run without the prefix to see the '
      + 'names this org actually stores.';
  }
  const inactiveNote = facts.includeInactive
    ? ''
    : ' Components this org\'s listing marks as inactive are excluded by default; re-run with includeInactive to '
      + 'confirm the type is genuinely empty rather than filtered to empty.';
  return `This org lists no component of this type.${inactiveNote}`;
}
