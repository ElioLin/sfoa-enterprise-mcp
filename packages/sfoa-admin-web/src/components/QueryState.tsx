import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton, Space, Typography } from 'antd';
import { ApiError } from '../api/client.js';
import { localizeErrorCode } from '../localization.js';

export function LoadingState({ rows = 5 }: Readonly<{ rows?: number }>) {
  return <div className="surface-card" aria-busy="true" aria-label="正在加载"><Skeleton active paragraph={{ rows }} /></div>;
}

export function ErrorState({ error, onRetry }: Readonly<{ error: unknown; onRetry?: () => void }>) {
  const detail = errorDetails(error);
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      title={detail.title}
      description={<ErrorDetailContent detail={detail} />}
      action={onRetry ? <Button onClick={onRetry}>重试</Button> : undefined}
    />
  );
}

export function EmptyState({ description, action }: Readonly<{ description: string; action?: ReactNode }>) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description}>{action}</Empty>;
}

export function MutationError({ error }: Readonly<{ error: unknown }>) {
  if (!error) return null;
  const detail = errorDetails(error);
  return (
    <Alert
      closable
      showIcon
      type={error instanceof ApiError && error.status === 409 ? 'warning' : 'error'}
      role="alert"
      title={detail.title}
      description={<ErrorDetailContent detail={detail} />}
    />
  );
}

export type LocalizedErrorDetail = Readonly<{
  title: string;
  description: string;
  errorCode?: string;
  safeRawMessage?: string;
  correlationId?: string;
}>;

export function errorDetails(error: unknown): LocalizedErrorDetail {
  if (error instanceof ApiError) {
    const localized = localizeErrorCode(error.code, error.status);
    return Object.freeze({
      title: localized.title,
      description: localized.explanation,
      errorCode: error.code,
      safeRawMessage: error.message,
      ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    });
  }
  return Object.freeze({ title: '请求失败', description: '操作已安全失败，请重试或检查 Admin API 健康状态。' });
}

export function ErrorDetailContent({ detail }: Readonly<{ detail: LocalizedErrorDetail }>) {
  const technical = detail.errorCode || detail.safeRawMessage || detail.correlationId;
  return (
    <Space orientation="vertical" size={8}>
      <span>{detail.description}</span>
      {technical ? (
        <details className="technical-error-details">
          <summary>查看技术详情</summary>
          {detail.errorCode ? <Typography.Text><strong>Error Code：</strong><code>{detail.errorCode}</code></Typography.Text> : null}
          {detail.safeRawMessage ? <Typography.Text><strong>Safe raw message：</strong>{detail.safeRawMessage}</Typography.Text> : null}
          {detail.correlationId ? <Typography.Text><strong>Correlation ID：</strong><code>{detail.correlationId}</code></Typography.Text> : null}
        </details>
      ) : null}
    </Space>
  );
}
