import { CheckCircleOutlined, EditOutlined, PlusOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Descriptions, Form, Input, Modal, Pagination, Popconfirm, Space, Switch, Table, Tooltip } from 'antd';
import { useState } from 'react';
import type { IdentityRouteRecord, RouteVerificationDto } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

const PAGE_SIZE = 25;
type RouteForm = Readonly<{ platformUserId: string; salesforceUsername: string; enabled: boolean; remark: string | null }>;

export default function IdentityRoutesPage() {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<IdentityRouteRecord | 'create' | null>(null);
  const [verification, setVerification] = useState<RouteVerificationDto | null>(null);
  const [form] = Form.useForm<RouteForm>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ['routes', PAGE_SIZE, offset],
    queryFn: () => adminApi.routes(PAGE_SIZE, offset),
  });
  const save = useMutation({
    mutationFn: async (values: RouteForm) => editing === 'create'
      ? adminApi.createRoute(values)
      : editing ? adminApi.updateRoute(editing.id, { ...values, rowVersion: editing.rowVersion }) : Promise.reject(new Error('No route selected.')),
    onSuccess: async () => {
      await invalidateRoutes(queryClient);
      setEditing(null);
      form.resetFields();
      void message.success('Identity route saved. New MCP requests will load the latest route.');
    },
  });
  const disable = useMutation({
    mutationFn: (record: IdentityRouteRecord) => adminApi.disableRoute(record.id, record.rowVersion),
    onSuccess: async () => {
      await invalidateRoutes(queryClient);
      void message.success('Identity route disabled.');
    },
  });
  const enable = useMutation({
    mutationFn: (record: IdentityRouteRecord) => adminApi.updateRoute(record.id, {
      platformUserId: record.platformUserId,
      salesforceUsername: record.salesforceUsername,
      enabled: true,
      remark: record.remark,
      rowVersion: record.rowVersion,
    }),
    onSuccess: async () => {
      await invalidateRoutes(queryClient);
      void message.success('Identity route enabled.');
    },
  });
  const verify = useMutation({
    mutationFn: (record: IdentityRouteRecord) => adminApi.verifyRoute(record.id),
    onSuccess: setVerification,
  });
  const mutationError = save.error ?? disable.error ?? enable.error ?? verify.error;

  const openCreate = (): void => {
    form.setFieldsValue({ platformUserId: '', salesforceUsername: '', enabled: true, remark: null });
    setEditing('create');
  };
  const openEdit = (record: IdentityRouteRecord): void => {
    form.setFieldsValue({
      platformUserId: record.platformUserId,
      salesforceUsername: record.salesforceUsername,
      enabled: record.enabled,
      remark: record.remark,
    });
    setEditing(record);
  };

  return (
    <PageFrame
      title="Identity routing"
      description="Map authenticated platform users to server-owned Salesforce JWT identities. Multiple platform users may intentionally share one Salesforce username."
      action={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Create route</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <MutationError error={mutationError} />
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.items.length === 0 ? <EmptyState description="No identity routes are configured." action={<Button onClick={openCreate}>Create the first route</Button>} /> : (
              <Table<IdentityRouteRecord>
                rowKey="id"
                pagination={false}
                dataSource={[...query.data.items]}
                scroll={{ x: 980 }}
                columns={[
                  { title: 'Platform user', dataIndex: 'platformUserId', render: (value: string) => <code>{value}</code> },
                  { title: 'Salesforce username', dataIndex: 'salesforceUsername', render: (value: string) => <span className="wrap-value">{value}</span> },
                  { title: 'Status', dataIndex: 'enabled', render: (value: boolean) => <StatusTag label={value ? 'ENABLED' : 'DISABLED'} /> },
                  { title: 'Last updated', dataIndex: 'updatedAt', render: formatDate },
                  { title: 'Remark', dataIndex: 'remark', render: (value: string | null) => value ?? '—' },
                  {
                    title: 'Actions', fixed: 'right', width: 310,
                    render: (_value, record) => (
                      <Space wrap>
                        <Button icon={<EditOutlined />} onClick={() => openEdit(record)}>Edit</Button>
                        <Button
                          icon={<SafetyCertificateOutlined />}
                          loading={verify.isPending && verify.variables?.id === record.id}
                          onClick={() => verify.mutate(record)}
                        >Verify</Button>
                        {record.enabled ? (
                          <Popconfirm
                            title="Disable this route?"
                            description="New MCP requests for this platform user will be denied."
                            onConfirm={() => disable.mutate(record)}
                          >
                            <Button danger icon={<StopOutlined />}>Disable</Button>
                          </Popconfirm>
                        ) : (
                          <Button icon={<CheckCircleOutlined />} loading={enable.isPending} onClick={() => enable.mutate(record)}>Enable</Button>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            )}
            <Pagination
              className="table-pagination"
              current={Math.floor(offset / PAGE_SIZE) + 1}
              pageSize={PAGE_SIZE}
              total={offset + query.data.count + (query.data.hasMore ? 1 : 0)}
              showSizeChanger={false}
              hideOnSinglePage={!query.data.hasMore && offset === 0}
              onChange={(page) => setOffset((page - 1) * PAGE_SIZE)}
            />
          </div>
        )}
      </Space>

      <Modal
        open={editing !== null}
        title={editing === 'create' ? 'Create identity route' : 'Edit identity route'}
        okText="Save route"
        confirmLoading={save.isPending}
        onCancel={() => { setEditing(null); save.reset(); }}
        onOk={() => void form.submit()}
        destroyOnHidden
      >
        <Form<RouteForm> form={form} layout="vertical" onFinish={(values) => save.mutate({ ...values, remark: values.remark || null })}>
          <Form.Item
            name="platformUserId"
            label="Platform user ID"
            extra="Unique authenticated platform identity; never supplied as a Tool argument."
            rules={[{ required: true, whitespace: true, message: 'Enter a platform user ID.' }, { max: 128 }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="salesforceUsername"
            label="Salesforce username"
            extra="May be shared by multiple platform users, but must differ from the enabled Diagnostic username."
            rules={[{ required: true, whitespace: true, message: 'Enter a Salesforce username.' }, { type: 'email', message: 'Use a complete Salesforce username.' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="enabled" label="Route status" valuePropName="checked"><Switch checkedChildren="Enabled" unCheckedChildren="Disabled" /></Form.Item>
          <Form.Item name="remark" label="Remark" rules={[{ max: 512 }]}><Input.TextArea rows={3} showCount maxLength={512} /></Form.Item>
        </Form>
      </Modal>

      <Modal open={verification !== null} title="Route verification" footer={<Button onClick={() => setVerification(null)}>Close</Button>} onCancel={() => setVerification(null)}>
        {verification ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="Authentication"><StatusTag label={verification.status} /></Descriptions.Item>
            <Descriptions.Item label="Identity matched">{verification.identityMatched ? 'YES' : 'NO'}</Descriptions.Item>
            <Descriptions.Item label="Salesforce username">{verification.salesforceUsername ?? 'Not returned'}</Descriptions.Item>
            <Descriptions.Item label="Duration">{verification.durationMs} ms</Descriptions.Item>
            {verification.error ? <Descriptions.Item label="Safe error"><Tooltip title={verification.error.code}>{verification.error.message}</Tooltip></Descriptions.Item> : null}
          </Descriptions>
        ) : null}
      </Modal>
    </PageFrame>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

async function invalidateRoutes(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['routes'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ]);
}
