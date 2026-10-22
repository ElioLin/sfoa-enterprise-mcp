/** Server-Sent Events frame used by both the plugin client bridge and the browser stream. */
export function encodeSseEvent(type: string, data: unknown): string {
  if (!/^[a-z][a-z0-9.-]{0,63}$/u.test(type)) throw new Error('Invalid SSE event type.');
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
