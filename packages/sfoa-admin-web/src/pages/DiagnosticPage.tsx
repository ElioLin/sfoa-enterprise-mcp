import { ReloadOutlined, SaveOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Descriptions, Form, Input, Row, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { ADMIN_DIAGNOSTIC_METADATA_TYPES, type DiagnosticVerificationDto } from '@sfoa/control-plane/admin-contracts';
import { adminApi } from '../api/client.js';
import { ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';
import { formatDateTime, statusLabel } from '../localization.js';

type DiagnosticForm = Readonly<{
  salesforceUsername: string;
  enabled: boolean;
  testMetadataType: (typeof ADMIN_DIAGNOSTIC_METADATA_TYPES)[number] | null;
  testMetadataFullName: string | null;
}>;

export default function DiagnosticPage() {
  const [form] = Form.useForm<DiagnosticForm>();
  const [verification, setVerification] = useState<DiagnosticVerificationDto['verification'] | null>(null);
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const query = useQuery({ queryKey: ['diagnostic'], queryFn: adminApi.diagnostic });
  const save = useMutation({
    mutationFn: (values: DiagnosticForm) => adminApi.updateDiagnostic({
      ...values,
      testMetadataType: values.testMetadataType || null,
      testMetadataFullName: values.testMetadataFullName || null,
      rowVersion: query.data?.config?.rowVersion ?? null,
    }),
    onSuccess: async () => {
      await invalidateDiagnostic(queryClient);
      void message.success('Diagnostic 配置已保存，将应用于新请求。');
    },
  });
  const verify = useMutation({
    mutationFn: adminApi.verifyDiagnostic,
    onSuccess: async (result) => {
      setVerification(result.verification);
      await invalidateDiagnostic(queryClient);
      if (result.verification.status === 'PASS') void message.success('Diagnostic 链路验证通过。');
    },
  });

  useEffect(() => {
    if (!query.data) return;
    form.setFieldsValue({
      salesforceUsername: query.data.config?.salesforceUsername ?? '',
      enabled: query.data.config?.enabled ?? true,
      testMetadataType: asMetadataType(query.data.config?.testMetadataType),
      testMetadataFullName: query.data.config?.testMetadataFullName ?? null,
    });
  }, [form, query.data]);

  return (
    <PageFrame
      title="系统诊断"
      description="服务端自有的固定 Salesforce 身份，用于真实 P4 Tooling 与有界 Metadata context 验证路径。MCP Tool 输入永远无法选择该身份。"
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新</Button>}
    >
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
        <Space orientation="vertical" size="large" className="full-width">
          <Alert
            type="warning"
            showIcon
            title="验证会执行真实 Salesforce 调用"
            description="它会创建全新 JWT Connection，检查精确身份，调用真实 Tooling 查询与 P4 metadata-context 链路，然后验证工作区清理。不使用 Salesforce CLI auth cache。"
          />
          <MutationError error={save.error ?? verify.error} />
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={15}>
              <Card title="配置" className="surface-card">
                <Form<DiagnosticForm> form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
                  <Form.Item
                    name="salesforceUsername"
                    label="Diagnostic Salesforce Username"
                    extra="必须在不区分大小写时与每个已启用 USER 路由不同。"
                    rules={[{ required: true, whitespace: true, message: '请输入 Diagnostic Salesforce Username。' }, { type: 'email', message: '请使用完整的 Salesforce Username。' }]}
                  >
                    <Input autoComplete="off" />
                  </Form.Item>
                  <Form.Item name="enabled" label="Diagnostic 状态" valuePropName="checked">
                    <Switch checkedChildren="已启用" unCheckedChildren="已停用" />
                  </Form.Item>
                  <Row gutter={16}>
                    <Col xs={24} md={10}>
                      <Form.Item
                        name="testMetadataType"
                        label="验证 Metadata 类型"
                        dependencies={['testMetadataFullName']}
                        rules={[
                          ({ getFieldValue }) => ({
                            validator: async (_rule, value: string | null) => {
                              if (Boolean(value) === Boolean(getFieldValue('testMetadataFullName'))) return;
                              throw new Error('请同时设置两个验证 Metadata 字段，或同时清空。');
                            },
                          }),
                        ]}
                      >
                        <Select allowClear options={ADMIN_DIAGNOSTIC_METADATA_TYPES.map((value) => ({ value, label: value }))} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={14}>
                      <Form.Item
                        name="testMetadataFullName"
                        label="验证 Metadata Full Name"
                        rules={[{ max: 255 }, { pattern: /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/u, message: '请使用有界的 Metadata Full Name。' }]}
                      >
                        <Input autoComplete="off" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Space wrap>
                    <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={save.isPending}>保存配置</Button>
                    <Button
                      aria-label="验证 Diagnostic Connection"
                      icon={<SafetyCertificateOutlined />}
                      loading={verify.isPending}
                      disabled={!query.data.config?.enabled}
                      onClick={() => verify.mutate()}
                    >
                      验证 Diagnostic Connection
                    </Button>
                  </Space>
                </Form>
              </Card>
            </Col>
            <Col xs={24} lg={9}>
              <Card title="凭据就绪状态" className="surface-card">
                <Descriptions column={1} bordered size="small">
                  <Descriptions.Item label="Connected App 已配置"><StatusTag label={query.data.configured.connectedApp ? 'YES' : 'NO'} tone={query.data.configured.connectedApp ? 'success' : 'error'} /></Descriptions.Item>
                  <Descriptions.Item label="JWT key 已配置"><StatusTag label={query.data.configured.jwtPrivateKey ? 'YES' : 'NO'} tone={query.data.configured.jwtPrivateKey ? 'success' : 'error'} /></Descriptions.Item>
                  <Descriptions.Item label="状态"><StatusTag label={query.data.config?.verificationStatus ?? 'NOT_CONFIGURED'} /></Descriptions.Item>
                  <Descriptions.Item label="最后验证">{formatOptionalDate(query.data.config?.lastVerifiedAt)}</Descriptions.Item>
                  <Descriptions.Item label="安全错误">{query.data.config?.lastErrorMessageSafe ?? '—'}</Descriptions.Item>
                </Descriptions>
                <Typography.Paragraph type="secondary" className="credential-note">
                  Client ID、key 内容、文件系统路径、access token 与 JWT assertion 永远不会返回到浏览器。
                </Typography.Paragraph>
              </Card>
            </Col>
          </Row>
          {verification ? <VerificationEvidence verification={verification} /> : null}
        </Space>
      )}
    </PageFrame>
  );
}

