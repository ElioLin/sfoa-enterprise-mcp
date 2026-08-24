import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Row, Space, Statistic, Table, Typography } from 'antd';
import type { AuditRecord } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';
import { formatDateTime } from '../localization.js';

export default function DashboardPage() {
  const query = useQuery({ queryKey: ['dashboard'], queryFn: adminApi.dashboard, refetchInterval: 60_000 });
  return (
    <PageFrame
      title="运行概览"
      description="展示当前 Runtime、治理、Diagnostic 与 24 小时持久审计信号，不查询 Salesforce 业务数据。"
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新</Button>}
    >
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
        <Space orientation="vertical" size="large" className="full-width">
          <Row gutter={[16, 16]}>
            <HealthCard title="MCP Runtime" status={query.data.runtimeHealth} />
            <HealthCard title="MySQL" status={query.data.databaseHealth} />
            <HealthCard title="上游契约" status={query.data.upstreamDrift} />
            <HealthCard title="Diagnostic" status={query.data.diagnostic?.verificationStatus ?? 'NOT CONFIGURED'} />
          </Row>
          <Row gutter={[16, 16]}>
            <MetricCard title="已启用路由" value={query.data.routeCount} />
            <MetricCard title="已启用 Tool" value={query.data.enabledToolCount} />
            <MetricCard title="DML 已启用对象" value={query.data.dmlPolicyObjectCount} />
            <MetricCard title="24 小时调用" value={query.data.calls24h.total} />
          </Row>
          <Card title="24 小时结果" className="surface-card">
            <Row gutter={[16, 16]}>
              <MetricCard compact title="成功" value={query.data.calls24h.pass} />
              <MetricCard compact title="已阻止" value={query.data.calls24h.blocked} />
              <MetricCard compact title="错误" value={query.data.calls24h.error} />
              <MetricCard compact title="结果未知" value={query.data.calls24h.unknown} />
            </Row>
          </Card>
          <Card title="最近失败" className="surface-card">
            {query.data.latestErrors.length === 0 ? <EmptyState description="当前时间窗内没有持久化 ERROR 审计事件。" /> : (
              <Table<AuditRecord>
                rowKey="id"
                size="middle"
                pagination={false}
                scroll={{ x: 760 }}
                dataSource={[...query.data.latestErrors]}
                columns={[
                  { title: '发生时间', dataIndex: 'occurredAt', render: (value: string) => formatDateTime(value) },
                  { title: 'Tool', dataIndex: 'toolName', render: (value: string | null) => <code>{value ?? '请求边界'}</code> },
                  { title: '结果', dataIndex: 'result', render: (value: string) => <StatusTag label={value} /> },
                  { title: 'Error Code', dataIndex: 'errorCode', render: (value: string | null) => value ? <code>{value}</code> : '—' },
                  { title: 'Correlation ID', dataIndex: 'correlationId', ellipsis: true },
                ]}
              />
            )}
          </Card>
        </Space>
      )}
    </PageFrame>
  );
}

function HealthCard({ title, status }: Readonly<{ title: string; status: string }>) {
  return (
    <Col xs={24} sm={12} xl={6}>
      <Card className="status-card" variant="borderless">
        <Typography.Text type="secondary">{title}</Typography.Text>
        <div className="status-card-value"><StatusTag label={status} /></div>
      </Card>
    </Col>
  );
}

function MetricCard({ title, value, compact = false }: Readonly<{ title: string; value: number; compact?: boolean }>) {
  return (
    <Col xs={12} md={compact ? 6 : 12} xl={6}>
      <Card className={compact ? 'metric-card metric-card-compact' : 'metric-card'} variant={compact ? 'borderless' : 'outlined'}>
        <Statistic title={title} value={value} styles={{ content: { fontVariantNumeric: 'tabular-nums' } }} />
      </Card>
    </Col>
  );
}
