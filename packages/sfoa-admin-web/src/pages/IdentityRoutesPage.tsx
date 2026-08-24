import { CheckCircleOutlined, EditOutlined, PlusOutlined, SafetyCertificateOutlined, StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Descriptions, Form, Input, Modal, Pagination, Popconfirm, Space, Switch, Table, Tooltip } from 'antd';
import { useState } from 'react';
import type { IdentityRouteRecord, RouteVerificationDto } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';
import { formatDateTime } from '../localization.js';

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
      void message.success('用户身份路由已保存，新 MCP 请求将加载最新路由。');
    },
  });
  const disable = useMutation({
    mutationFn: (record: IdentityRouteRecord) => adminApi.disableRoute(record.id, record.rowVersion),
    onSuccess: async () => {
      await invalidateRoutes(queryClient);
      void message.success('用户身份路由已停用。');
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
      void message.success('用户身份路由已启用。');
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
      title="用户身份路由"
      description="将已认证的平台用户映射到服务端管理的 Salesforce JWT 身份。多个平台用户可以有意共用同一个 Salesforce Username。"
      action={<Button type="primary" aria-label="新建路由" icon={<PlusOutlined />} onClick={openCreate}>新建路由</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <MutationError error={mutationError} />
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.items.length === 0 ? <EmptyState description="尚未配置用户身份路由。" action={<Button onClick={openCreate}>新建第一条路由</Button>} /> : (
              <Table<IdentityRouteRecord>
                rowKey="id"
                pagination={false}
                dataSource={[...query.data.items]}
                scroll={{ x: 980 }}
                columns={[
                  { title: '平台用户', dataIndex: 'platformUserId', render: (value: string) => <code>{value}</code> },
                  { title: 'Salesforce Username', dataIndex: 'salesforceUsername', render: (value: string) => <span className="wrap-value">{value}</span> },
                  { title: '状态', dataIndex: 'enabled', render: (value: boolean) => <StatusTag label={value ? 'ENABLED' : 'DISABLED'} /> },
                  { title: '最后更新', dataIndex: 'updatedAt', render: formatDateTime },
                  { title: '备注', dataIndex: 'remark', render: (value: string | null) => value ?? '—' },
                  {
                    title: '操作', fixed: 'right', width: 310,
                    render: (_value, record) => (
                      <Space wrap>
                        <Button aria-label="编辑" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
                        <Button
                          icon={<SafetyCertificateOutlined />}
                          loading={verify.isPending && verify.variables?.id === record.id}
                          onClick={() => verify.mutate(record)}
                        >验证</Button>
                        {record.enabled ? (
                          <Popconfirm
                            title="停用该路由？"
                            description="该平台用户的新 MCP 请求将被拒绝。"
                            onConfirm={() => disable.mutate(record)}
                          >
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
        title={editing === 'create' ? '新建用户身份路由' : '编辑用户身份路由'}
        okText="保存路由"
        confirmLoading={save.isPending}
        onCancel={() => { setEditing(null); save.reset(); }}
        onOk={() => void form.submit()}
        destroyOnHidden
      >
        <Form<RouteForm> form={form} layout="vertical" onFinish={(values) => save.mutate({ ...values, remark: values.remark || null })}>
          <Form.Item
            name="platformUserId"
            label="平台用户 ID"
            extra="唯一的已认证平台身份；永不作为 Tool 参数传入。"
            rules={[{ required: true, whitespace: true, message: '请输入平台用户 ID。' }, { max: 128 }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="salesforceUsername"
            label="Salesforce Username"
            extra="可由多个平台用户共用，但必须与已启用的 Diagnostic Username 不同。"
            rules={[{ required: true, whitespace: true, message: '请输入 Salesforce Username。' }, { type: 'email', message: '请使用完整的 Salesforce Username。' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="enabled" label="路由状态" valuePropName="checked"><Switch checkedChildren="已启用" unCheckedChildren="已停用" /></Form.Item>
          <Form.Item name="remark" label="备注" rules={[{ max: 512 }]}><Input.TextArea rows={3} showCount maxLength={512} /></Form.Item>
        </Form>
      </Modal>

      <Modal open={verification !== null} title="路由验证" footer={<Button onClick={() => setVerification(null)}>关闭</Button>} onCancel={() => setVerification(null)}>
        {verification ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="认证"><StatusTag label={verification.status} /></Descriptions.Item>
            <Descriptions.Item label="身份匹配">{verification.identityMatched ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="Salesforce Username">{verification.salesforceUsername ?? '未返回'}</Descriptions.Item>
            <Descriptions.Item label="耗时">{verification.durationMs} ms</Descriptions.Item>
            {verification.error ? <Descriptions.Item label="安全错误"><Tooltip title={`Error Code：${verification.error.code}`}>{verification.error.message}</Tooltip></Descriptions.Item> : null}
          </Descriptions>
        ) : null}
      </Modal>
    </PageFrame>
  );
}

async function invalidateRoutes(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['routes'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ]);
}
