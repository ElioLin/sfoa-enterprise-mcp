/**
 * Requester-scoped connection decision for the SFOA enterprise MCP server.
 *
 * This module is deliberately free of OpenClaw imports so the decision can be
 * unit-tested without a running Gateway. It contains no mutable state: every
 * call derives its answer from the arguments alone, which is what keeps
 * concurrent WeCom runs from observing each other's identity.
 *
 * Identity rule (see docs/sfoa/OPENCLAW_WECOM_SFOA_INTEGRATION.md):
 *   WeCom `body.from.userid`
 *     -> OpenClaw host-trusted `requesterSenderId`
 *     -> `X-WeCom-User-Id`
 *
 * The requester id is never read from a prompt, a tool argument, an agent
 * memory, or any process-wide variable.
 */

/** MCP server name; must match the `mcp.servers` entry and the resolver registration. */
export const SFOA_MCP_SERVER_NAME = "sfoa-enterprise-mcp";

/** OpenClaw channel id reported by the official WeCom plugin. */
export const WECOM_CHANNEL_ID = "wecom";

/** Maximum accepted requester id length, matching the P8-05 platformUserId rule. */
const MAX_PLATFORM_USER_ID_LENGTH = 128;

/**
 * Normalizes a trusted requester id.
 *
 * Mirrors the runtime's `platformUserId` rule (1-128 printable characters) so an
 * id this adapter forwards is always one the SFOA runtime will accept. Returns
 * `undefined` for anything that is absent, empty, over-long, or contains control
 * characters, and the caller then fails closed.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeRequesterId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PLATFORM_USER_ID_LENGTH) return undefined;
  // Reject control characters and any interior whitespace. A WeCom user id never
  // contains whitespace, and a value that does is either malformed or an attempt
  // to smuggle a second field into the header, so fail closed rather than forward it.
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return undefined;
  }
  return trimmed;
}

/**
 * Builds the requester-scoped MCP connection, or `null` to withhold the server.
 *
 * Fail-closed by construction: every precondition that cannot be satisfied
 * returns `null`, which makes OpenClaw resolve no connection for this run and
 * therefore expose no SFOA tool at all. There is no fallback to a previous
 * requester, to a shared/default user, or to an agent-generated identity.
 *
 * @param {object} params
 * @param {{ requesterSenderId?: unknown, messageChannel?: unknown }} params.context
 *   Trusted per-run context supplied by OpenClaw core.
 * @param {string | undefined} params.token
 *   Resolved SFOA WeCom channel credential; `undefined` withholds the server.
 * @param {string} params.url
 *   Loopback MCP endpoint.
 * @returns {{ url: string, headers: Record<string, string> } | null}
 */
export function buildRequesterConnection(params) {
  const context = params?.context;
  if (!context || typeof context !== "object") return null;

  // Only the WeCom channel may borrow the WeCom identity header. Any other
  // channel's sender id is a different identity namespace and must not be
  // presented to SFOA as a WeCom user id.
  if (context.messageChannel !== WECOM_CHANNEL_ID) return null;

  const requesterId = normalizeRequesterId(context.requesterSenderId);
  if (requesterId === undefined) return null;

  if (typeof params.token !== "string" || params.token.trim().length === 0) return null;

  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (url.length === 0) return null;

  return {
    url,
    headers: {
      // Channel credential: identifies the client, never the end user.
      Authorization: `Bearer ${params.token}`,
      // Identity context: identifies the current WeCom sender for this run only.
      "X-WeCom-User-Id": requesterId,
    },
  };
}
