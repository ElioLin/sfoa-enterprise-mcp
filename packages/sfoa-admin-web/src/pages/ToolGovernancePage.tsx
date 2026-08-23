import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Form, Input, Modal, Space, Switch, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import type { AdminToolRecordDto } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

export default function ToolGovernancePage() {
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [editing, setEditing] = useState<AdminToolRecordDto | null>(null);
  const [form] = Form.useForm<{ remark: string | null }>();
  const query = useQuery({ queryKey: ['tools'], queryFn: adminApi.tools });
  const update = useMutation({
    mutationFn: ({ record, enabled, remark }: Readonly<{ record: AdminToolRecordDto; enabled: boolean; remark: string | null }>) =>
      adminApi.updateTool(record.toolName, { enabled, remark, rowVersion: record.rowVersion }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tools'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      setEditing(null);
      void message.success('Tool governance updated for new MCP requests.');
    },
  });
  const openNote = (record: AdminToolRecordDto): void => {
    form.setFieldsValue({ remark: record.remark });
    setEditing(record);
  };

  return (
    <PageFrame
      title="Tool governance"
      description="Actual tools/list is the intersection of this enabled state and the audited executable catalog. Database state can never promote an unknown or unsafe Tool."
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>Refresh catalog</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <Alert
          type="info"
          showIcon
          title="Executable safety stays in code"
          description="Classification, execution role, release state, remote compatibility, host-owned arguments, and upstream drift come from Provider inspection—not MySQL."
        />
        <MutationError error={update.error} />
        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="surface-card">
            {query.data.controlsTruncated ? (
              <Alert type="warning" showIcon title="Unknown database controls were truncated at the bounded API limit." />
            ) : null}
            <Table<AdminToolRecordDto>
              rowKey="toolName"
              pagination={false}
              dataSource={[...query.data.items]}
              scroll={{ x: 1180 }}
              columns={[
                { title: 'Tool name', dataIndex: 'toolName', fixed: 'left', render: (value: string) => <code>{value}</code> },
                { title: 'Classification', dataIndex: 'classification', render: (value: string) => <Tag>{value}</Tag> },
                { title: 'Role', dataIndex: 'executionRole', render: (value: string) => <StatusTag label={value} tone={value === 'DIAGNOSTIC' ? 'warning' : 'neutral'} /> },
                { title: 'Release', dataIndex: 'releaseState', render: (value: string) => <StatusTag label={value} /> },
                { title: 'Remote', dataIndex: 'remoteCompatible', render: (value: boolean) => value ? 'YES' : 'NO' },
                { title: 'Dependencies', dataIndex: 'dependencies', render: (values: readonly string[]) => values.length ? <Space wrap>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> : 'None' },
                { title: 'Status', dataIndex: 'status', render: (value: string) => <StatusTag label={value} /> },
                {
                  title: 'Enabled', dataIndex: 'enabled', width: 130,
                  render: (enabled: boolean, record) => (
                    <Switch
                      aria-label={`${enabled ? 'Disable' : 'Enable'} ${record.toolName}`}
                      checked={enabled}
                      disabled={!enabled && !record.enableAllowed}
                      loading={update.isPending && update.variables?.record.toolName === record.toolName}
                      onChange={(next) => update.mutate({ record, enabled: next, remark: record.remark })}
                    />
                  ),
                },
                {
                  title: 'Review', width: 270,
                  render: (_value, record) => (
                    <Space orientation="vertical" size={4}>
                      <Button icon={<EditOutlined />} onClick={() => openNote(record)}>Edit remark</Button>
                      {record.disabledReason ? <Typography.Text type="secondary" className="small-copy">{record.disabledReason}</Typography.Text> : null}
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
        title={editing ? `Remark for ${editing.toolName}` : 'Tool remark'}
        okText="Save remark"
        confirmLoading={update.isPending}
        onCancel={() => setEditing(null)}
        onOk={() => void form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => editing && update.mutate({
          record: editing,
          enabled: editing.enabled,
          remark: values.remark || null,
        })}>
          <Form.Item name="remark" label="Governance remark" rules={[{ max: 512 }]}>
            <Input.TextArea rows={4} maxLength={512} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </PageFrame>
  );
}
