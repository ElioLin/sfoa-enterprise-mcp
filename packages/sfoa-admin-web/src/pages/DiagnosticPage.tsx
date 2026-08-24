import { ReloadOutlined, SaveOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Descriptions, Form, Input, Row, Select, Space, Switch, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { ADMIN_DIAGNOSTIC_METADATA_TYPES, type DiagnosticVerificationDto } from '@sfoa/control-plane/admin-contracts';
import { adminApi } from '../api/client.js';
import { ErrorState, LoadingState, MutationError } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

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
      void message.success('Diagnostic configuration saved for new requests.');
    },
  });
  const verify = useMutation({
    mutationFn: adminApi.verifyDiagnostic,
    onSuccess: async (result) => {
      setVerification(result.verification);
      await invalidateDiagnostic(queryClient);
      if (result.verification.status === 'PASS') void message.success('Diagnostic chain passed.');
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
      title="Diagnostic integration"
      description="Server-owned, fixed Salesforce identity for the real P4 Tooling and bounded Metadata context verification path. MCP Tool input can never select this identity."
      action={<Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button>}
    >
      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
        <Space orientation="vertical" size="large" className="full-width">
          <Alert
            type="warning"
            showIcon
            title="Verification performs live Salesforce calls"
            description="It creates a fresh JWT connection, checks the exact identity, calls the real Tooling query and P4 metadata-context chain, then verifies workspace cleanup. No Salesforce CLI auth cache is used."
          />
          <MutationError error={save.error ?? verify.error} />
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={15}>
              <Card title="Configuration" className="surface-card">
                <Form<DiagnosticForm> form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
                  <Form.Item
                    name="salesforceUsername"
                    label="Diagnostic Salesforce username"
                    extra="Must be case-insensitively distinct from every enabled USER route."
                    rules={[{ required: true, whitespace: true }, { type: 'email', message: 'Use a complete Salesforce username.' }]}
                  >
                    <Input autoComplete="off" />
                  </Form.Item>
                  <Form.Item name="enabled" label="Diagnostic status" valuePropName="checked">
                    <Switch checkedChildren="Enabled" unCheckedChildren="Disabled" />
                  </Form.Item>
                  <Row gutter={16}>
                    <Col xs={24} md={10}>
                      <Form.Item
                        name="testMetadataType"
                        label="Verification metadata type"
                        dependencies={['testMetadataFullName']}
                        rules={[
                          ({ getFieldValue }) => ({
                            validator: async (_rule, value: string | null) => {
                              if (Boolean(value) === Boolean(getFieldValue('testMetadataFullName'))) return;
                              throw new Error('Set both verification metadata fields or clear both.');
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
                        label="Verification metadata full name"
                        rules={[{ max: 255 }, { pattern: /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/u, message: 'Use a bounded metadata full name.' }]}
                      >
                        <Input autoComplete="off" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Space wrap>
                    <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={save.isPending}>Save configuration</Button>
                    <Button
                      aria-label="Verify Diagnostic Connection"
                      icon={<SafetyCertificateOutlined />}
                      loading={verify.isPending}
                      disabled={!query.data.config?.enabled}
                      onClick={() => verify.mutate()}
                    >
                      Verify Diagnostic Connection
                    </Button>
                  </Space>
                </Form>
              </Card>
            </Col>
            <Col xs={24} lg={9}>
              <Card title="Credential readiness" className="surface-card">
                <Descriptions column={1} bordered size="small">
                  <Descriptions.Item label="Connected App configured"><StatusTag label={query.data.configured.connectedApp ? 'YES' : 'NO'} tone={query.data.configured.connectedApp ? 'success' : 'error'} /></Descriptions.Item>
                  <Descriptions.Item label="JWT key configured"><StatusTag label={query.data.configured.jwtPrivateKey ? 'YES' : 'NO'} tone={query.data.configured.jwtPrivateKey ? 'success' : 'error'} /></Descriptions.Item>
                  <Descriptions.Item label="Status"><StatusTag label={query.data.config?.verificationStatus ?? 'NOT_CONFIGURED'} /></Descriptions.Item>
                  <Descriptions.Item label="Last verified">{formatOptionalDate(query.data.config?.lastVerifiedAt)}</Descriptions.Item>
                  <Descriptions.Item label="Safe error">{query.data.config?.lastErrorMessageSafe ?? '—'}</Descriptions.Item>
                </Descriptions>
                <Typography.Paragraph type="secondary" className="credential-note">
                  Client identifiers, key contents, filesystem paths, access tokens, and JWT assertions are never returned to this browser.
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
    <Card title="Latest verification evidence" className="surface-card" extra={<StatusTag label={verification.status} />}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="Exact identity matched">{verification.identityMatched ? 'YES' : 'NO'}</Descriptions.Item>
        <Descriptions.Item label="Salesforce username">{verification.salesforceUsername}</Descriptions.Item>
        <Descriptions.Item label="API version">{verification.apiVersion ?? 'Not returned'}</Descriptions.Item>
        <Descriptions.Item label="Duration">{verification.durationMs} ms</Descriptions.Item>
        <Descriptions.Item label="Tooling records">{verification.tooling ? `${verification.tooling.returnedRecords} of ${verification.tooling.totalSize}${verification.tooling.truncated ? ' (bounded)' : ''}` : 'Not tested'}</Descriptions.Item>
        <Descriptions.Item label="Metadata context">{verification.metadata ? `${verification.metadata.status}; ${verification.metadata.returnedFiles} file(s), ${verification.metadata.returnedBytes} byte(s)` : 'Not tested'}</Descriptions.Item>
        <Descriptions.Item label="Workspace cleanup">{verification.cleanup ? `${verification.cleanup.cleaned}/${verification.cleanup.created} cleaned; ${verification.cleanup.active} active` : 'Not tested'}</Descriptions.Item>
        <Descriptions.Item label="Safe error">{verification.error ? `${verification.error.code}: ${verification.error.message}` : '—'}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function asMetadataType(value: string | null | undefined): DiagnosticForm['testMetadataType'] {
  return ADMIN_DIAGNOSTIC_METADATA_TYPES.find((candidate) => candidate === value) ?? null;
}

function formatOptionalDate(value: string | null | undefined): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Never';
}

async function invalidateDiagnostic(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['diagnostic'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['system-status'] }),
  ]);
}
