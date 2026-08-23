import type { ReactNode } from 'react';
import { Alert, Button, Empty, Skeleton } from 'antd';
import { ApiError } from '../api/client.js';

export function LoadingState({ rows = 5 }: Readonly<{ rows?: number }>) {
  return <div className="surface-card" aria-busy="true" aria-label="Loading"><Skeleton active paragraph={{ rows }} /></div>;
}

export function ErrorState({ error, onRetry }: Readonly<{ error: unknown; onRetry?: () => void }>) {
  const detail = errorDetails(error);
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      title={detail.title}
      description={<span>{detail.description}{detail.correlationId ? <> Correlation: <code>{detail.correlationId}</code>.</> : null}</span>}
      action={onRetry ? <Button onClick={onRetry}>Retry</Button> : undefined}
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
      description={detail.description}
    />
  );
}

export function errorDetails(error: unknown): Readonly<{ title: string; description: string; correlationId?: string }> {
  if (error instanceof ApiError) {
    return Object.freeze({
      title: error.status === 409 ? 'Configuration changed' : error.code,
      description: error.status === 409
        ? 'Another administrator changed this row. Refresh the latest version, review it, and retry.'
        : error.message,
      ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    });
  }
  return Object.freeze({ title: 'Request failed', description: 'The operation failed safely. Retry or inspect Admin API health.' });
}
