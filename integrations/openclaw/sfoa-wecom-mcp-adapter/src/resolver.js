/**
 * Requester-scoped connection decision for the SFOA enterprise MCP server.
 *
 * This module is deliberately free of OpenClaw imports so the decision can be
 * unit-tested without a running Gateway. It contains no mutable state: every
 * call derives its answer from the arguments alone, which is what keeps
 * concurrent channel runs from observing each other's identity.
 *
 * Two channels are supported, and they are deliberately not interchangeable:
 *
 *   WeCom `body.from.userid`
 *     -> OpenClaw host-trusted `requesterSenderId`
 *     -> `X-WeCom-User-Id` with the WeCom channel credential
 *
 *   Salesforce CRM access service (Apex-signed identity)
 *     -> OpenClaw host-trusted `requesterSenderId`
 *     -> `X-SFOA-CRM-User-Id` with the CRM channel credential
 *
 * A sender id is only forwarded for the channel that produced it. The requester
 * id is never read from a prompt, a tool argument, an agent memory, or any
 * process-wide variable.
 */

/** MCP server name; must match the `mcp.servers` entry and the resolver registration. */
export const SFOA_MCP_SERVER_NAME = "sfoa-enterprise-mcp";

/** OpenClaw channel id reported by the official WeCom plugin. */
export const WECOM_CHANNEL_ID = "wecom";

/** OpenClaw channel id registered by the SFoA CRM channel plugin. */
export const CRM_CHANNEL_ID = "sfoa-crm";

/** Identity header for the CRM channel; never accepted with a WeCom credential. */
export const CRM_USER_ID_HEADER = "X-SFOA-CRM-User-Id";

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
  // Reject control characters and any interior whitespace. A channel user id never
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
 *   Resolved SFOA WeCom channel credential; `undefined` withholds WeCom.
 * @param {string | undefined} [params.crmToken]
 *   Resolved SFOA CRM channel credential; `undefined` withholds CRM.
 * @param {string} params.url
 *   Loopback MCP endpoint.
 * @returns {{ url: string, headers: Record<string, string> } | null}
 */
export function buildRequesterConnection(params) {
  const context = params?.context;
  if (!context || typeof context !== "object") return null;

  const channel = context.messageChannel;
  // Each channel has its own identity namespace and its own credential. A
  // sender id from one channel can never be forwarded under another channel's
  // header, even if both credentials happen to be configured.
  let token;
  let headerName;
  if (channel === WECOM_CHANNEL_ID) {
    token = params.token;
    headerName = "X-WeCom-User-Id";
  } else if (channel === CRM_CHANNEL_ID) {
    token = params.crmToken;
    headerName = CRM_USER_ID_HEADER;
  } else {
    return null;
  }

  const requesterId = normalizeRequesterId(context.requesterSenderId);
  if (requesterId === undefined) return null;

  if (typeof token !== "string" || token.trim().length === 0) return null;

  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (url.length === 0) return null;

  return {
    url,
    headers: {
      // Channel credential: identifies the client, never the end user.
      Authorization: `Bearer ${token}`,
      // Identity context: identifies the current channel sender for this run only.
      [headerName]: requesterId,
    },
  };
}
