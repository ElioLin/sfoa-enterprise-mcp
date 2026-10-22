/**
 * Stub for `openclaw/plugin-sdk/secret-input-runtime` used only by node:test.
 * The real module exists only inside a running Gateway; the plugin's
 * credential-resolution logic is still the shipped code.
 */

export const state = {
  value: "test-crm-service-credential",
  unresolvedRefReason: undefined,
  calls: 0,
};

export function reset(next = {}) {
  state.value = Object.prototype.hasOwnProperty.call(next, "value")
    ? next.value
    : "test-crm-service-credential";
  state.unresolvedRefReason = next.unresolvedRefReason;
  state.calls = 0;
}

export async function resolveConfiguredSecretInputString() {
  state.calls += 1;
  return { value: state.value, unresolvedRefReason: state.unresolvedRefReason };
}
