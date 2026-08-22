import { RemoteRuntimeError, type RemoteRuntimeErrorCode } from './errors.js';

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: Extract<RemoteRuntimeErrorCode, 'MCP_REQUEST_TIMEOUT' | 'MCP_TOOL_TIMEOUT'>,
  message: string,
  correlationId?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RemoteRuntimeError(code, message, { correlationId })),
      timeoutMs,
    );
    timer.unref();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
