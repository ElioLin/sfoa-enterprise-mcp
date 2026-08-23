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
  auditRetentionDays: Object.freeze({ title: 'Audit retention days', description: 'Operational retention target for durable audit maintenance.', min: 1, max: 3650 }),
  adminDefaultPageSize: Object.freeze({ title: 'Admin default page size', description: 'Bounded default used by compatible Admin list clients.', min: 10, max: 100 }),
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
      void message.success('Runtime setting saved for new requests.');
    },
  });
  const openEdit = (record: RuntimeSettingRecord): void => {
    form.setFieldsValue({ value: numericValue(record.settingValue) });
    setEditing(record);
  };

  return (
    <PageFrame
      title="System status"
      description="Runtime, database, Provider, phase, and safe configuration state. Environment-owned credentials and authentication settings remain read-only and masked."
      action={<Button icon={<ReloadOutlined />} loading={status.isFetching || settings.isFetching} onClick={() => { void status.refetch(); void settings.refetch(); }}>Refresh</Button>}
    >
      {status.isPending ? <LoadingState /> : status.isError ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : (
        <Space orientation="vertical" size="large" className="full-width">
          <MutationError error={update.error} />
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={12}>
              <Card title="Runtime" className="surface-card full-height">
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="Runtime mode"><StatusTag label={status.data.runtimeMode.toLocaleUpperCase('en-US')} tone={status.data.runtimeMode === 'mysql' ? 'processing' : 'warning'} /></Descriptions.Item>
                  <Descriptions.Item label="MCP endpoint">{status.data.mcpEndpoint}</Descriptions.Item>
                  <Descriptions.Item label="MCP health"><StatusTag label={status.data.mcpHealth} /></Descriptions.Item>
                  <Descriptions.Item label="Admin version">{status.data.adminVersion}</Descriptions.Item>
                  <Descriptions.Item label="MCP server version">{status.data.mcpServerVersion}</Descriptions.Item>
                  <Descriptions.Item label="Salesforce API version">{status.data.salesforceApiVersion}</Descriptions.Item>
                  <Descriptions.Item label="Salesforce instance host">{status.data.salesforceInstanceHost ?? 'Not configured'}</Descriptions.Item>
                  <Descriptions.Item label="Upstream drift"><StatusTag label={status.data.upstreamDrift.status} /></Descriptions.Item>
                  <Descriptions.Item label="Audit persistence"><StatusTag label={status.data.auditPersistence.status} /> ({status.data.auditPersistence.failureCount} observed failure(s))</Descriptions.Item>
                </Descriptions>
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card title="Database and credential readiness" className="surface-card full-height">
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="Database"><StatusTag label={status.data.database.status} /></Descriptions.Item>
                  <Descriptions.Item label="Database version">{status.data.database.version ?? 'Unavailable'}</Descriptions.Item>
                  <Descriptions.Item label="Schema versions">{status.data.database.schemaVersions.length ? status.data.database.schemaVersions.join(', ') : 'None reported'}</Descriptions.Item>
                  <Descriptions.Item label="Connected App configured"><Configured configured={status.data.configured.connectedApp} /></Descriptions.Item>
                  <Descriptions.Item label="JWT key configured"><Configured configured={status.data.configured.jwtPrivateKey} /></Descriptions.Item>
                  <Descriptions.Item label="MCP client token configured"><Configured configured={status.data.configured.mcpClientToken} /></Descriptions.Item>
                  <Descriptions.Item label="Diagnostic status"><StatusTag label={status.data.diagnostic?.verificationStatus ?? 'NOT_CONFIGURED'} /></Descriptions.Item>
                </Descriptions>
                <Typography.Paragraph type="secondary" className="credential-note">
                  Secret values, JWT material, key paths, database passwords, and authorization headers are never returned by this API.
                </Typography.Paragraph>
              </Card>
            </Col>
          </Row>

          <Card title="Phase status" className="surface-card">
            <div className="phase-grid">
              {Object.entries(status.data.phases).map(([phase, value]) => (
                <div className="phase-item" key={phase}><strong>{phase}</strong><StatusTag label={value} /></div>
              ))}
            </div>
          </Card>

          <Card title="Provider inventory" className="surface-card">
            <Table
              rowKey="name"
              pagination={false}
              dataSource={[...status.data.providerVersions]}
              columns={[
                { title: 'Provider', dataIndex: 'name' },
                { title: 'Version', dataIndex: 'version', render: (value: string) => <code>{value}</code> },
              ]}
            />
          </Card>

          <Card title="Editable non-secret settings" className="surface-card">
            {settings.isPending ? <LoadingState rows={2} /> : settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : (
              <List
                dataSource={[...settings.data]}
                renderItem={(record) => (
                  <List.Item actions={[<Button key="edit" icon={<EditOutlined />} onClick={() => openEdit(record)}>Edit</Button>]}> 
                    <List.Item.Meta title={SETTING_LABELS[record.settingKey].title} description={SETTING_LABELS[record.settingKey].description} />
                    <Typography.Text strong>{String(record.settingValue)}</Typography.Text>
                  </List.Item>
                )}
              />
            )}
          </Card>

          <Card title="Read-only environment settings" className="surface-card">
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
        title={editing ? `Edit ${SETTING_LABELS[editing.settingKey].title}` : 'Edit setting'}
        okText="Save setting"
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
  if (value === null) return 'Not configured';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
