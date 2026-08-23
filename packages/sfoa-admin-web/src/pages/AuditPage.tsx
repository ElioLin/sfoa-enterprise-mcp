import { FilterOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Descriptions, Drawer, Form, Input, Pagination, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import type { AuditRecord } from '@sfoa/control-plane';
import { adminApi, type AuditFilters } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

const PAGE_SIZE = 25;
type AuditFilterForm = Readonly<{
  occurredFrom?: string;
  occurredTo?: string;
  correlationId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  toolName?: string;
  result?: AuditFilters['result'];
  errorCode?: string;
}>;

export default function AuditPage() {
  const [form] = Form.useForm<AuditFilterForm>();
  const [filters, setFilters] = useState<AuditFilters>({ limit: PAGE_SIZE, offset: 0 });
  const [detailId, setDetailId] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['audits', filters], queryFn: () => adminApi.audits(filters) });
  const detail = useQuery({
    queryKey: ['audit', detailId],
    queryFn: () => adminApi.audit(detailId ?? '0'),
    enabled: detailId !== null,
  });

  const applyFilters = (values: AuditFilterForm): void => {
    setFilters({
      ...compactFilters(values),
      limit: PAGE_SIZE,
      offset: 0,
    });
  };
  const clearFilters = (): void => {
    form.resetFields();
    setFilters({ limit: PAGE_SIZE, offset: 0 });
  };

  return (
    <PageFrame
      title="Durable audit"
      description="Bounded, server-paginated MCP and Admin evidence. Summaries intentionally omit Salesforce field values, result rows, credentials, and authorization material."
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <div className="surface-card filter-card">
          <Form<AuditFilterForm> form={form} layout="vertical" onFinish={applyFilters}>
            <div className="filter-grid">
              <Form.Item name="occurredFrom" label="From"><Input type="datetime-local" /></Form.Item>
              <Form.Item name="occurredTo" label="To"><Input type="datetime-local" /></Form.Item>
              <Form.Item name="correlationId" label="Correlation ID"><Input allowClear maxLength={128} /></Form.Item>
              <Form.Item name="platformUserId" label="Platform user"><Input allowClear maxLength={128} /></Form.Item>
              <Form.Item name="salesforceUsername" label="Salesforce username"><Input allowClear maxLength={320} /></Form.Item>
              <Form.Item name="toolName" label="Tool"><Input allowClear maxLength={128} /></Form.Item>
              <Form.Item name="result" label="Result">
                <Select allowClear options={['PASS', 'BLOCKED', 'ERROR'].map((value) => ({ value, label: value }))} />
              </Form.Item>
              <Form.Item name="errorCode" label="Error code"><Input allowClear maxLength={128} /></Form.Item>
            </div>
            <Space wrap>
              <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>Search audit</Button>
              <Button icon={<FilterOutlined />} onClick={clearFilters}>Clear filters</Button>
            </Space>
          </Form>
        </div>
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.items.length === 0 ? <EmptyState description="No audit rows match these filters." /> : (
              <Table<AuditRecord>
                rowKey="id"
                pagination={false}
                dataSource={[...query.data.items]}
                scroll={{ x: 1250 }}
                onRow={(record) => ({ onClick: () => setDetailId(record.id), className: 'clickable-row' })}
                columns={[
                  { title: 'Occurred', dataIndex: 'occurredAt', width: 180, render: formatDate },
                  { title: 'Channel', dataIndex: 'channel', render: (value: string) => <StatusTag label={value} tone="neutral" /> },
                  { title: 'Platform user', dataIndex: 'platformUserId', render: (value: string | null) => value ? <code>{value}</code> : '—' },
                  { title: 'Salesforce execution user', dataIndex: 'salesforceUsername', render: (value: string | null) => value ?? '—' },
                  { title: 'Role', dataIndex: 'executionRole', render: (value: string | null) => value ? <StatusTag label={value} tone={value === 'DIAGNOSTIC' ? 'warning' : 'neutral'} /> : '—' },
                  { title: 'Tool / operation', render: (_value, record) => <span><code>{record.toolName ?? 'Admin'}</code>{record.operation ? ` · ${record.operation}` : ''}</span> },
                  { title: 'Result', dataIndex: 'result', render: (value: string) => <StatusTag label={value} /> },
                  { title: 'Error', dataIndex: 'errorCode', render: (value: string | null) => value ? <code>{value}</code> : '—' },
                  { title: 'Duration', dataIndex: 'durationMs', render: (value: number | null) => value === null ? '—' : `${value} ms` },
                  { title: 'Correlation ID', dataIndex: 'correlationId', ellipsis: true, width: 220 },
                ]}
              />
            )}
            <Pagination
              className="table-pagination"
              current={Math.floor(filters.offset / PAGE_SIZE) + 1}
              pageSize={PAGE_SIZE}
              total={filters.offset + query.data.count + (query.data.hasMore ? 1 : 0)}
              showSizeChanger={false}
              hideOnSinglePage={!query.data.hasMore && filters.offset === 0}
              onChange={(page) => setFilters((current) => ({ ...current, offset: (page - 1) * PAGE_SIZE }))}
            />
          </div>
        )}
      </Space>

      <Drawer
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title="Audit detail"
        size={Math.min(720, window.innerWidth)}
        destroyOnHidden
      >
        {detail.isPending ? <LoadingState rows={8} /> : detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : detail.data ? <AuditDetail record={detail.data} /> : null}
      </Drawer>
    </PageFrame>
  );
}

