import { CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined, MinusCircleOutlined } from '@ant-design/icons';
import { Tag, Tooltip } from 'antd';
import { hasLocalizedStatus, statusLabel } from '../localization.js';

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
  const tag = <Tag color={config.color} icon={config.icon}>{statusLabel(label)}</Tag>;
  return hasLocalizedStatus(label) ? <Tooltip title={`原始值：${label}`}>{tag}</Tooltip> : tag;
}

export function statusTone(value: string | null | undefined): StatusTone {
  const normalized = value?.toLocaleUpperCase('en-US') ?? '';
  if (['PASS', 'UP', 'SUCCESS', 'AVAILABLE', 'ENABLED', 'GA', 'READY', 'CONFIGURED', 'ALLOWED', 'YES'].includes(normalized)) return 'success';
  if (['PARTIAL', 'NOT_TESTED', 'NOT_VERIFIED', 'NOT_CONFIGURED', 'UNKNOWN', 'REVIEW_REQUIRED', 'DEGRADED', 'NON_GA'].includes(normalized)) return 'warning';
  if (['FAIL', 'FAILED', 'ERROR', 'DOWN', 'BLOCKED', 'UNSUPPORTED', 'DENIED'].includes(normalized)) return 'error';
  if (['IN DEVELOPMENT', 'IN_DEVELOPMENT', 'PROCESSING'].includes(normalized)) return 'processing';
  return 'neutral';
}
