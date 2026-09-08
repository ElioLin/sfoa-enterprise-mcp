import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Select, Space, Table, Typography } from 'antd';
import { dynamicFormsObjectPoliciesSchema } from '@sfoa/control-plane/contracts';
import { adminApi } from '../api/client.js';
import { PageFrame } from '../components/PageFrame.js';
import { ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { formatDateTime } from '../localization.js';

type Policy = { objectApiName: string; mode: 'OFF' | 'SHADOW' | 'ENFORCE'; defaultApp?: string | null };
const UI_MODE_LABELS: Record<Policy['mode'], string> = Object.freeze({
  OFF: '关闭（OFF）',
  SHADOW: '影子（SHADOW）',
  ENFORCE: '强制（ENFORCE）',
});
export default function UiContextPage() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ['runtime-settings'], queryFn: adminApi.runtimeSettings });
  const snapshots = useQuery({ queryKey: ['ui-snapshots'], queryFn: adminApi.uiSnapshots });
  const [form] = Form.useForm<Policy>();
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const policySetting = settings.data?.find((setting) => setting.settingKey === 'dynamicFormsObjectPolicies');
  const parsed = dynamicFormsObjectPoliciesSchema.safeParse(policySetting?.settingValue ?? []);
  const policies = parsed.success ? parsed.data : [];
  const save = useMutation({
    mutationFn: (value: Policy) => adminApi.updateRuntimeSetting('dynamicFormsObjectPolicies',
      dynamicFormsObjectPoliciesSchema.parse([...policies.filter((row) => row.objectApiName.toLowerCase() !== value.objectApiName.toLowerCase()),
        { ...value, defaultApp: value.defaultApp || null }]), policySetting?.rowVersion),
    onSuccess: async () => { form.resetFields(); await client.invalidateQueries({ queryKey: ['runtime-settings'] }); },
  });
  const refresh = useMutation({ mutationFn: adminApi.refreshUiSnapshot,
    onMutate: (name) => setRefreshing(name),
    onSettled: async () => { setRefreshing(null); await client.invalidateQueries({ queryKey: ['ui-snapshots'] }); },
  });
  const defaultSetting = settings.data?.find((setting) => setting.settingKey === 'integrationDefaultSalesforceAppDeveloperName');
  const defaultApp = useMutation({
    mutationFn: (value: string) => adminApi.updateRuntimeSetting('integrationDefaultSalesforceAppDeveloperName', value || null, defaultSetting?.rowVersion),
    onSuccess: () => client.invalidateQueries({ queryKey: ['runtime-settings'] }),
  });
  return <PageFrame title="CREATE 页面上下文" description="按对象配置 Dynamic Forms 解析策略，查看并刷新当前页面配置。">
    <Space orientation="vertical" className="full-width" size="large">
      <Alert type="info" showIcon title="未配置的对象默认关闭（OFF）。先用影子（SHADOW）观察审计，再对测试对象启用强制（ENFORCE）；可随时退回关闭。" description="快照超过 24 小时会在审计中标记陈旧。刷新失败保留上次快照；无法解析时继续使用 Page Layout。" />
      <MutationError error={save.error ?? refresh.error ?? defaultApp.error} />
      {settings.isPending ? <LoadingState /> : settings.error ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : <Card title="对象策略">
        <Form form={form} layout="inline" initialValues={{ mode: 'SHADOW' }} onFinish={(value) => save.mutate(value)}>
          <Form.Item name="objectApiName" label="对象 API 名" rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9_]{0,127}$/u }]}><Input /></Form.Item>
          <Form.Item name="mode" label="模式"><Select style={{ width: 150 }} options={(['OFF', 'SHADOW', 'ENFORCE'] as const).map((value) => ({ value, label: UI_MODE_LABELS[value] }))} /></Form.Item>
          <Form.Item name="defaultApp" label="默认 App"><Input placeholder="可选 DeveloperName" /></Form.Item>
          <Form.Item><Button type="primary" htmlType="submit" loading={save.isPending}>保存对象策略</Button></Form.Item>
        </Form>
        {!parsed.success ? <Alert type="error" title="当前策略配置无效，请修正后保存。" /> : null}
        <Table rowKey="objectApiName" dataSource={policies} pagination={false} scroll={{ x: 600 }} columns={[
          { title: '对象', dataIndex: 'objectApiName' }, { title: '模式', render: (_value, row) => UI_MODE_LABELS[row.mode] ?? row.mode }, { title: '默认 App', dataIndex: 'defaultApp' },
          { title: '操作', render: (_value, row) => <Space><Button onClick={() => form.setFieldsValue(row)}>编辑</Button>
            <Button loading={refreshing === row.objectApiName} disabled={refresh.isPending} onClick={() => refresh.mutate(row.objectApiName)}>刷新快照</Button></Space> },
        ]} />
        <Typography.Paragraph type="secondary">集成默认 App：{String(defaultSetting?.settingValue ?? '未配置')}。对象配置优先；请求显式 App 优先于配置。</Typography.Paragraph>
        <Form onFinish={(value: { app?: string }) => defaultApp.mutate(value.app ?? '')} layout="inline">
          <Form.Item name="app" label="集成默认 App"><Input placeholder="留空清除" /></Form.Item>
          <Form.Item><Button htmlType="submit" loading={defaultApp.isPending}>保存默认 App</Button></Form.Item>
        </Form>
      </Card>}
      <Card title="当前 UI 快照">
        {snapshots.error ? <ErrorState error={snapshots.error} onRetry={() => void snapshots.refetch()} /> : <Table rowKey="id" loading={snapshots.isPending} dataSource={[...(snapshots.data ?? [])]} scroll={{ x: 1100 }} columns={[
          { title: '对象', dataIndex: 'objectApiName' },
          { title: '页面 / 来源', render: (_value, row) => row.pages.map((name, index) => <div key={name}>{name} · {row.formSources[index]}</div>) },
          { title: 'App / 范围', render: (_value, row) => <details><summary>{row.apps.length} Apps / {row.profileCount} Profiles / {row.recordTypeCount} RT</summary>{row.apps.join(', ')}</details> },
          { title: '状态', dataIndex: 'status' }, { title: '刷新时间', dataIndex: 'refreshedAt', render: formatDateTime },
          { title: '解析器', dataIndex: 'parserVersion' }, { title: '最近错误', dataIndex: 'lastError' },
        ]} />}
      </Card>
    </Space>
  </PageFrame>;
}
