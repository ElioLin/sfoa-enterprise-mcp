/**
 * SFoA WeCom MCP adapter — an OpenClaw plugin with exactly one job:
 *
 *   bind the statically declared `sfoa-enterprise-mcp` MCP server to the
 *   trusted requester of the current WeCom message.
 *
 * It does not implement a channel, a tool, an identity provider, or a
 * Salesforce client. Server name, tool surface, and tool governance stay
 * static and continue to come from `mcp.servers` and the SFOA runtime; only the
 * transport (URL + headers) is resolved per requester.
 *
 * Design rules enforced here:
 *   - No OpenClaw core, WeCom plugin, or node_modules modification.
 *   - No static `X-WeCom-User-Id` in configuration; it exists only in the
 *     per-requester connection returned below.
 *   - No process-wide "current user". The credential is the only cached value.
 */

import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { buildRequesterConnection, SFOA_MCP_SERVER_NAME, WECOM_CHANNEL_ID } from "./resolver.js";

/** Loopback MCP endpoint; OpenClaw and the SFOA runtime share this host. */
const DEFAULT_MCP_URL = "http://127.0.0.1:8080/mcp";

/** Plugin config path used in secret-resolution diagnostics. */
const TOKEN_CONFIG_PATH = "plugins.entries.sfoa-wecom-mcp-adapter.config.mcpWecomClientToken";

/**
 * How long a resolved channel credential is reused before the SecretRef is
 * re-read. This caches the *shared client credential* only — never a user
 * identity, which is derived fresh from each run's trusted context.
 */
const TOKEN_CACHE_TTL_MS = 60_000;

/**
 * @param {object} api OpenClaw plugin API.
 * @param {{ serverName: string, mcpUrl: string }} settings
 */
function createTokenResolver(api, settings) {
  /** @type {{ value: string, expiresAt: number } | undefined} */
  let cached;

  return async function resolveToken() {
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt > now) return cached.value;

    const resolved = await resolveConfiguredSecretInputString({
      config: api.config,
      env: process.env,
      value: api.pluginConfig?.mcpWecomClientToken,
      path: TOKEN_CONFIG_PATH,
    });

    if (resolved?.value === undefined) {
      // Unresolved or unconfigured: drop any cached value and withhold the server.
      cached = undefined;
      api.logger.warn(
        `[${settings.serverName}] SFOA WeCom credential is unavailable` +
          (resolved?.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : "") +
          "; SFOA MCP is withheld for every requester.",
      );
      return undefined;
    }

    cached = { value: resolved.value, expiresAt: now + TOKEN_CACHE_TTL_MS };
    return resolved.value;
  };
}

/** @type {import("openclaw/plugin-sdk/core").OpenClawPluginDefinition} */
const plugin = {
  id: "sfoa-wecom-mcp-adapter",
  name: "SFoA WeCom MCP Adapter",
  description:
    "Binds the sfoa-enterprise-mcp MCP server transport to the trusted WeCom message requester.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      serverName: { type: "string" },
      mcpUrl: { type: "string" },
      mcpWecomClientToken: {},
    },
  },

  register(api) {
    const serverName =
      typeof api.pluginConfig?.serverName === "string" && api.pluginConfig.serverName.trim().length > 0
        ? api.pluginConfig.serverName.trim()
        : SFOA_MCP_SERVER_NAME;
    const mcpUrl =
      typeof api.pluginConfig?.mcpUrl === "string" && api.pluginConfig.mcpUrl.trim().length > 0
        ? api.pluginConfig.mcpUrl.trim()
        : DEFAULT_MCP_URL;

    if (serverName !== SFOA_MCP_SERVER_NAME) {
      // The resolver matches `mcp.servers` by exact name; a mismatch would
      // silently leave the server static and unauthenticated. Refuse instead.
      throw new Error(
        `sfoa-wecom-mcp-adapter: configured serverName "${serverName}" does not match the ` +
          `supported server "${SFOA_MCP_SERVER_NAME}"`,
      );
    }

    const resolveToken = createTokenResolver(api, { serverName, mcpUrl });

    api.registerMcpServerConnectionResolver({
      serverName,

      /**
       * Runs once per requester-scoped MCP runtime (OpenClaw re-resolves at
       * least every 5 minutes). Returning `null` withholds the server for this
       * run; there is no shared-connection fallback.
       *
       * @param {{ requesterSenderId: string, agentAccountId?: string, messageChannel?: string }} ctx
       */
      async resolve(ctx) {
        const connection = buildRequesterConnection({
          context: ctx,
          token: await resolveToken(),
          url: mcpUrl,
        });

        if (connection === null) {
          // No trusted WeCom requester (or no credential) => no SFOA MCP.
          // Debug level so identity values never reach default-verbosity logs.
          api.logger.debug?.(
            `[${serverName}] withheld: channel=${String(ctx?.messageChannel)} ` +
              `requesterSenderId=${String(ctx?.requesterSenderId)}`,
          );
          return null;
        }

        api.logger.debug?.(
          `[${serverName}] bound channel=${WECOM_CHANNEL_ID} ` +
            `requesterSenderId=${String(ctx?.requesterSenderId)}`,
        );
        return connection;
      },
    });

    api.logger.info(
      `[${serverName}] requester-scoped MCP connection resolver registered (url=${mcpUrl})`,
    );
  },
};

export default plugin;
