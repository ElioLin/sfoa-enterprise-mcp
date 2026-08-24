import { CheckCircleOutlined, EditOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Form, Input, Modal, Pagination, Popconfirm, Space, Switch, Table } from 'antd';
import { useState } from 'react';
import type { DmlPolicyRecord } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

const PAGE_SIZE = 25;
type PolicyForm = Readonly<{
  objectApiName: string;
  allowCreate: boolean;
  allowUpdate: boolean;
  enabled: boolean;
  remark: string | null;
}>;

export default function DmlPoliciesPage() {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<DmlPolicyRecord | 'create' | null>(null);
  const [form] = Form.useForm<PolicyForm>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ['dml-policies', PAGE_SIZE, offset],
    queryFn: () => adminApi.dmlPolicies(PAGE_SIZE, offset),
  });
  const save = useMutation({
    mutationFn: async (values: PolicyForm) => editing === 'create'
      ? adminApi.createDmlPolicy(values)
      : editing
        ? adminApi.updateDmlPolicy(editing.id, { ...values, rowVersion: editing.rowVersion })
        : Promise.reject(new Error('No policy selected.')),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
      setEditing(null);
      form.resetFields();
      void message.success('DML policy saved. New MCP requests will use the latest snapshot.');
    },
  });
  const disable = useMutation({
    mutationFn: (record: DmlPolicyRecord) => adminApi.disableDmlPolicy(record.id, record.rowVersion),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
      void message.success('DML policy disabled.');
    },
  });
  const enable = useMutation({
    mutationFn: (record: DmlPolicyRecord) => adminApi.updateDmlPolicy(record.id, {
      objectApiName: record.objectApiName,
      allowCreate: record.allowCreate,
      allowUpdate: record.allowUpdate,
      enabled: true,
      remark: record.remark,
      rowVersion: record.rowVersion,
    }),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
      void message.success('DML policy enabled.');
    },
  });
  const mutationError = save.error ?? disable.error ?? enable.error;

  const openCreate = (): void => {
    form.setFieldsValue({ objectApiName: '', allowCreate: false, allowUpdate: false, enabled: true, remark: null });
    setEditing('create');
  };
  const openEdit = (record: DmlPolicyRecord): void => {
    form.setFieldsValue({
      objectApiName: record.objectApiName,
      allowCreate: record.allowCreate,
      allowUpdate: record.allowUpdate,
      enabled: record.enabled,
      remark: record.remark,
    });
    setEditing(record);
  };

  return (
    <PageFrame
      title="DML policies"
      description="Deny-by-default object allowlist for the two supported mutation operations. Salesforce remains authoritative for CRUD, FLS, sharing, validation, Flow, and Trigger behavior."
      action={<Button type="primary" aria-label="Add object policy" icon={<PlusOutlined />} onClick={openCreate}>Add object policy</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <MutationError error={mutationError} />
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.items.length === 0 ? (
              <EmptyState description="No object policies are configured; all DML is denied." action={<Button onClick={openCreate}>Add the first policy</Button>} />
            ) : (
              <Table<DmlPolicyRecord>
                rowKey="id"
                pagination={false}
                dataSource={[...query.data.items]}
                scroll={{ x: 860 }}
                columns={[
                  { title: 'Object API name', dataIndex: 'objectApiName', render: (value: string) => <code>{value}</code> },
                  { title: 'CREATE', dataIndex: 'allowCreate', render: (value: boolean) => <StatusTag label={value ? 'ALLOWED' : 'DENIED'} tone={value ? 'success' : 'neutral'} /> },
                  { title: 'UPDATE', dataIndex: 'allowUpdate', render: (value: boolean) => <StatusTag label={value ? 'ALLOWED' : 'DENIED'} tone={value ? 'success' : 'neutral'} /> },
                  { title: 'Status', dataIndex: 'enabled', render: (value: boolean) => <StatusTag label={value ? 'ENABLED' : 'DISABLED'} /> },
                  { title: 'Remark', dataIndex: 'remark', render: (value: string | null) => value ?? '—' },
                  {
                    title: 'Actions', width: 240,
                    render: (_value, record) => (
                      <Space wrap>
                        <Button icon={<EditOutlined />} onClick={() => openEdit(record)}>Edit</Button>
                        {record.enabled ? (
                          <Popconfirm title="Disable this policy?" description="New requests for this object will be denied." onConfirm={() => disable.mutate(record)}>
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
        title={editing === 'create' ? 'Add object policy' : 'Edit object policy'}
        okText="Save policy"
        confirmLoading={save.isPending}
        onCancel={() => { setEditing(null); save.reset(); }}
        onOk={() => void form.submit()}
        destroyOnHidden
      >
        <Form<PolicyForm>
          form={form}
          layout="vertical"
          onFinish={(values) => save.mutate({ ...values, remark: values.remark || null })}
        >
          <Form.Item
            name="objectApiName"
            label="Object API name"
            extra="Stored as data and never interpolated as a SQL identifier."
            rules={[
              { required: true, whitespace: true, message: 'Enter an object API name.' },
              { pattern: /^[A-Za-z][A-Za-z0-9_]{0,127}$/u, message: 'Use a valid Salesforce object API name.' },
            ]}
          >
            <Input autoComplete="off" disabled={editing !== 'create'} />
          </Form.Item>
          <Space size="large" wrap className="policy-toggles">
            <Form.Item
              name="allowCreate"
              label="CREATE"
              valuePropName="checked"
              dependencies={['allowUpdate', 'enabled']}
              rules={[
                ({ getFieldValue }) => ({
                  validator: async (_rule, value: boolean) => {
                    if (!getFieldValue('enabled') || value || getFieldValue('allowUpdate')) return;
                    throw new Error('Allow CREATE, UPDATE, or both before enabling this policy.');
                  },
                }),
              ]}
            ><Switch /></Form.Item>
            <Form.Item name="allowUpdate" label="UPDATE" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="enabled" label="Policy status" valuePropName="checked"><Switch checkedChildren="Enabled" unCheckedChildren="Disabled" /></Form.Item>
          </Space>
          <Form.Item name="remark" label="Remark" rules={[{ max: 512 }]}><Input.TextArea rows={3} maxLength={512} showCount /></Form.Item>
        </Form>
      </Modal>
    </PageFrame>
  );
}

async function invalidatePolicies(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['dml-policies'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ]);
}
