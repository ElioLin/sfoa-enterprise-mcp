/**
 * Contract fixtures, not an installed Gateway or real channel execution.
 * OpenClaw v2026.9.5 primary source, inspected 2026-11-05:
 * https://github.com/openclaw/openclaw/blob/v2026.9.5/src/agents/tools/pdf-tool.ts
 * https://github.com/openclaw/openclaw/blob/v2026.9.5/src/agents/tools/image-tool.result.ts
 * https://github.com/openclaw/openclaw/blob/v2026.9.5/src/agents/tools/media-tool-shared.ts
 * https://github.com/openclaw/openclaw/blob/v2026.9.5/src/hooks/message-hook-mappers.ts
 * https://github.com/openclaw/openclaw/blob/v2026.9.5/src/auto-reply/reply/message-preprocess-hooks.ts
 * https://github.com/openclaw/openclaw/blob/v2026.9.5/src/plugins/registry-registrars-tools-hooks.ts
 * Local hooks.d.ts/api.d.ts from that SDK independently confirm callback shapes.
 */
export const pdfResult = (pdf, text = "Extracted task facts") => ({
  content: [{ type: "text", text }], details: { model: "fixture/model", native: false, pdf, text, attempts: [] },
});
export const imageResult = (image) => ({
  content: [{ type: "text", text: "Native image input" }, { type: "image", data: "fixture-image-bytes", mimeType: "image/png" }],
  details: { transport: "native", image, media: { outbound: false } },
});
export const transcriptEvent = (sessionKey, senderId, messageId, filePath, transcript = "客户尚未承诺采购，数量未定。") => ({
  type: "message", action: "transcribed", sessionKey, timestamp: new Date(), messages: [],
  context: { channelId: "wecom", senderId, messageId, transcript,
    media: [{ path: filePath, kind: "audio", contentType: "audio/wav", transcribed: true }] },
});
