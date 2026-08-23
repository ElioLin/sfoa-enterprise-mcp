import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Row, Space, Statistic, Table, Typography } from 'antd';
import type { AuditRecord } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

export default function DashboardPage() {
  const query = useQuery({ queryKey: ['dashboard'], queryFn: adminApi.dashboard, refetchInterval: 60_000 });
  return (
    <PageFrame
      title="Operational overview"
      description="Current runtime, governance, Diagnostic, and 24-hour durable audit signals—without querying Salesforce business data."
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button>}
    >
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
        <Space orientation="vertical" size="large" className="full-width">
          <Row gutter={[16, 16]}>
            <HealthCard title="MCP runtime" status={query.data.runtimeHealth} />
            <HealthCard title="MySQL" status={query.data.databaseHealth} />
            <HealthCard title="Upstream contract" status={query.data.upstreamDrift} />
            <HealthCard title="Diagnostic" status={query.data.diagnostic?.verificationStatus ?? 'NOT CONFIGURED'} />
          </Row>
          <Row gutter={[16, 16]}>
            <MetricCard title="Active routes" value={query.data.routeCount} />
            <MetricCard title="Enabled Tools" value={query.data.enabledToolCount} />
            <MetricCard title="DML-enabled objects" value={query.data.dmlPolicyObjectCount} />
            <MetricCard title="24h calls" value={query.data.calls24h.total} />
          </Row>
          <Card title="24-hour outcomes" className="surface-card">
            <Row gutter={[16, 16]}>
              <MetricCard compact title="Success" value={query.data.calls24h.pass} />
              <MetricCard compact title="Blocked" value={query.data.calls24h.blocked} />
              <MetricCard compact title="Error" value={query.data.calls24h.error} />
              <MetricCard compact title="Unknown outcome" value={query.data.calls24h.unknown} />
            </Row>
          </Card>
          <Card title="Recent failures" className="surface-card">
            {query.data.latestErrors.length === 0 ? <EmptyState description="No durable ERROR audit events in the current window." /> : (
              <Table<AuditRecord>
                rowKey="id"
                size="middle"
                pagination={false}
                scroll={{ x: 760 }}
                dataSource={[...query.data.latestErrors]}
                columns={[
                  { title: 'Occurred', dataIndex: 'occurredAt', render: (value: string) => formatTime(value) },
                  { title: 'Tool', dataIndex: 'toolName', render: (value: string | null) => <code>{value ?? 'Request boundary'}</code> },
                  { title: 'Result', dataIndex: 'result', render: (value: string) => <StatusTag label={value} /> },
                  { title: 'Error', dataIndex: 'errorCode', render: (value: string | null) => value ? <code>{value}</code> : '—' },
                  { title: 'Correlation', dataIndex: 'correlationId', ellipsis: true },
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
        <Statistic title={title} value={value} valueStyle={{ fontVariantNumeric: 'tabular-nums' }} />
      </Card>
    </Col>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
