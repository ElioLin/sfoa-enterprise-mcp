import { EditOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Form, Input, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import type { AdminToolRecordDto } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';
import {
  localizeToolDependency,
  localizeToolDisabledReason,
  statusLabel,
} from '../localization.js';

const DEFAULT_PAGE_SIZE = 20;

function matchesSearch(record: AdminToolRecordDto, searchText: string): boolean {
  const keyword = searchText.trim().toLocaleLowerCase();
  if (!keyword) return true;

  const searchableValues = [
    record.toolName,
    record.classification,
    statusLabel(record.classification),
    record.executionRole,
    statusLabel(record.executionRole),
    record.releaseState,
    statusLabel(record.releaseState),
    record.status,
    statusLabel(record.status),
    record.remoteCompatible ? 'remote yes 远程兼容 是' : 'remote no 非远程兼容 否',
    record.enabled ? 'enabled 已启用 已启动' : 'disabled 未启用 未启动',
    record.enableAllowed ? 'enable allowed 可启用' : 'enable blocked 不可启用',
    record.remark ?? '',
    record.disabledReason ?? '',
    record.disabledReason ? localizeToolDisabledReason(record.disabledReason) : '',
    ...record.dependencies,
    ...record.dependencies.map((value) => localizeToolDependency(value)),
  ];

  return searchableValues.some((value) => String(value).toLocaleLowerCase().includes(keyword));
}

function compareToolRows(left: AdminToolRecordDto, right: AdminToolRecordDto): number {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  return left.toolName.localeCompare(right.toolName, 'en-US');
}

export default function ToolGovernancePage() {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [editing, setEditing] = useState<AdminToolRecordDto | null>(null);
  const [searchText, setSearchText] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [form] = Form.useForm<{ remark: string | null }>();
  const query = useQuery({ queryKey: ['tools'], queryFn: adminApi.tools });

  const filteredItems = useMemo(
    () => (query.data?.items ?? [])
      .filter((record) => matchesSearch(record, searchText))
      .sort(compareToolRows),
    [query.data?.items, searchText],
  );

  const enabledCount = useMemo(
    () => (query.data?.items ?? []).filter((record) => record.enabled).length,
    [query.data?.items],
  );

  const enableAllowedCount = useMemo(
    () => (query.data?.items ?? []).filter((record) => record.enableAllowed).length,
    [query.data?.items],
  );

  const update = useMutation({
    mutationFn: ({ record, enabled, remark }: Readonly<{ record: AdminToolRecordDto; enabled: boolean; remark: string | null }>) =>
      adminApi.updateTool(record.toolName, { enabled, remark, rowVersion: record.rowVersion }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tools'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      setEditing(null);
      setPage(1);
      void message.success('Tool 治理已更新，将应用于新 MCP 请求。');
    },
  });

  const openNote = (record: AdminToolRecordDto): void => {
    form.setFieldsValue({ remark: record.remark });
    setEditing(record);
  };

  return (
    <PageFrame
      title="工具治理"
      description="实际 tools/list 是当前 enabled state 与已审计可执行目录的交集。数据库状态永远不能提升未知或不安全的 Tool。"
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新目录</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <Alert
          type="info"
          showIcon
          title="可执行安全保持在代码中"
          description="分类、执行角色、发布状态、远程兼容性、Host 自有参数与上游漂移均来自 Provider 检查，而不是 MySQL。"
        />
        <Alert
          type="info"
          showIcon
          title="UNKNOWN 不等同于 Salesforce 非 GA"
          description="UNKNOWN 表示当前 SFoA Runtime 尚未锁定并审计该 Tool 的上游发布契约；在完成远程契约与安全分类审查前，该状态不会自动获得启用资格。"
        />
        <MutationError error={update.error} />
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.controlsTruncated ? (
              <Alert type="warning" showIcon title="未知数据库控制项已在 API 边界上限处截断。" />
            ) : null}
            <Space wrap size="middle" style={{ width: '100%', marginBottom: 16, justifyContent: 'space-between' }}>
              <Input
                allowClear
                prefix={<SearchOutlined />}
                placeholder="搜索 Tool 名称、状态、分类、依赖、备注或不可启用原因"
                value={searchText}
                onChange={(event) => {
                  setSearchText(event.target.value);
                  setPage(1);
                }}
                style={{ width: 460, maxWidth: '100%' }}
              />
              <Typography.Text type="secondary">
                共 {query.data.items.length} 个 · 已启用 {enabledCount} 个 · 可启用 {enableAllowedCount} 个 · 当前匹配 {filteredItems.length} 个
              </Typography.Text>
            </Space>
            <Table<AdminToolRecordDto>
              rowKey="toolName"
              pagination={{
                current: page,
                pageSize,
                total: filteredItems.length,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50, 100],
                showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
                onChange: (nextPage, nextPageSize) => {
                  const sizeChanged = nextPageSize !== pageSize;
                  setPageSize(nextPageSize);
                  setPage(sizeChanged ? 1 : nextPage);
                },
              }}
              dataSource={filteredItems}
              scroll={{ x: 1180 }}
              columns={[
                { title: 'Tool 名称', dataIndex: 'toolName', fixed: 'left', render: (value: string) => <code>{value}</code> },
                { title: '分类', dataIndex: 'classification', render: (value: string) => <StatusTag label={value} tone="neutral" /> },
                { title: '执行角色', dataIndex: 'executionRole', render: (value: string) => <StatusTag label={value} tone={value === 'DIAGNOSTIC' ? 'warning' : 'neutral'} /> },
                { title: '发布状态', dataIndex: 'releaseState', render: (value: string) => <StatusTag label={value} /> },
                { title: '远程兼容', dataIndex: 'remoteCompatible', render: (value: boolean) => value ? '是' : '否' },
                { title: '依赖', dataIndex: 'dependencies', render: (values: readonly string[]) => values.length ? <Space wrap>{values.map((value) => <Tag key={value}>{localizeToolDependency(value)}</Tag>)}</Space> : '无' },
                { title: '状态', dataIndex: 'status', render: (value: string) => <StatusTag label={value} /> },
                {
                  title: '启用状态', dataIndex: 'enabled', width: 130,
                  render: (enabled: boolean, record) => (
                    <Switch
                      aria-label={`${enabled ? '停用' : '启用'} ${record.toolName}`}
                      checked={enabled}
                      disabled={!enabled && !record.enableAllowed}
                      loading={update.isPending && update.variables?.record.toolName === record.toolName}
                      onChange={(next) => update.mutate({ record, enabled: next, remark: record.remark })}
                    />
                  ),
                },
                {
                  title: '审查', width: 270,
                  render: (_value, record) => (
                    <Space orientation="vertical" size={4}>
                      <Button icon={<EditOutlined />} onClick={() => openNote(record)}>编辑备注</Button>
                      {record.disabledReason ? <Typography.Text type="secondary" className="small-copy" title={record.disabledReason}>{localizeToolDisabledReason(record.disabledReason)}</Typography.Text> : null}
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Space>
      <Modal
        open={editing !== null}
        title={editing ? `${editing.toolName} 的备注` : 'Tool 备注'}
        okText="保存备注"
        confirmLoading={update.isPending}
        onCancel={() => setEditing(null)}
        onOk={() => void form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => editing && update.mutate({
          record: editing,
          enabled: editing.enabled,
          remark: values.remark || null,
        })}>
          <Form.Item name="remark" label="治理备注" rules={[{ max: 512 }]}>
            <Input.TextArea rows={4} maxLength={512} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </PageFrame>
  );
}
