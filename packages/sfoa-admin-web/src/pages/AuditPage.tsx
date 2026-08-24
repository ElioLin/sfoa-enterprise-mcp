import { FilterOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Descriptions, Drawer, Form, Input, Pagination, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import type { AuditRecord } from '@sfoa/control-plane';
import { adminApi, type AuditFilters } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';
import { formatDateTime } from '../localization.js';

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
      title="调用审计"
      description="有界、服务端分页的 MCP 与 Admin 证据。摘要会有意省略 Salesforce 字段值、结果行、凭据与授权材料。"
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <div className="surface-card filter-card">
          <Form<AuditFilterForm> form={form} layout="vertical" onFinish={applyFilters}>
            <div className="filter-grid">
              <Form.Item name="occurredFrom" label="开始时间"><Input type="datetime-local" /></Form.Item>
              <Form.Item name="occurredTo" label="结束时间"><Input type="datetime-local" /></Form.Item>
              <Form.Item name="correlationId" label="Correlation ID"><Input allowClear maxLength={128} /></Form.Item>
              <Form.Item name="platformUserId" label="平台用户"><Input allowClear maxLength={128} /></Form.Item>
              <Form.Item name="salesforceUsername" label="Salesforce Username"><Input allowClear maxLength={320} /></Form.Item>
              <Form.Item name="toolName" label="Tool"><Input allowClear maxLength={128} /></Form.Item>
              <Form.Item name="result" label="结果">
                <Select allowClear options={[
                  { value: 'PASS', label: '通过（PASS）' },
                  { value: 'BLOCKED', label: '已阻止（BLOCKED）' },
                  { value: 'ERROR', label: '错误（ERROR）' },
                ]} />
              </Form.Item>
              <Form.Item name="errorCode" label="Error Code"><Input allowClear maxLength={128} /></Form.Item>
            </div>
            <Space wrap>
              <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>搜索审计</Button>
              <Button icon={<FilterOutlined />} onClick={clearFilters}>清除筛选</Button>
            </Space>
          </Form>
        </div>
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.items.length === 0 ? <EmptyState description="没有匹配当前筛选条件的审计记录。" /> : (
              <Table<AuditRecord>
                rowKey="id"
                pagination={false}
                dataSource={[...query.data.items]}
                scroll={{ x: 1250 }}
                onRow={(record) => ({ onClick: () => setDetailId(record.id), className: 'clickable-row' })}
                columns={[
                  { title: '发生时间', dataIndex: 'occurredAt', width: 180, render: formatDateTime },
                  { title: '通道', dataIndex: 'channel', render: (value: string) => <StatusTag label={value} tone="neutral" /> },
                  { title: '平台用户', dataIndex: 'platformUserId', render: (value: string | null) => value ? <code>{value}</code> : '—' },
                  { title: 'Salesforce 执行用户', dataIndex: 'salesforceUsername', render: (value: string | null) => value ?? '—' },
                  { title: '执行角色', dataIndex: 'executionRole', render: (value: string | null) => value ? <StatusTag label={value} tone={value === 'DIAGNOSTIC' ? 'warning' : 'neutral'} /> : '—' },
                  { title: 'Tool / 操作', render: (_value, record) => <span><code>{record.toolName ?? 'Admin'}</code>{record.operation ? ` · ${record.operation}` : ''}</span> },
                  { title: '结果', dataIndex: 'result', render: (value: string) => <StatusTag label={value} /> },
                  { title: 'Error Code', dataIndex: 'errorCode', render: (value: string | null) => value ? <code>{value}</code> : '—' },
                  { title: '耗时', dataIndex: 'durationMs', render: (value: number | null) => value === null ? '—' : `${value} ms` },
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
        title="审计详情"
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
        <Descriptions.Item label="发生时间">{formatDateTime(record.occurredAt)}</Descriptions.Item>
        <Descriptions.Item label="触发平台用户">{record.platformUserId ?? '不适用'}</Descriptions.Item>
        <Descriptions.Item label="实际 Salesforce 执行用户">{record.salesforceUsername ?? '不适用'}</Descriptions.Item>
        <Descriptions.Item label="执行角色">{record.executionRole ? <StatusTag label={record.executionRole} /> : '不适用'}</Descriptions.Item>
        <Descriptions.Item label="Admin 操作人">{record.actorAdmin ?? '不适用'}</Descriptions.Item>
        <Descriptions.Item label="Client ID">{record.clientId ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Tool">{record.toolName ?? 'Admin 配置'}</Descriptions.Item>
        <Descriptions.Item label="操作">{record.operation ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="对象 API 名称">{record.objectApiName ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Record ID">{record.recordId ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="结果"><StatusTag label={record.result} /></Descriptions.Item>
        <Descriptions.Item label="Outcome">{record.outcome ? <StatusTag label={record.outcome} /> : '—'}</Descriptions.Item>
        <Descriptions.Item label="Error Code">{record.errorCode ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="耗时">{record.durationMs === null ? '—' : `${record.durationMs} ms`}</Descriptions.Item>
        <Descriptions.Item label="Correlation ID"><Typography.Text copyable code>{record.correlationId}</Typography.Text></Descriptions.Item>
      </Descriptions>
      <SafeSummary title="安全请求摘要" value={record.requestSummary} />
      <SafeSummary title="安全响应摘要" value={record.responseSummary} />
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
  if (value === null || value === undefined) return '未记录摘要。';
  try {
    return JSON.stringify(value, null, 2).slice(0, 16_384);
  } catch {
    return '摘要无法序列化。';
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