function AuditDetail({ record }: Readonly<{ record: AuditRecord }>) {
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="Occurred">{formatDate(record.occurredAt)}</Descriptions.Item>
        <Descriptions.Item label="Triggering platform user">{record.platformUserId ?? 'Not applicable'}</Descriptions.Item>
        <Descriptions.Item label="Actual Salesforce execution user">{record.salesforceUsername ?? 'Not applicable'}</Descriptions.Item>
        <Descriptions.Item label="Execution role">{record.executionRole ? <StatusTag label={record.executionRole} /> : 'Not applicable'}</Descriptions.Item>
        <Descriptions.Item label="Admin actor">{record.actorAdmin ?? 'Not applicable'}</Descriptions.Item>
        <Descriptions.Item label="Client ID">{record.clientId ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Tool">{record.toolName ?? 'Admin configuration'}</Descriptions.Item>
        <Descriptions.Item label="Operation">{record.operation ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Object API name">{record.objectApiName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Record ID">{record.recordId ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Result"><StatusTag label={record.result} /></Descriptions.Item>
        <Descriptions.Item label="Outcome">{record.outcome ? <StatusTag label={record.outcome} /> : '—'}</Descriptions.Item>
        <Descriptions.Item label="Error">{record.errorCode ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Duration">{record.durationMs === null ? '—' : `${record.durationMs} ms`}</Descriptions.Item>
        <Descriptions.Item label="Correlation ID"><Typography.Text copyable code>{record.correlationId}</Typography.Text></Descriptions.Item>
      </Descriptions>
      <SafeSummary title="Safe request summary" value={record.requestSummary} />
      <SafeSummary title="Safe response summary" value={record.responseSummary} />
    </Space>
  );
}

function SafeSummary({ title, value }: Readonly<{ title: string; value: unknown }>) {
  return (
    <section aria-label={title}>
      <Typography.Title level={5}>{title}</Typography.Title>
      <pre className="json-summary">{safeJson(value)}</pre>
    </section>
  );
}

function safeJson(value: unknown): string {
  if (value === null || value === undefined) return 'No summary recorded.';
  try {
    return JSON.stringify(value, null, 2).slice(0, 16_384);
  } catch {
    return 'Summary is not serializable.';
  }
}

function compactFilters(values: AuditFilterForm): Omit<AuditFilters, 'limit' | 'offset'> {
  return {
    ...(values.occurredFrom ? { occurredFrom: new Date(values.occurredFrom).toISOString() } : {}),
    ...(values.occurredTo ? { occurredTo: new Date(values.occurredTo).toISOString() } : {}),
    ...(values.correlationId?.trim() ? { correlationId: values.correlationId.trim() } : {}),
    ...(values.platformUserId?.trim() ? { platformUserId: values.platformUserId.trim() } : {}),
    ...(values.salesforceUsername?.trim() ? { salesforceUsername: values.salesforceUsername.trim() } : {}),
    ...(values.toolName?.trim() ? { toolName: values.toolName.trim() } : {}),
    ...(values.result ? { result: values.result } : {}),
    ...(values.errorCode?.trim() ? { errorCode: values.errorCode.trim().toLocaleUpperCase('en-US') } : {}),
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
