import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, MinusCircleOutlined } from '@ant-design/icons';
import { Tag } from 'antd';

export type StatusTone = 'success' | 'warning' | 'error' | 'neutral' | 'processing';

export function StatusTag({ label, tone = statusTone(label) }: Readonly<{ label: string; tone?: StatusTone }>) {
  const config = tone === 'success'
    ? { color: 'success', icon: <CheckCircleOutlined /> }
    : tone === 'warning'
      ? { color: 'warning', icon: <ExclamationCircleOutlined /> }
      : tone === 'error'
        ? { color: 'error', icon: <CloseCircleOutlined /> }
        : tone === 'processing'
          ? { color: 'processing', icon: <CheckCircleOutlined /> }
          : { color: 'default', icon: <MinusCircleOutlined /> };
  return <Tag color={config.color} icon={config.icon}>{label.replaceAll('_', ' ')}</Tag>;
}

export function statusTone(value: string | null | undefined): StatusTone {
  const normalized = value?.toLocaleUpperCase('en-US') ?? '';
  if (['PASS', 'UP', 'SUCCESS', 'AVAILABLE', 'ENABLED', 'GA'].includes(normalized)) return 'success';
  if (['PARTIAL', 'NOT_TESTED', 'NOT_VERIFIED', 'UNKNOWN', 'REVIEW_REQUIRED', 'DEGRADED'].includes(normalized)) return 'warning';
  if (['FAIL', 'FAILED', 'ERROR', 'DOWN', 'BLOCKED', 'UNSUPPORTED', 'DENIED'].includes(normalized)) return 'error';
  if (['IN DEVELOPMENT', 'PROCESSING'].includes(normalized)) return 'processing';
  return 'neutral';
}
