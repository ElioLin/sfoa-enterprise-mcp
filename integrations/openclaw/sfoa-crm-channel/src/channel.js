/**
 * Minimal OpenClaw channel definition for the SFoA CRM entry.
 *
 * The channel has no transport of its own: the qualified transport is the
 * plugin HTTP ingress in index.js, which is reachable only with the service
 * credential shared with the SFoA CRM access service. Registering the channel
 * is what makes OpenClaw's official routing/session/delivery machinery apply
 * (`resolveAgentRoute`, session metadata, reply dispatch) instead of inventing
 * a session-key syntax or writing to the session store directly.
 */

import { CHANNEL_ID } from "./protocol.js";

const account = Object.freeze({
  accountId: "default",
  name: "SFoA CRM",
  enabled: true,
  configured: true,
});

export const sfoaCrmChannelPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "SFoA CRM",
    selectionLabel: "Salesforce SFoA CRM",
    detailLabel: "Salesforce 内嵌 CRM 聊天",
    docsPath: `/channels/${CHANNEL_ID}`,
    docsLabel: CHANNEL_ID,
    blurb: "Salesforce LWC -> SFoA CRM 接入服务 -> OpenClaw 的可信 CRM 渠道",
    systemImage: "bubble.left.and.bubble.right.fill",
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
    defaultAccountId: () => "default",
    isEnabled: () => true,
    isConfigured: () => true,
    describeAccount: () => account,
    buildAccountSnapshot: () => ({ ...account, running: true }),
  },
  gateway: {
    /**
     * The channel has no long-lived socket. It stays "running" for the life of
     * the Gateway; the HTTP ingress is installed by registerHttpRoute.
     */
    startAccount: async (ctx) => {
      ctx?.log?.info?.(`[${CHANNEL_ID}] channel running (no inbound socket; HTTP ingress is credentialed)`);
      await new Promise((resolve) => {
        if (ctx?.abortSignal?.aborted) {
          resolve();
          return;
        }
        ctx?.abortSignal?.addEventListener?.("abort", () => resolve(), { once: true });
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    // Delivery is owned by dispatchReplyWithBufferedBlockDispatcher's deliver
    // callback. This adapter exists only so the channel is structurally a chat
    // channel; it must never be used as a second delivery path.
    sendText: async ({ to }) => ({ channel: CHANNEL_ID, messageId: `crm-${Date.now()}`, chatId: String(to ?? "") }),
    sendMedia: async () => {
      throw new Error("The SFoA CRM channel does not support media.");
    },
  },
};
