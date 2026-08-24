import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Col, Descriptions, Form, InputNumber, List, Modal, Row, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import type { RuntimeSettingKey, RuntimeSettingRecord } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

const SETTING_LABELS: Readonly<Record<RuntimeSettingKey, Readonly<{ title: string; description: string; min: number; max: number }>>> = Object.freeze({
  auditRetentionDays: Object.freeze({ title: '审计保留天数', description: '持久审计维护的运维保留目标。', min: 1, max: 3650 }),
  adminDefaultPageSize: Object.freeze({ title: 'Admin 默认分页大小', description: '兼容 Admin 列表客户端使用的有界默认值。', min: 10, max: 100 }),
});

export default function SystemPage() {
  const [editing, setEditing] = useState<RuntimeSettingRecord | null>(null);
  const [form] = Form.useForm<{ value: number }>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const status = useQuery({ queryKey: ['system-status'], queryFn: adminApi.systemStatus, refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ['runtime-settings'], queryFn: adminApi.runtimeSettings });
  const update = useMutation({
    mutationFn: ({ record, value }: Readonly<{ record: RuntimeSettingRecord; value: number }>) => adminApi.updateRuntimeSetting(record.settingKey, value, record.rowVersion),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['runtime-settings'] }),
        queryClient.invalidateQueries({ queryKey: ['system-status'] }),
      ]);
      setEditing(null);
      void message.success('Runtime 设置已保存，将应用于新请求。');
    },
  });
  const openEdit = (record: RuntimeSettingRecord): void => {
    form.setFieldsValue({ value: numericValue(record.settingValue) });
    setEditing(record);
  };

  return (
    <PageFrame
      title="系统状态"
      description="展示 Runtime、数据库、Provider、阶段与安全配置状态。环境自有凭据与认证设置保持只读且脱敏。"
      action={<Button icon={<ReloadOutlined />} loading={status.isFetching || settings.isFetching} onClick={() => { void status.refetch(); void settings.refetch(); }}>刷新</Button>}
    >
      {status.isPending ? <LoadingState /> : status.isError ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : (
        <Space orientation="vertical" size="large" className="full-width">
          <MutationError error={update.error} />
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={12}>
              <Card title="Runtime" className="surface-card full-height">
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="Runtime 模式"><StatusTag label={status.data.runtimeMode.toLocaleUpperCase('en-US')} tone={status.data.runtimeMode === 'mysql' ? 'processing' : 'warning'} /></Descriptions.Item>
                  <Descriptions.Item label="MCP Endpoint">{status.data.mcpEndpoint}</Descriptions.Item>
                  <Descriptions.Item label="MCP 健康状态"><StatusTag label={status.data.mcpHealth} /></Descriptions.Item>
                  <Descriptions.Item label="Admin 版本">{status.data.adminVersion}</Descriptions.Item>
                  <Descriptions.Item label="MCP Server 版本">{status.data.mcpServerVersion}</Descriptions.Item>
                  <Descriptions.Item label="Salesforce API 版本">{status.data.salesforceApiVersion}</Descriptions.Item>
                  <Descriptions.Item label="Salesforce 实例 Host">{status.data.salesforceInstanceHost ?? '未配置'}</Descriptions.Item>
                  <Descriptions.Item label="上游漂移"><StatusTag label={status.data.upstreamDrift.status} /></Descriptions.Item>
                  <Descriptions.Item label="审计持久化"><StatusTag label={status.data.auditPersistence.status} />（已观察到 {status.data.auditPersistence.failureCount} 次失败）</Descriptions.Item>
                </Descriptions>
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card title="数据库与凭据就绪状态" className="surface-card full-height">
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="数据库"><StatusTag label={status.data.database.status} /></Descriptions.Item>
                  <Descriptions.Item label="数据库版本">{status.data.database.version ?? '不可用'}</Descriptions.Item>
                  <Descriptions.Item label="Schema 版本">{status.data.database.schemaVersions.length ? status.data.database.schemaVersions.join(', ') : '未报告'}</Descriptions.Item>
                  <Descriptions.Item label="Connected App 已配置"><Configured configured={status.data.configured.connectedApp} /></Descriptions.Item>
                  <Descriptions.Item label="JWT key 已配置"><Configured configured={status.data.configured.jwtPrivateKey} /></Descriptions.Item>
                  <Descriptions.Item label="MCP client token 已配置"><Configured configured={status.data.configured.mcpClientToken} /></Descriptions.Item>
                  <Descriptions.Item label="Diagnostic 状态"><StatusTag label={status.data.diagnostic?.verificationStatus ?? 'NOT_CONFIGURED'} /></Descriptions.Item>
                </Descriptions>
                <Typography.Paragraph type="secondary" className="credential-note">
                  Secret 值、JWT 材料、key 路径、数据库密码与 Authorization Header 永远不会由该 API 返回。
                </Typography.Paragraph>
              </Card>
            </Col>
          </Row>

          <Card title="阶段状态" className="surface-card">
            <div className="phase-grid">
              {Object.entries(status.data.phases).map(([phase, value]) => (
                <div className="phase-item" key={phase}><strong>{phase}</strong><StatusTag label={value} /></div>
              ))}
            </div>
          </Card>

          <Card title="Provider 目录" className="surface-card">
            <Table
              rowKey="name"
              pagination={false}
              dataSource={[...status.data.providerVersions]}
              columns={[
                { title: 'Provider', dataIndex: 'name' },
                { title: '版本', dataIndex: 'version', render: (value: string) => <code>{value}</code> },
              ]}
            />
          </Card>

          <Card title="可编辑的非 secret 设置" className="surface-card">
            {settings.isPending ? <LoadingState rows={2} /> : settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : (
              <List
                dataSource={[...settings.data]}
                renderItem={(record) => (
                  <List.Item actions={[<Button key="edit" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>]}>
                    <List.Item.Meta title={SETTING_LABELS[record.settingKey].title} description={SETTING_LABELS[record.settingKey].description} />
                    <Typography.Text strong>{String(record.settingValue)}</Typography.Text>
                  </List.Item>
                )}
              />
            )}
          </Card>

          <Card title="只读环境设置" className="surface-card">
            <Descriptions bordered size="small" column={{ xs: 1, lg: 2 }}>
              {Object.entries(status.data.readOnlyRuntimeSettings).map(([key, value]) => (
                <Descriptions.Item key={key} label={key}><span className="wrap-value">{displaySafeSetting(value)}</span></Descriptions.Item>
              ))}
            </Descriptions>
          </Card>
        </Space>
      )}

      <Modal
        open={editing !== null}
        title={editing ? `编辑 ${SETTING_LABELS[editing.settingKey].title}` : '编辑设置'}
        okText="保存设置"
        confirmLoading={update.isPending}
        onCancel={() => setEditing(null)}
        onOk={() => void form.submit()}
        destroyOnHidden
      >
        {editing ? (
          <Form form={form} layout="vertical" onFinish={(values) => update.mutate({ record: editing, value: values.value })}>
            <Form.Item
              name="value"
              label={SETTING_LABELS[editing.settingKey].title}
              extra={SETTING_LABELS[editing.settingKey].description}
              rules={[{ required: true, type: 'number', min: SETTING_LABELS[editing.settingKey].min, max: SETTING_LABELS[editing.settingKey].max }]}
            >
              <InputNumber min={SETTING_LABELS[editing.settingKey].min} max={SETTING_LABELS[editing.settingKey].max} precision={0} className="full-width" />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>
    </PageFrame>
  );
}

function Configured({ configured }: Readonly<{ configured: boolean }>) {
  return <StatusTag label={configured ? 'CONFIGURED' : 'NOT_CONFIGURED'} tone={configured ? 'success' : 'warning'} />;
}

function numericValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function displaySafeSetting(value: string | number | boolean | readonly string[] | null): string {
  if (value === null) return '未配置';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
