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
      void message.success('DML 操作策略已保存，新 MCP 请求将使用最新快照。');
    },
  });
  const disable = useMutation({
    mutationFn: (record: DmlPolicyRecord) => adminApi.disableDmlPolicy(record.id, record.rowVersion),
    onSuccess: async () => {
      await invalidatePolicies(queryClient);
      void message.success('DML 操作策略已停用。');
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
      void message.success('DML 操作策略已启用。');
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
      title="DML 操作策略"
      description="为两种已支持的 DML 操作提供默认拒绝的对象允许列表。Salesforce 仍是 CRUD、FLS、Sharing、Validation Rule、Flow 与 Trigger 行为的权威来源。"
      action={<Button type="primary" aria-label="添加对象策略" icon={<PlusOutlined />} onClick={openCreate}>添加对象策略</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <MutationError error={mutationError} />
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.items.length === 0 ? (
              <EmptyState description="尚未配置对象策略；所有 DML 均被拒绝。" action={<Button onClick={openCreate}>添加第一条策略</Button>} />
            ) : (
              <Table<DmlPolicyRecord>
                rowKey="id"
                pagination={false}
                dataSource={[...query.data.items]}
                scroll={{ x: 860 }}
                columns={[
                  { title: '对象 API 名称', dataIndex: 'objectApiName', render: (value: string) => <code>{value}</code> },
                  { title: 'CREATE', dataIndex: 'allowCreate', render: (value: boolean) => <StatusTag label={value ? 'ALLOWED' : 'DENIED'} tone={value ? 'success' : 'neutral'} /> },
                  { title: 'UPDATE', dataIndex: 'allowUpdate', render: (value: boolean) => <StatusTag label={value ? 'ALLOWED' : 'DENIED'} tone={value ? 'success' : 'neutral'} /> },
                  { title: '状态', dataIndex: 'enabled', render: (value: boolean) => <StatusTag label={value ? 'ENABLED' : 'DISABLED'} /> },
                  { title: '备注', dataIndex: 'remark', render: (value: string | null) => value ?? '—' },
                  {
                    title: '操作', width: 240,
                    render: (_value, record) => (
                      <Space wrap>
                        <Button icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
                        {record.enabled ? (
                          <Popconfirm title="停用该策略？" description="该对象的新请求将被拒绝。" onConfirm={() => disable.mutate(record)}>
                            <Button danger icon={<StopOutlined />}>停用</Button>
                          </Popconfirm>
                        ) : (
                          <Button icon={<CheckCircleOutlined />} loading={enable.isPending} onClick={() => enable.mutate(record)}>启用</Button>
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
        title={editing === 'create' ? '添加对象策略' : '编辑对象策略'}
        okText="保存策略"
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
            label="对象 API 名称"
            extra="仅作为数据存储，永不插值为 SQL 标识符。"
            rules={[
              { required: true, whitespace: true, message: '请输入对象 API 名称。' },
              { pattern: /^[A-Za-z][A-Za-z0-9_]{0,127}$/u, message: '请使用有效的 Salesforce 对象 API 名称。' },
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
                    throw new Error('启用策略前，请允许 CREATE、UPDATE 或两者。');
                  },
                }),
              ]}
            ><Switch /></Form.Item>
            <Form.Item name="allowUpdate" label="UPDATE" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="enabled" label="策略状态" valuePropName="checked"><Switch checkedChildren="已启用" unCheckedChildren="已停用" /></Form.Item>
          </Space>
          <Form.Item name="remark" label="备注" rules={[{ max: 512 }]}><Input.TextArea rows={3} maxLength={512} showCount /></Form.Item>
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