function VerificationEvidence({ verification }: Readonly<{ verification: DiagnosticVerificationDto['verification'] }>) {
  return (
    <Card title="最新验证证据" className="surface-card" extra={<StatusTag label={verification.status} />}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="精确身份匹配">{verification.identityMatched ? '是' : '否'}</Descriptions.Item>
        <Descriptions.Item label="Salesforce Username">{verification.salesforceUsername}</Descriptions.Item>
        <Descriptions.Item label="API 版本">{verification.apiVersion ?? '未返回'}</Descriptions.Item>
        <Descriptions.Item label="耗时">{verification.durationMs} ms</Descriptions.Item>
        <Descriptions.Item label="Tooling 记录">{verification.tooling ? `${verification.tooling.returnedRecords} / ${verification.tooling.totalSize}${verification.tooling.truncated ? '（已限界）' : ''}` : '未测试'}</Descriptions.Item>
        <Descriptions.Item label="Metadata context">{verification.metadata ? `${statusLabel(verification.metadata.status)}；${verification.metadata.returnedFiles} 个文件，${verification.metadata.returnedBytes} 字节` : '未测试'}</Descriptions.Item>
        <Descriptions.Item label="工作区清理">{verification.cleanup ? `${verification.cleanup.cleaned}/${verification.cleanup.created} 已清理；${verification.cleanup.active} 个活动` : '未测试'}</Descriptions.Item>
        <Descriptions.Item label="安全错误">{verification.error ? `${verification.error.code}: ${verification.error.message}` : '—'}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function asMetadataType(value: string | null | undefined): DiagnosticForm['testMetadataType'] {
  return ADMIN_DIAGNOSTIC_METADATA_TYPES.find((candidate) => candidate === value) ?? null;
}

function formatOptionalDate(value: string | null | undefined): string {
  return value ? formatDateTime(value) : '从未';
}

async function invalidateDiagnostic(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['diagnostic'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['system-status'] }),
  ]);
}
