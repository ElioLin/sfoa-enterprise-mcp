import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import type { DmlPolicyRecord, ManagedDmlFieldRuleRecord, ManagedDmlFieldStrategy } from '@sfoa/control-plane';
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
type ManagedFieldForm = Readonly<{
  targetFieldApiName: string;
  strategy: ManagedDmlFieldStrategy;
  applyOnCreate: boolean;
  applyOnUpdate: boolean;
  lookupObjectApiName: string | null;
  lookupMatchFieldApiName: string | null;
  enabled: boolean;
  remark: string | null;
}>;

export default function DmlPoliciesPage() {
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<DmlPolicyRecord | 'create' | null>(null);
  const [managedPolicy, setManagedPolicy] = useState<DmlPolicyRecord | null>(null);
  const [editingRule, setEditingRule] = useState<ManagedDmlFieldRuleRecord | 'create' | null>(null);
  const [form] = Form.useForm<PolicyForm>();
  const [ruleForm] = Form.useForm<ManagedFieldForm>();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const query = useQuery({
    queryKey: ['dml-policies', PAGE_SIZE, offset],
    queryFn: () => adminApi.dmlPolicies(PAGE_SIZE, offset),
  });
  const managedQuery = useQuery({
    queryKey: ['managed-dml-fields', managedPolicy?.id],
    queryFn: () => adminApi.managedDmlFieldRules(managedPolicy?.id ?? ''),
    enabled: managedPolicy !== null,
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
  const saveRule = useMutation({
    mutationFn: async (values: ManagedFieldForm) => {
      if (!managedPolicy) throw new Error('No DML policy selected.');
      const normalized = values.strategy === 'AI_CREATED_MARKER'
        ? { ...values, applyOnCreate: true, applyOnUpdate: false, lookupObjectApiName: null, lookupMatchFieldApiName: null }
        : { ...values, lookupObjectApiName: values.lookupObjectApiName || null, lookupMatchFieldApiName: values.lookupMatchFieldApiName || null };
      return editingRule === 'create'
        ? adminApi.createManagedDmlFieldRule(managedPolicy.id, normalized)
        : editingRule
          ? adminApi.updateManagedDmlFieldRule(managedPolicy.id, editingRule.id, {
              ...normalized,
              rowVersion: editingRule.rowVersion,
            })
          : Promise.reject(new Error('No managed field rule selected.'));
    },
    onSuccess: async () => {
      await invalidateManagedFields(queryClient, managedPolicy?.id);
      setEditingRule(null);
      ruleForm.resetFields();
      void message.success('托管字段规则已保存；新 MCP 请求将使用最新策略快照。');
    },
  });
  const disableRule = useMutation({
    mutationFn: (record: ManagedDmlFieldRuleRecord) => {
      if (!managedPolicy) throw new Error('No DML policy selected.');
      return adminApi.disableManagedDmlFieldRule(managedPolicy.id, record.id, record.rowVersion);
    },
    onSuccess: async () => {
      await invalidateManagedFields(queryClient, managedPolicy?.id);
      void message.success('托管字段规则已停用。');
    },
  });
  const deleteRule = useMutation({
    mutationFn: (record: ManagedDmlFieldRuleRecord) => {
      if (!managedPolicy) throw new Error('No DML policy selected.');
      return adminApi.deleteManagedDmlFieldRule(managedPolicy.id, record.id, record.rowVersion);
    },
    onSuccess: async () => {
      await invalidateManagedFields(queryClient, managedPolicy?.id);
      void message.success('已永久删除停用的托管字段规则。');
    },
  });
  const mutationError = save.error ?? disable.error ?? enable.error;
  const ruleMutationError = saveRule.error ?? disableRule.error ?? deleteRule.error;

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
  const openRuleCreate = (): void => {
    if (!managedPolicy) return;
    const applyOnCreate = managedPolicy.allowCreate;
    ruleForm.setFieldsValue({
      targetFieldApiName: '',
      strategy: 'PLATFORM_USER_LOOKUP',
      applyOnCreate,
      applyOnUpdate: !applyOnCreate && managedPolicy.allowUpdate,
      lookupObjectApiName: '',
      lookupMatchFieldApiName: '',
      enabled: true,
      remark: null,
    });
    setEditingRule('create');
  };
  const openRuleEdit = (record: ManagedDmlFieldRuleRecord): void => {
    ruleForm.setFieldsValue({
      targetFieldApiName: record.targetFieldApiName,
      strategy: record.strategy,
      applyOnCreate: record.applyOnCreate,
      applyOnUpdate: record.applyOnUpdate,
      lookupObjectApiName: record.lookupObjectApiName,
      lookupMatchFieldApiName: record.lookupMatchFieldApiName,
      enabled: record.enabled,
      remark: record.remark,
    });
    setEditingRule(record);
  };

  return (
    <PageFrame
      title="DML 操作策略"
      description="为两种已支持的 DML 操作提供默认拒绝的对象允许列表。每个对象策略可配置由 MCP 从可信请求身份派生或固定写入的托管字段。"
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
                scroll={{ x: 1040 }}
                columns={[
                  { title: '对象 API 名称', dataIndex: 'objectApiName', render: (value: string) => <code>{value}</code> },
                  { title: 'CREATE', dataIndex: 'allowCreate', render: (value: boolean) => <StatusTag label={value ? 'ALLOWED' : 'DENIED'} tone={value ? 'success' : 'neutral'} /> },
                  { title: 'UPDATE', dataIndex: 'allowUpdate', render: (value: boolean) => <StatusTag label={value ? 'ALLOWED' : 'DENIED'} tone={value ? 'success' : 'neutral'} /> },
                  { title: '状态', dataIndex: 'enabled', render: (value: boolean) => <StatusTag label={value ? 'ENABLED' : 'DISABLED'} /> },
                  { title: '备注', dataIndex: 'remark', render: (value: string | null) => value ?? '—' },
                  {
                    title: '操作', width: 360,
                    render: (_value, record) => (
                      <Space wrap>
                        <ManagedFieldsButton policy={record} onOpen={() => setManagedPolicy(record)} />
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

      <PolicyModal editing={editing} form={form} saving={save.isPending} onCancel={() => { setEditing(null); save.reset(); }} onSave={(values) => save.mutate(values)} />

      <Drawer
        open={managedPolicy !== null}
        title={managedPolicy ? `${managedPolicy.objectApiName} · MCP 托管字段` : 'MCP 托管字段'}
        width="min(760px, 100vw)"
        className="managed-field-drawer"
        extra={<Button type="primary" icon={<PlusOutlined />} disabled={!managedPolicy?.allowCreate && !managedPolicy?.allowUpdate} onClick={openRuleCreate}>添加规则</Button>}
        onClose={() => { setManagedPolicy(null); setEditingRule(null); }}
        destroyOnHidden
      >
        {managedPolicy && (
          <Space orientation="vertical" size="middle" className="full-width">
            <Alert
              type="info"
              showIcon
              title="值由 MCP 管理"
              description="Agent 不应询问、推荐或提交这些字段。身份映射始终使用当前请求的可信 platformUserId 和 USER Connection；服务端托管值覆盖客户端同名字段。"
            />
            <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label="对象 API"><code>{managedPolicy.objectApiName}</code></Descriptions.Item>
              <Descriptions.Item label="托管规则">{managedQuery.data?.count ?? '加载中'}</Descriptions.Item>
              <Descriptions.Item label="允许创建">{managedPolicy.allowCreate ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="允许编辑">{managedPolicy.allowUpdate ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="可信身份值来源" span={2}>当前可信平台用户编号</Descriptions.Item>
            </Descriptions>
            <MutationError error={ruleMutationError} />
            {managedQuery.isPending ? <LoadingState rows={3} /> : managedQuery.isError ? (
              <ErrorState error={managedQuery.error} onRetry={() => void managedQuery.refetch()} />
            ) : managedQuery.data.items.length === 0 ? (
              <EmptyState description="该对象尚未配置托管字段。普通业务字段仍由 Agent 按 action context 收集。" action={<Button onClick={openRuleCreate}>添加第一条规则</Button>} />
            ) : (
              <Table<ManagedDmlFieldRuleRecord>
                rowKey="id"
                pagination={false}
                dataSource={[...managedQuery.data.items]}
                scroll={{ x: 920 }}
                columns={[
                  { title: '目标字段', dataIndex: 'targetFieldApiName', render: (value: string) => <code>{value}</code> },
                  { title: '策略', dataIndex: 'strategy', width: 170, render: (value: ManagedDmlFieldStrategy) => <Tag color={value === 'PLATFORM_USER_LOOKUP' ? 'blue' : 'geekblue'}>{strategyLabel(value)}</Tag> },
                  { title: '生效操作', width: 120, render: (_value, record) => <Space wrap size={4}>{record.applyOnCreate && <Tag>创建</Tag>}{record.applyOnUpdate && <Tag>编辑</Tag>}</Space> },
                  {
                    title: '来源摘要', width: 220,
                    render: (_value, record) => record.strategy === 'PLATFORM_USER_LOOKUP'
                      ? <code>{record.lookupObjectApiName}.{record.lookupMatchFieldApiName}</code>
                      : <span>自动写入 <code>true</code></span>,
                  },
                  { title: '状态', dataIndex: 'enabled', width: 100, render: (value: boolean) => <StatusTag label={value ? 'ENABLED' : 'DISABLED'} /> },
                  {
                    title: '操作', width: 220,
                    render: (_value, record) => <Space wrap>
                      <Button icon={<EditOutlined />} onClick={() => openRuleEdit(record)}>编辑</Button>
                      {record.enabled ? (
                        <Popconfirm title="停用该托管字段规则？" description="新请求将不再写入该字段。" onConfirm={() => disableRule.mutate(record)}>
                          <Button danger icon={<StopOutlined />}>停用</Button>
                        </Popconfirm>
                      ) : (
                        <Popconfirm title="永久删除该规则？" description="删除后，MCP 不再自动为该字段赋值。此操作不可撤销。" onConfirm={() => deleteRule.mutate(record)}>
                          <Button danger icon={<DeleteOutlined />}>删除</Button>
                        </Popconfirm>
                      )}
                    </Space>,
                  },
                ]}
              />
            )}
          </Space>
        )}
      </Drawer>

      <ManagedFieldModal
        open={editingRule !== null}
        editingRule={editingRule}
        policy={managedPolicy}
        existingRules={managedQuery.data?.items ?? []}
        form={ruleForm}
        saving={saveRule.isPending}
        onCancel={() => { setEditingRule(null); saveRule.reset(); }}
        onSave={(values) => saveRule.mutate(values)}
      />
    </PageFrame>
  );
}

function PolicyModal({
  editing,
  form,
  saving,
  onCancel,
  onSave,
}: Readonly<{
  editing: DmlPolicyRecord | 'create' | null;
  form: ReturnType<typeof Form.useForm<PolicyForm>>[0];
  saving: boolean;
  onCancel(): void;
  onSave(values: PolicyForm): void;
}>) {
  return (
    <Modal open={editing !== null} title={editing === 'create' ? '添加对象策略' : '编辑对象策略'} okText="保存策略" confirmLoading={saving} onCancel={onCancel} onOk={() => void form.submit()} destroyOnHidden>
      <Form<PolicyForm> form={form} layout="vertical" onFinish={(values) => onSave({ ...values, remark: values.remark || null })}>
        <Form.Item
          name="objectApiName"
          label="对象 API 名称"
          extra="使用 Salesforce API 标识符；对象策略是托管字段规则的唯一父级。"
          rules={[
            { required: true, whitespace: true, message: '请输入对象 API 名称。' },
            { pattern: /^[A-Za-z][A-Za-z0-9_]{0,127}$/u, message: '请使用有效的 Salesforce 对象 API 名称。' },
          ]}
        ><Input autoComplete="off" disabled={editing !== 'create'} /></Form.Item>
        <Space size="large" wrap className="policy-toggles">
          <Form.Item
            name="allowCreate"
            label="CREATE"
            valuePropName="checked"
            dependencies={['allowUpdate', 'enabled']}
            rules={[({ getFieldValue }) => ({
              validator: async (_rule, value: boolean) => {
                if (!getFieldValue('enabled') || value || getFieldValue('allowUpdate')) return;
                throw new Error('启用策略前，请允许 CREATE、UPDATE 或两者。');
              },
            })]}
          ><Switch /></Form.Item>
          <Form.Item name="allowUpdate" label="UPDATE" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="enabled" label="策略状态" valuePropName="checked"><Switch checkedChildren="已启用" unCheckedChildren="已停用" /></Form.Item>
        </Space>
        <Form.Item name="remark" label="备注" rules={[{ max: 512 }]}><Input.TextArea rows={3} maxLength={512} showCount /></Form.Item>
      </Form>
    </Modal>
  );
}

function ManagedFieldModal({
  open,
  editingRule,
  policy,
  existingRules,
  form,
  saving,
  onCancel,
  onSave,
}: Readonly<{
  open: boolean;
  editingRule: ManagedDmlFieldRuleRecord | 'create' | null;
  policy: DmlPolicyRecord | null;
  existingRules: readonly ManagedDmlFieldRuleRecord[];
  form: ReturnType<typeof Form.useForm<ManagedFieldForm>>[0];
  saving: boolean;
  onCancel(): void;
  onSave(values: ManagedFieldForm): void;
}>) {
  const strategy = Form.useWatch('strategy', form);
  return (
    <Modal open={open} title={editingRule === 'create' ? '添加 MCP 托管字段' : '编辑 MCP 托管字段'} okText="保存规则" confirmLoading={saving} onCancel={onCancel} onOk={() => void form.submit()} destroyOnHidden>
      <Alert className="margin-bottom" type="warning" showIcon title="服务端值优先" description="若 Agent 仍提交同名字段，MCP 会覆盖其值；审计仅记录字段名、策略和是否覆盖，不记录派生值。" />
      <Form<ManagedFieldForm> form={form} layout="vertical" onFinish={(values) => onSave({ ...values, remark: values.remark || null })}>
        <Form.Item
          name="targetFieldApiName"
          label="目标字段 API 名称"
          extra="同一对象策略下不可重复。"
          validateTrigger="onBlur"
          rules={[
            { required: true, whitespace: true, message: '请输入目标字段 API 名称。' },
            { pattern: /^[A-Za-z][A-Za-z0-9_]{0,127}$/u, message: '请使用有效的 Salesforce 字段 API 名称。' },
            {
              validator: async (_rule, value: string) => {
                const duplicate = existingRules.some((rule) => rule.id !== (editingRule === 'create' ? undefined : editingRule?.id)
                  && rule.targetFieldApiName.toLocaleLowerCase('en-US') === value?.trim().toLocaleLowerCase('en-US'));
                if (duplicate) throw new Error('该对象已存在同名托管字段规则。');
              },
            },
          ]}
        ><Input autoComplete="off" placeholder="Custom_Field__c" /></Form.Item>
        <Form.Item name="strategy" label="托管策略" rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'PLATFORM_USER_LOOKUP', label: '当前平台用户 Lookup' },
              { value: 'AI_CREATED_MARKER', label: 'AI 创建标记', disabled: !policy?.allowCreate },
            ]}
            onChange={(value: ManagedDmlFieldStrategy) => {
              if (value === 'AI_CREATED_MARKER') form.setFieldsValue({ applyOnCreate: true, applyOnUpdate: false, lookupObjectApiName: null, lookupMatchFieldApiName: null });
            }}
          />
        </Form.Item>
        {!policy?.allowCreate && strategy === 'AI_CREATED_MARKER' ? (
          <Alert className="margin-bottom" type="error" showIcon title="当前对象策略未启用创建" description="AI 创建标记只能用于创建操作，因此不能保存或启用此策略。" />
        ) : null}
        <Typography.Paragraph type="secondary">
          {strategy === 'AI_CREATED_MARKER'
            ? '经 SFoA MCP 创建记录时自动将目标字段写为 true，仅在创建时生效。'
            : '使用当前可信平台用户编号，在指定 Salesforce 对象和字段中唯一匹配记录，并把其 Id 写入目标 Lookup 字段。'}
        </Typography.Paragraph>
        {strategy === 'PLATFORM_USER_LOOKUP' ? (
          <>
            <Space size="large" wrap className="policy-toggles">
              <Form.Item
                name="applyOnCreate"
                label="应用于创建"
                valuePropName="checked"
                dependencies={['applyOnUpdate']}
                rules={[({ getFieldValue }) => ({
                  validator: async (_rule, value: boolean) => {
                    if (value || getFieldValue('applyOnUpdate')) return;
                    throw new Error('请至少选择一个父策略已允许的操作。');
                  },
                })]}
              ><Switch disabled={!policy?.allowCreate} /></Form.Item>
              <Form.Item name="applyOnUpdate" label="应用于编辑" valuePropName="checked"><Switch disabled={!policy?.allowUpdate} /></Form.Item>
            </Space>
            {!policy?.allowCreate ? <Typography.Text type="warning">当前对象策略未启用创建。</Typography.Text> : null}
            {!policy?.allowUpdate ? <Typography.Text type="warning">当前对象策略未启用编辑。</Typography.Text> : null}
            <div className="managed-lookup-grid">
              <Form.Item name="lookupObjectApiName" label="Lookup 对象 API 名称" extra="例如 Contact。" rules={[{ required: true, whitespace: true, message: '请输入 Lookup 对象 API 名称。' }, { pattern: /^[A-Za-z][A-Za-z0-9_]{0,127}$/u, message: '请输入有效 API 名称。' }]}><Input autoComplete="off" placeholder="Contact" /></Form.Item>
              <Form.Item name="lookupMatchFieldApiName" label="身份匹配字段 API 名称" extra="字段值必须唯一匹配 platformUserId。" rules={[{ required: true, whitespace: true, message: '请输入身份匹配字段 API 名称。' }, { pattern: /^[A-Za-z][A-Za-z0-9_]{0,127}$/u, message: '请输入有效 API 名称。' }]}><Input autoComplete="off" placeholder="Custom_Field__c" /></Form.Item>
            </div>
          </>
        ) : (
          <Descriptions bordered size="small" column={1} className="margin-bottom">
            <Descriptions.Item label="生效操作">创建（固定）</Descriptions.Item>
            <Descriptions.Item label="写入值"><code>true</code>（固定）</Descriptions.Item>
          </Descriptions>
        )}
        <Form.Item name="enabled" label="规则状态" valuePropName="checked"><Switch checkedChildren="已启用" unCheckedChildren="已停用" /></Form.Item>
        <Form.Item name="remark" label="备注" rules={[{ max: 512 }]}><Input.TextArea rows={3} maxLength={512} showCount /></Form.Item>
      </Form>
    </Modal>
  );
}

function ManagedFieldsButton({ policy, onOpen }: Readonly<{
  policy: DmlPolicyRecord;
  onOpen(): void;
}>) {
  const query = useQuery({
    queryKey: ['managed-dml-fields', policy.id],
    queryFn: () => adminApi.managedDmlFieldRules(policy.id),
  });
  return (
    <Button
      icon={<SafetyCertificateOutlined />}
      aria-label={`管理 ${policy.objectApiName} 的托管字段`}
      loading={query.isFetching && !query.data}
      onClick={onOpen}
    >
      托管字段 {query.data?.count ?? '—'}
    </Button>
  );
}

function strategyLabel(value: ManagedDmlFieldStrategy): string {
  return value === 'PLATFORM_USER_LOOKUP' ? '当前平台用户 Lookup' : 'AI 创建标记';
}

async function invalidatePolicies(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['dml-policies'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ]);
}

async function invalidateManagedFields(queryClient: ReturnType<typeof useQueryClient>, dmlPolicyId: string | undefined): Promise<void> {
  if (!dmlPolicyId) return;
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['managed-dml-fields', dmlPolicyId] }),
    queryClient.invalidateQueries({ queryKey: ['agent-integration'] }),
  ]);
}
