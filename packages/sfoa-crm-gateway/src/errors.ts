/**
 * Stable public errors for the CRM access service.
 *
 * The browser receives `errorCode`, a safe Chinese message and a correlation
 * id. It never receives a stack, a token, a database error or an OpenClaw
 * internal message.
 */

export class CrmGatewayError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly safeMessage: string;

  public constructor(code: string, safeMessage: string, status = 400, options?: { cause?: unknown }) {
    super(safeMessage, options);
    this.name = 'CrmGatewayError';
    this.code = code;
    this.status = status;
    this.safeMessage = safeMessage;
  }
}

export function isCrmGatewayError(error: unknown): error is CrmGatewayError {
  return error instanceof CrmGatewayError;
}

/** Maps an unknown failure to a stable, non-leaking API error. */
export function toCrmGatewayError(error: unknown): CrmGatewayError {
  if (isCrmGatewayError(error)) return error;
  return new CrmGatewayError(
    'CRM_INTERNAL_ERROR',
    'CRM 聊天服务暂时无法处理该请求。请稍后重试，并保留关联编号。',
    500,
    { cause: error },
  );
}
