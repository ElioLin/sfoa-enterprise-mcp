import { CopyOutlined, FileTextOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Modal, Space, Typography, message } from 'antd';
import type { AuditPayloadEvidenceSummaryRecord } from '@sfoa/control-plane';
import { adminApi } from '../../api/client.js';
import { ErrorState, LoadingState } from '../../components/QueryState.js';

export function PayloadEvidenceViewer({
  payload,
  open,
  onClose,
}: Readonly<{
  payload: AuditPayloadEvidenceSummaryRecord | null;
  open: boolean;
  onClose(): void;
}>) {
  const query = useQuery({
    queryKey: ['audit-payload', payload?.id],
    queryFn: () => adminApi.auditPayload(payload?.id ?? '0'),
    enabled: open && payload !== null,
    staleTime: 60_000,
  });
  const text = query.data?.safePayload ?? '';
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={960}
      title={payload ? `${payloadTypeLabel(payload.payloadType)} · 载荷证据` : '载荷证据'}
      destroyOnHidden
    >
      {query.isPending ? <LoadingState rows={6} /> : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data ? (
        <Space orientation="vertical" size="middle" className="full-width">
          {query.data.truncated ? (
            <Alert
              type="warning"
              showIcon
              title="此载荷已截断"
              description={`原始大小 ${formatBytes(query.data.originalSizeBytes)}，审计保存 ${formatBytes(String(query.data.storedSizeBytes))}。以下内容不是完整响应。`}
            />
          ) : null}
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label="类型">{payloadTypeLabel(query.data.payloadType)}</Descriptions.Item>
            <Descriptions.Item label="Content-Type">{query.data.contentType}</Descriptions.Item>
            <Descriptions.Item label="原始大小">{formatBytes(query.data.originalSizeBytes)}</Descriptions.Item>
            <Descriptions.Item label="保存大小">{formatBytes(String(query.data.storedSizeBytes))}</Descriptions.Item>
            <Descriptions.Item label="SHA-256" span={2}>
              {query.data.contentSha256 ? <Typography.Text copyable code>{query.data.contentSha256}</Typography.Text> : '—'}
            </Descriptions.Item>
          </Descriptions>
          <div className="payload-viewer-toolbar">
            <Typography.Text type="secondary"><FileTextOutlined /> {query.data.contentType}</Typography.Text>
            <Button
              size="small"
              icon={<CopyOutlined />}
              disabled={!text}
              onClick={() => void copyText(text, '载荷内容')}
            >
              复制内容
            </Button>
          </div>
          <pre className="audit-code-block payload-code-block">{prettyPayload(text, query.data.contentType)}</pre>
        </Space>
      ) : null}
    </Modal>
  );
}

export function payloadTypeLabel(type: AuditPayloadEvidenceSummaryRecord['payloadType']): string {
  switch (type) {
    case 'MCP_REQUEST': return 'MCP 请求';
    case 'MCP_RESPONSE': return 'MCP 响应';
    case 'SALESFORCE_REQUEST': return 'Salesforce 请求';
    case 'SALESFORCE_RESPONSE': return 'Salesforce 响应';
    case 'ERROR_RESPONSE': return '错误响应';
    default: return type;
  }
}

export function formatBytes(value: string | null): string {
  if (value === null) return '未知';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return value;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function prettyPayload(text: string, contentType: string): string {
  if (!text) return '未保存正文。';
  if (contentType.toLocaleLowerCase().includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
    try { return JSON.stringify(JSON.parse(text) as unknown, null, 2); } catch { return text; }
  }
  return text;
}

async function copyText(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    void message.success(`${label}已复制`);
  } catch {
    void message.error('复制失败，请手动选择内容。');
  }
}
