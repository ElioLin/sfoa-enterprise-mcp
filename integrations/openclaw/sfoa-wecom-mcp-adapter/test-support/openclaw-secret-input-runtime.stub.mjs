/**
 * Stub for `openclaw/plugin-sdk/secret-input-runtime`.
 *
 * `src/index.js` resolves the SFOA WeCom channel credential through OpenClaw's
 * secret runtime, which is only available inside a running Gateway. The
 * concurrency test needs the real plugin `register()` path (it is where the
 * one piece of shared mutable state lives — the credential cache), so the test
 * substitutes this module for the SDK import.
 *
 * It deliberately returns a *channel credential*, never an identity: the
 * production code is only allowed to pull the shared token from here.
 */

export const state = {
  /** Value handed back as `resolved.value`; `undefined` simulates an unresolved SecretRef. */
  value: "test-channel-credential",
  /** Reason string surfaced when `value` is undefined. */
  unresolvedRefReason: undefined,
  /** How many times the plugin asked for the credential. */
  calls: 0,
  /** Artificial latency, so concurrent callers actually overlap. */
  delayMs: 1,
};

export function reset(next = {}) {
  state.value = next.value === undefined ? "test-channel-credential" : next.value;
  state.unresolvedRefReason = next.unresolvedRefReason;
  state.calls = 0;
  state.delayMs = next.delayMs === undefined ? 1 : next.delayMs;
}

export async function resolveConfiguredSecretInputString() {
  state.calls += 1;
  if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
  return { value: state.value, unresolvedRefReason: state.unresolvedRefReason };
}
