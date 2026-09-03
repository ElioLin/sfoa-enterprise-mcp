import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  KeyOutlined,
  PlusOutlined,
  ProfileOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Form,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import type {
  AdminIdentityCredentialResponse,
  AdminIdentityRouteDto,
  RouteVerificationDto,
  RuntimeSettingRecord,
} from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';
import { formatDateTime } from '../localization.js';
import { copyTextToClipboard } from '../clipboard.js';
import BatchAddIdentityRoutesModal from './identity-routes/BatchAddIdentityRoutesModal.js';

const FALLBACK_PAGE_SIZE = 25;
type RouteForm = Readonly<{ userName: string; platformUserId: string; salesforceUsername: string; enabled: boolean; remark: string | null }>;
type SaveTarget = Readonly<{ payload: RouteForm; editingRouteId: string | null; autoVerifyNow: boolean }>;

export default function IdentityRoutesPage() {
  const [page, setPage] = useState(1);
  const [pageSizeOverride, setPageSizeOverride] = useState<number>();
  const [searchInput, setSearchInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [editing, setEditing] = useState<AdminIdentityRouteDto | 'create' | null>(null);
  const [credentialRouteId, setCredentialRouteId] = useState<string | null>(null);
  const [verification, setVerification] = useState<RouteVerificationDto | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [verifyAfterDrawerRouteId, setVerifyAfterDrawerRouteId] = useState<string | null>(null);
  const [form] = Form.useForm<RouteForm>();
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();
  const settings = useQuery({ queryKey: ['runtime-settings'], queryFn: adminApi.runtimeSettings });
  const pageSize = pageSizeOverride ?? defaultPageSize(settings.data);
  const offset = (page - 1) * pageSize;
  const query = useQuery({
    queryKey: ['routes', pageSize, offset, keyword],
    queryFn: () => adminApi.routes(pageSize, offset, keyword || undefined),
  });
  const credentialQuery = useQuery({
    queryKey: ['route-credential', credentialRouteId],
    queryFn: () => credentialRouteId
      ? adminApi.routeCredential(credentialRouteId)
      : Promise.reject(new Error('未选择用户身份路由。')),
    enabled: credentialRouteId !== null,
  });

  useEffect(() => {
    if (!query.data) return;
    const lastPage = Math.max(1, Math.ceil(query.data.total / pageSize));
    if (page > lastPage) setPage(lastPage);
  }, [page, pageSize, query.data]);

  const autoVerify = useMutation({
    mutationFn: (routeId: string) => adminApi.verifyRoute(routeId),
    onSuccess: setVerification,
  });

  const save = useMutation({
    mutationFn: async (target: SaveTarget) => editing === 'create'
      ? adminApi.createRoute(target.payload)
      : editing
        ? adminApi.updateRoute(editing.id, { ...target.payload, rowVersion: editing.rowVersion })
        : Promise.reject(new Error('未选择用户身份路由。')),
    onSuccess: async (result, target) => {
      await invalidateRoutes(queryClient);
      setEditing(null);
      form.resetFields();
      if ('mcpEndpoint' in result) {
        setSearchInput('');
        setKeyword('');
        setPage(1);
        queryClient.setQueryData(['route-credential', result.route.id], result);
        setCredentialRouteId(result.route.id);
        void message.success('路由创建成功，并已生成 MCP 用户凭证。');
        // Auto-verify Salesforce connectivity once the credential drawer is
        // closed so the verification result never overlays the token-copy path.
        setVerifyAfterDrawerRouteId(result.route.id);
      } else {
        void message.success('用户身份路由已保存，新 MCP 请求将加载最新路由。');
        if (target.autoVerifyNow && target.editingRouteId) autoVerify.mutate(target.editingRouteId);
      }
    },
  });
  const disable = useMutation({
    mutationFn: (record: AdminIdentityRouteDto) => adminApi.disableRoute(record.id, record.rowVersion),
    onSuccess: async () => {
      await invalidateRoutes(queryClient);
      await refreshOpenCredential(queryClient, credentialRouteId);
      void message.success('用户身份路由已停用，USER_BOUND Token 已立即不可用。');
    },
  });
  const enable = useMutation({
    mutationFn: (record: AdminIdentityRouteDto) => adminApi.updateRoute(record.id, {
      platformUserId: record.platformUserId,
      userName: record.userName,
      salesforceUsername: record.salesforceUsername,
      enabled: true,
      remark: record.remark,
      rowVersion: record.rowVersion,
    }),
    onSuccess: async () => {
      await invalidateRoutes(queryClient);
      await refreshOpenCredential(queryClient, credentialRouteId);
      void message.success('用户身份路由已启用，原 USER_BOUND Token 已恢复可用。');
    },
  });
  const remove = useMutation({
    mutationFn: (record: AdminIdentityRouteDto) => adminApi.deleteRoute(record.id, record.rowVersion),
    onSuccess: async () => {
      const remainingTotal = Math.max(0, (query.data?.total ?? 1) - 1);
      const lastPage = Math.max(1, Math.ceil(remainingTotal / pageSize));
      if (page > lastPage) setPage(lastPage);
      setCredentialRouteId(null);
      await invalidateRoutes(queryClient);
      void message.success('已永久删除用户身份路由，对应 MCP Token 已失效。');
    },
  });
  const verify = useMutation({
    mutationFn: (record: AdminIdentityRouteDto) => adminApi.verifyRoute(record.id),
    onSuccess: setVerification,
  });
  const regenerate = useMutation({
    mutationFn: (access: AdminIdentityCredentialResponse) => adminApi.regenerateRouteCredential(access.route.id, {
      credentialId: access.credential?.id ?? null,
      credentialRowVersion: access.credential?.rowVersion ?? null,
      routeRowVersion: access.route.rowVersion,
    }),
    onSuccess: async (result) => {
      queryClient.setQueryData(['route-credential', result.route.id], result);
      await invalidateRoutes(queryClient);
      void message.success('已生成新 Token，旧 Token 已立即永久失效。');
    },
  });
  const mutationError = save.error ?? disable.error ?? enable.error ?? remove.error ?? verify.error ?? regenerate.error;

  const openCreate = (): void => {
    form.setFieldsValue({ userName: '', platformUserId: '', salesforceUsername: '', enabled: true, remark: null });
    setEditing('create');
  };
  const openEdit = (record: AdminIdentityRouteDto): void => {
    form.setFieldsValue({
      userName: record.userName,
      platformUserId: record.platformUserId,
      salesforceUsername: record.salesforceUsername,
      enabled: record.enabled,
      remark: record.remark,
    });
    setEditing(record);
  };
  const applySearch = (): void => {
    setKeyword(searchInput.trim());
    setPage(1);
  };
  const resetSearch = (): void => {
    setSearchInput('');
    setKeyword('');
    setPage(1);
  };
  const copyText = async (value: string, success: string): Promise<void> => {
    try {
      await copyTextToClipboard(value);
      void message.success(success);
    } catch {
      void message.error('复制失败，请检查浏览器剪贴板权限后重试。');
    }
  };
  const confirmDisable = (record: AdminIdentityRouteDto): void => {
    modal.confirm({
      title: '停用用户身份路由？',
      content: (
        <ul className="guidance-list route-confirm-list">
          <li>当前平台用户的新 MCP 请求将被拒绝。</li>
          <li>USER_BOUND Token 将立即不可使用。</li>
          <li>不影响其他用户身份路由。</li>
        </ul>
      ),
      okText: '停用路由',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => disable.mutateAsync(record),
    });
  };
  const confirmDelete = (record: AdminIdentityRouteDto): void => {
    modal.confirm({
      title: '删除用户身份路由？',
      content: (
        <Space orientation="vertical" size="small" className="full-width">
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="平台用户">{record.platformUserId}</Descriptions.Item>
            <Descriptions.Item label="Salesforce Username">{record.salesforceUsername}</Descriptions.Item>
          </Descriptions>
          <ul className="guidance-list route-confirm-list">
            <li>该路由将从系统中永久移除。</li>
            <li>对应 MCP Token 将永久失效。</li>
            <li>WorkBuddy Connector 将无法继续使用该凭证。</li>
            <li>调用审计不会被删除。</li>
          </ul>
          <Typography.Text type="danger" strong>此操作不可撤销。</Typography.Text>
        </Space>
      ),
      okText: '永久删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => remove.mutateAsync(record),
    });
  };

  return (
    <PageFrame
      title="用户身份路由"
      description="将平台用户映射到 Salesforce 身份，并管理用户专属 MCP 接入凭证。"
      action={
        <Space wrap>
          <Button type="primary" aria-label="新建身份路由" icon={<PlusOutlined />} onClick={openCreate}>新建身份路由</Button>
          <Button aria-label="批量添加身份路由" icon={<ProfileOutlined />} onClick={() => setBatchOpen(true)}>批量添加</Button>
        </Space>
      }
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <MutationError error={mutationError} />
        <div className="surface-card route-search-card" role="search" aria-label="搜索用户身份路由">
          <Input
            value={searchInput}
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索用户名称 / 平台用户 / Salesforce Username / 备注"
            aria-label="搜索用户名称 / 平台用户 / Salesforce Username / 备注"
            onChange={(event) => setSearchInput(event.target.value)}
            onPressEnter={applySearch}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={applySearch}>搜索</Button>
          <Button onClick={resetSearch}>重置</Button>
        </div>

        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.items.length === 0 ? (
              <EmptyState
                description={keyword ? '没有找到匹配的用户身份路由。' : '尚未配置用户身份路由。'}
                action={keyword ? <Button onClick={resetSearch}>清除搜索条件</Button> : <Button onClick={openCreate}>新建第一条路由</Button>}
              />
            ) : (
              <Table<AdminIdentityRouteDto>
                rowKey="id"
                pagination={false}
                dataSource={[...query.data.items]}
                scroll={{ x: 1860 }}
                columns={[
                  {
                    title: '用户名称', dataIndex: 'userName', width: 180,
                    render: (value: string) => <Typography.Text strong>{value}</Typography.Text>,
                  },
                  {
                    title: '平台用户', dataIndex: 'platformUserId', width: 190,
                    render: (value: string) => <CopyableValue value={value} label="平台用户 ID" onCopy={copyText} code />,
                  },
                  {
                    title: 'Salesforce Username', dataIndex: 'salesforceUsername', width: 270,
                    render: (value: string) => <CopyableValue value={value} label="Salesforce Username" onCopy={copyText} />,
                  },
                  {
                    title: '备注', dataIndex: 'remark', width: 220, ellipsis: true,
                    render: (value: string | null) => value || <Typography.Text type="secondary">—</Typography.Text>,
                  },
                  {
                    title: '路由状态', dataIndex: 'enabled', width: 110,
                    render: (value: boolean) => <StatusTag label={value ? 'ENABLED' : 'DISABLED'} />,
                  },
                  {
                    title: 'MCP 凭证', width: 190,
                    render: (_value, record) => <CredentialStatus record={record} />,
                  },
                  {
                    title: '最后使用', width: 170,
                    render: (_value, record) => record.credential?.lastUsedAt ? formatDateTime(record.credential.lastUsedAt) : '尚未使用',
                  },
                  { title: '最后更新', dataIndex: 'updatedAt', width: 170, render: formatDateTime },
                  {
                    title: '操作', fixed: 'right', width: 340,
                    render: (_value, record) => (
                      <Space size="small">
                        <Button type="primary" ghost icon={<KeyOutlined />} onClick={() => setCredentialRouteId(record.id)}>接入配置</Button>
                        <Button aria-label={`编辑 ${record.platformUserId}`} icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
                        <Button
                          aria-label={`验证 ${record.platformUserId}`}
                          icon={<SafetyCertificateOutlined />}
                          loading={verify.isPending && verify.variables?.id === record.id}
                          onClick={() => verify.mutate(record)}
                        >验证</Button>
                        <Dropdown
                          trigger={['click']}
                          menu={{
                            items: record.enabled
                              ? [{ key: 'disable', icon: <StopOutlined />, label: '停用路由' }]
                              : [
                                  { key: 'enable', icon: <CheckCircleOutlined />, label: '启用路由' },
                                  { type: 'divider' },
                                  { key: 'delete', icon: <DeleteOutlined />, label: '删除路由', danger: true },
                                ],
                            onClick: ({ key }) => {
                              if (key === 'disable') confirmDisable(record);
                              if (key === 'enable') enable.mutate(record);
                              if (key === 'delete') confirmDelete(record);
                            },
                          }}
                        >
                          <Tooltip title="更多操作">
                            <Button aria-label={`更多操作 ${record.platformUserId}`} icon={<EllipsisOutlined />} />
                          </Tooltip>
                        </Dropdown>
                      </Space>
                    ),
                  },
                ]}
              />
            )}
            <Pagination
              className="table-pagination"
              current={page}
              pageSize={pageSize}
              total={query.data.total}
              showSizeChanger
              pageSizeOptions={pageSizeOptions(pageSize)}
              showTotal={(total, range) => `第 ${range[0]}–${range[1]} 条，共 ${total} 条`}
              hideOnSinglePage={false}
              onChange={(nextPage, nextPageSize) => {
                if (nextPageSize !== pageSize) {
                  setPageSizeOverride(nextPageSize);
                  setPage(1);
                } else {
                  setPage(nextPage);
                }
              }}
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
        <Form<RouteForm> form={form} layout="vertical" onFinish={(values) => {
          const payload: RouteForm = { ...values, remark: values.remark || null };
          if (editing === 'create') {
            save.mutate({ payload, editingRouteId: null, autoVerifyNow: false });
            return;
          }
          if (editing) {
            save.mutate({
              payload,
              editingRouteId: editing.id,
              autoVerifyNow: editing.salesforceUsername !== (values.salesforceUsername ?? '').trim(),
            });
          }
        }}>
          {editing === 'create' ? (
            <Alert className="route-form-notice" type="info" showIcon title="保存后系统会自动为该平台用户生成专属 MCP 接入 Token；关闭接入配置抽屉后会自动验证该路由与 Salesforce 的连通性。" />
          ) : null}
          <Form.Item
            name="userName"
            label="用户名称"
            extra="该平台用户的人类可读名称（如真实姓名）；区别于平台用户 ID。"
            rules={[{ required: true, whitespace: true, message: '请输入用户名称。' }, { max: 128 }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
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

      <Drawer
        open={credentialRouteId !== null}
        title="MCP 接入配置"
        size="large"
        destroyOnHidden
        onClose={() => setCredentialRouteId(null)}
        afterOpenChange={(open) => {
          if (open || !verifyAfterDrawerRouteId) return;
          const routeId = verifyAfterDrawerRouteId;
          setVerifyAfterDrawerRouteId(null);
          autoVerify.mutate(routeId);
        }}
        extra={<Tooltip title="刷新当前凭据"><Button aria-label="刷新当前凭据" icon={<ReloadOutlined />} loading={credentialQuery.isFetching} onClick={() => void credentialQuery.refetch()} /></Tooltip>}
      >
        {credentialQuery.isPending ? <LoadingState rows={5} /> : credentialQuery.isError ? (
          <ErrorState error={credentialQuery.error} onRetry={() => void credentialQuery.refetch()} />
        ) : (
          <CredentialDrawer
            access={credentialQuery.data}
            regenerating={regenerate.isPending}
            onCopy={copyText}
            onRegenerate={() => regenerate.mutate(credentialQuery.data)}
          />
        )}
      </Drawer>

      <Modal open={verification !== null} title="路由验证结果" footer={<Button onClick={() => setVerification(null)}>关闭</Button>} onCancel={() => setVerification(null)}>
        {verification ? (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="验证状态"><StatusTag label={verification.status} /></Descriptions.Item>
            <Descriptions.Item label="身份一致">{verification.identityMatched ? '是' : '否'}</Descriptions.Item>
            <Descriptions.Item label="Salesforce Username">{verification.salesforceUsername ?? '未返回'}</Descriptions.Item>
            <Descriptions.Item label="耗时">{verification.durationMs} ms</Descriptions.Item>
            <Descriptions.Item label="Correlation ID"><code>{verification.correlationId}</code></Descriptions.Item>
            {verification.error ? (
              <Descriptions.Item label="安全错误">
                <Space orientation="vertical" size={2}>
                  <Typography.Text>{verification.error.message}</Typography.Text>
                  <Typography.Text type="secondary"><code>{verification.error.code}</code></Typography.Text>
                </Space>
              </Descriptions.Item>
            ) : null}
          </Descriptions>
        ) : null}
      </Modal>
      <BatchAddIdentityRoutesModal
        open={batchOpen}
        existingRoutes={query.data?.items ?? []}
        onCommitted={() => void invalidateRoutes(queryClient)}
        onEditRoute={(route) => { setBatchOpen(false); openEdit(route); }}
        onClose={() => setBatchOpen(false)}
      />
    </PageFrame>
  );
}

function CredentialDrawer({
  access,
  regenerating,
  onCopy,
  onRegenerate,
}: Readonly<{
  access: AdminIdentityCredentialResponse;
  regenerating: boolean;
  onCopy(value: string, success: string): Promise<void>;
  onRegenerate(): void;
}>) {
  const { route, credential, mcpEndpoint } = access;
  return (
    <Space orientation="vertical" size="middle" className="full-width credential-drawer">
      <Descriptions column={1} bordered size="small">
        <Descriptions.Item label="平台用户"><code>{route.platformUserId}</code></Descriptions.Item>
        <Descriptions.Item label="Salesforce Username"><span className="wrap-value">{route.salesforceUsername}</span></Descriptions.Item>
        <Descriptions.Item label="路由状态"><StatusTag label={route.enabled ? 'ENABLED' : 'DISABLED'} /></Descriptions.Item>
        <Descriptions.Item label="凭证状态"><CredentialStatus record={{ ...route, credential: credential ? {
          id: credential.id,
          status: credential.status,
          tokenLast4: credential.tokenLast4,
          generatedAt: credential.generatedAt,
          lastUsedAt: credential.lastUsedAt,
          rowVersion: credential.rowVersion,
        } : null }} /></Descriptions.Item>
        <Descriptions.Item label="最后使用">{credential?.lastUsedAt ? formatDateTime(credential.lastUsedAt) : '尚未使用'}</Descriptions.Item>
        <Descriptions.Item label="备注">{route.remark ?? '—'}</Descriptions.Item>
      </Descriptions>

      {!credential ? <Alert type="warning" showIcon title="当前路由没有有效的 USER_BOUND 凭证，可通过重新生成创建新凭证。" /> : (
        <>
          <Divider titlePlacement="start">MCP 用户凭证</Divider>
          <CredentialField label="Token" value={credential.token} buttonLabel="复制 Token" onCopy={() => onCopy(credential.token, 'Token 已复制')} />
          <CredentialField label="Authorization" value={credential.authorization} buttonLabel="复制 Authorization" onCopy={() => onCopy(credential.authorization, 'Authorization 已复制')} />
        </>
      )}

      <Divider titlePlacement="start">MCP 接入地址</Divider>
      {mcpEndpoint.warning ? <Alert type="warning" showIcon title={mcpEndpoint.warning} /> : null}
      <CredentialField
        label="MCP URL"
        value={mcpEndpoint.url ?? '未配置 MCP_PUBLIC_URL'}
        buttonLabel="复制 MCP URL"
        disabled={!mcpEndpoint.url}
        onCopy={() => mcpEndpoint.url ? onCopy(mcpEndpoint.url, 'MCP 接入地址已复制') : Promise.resolve()}
      />

      {credential?.workBuddyJson ? (
        <>
          <Divider titlePlacement="start">WorkBuddy MCP JSON</Divider>
          <pre className="json-summary credential-json">{credential.workBuddyJson}</pre>
          <Button
            icon={<CopyOutlined />}
            onClick={() => onCopy(credential.workBuddyJson ?? '', 'WorkBuddy MCP 配置已复制，可直接粘贴到自定义连接器。')}
          >复制 WorkBuddy MCP JSON</Button>
        </>
      ) : null}

      <Divider />
      {credential ? (
        <Popconfirm
          title="重新生成 Token？"
          description={<span>重新生成后，当前 Token 将立即失效。使用旧 Token 的 WorkBuddy Connector 需要替换为新 Token 或 MCP JSON。</span>}
          okText="确定重新生成"
          cancelText="取消"
          onConfirm={onRegenerate}
        >
          <Button icon={<ReloadOutlined />} loading={regenerating}>重新生成 Token</Button>
        </Popconfirm>
      ) : (
        <Popconfirm
          title="生成 Token？"
          description={<span>将为当前路由生成新的 USER_BOUND 凭证，生成后可复制 Token 与 WorkBuddy MCP JSON。</span>}
          okText="确定生成"
          cancelText="取消"
          onConfirm={onRegenerate}
        >
          <Button icon={<ReloadOutlined />} loading={regenerating}>生成 Token</Button>
        </Popconfirm>
      )}
    </Space>
  );
}

function CredentialField({
  label,
  value,
  buttonLabel,
  disabled = false,
  onCopy,
}: Readonly<{ label: string; value: string; buttonLabel: string; disabled?: boolean; onCopy(): Promise<void> }>) {
  return (
    <div className="credential-field">
      <Typography.Text strong>{label}</Typography.Text>
      <Input.TextArea value={value} readOnly autoSize={{ minRows: 1, maxRows: 4 }} aria-label={label} />
      <Button icon={<CopyOutlined />} disabled={disabled} onClick={() => void onCopy()}>{buttonLabel}</Button>
    </div>
  );
}

function CredentialStatus({ record }: Readonly<{ record: AdminIdentityRouteDto }>) {
  if (!record.credential) return <Tag>已失效</Tag>;
  if (!record.enabled) return <Tag color="warning">路由停用 · 暂不可用</Tag>;
  return <Tag color="success">有效 · 尾号 {record.credential.tokenLast4}</Tag>;
}

function CopyableValue({
  value,
  label,
  code = false,
  onCopy,
}: Readonly<{
  value: string;
  label: string;
  code?: boolean;
  onCopy(value: string, success: string): Promise<void>;
}>) {
  return (
    <Space size={4}>
      {code ? <code>{value}</code> : <span className="wrap-value">{value}</span>}
      <Tooltip title={`复制${label}`}>
        <Button
          type="text"
          size="small"
          aria-label={`复制${label} ${value}`}
          icon={<CopyOutlined />}
          onClick={() => void onCopy(value, `${label}已复制`)}
        />
      </Tooltip>
    </Space>
  );
}

function defaultPageSize(settings: readonly RuntimeSettingRecord[] | undefined): number {
  if (!Array.isArray(settings)) return FALLBACK_PAGE_SIZE;
  const value = settings?.find((setting) => setting.settingKey === 'adminDefaultPageSize')?.settingValue;
  return typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 100
    ? value
    : FALLBACK_PAGE_SIZE;
}

function pageSizeOptions(current: number): number[] {
  return [...new Set([20, 50, 100, current])].sort((left, right) => left - right);
}

async function invalidateRoutes(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['routes'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ]);
}

async function refreshOpenCredential(
  queryClient: ReturnType<typeof useQueryClient>,
  identityRouteId: string | null,
): Promise<void> {
  if (identityRouteId) await queryClient.invalidateQueries({ queryKey: ['route-credential', identityRouteId] });
}
