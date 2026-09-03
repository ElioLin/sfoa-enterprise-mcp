import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileAddOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import type {
  AdminIdentityRouteDto,
  IdentityRouteRecord,
  RouteVerificationDto,
} from '@sfoa/control-plane';
import { adminApi } from '../../api/client.js';
import { ErrorDetailContent, errorDetails } from '../../components/QueryState.js';
import { StatusTag } from '../../components/StatusTag.js';
import {
  BATCH_ROW_LIMIT,
  IDENTITY_ROUTE_BATCH_EXAMPLE,
  IDENTITY_ROUTE_BATCH_HEADER,
  parseIdentityRouteBatchText,
  reassessDraftRows,
  type DraftRouteRow,
} from './batchParser.js';

type VerifyState = Readonly<
  | { status: 'pending' }
  | { status: 'done'; verification: RouteVerificationDto }
  | { status: 'error'; code?: string; message: string }
>;

type CommittedRoute = Readonly<{
  key: string;
  route: IdentityRouteRecord;
}>;

const STEP_LABELS = ['粘贴数据', '识别确认', '保存并验证'] as const;

export default function BatchAddIdentityRoutesModal({
  open,
  existingRoutes,
  onCommitted,
  onEditRoute,
  onClose,
}: Readonly<{
  open: boolean;
  existingRoutes: readonly AdminIdentityRouteDto[];
  onCommitted(): void;
  onEditRoute(route: AdminIdentityRouteDto): void;
  onClose(): void;
}>) {
  const [step, setStep] = useState(0);
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [headerUsed, setHeaderUsed] = useState(false);
  const [columnCount, setColumnCount] = useState(0);
  const [draftRows, setDraftRows] = useState<readonly DraftRouteRow[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [serverFailures, setServerFailures] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const [committed, setCommitted] = useState<readonly CommittedRoute[]>([]);
  const [verifyStates, setVerifyStates] = useState<Record<string, VerifyState>>({});
  const [verifying, setVerifying] = useState(false);
  const { message } = App.useApp();

  const existingPlatformUserIds = useMemo(
    () => new Set(existingRoutes.map((route) => route.platformUserId)),
    [existingRoutes],
  );

  const runBatchVerify = async (ids: readonly string[]): Promise<void> => {
    setVerifying(true);
    setVerifyStates((previous) => {
      const next = { ...previous };
      for (const id of ids) next[id] = { status: 'pending' };
      return next;
    });
    try {
      const result = await adminApi.batchVerifyRoutes(ids);
      setVerifyStates((previous) => {
        const next = { ...previous };
        result.rows.forEach((row, index) => {
          const id = ids[index];
          if (!id) return;
          if (row.ok && row.verification) {
            next[id] = { status: 'done', verification: row.verification };
          } else {
            next[id] = { status: 'error', code: row.error?.code, message: row.error?.message ?? '验证未返回结果。' };
          }
        });
        return next;
      });
    } catch (error) {
      setVerifyStates((previous) => {
        const next = { ...previous };
        for (const id of ids) next[id] = { status: 'error', message: error instanceof Error ? error.message : '批量验证失败。' };
        return next;
      });
      void message.error('批量验证失败，请重试。');
    } finally {
      setVerifying(false);
    }
  };

  const confirmSave = async (): Promise<void> => {
    const selected = draftRows.filter((row) => row.errors.length === 0 && checked[row.key] === true);
    if (selected.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await adminApi.batchCreateRoutes(selected.map((row) => ({
        platformUserId: row.platformUserId,
        userName: row.userName,
        salesforceUsername: row.salesforceUsername,
        enabled: true,
        remark: row.remark,
      })));
      if (!response.committed) {
        const nextFailures: Record<string, string> = {};
        for (const row of response.rows) {
          const selectedRow = selected[row.index];
          if (selectedRow) nextFailures[selectedRow.key] = row.error?.message ?? '服务端拒绝了该行。';
        }
        setServerFailures((previous) => ({ ...previous, ...nextFailures }));
        setChecked((previous) => {
          const next = { ...previous };
          for (const key of Object.keys(nextFailures)) next[key] = false;
          return next;
        });
        void message.warning(`${Object.keys(nextFailures).length} 行与现有配置冲突，已取消勾选，请处理后再保存。`);
        return;
      }
      const committedRoutes: CommittedRoute[] = [];
      selected.forEach((selectedRow, index) => {
        const created = response.rows[index];
        if (created?.ok && created.route) committedRoutes.push({ key: selectedRow.key, route: created.route });
      });
      if (committedRoutes.length === 0) {
        setSubmitError(new Error('服务端已确认保存但没有返回创建结果，请刷新列表后重试。'));
        return;
      }
      setCommitted(committedRoutes);
      setStep(2);
      onCommitted();
      void message.success(`已保存 ${committedRoutes.length} 条身份路由并生成接入凭证，正在验证 Salesforce 连通性…`);
      await runBatchVerify(committedRoutes.map((entry) => entry.route.id));
    } catch (error) {
      setSubmitError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const retryFailed = async (): Promise<void> => {
    const failed = committed
      .filter((entry) => !isPassed(verifyStates[entry.route.id]))
      .map((entry) => entry.route.id);
    if (failed.length === 0) return;
    await runBatchVerify(failed);
  };

  const close = (): void => {
    if (submitting || verifying) return;
    setStep(0);
    setText('');
    setParseError(null);
    setDraftRows([]);
    setChecked({});
    setServerFailures({});
    setSubmitError(null);
    setCommitted([]);
    setVerifyStates({});
    onClose();
  };

  const parsePaste = (): void => {
    const outcome = parseIdentityRouteBatchText(text);
    if (outcome.error) {
      setParseError(outcome.error);
      setDraftRows([]);
      return;
    }
    setParseError(null);
    const reassessed = reassessDraftRows(outcome.rows, existingPlatformUserIds);
    const nextChecked: Record<string, boolean> = {};
    for (const row of reassessed) nextChecked[row.key] = row.errors.length === 0;
    setHeaderUsed(outcome.headerUsed);
    setColumnCount(outcome.columnCount);
    setServerFailures({});
    setSubmitError(null);
    setDraftRows(reassessed);
    setChecked(nextChecked);
    setStep(1);
  };

  const updateRow = (key: string, patch: Readonly<Partial<Pick<DraftRouteRow, 'userName' | 'platformUserId' | 'salesforceUsername' | 'remark'>>>): void => {
    const updated = draftRows.map((row) => (row.key === key ? { ...row, ...patch } : row));
    const reassessed = reassessDraftRows(updated, existingPlatformUserIds);
    setDraftRows(reassessed);
    setServerFailures((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setChecked((previous) => {
      const next = { ...previous };
      const row = reassessed.find((item) => item.key === key);
      if (row && row.errors.length > 0) next[key] = false;
      return next;
    });
  };

  const toggleChecked = (key: string, value: boolean): void => {
    setChecked((previous) => ({ ...previous, [key]: value }));
  };

  const importable = draftRows.filter((row) => row.errors.length === 0);
  const selectedCount = importable.filter((row) => checked[row.key] === true).length;

  return (
    <Modal
      open={open}
      title="批量添加用户身份路由"
      width={1180}
      destroyOnHidden
      maskClosable={false}
      footer={null}
      onCancel={close}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <Steps
          current={step}
          items={STEP_LABELS.map((title) => ({ title }))}
          onChange={(next) => {
            if (next < step && step !== 2 && !submitting) setStep(next);
          }}
        />

        {step === 0 ? (
          <Space orientation="vertical" size="middle" className="full-width">
            <Alert
              type="info"
              showIcon
              title="从 Excel 或文本中批量粘贴身份路由"
              description={`每行一条，使用 Tab / 逗号 / 分号分隔。推荐 ${BATCH_ROW_LIMIT} 条以内，模板表头：${IDENTITY_ROUTE_BATCH_HEADER}。无表头时按列数识别：2 列视为「平台用户 + Salesforce Username」，3/4 列按「用户名称/平台用户/Salesforce Username[/备注]」。保存后每条自动生成 USER_BOUND 接入凭证并验证 Salesforce 连通性。`}
            />
            {parseError ? <Alert type="error" showIcon title={parseError} /> : null}
            <Input.TextArea
              value={text}
              rows={10}
              aria-label="批量粘贴数据"
              placeholder={`${IDENTITY_ROUTE_BATCH_HEADER}\n张三\tzhang.san\tzhang.san@example.com\t运营团队\n李四\tli.si\tli.si@example.com\t`}
              onChange={(event) => setText(event.target.value)}
            />
            <Space>
              <Button icon={<FileAddOutlined />} onClick={() => setText(IDENTITY_ROUTE_BATCH_EXAMPLE)}>填入示例</Button>
              <Button onClick={() => setText('')}>清空</Button>
              <Button type="primary" disabled={text.trim().length === 0} onClick={parsePaste}>识别数据</Button>
            </Space>
          </Space>
        ) : null}

        {step === 1 ? (
          <Space orientation="vertical" size="middle" className="full-width">
            <Alert
              type="info"
              showIcon
              title={headerUsed
                ? `已识别表头，共识别到 ${draftRows.length} 行数据。`
                : `未识别到表头，共识别到 ${draftRows.length} 行数据。`}
              description={`可导入 ${selectedCount} 条。勾选行导入，有错误的行（已在表格中标红）会保留在此等待修改或取消勾选。`}
            />
            {submitError ? (
              <Alert
                type="error"
                showIcon
                title={errorDetails(submitError).title}
                description={<ErrorDetailContent detail={errorDetails(submitError)} />}
              />
            ) : null}
            <Table<DraftRouteRow>
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={[...draftRows]}
              scroll={{ x: 1120, y: 360 }}
              columns={[
                {
                  title: '导入', key: 'select', width: 64, fixed: 'left',
                  render: (_value, row) => (
                    <Checkbox
                      checked={checked[row.key] === true}
                      disabled={row.errors.length > 0}
                      aria-label={`勾选导入 ${row.platformUserId || row.userName || row.key}`}
                      onChange={(event) => toggleChecked(row.key, event.target.checked)}
                    />
                  ),
                },
                {
                  title: '用户名称', dataIndex: 'userName', width: 190, fixed: 'left',
                  render: (value: string, row, index) => (
                    <Input
                      value={value}
                      aria-label={`第 ${index + 1} 行 用户名称`}
                      onChange={(event) => updateRow(row.key, { userName: event.target.value })}
                    />
                  ),
                },
                {
                  title: '平台用户', dataIndex: 'platformUserId', width: 210,
                  render: (value: string, row, index) => (
                    <Input
                      value={value}
                      aria-label={`第 ${index + 1} 行 平台用户`}
                      onChange={(event) => updateRow(row.key, { platformUserId: event.target.value })}
                    />
                  ),
                },
                {
                  title: 'Salesforce Username', dataIndex: 'salesforceUsername', width: 260,
                  render: (value: string, row, index) => (
                    <Input
                      value={value}
                      aria-label={`第 ${index + 1} 行 Salesforce Username`}
                      onChange={(event) => updateRow(row.key, { salesforceUsername: event.target.value })}
                    />
                  ),
                },
                {
                  title: '备注', dataIndex: 'remark', width: 220,
                  render: (value: string | null, row, index) => (
                    <Input
                      value={value ?? ''}
                      aria-label={`第 ${index + 1} 行 备注`}
                      placeholder="可留空"
                      onChange={(event) => updateRow(row.key, { remark: event.target.value ? event.target.value : null })}
                    />
                  ),
                },
                {
                  title: '校验', key: 'errors', width: 300, fixed: 'right',
                  render: (_value, row) => <RowIssues row={row} serverError={serverFailures[row.key]} />,
                },
              ]}
            />
            <Space className="full-width row-end-actions">
              <Typography.Text type="secondary">可导入 {selectedCount} 条，共 {draftRows.length} 行</Typography.Text>
              <Space>
                <Button icon={<RollbackOutlined />} disabled={submitting} onClick={() => setStep(0)}>返回修改</Button>
                <Button
                  type="primary"
                  disabled={selectedCount === 0}
                  loading={submitting}
                  onClick={() => void confirmSave()}
                >保存 {selectedCount > 0 ? `${selectedCount} 条` : ''}并生成凭证</Button>
              </Space>
            </Space>
          </Space>
        ) : null}

        {step === 2 ? (
          <Space orientation="vertical" size="middle" className="full-width">
            <Alert
              type="success"
              showIcon
              title={`已保存 ${committed.length} 条身份路由，每条均已自动生成 USER_BOUND 接入凭证。`}
              description={verifying
                ? '正在逐条验证与 Salesforce 的连通性（按需建连，通常数秒），请稍候…'
                : '验证结果不写入状态列；可在列表中随时用「验证」复检。'}
            />
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={[...committed]}
              columns={[
                {
                  title: '用户名称', width: 180,
                  render: (_value, entry) => entry.route.userName,
                },
                {
                  title: '平台用户', width: 200,
                  render: (_value, entry) => <code>{entry.route.platformUserId}</code>,
                },
                {
                  title: 'Salesforce Username', width: 260,
                  render: (_value, entry) => entry.route.salesforceUsername,
                },
                {
                  title: '备注', width: 200,
                  render: (_value, entry) => entry.route.remark ?? '—',
                },
                {
                  title: '验证结果', width: 360,
                  render: (_value, entry) => <VerifyCell state={verifyStates[entry.route.id]} />,
                },
                {
                  title: '操作', width: 120, fixed: 'right',
                  render: (_value, entry) => {
                    const state = verifyStates[entry.route.id];
                    const failed = state === undefined || state.status === 'pending' || !isPassed(state);
                    return (
                      <Button
                        size="small"
                        disabled={!failed || verifying}
                        onClick={() => onEditRoute({ ...entry.route, credential: null })}
                      >编辑</Button>
                    );
                  },
                },
              ]}
            />
            <Space className="full-width row-end-actions">
              <VerifySummary states={verifyStates} entries={committed} />
              <Space>
                <Button
                  icon={<ReloadOutlined />}
                  disabled={verifying || !committed.some((entry) => !isPassed(verifyStates[entry.route.id]))}
                  loading={verifying}
                  onClick={() => void retryFailed()}
                >重试失败项</Button>
                <Button type="primary" onClick={close}>完成</Button>
              </Space>
            </Space>
          </Space>
        ) : null}
      </Space>
    </Modal>
  );
}

function RowIssues({ row, serverError }: Readonly<{ row: DraftRouteRow; serverError?: string }>) {
  const errors = serverError ? [...row.errors, serverError] : row.errors;
  if (errors.length === 0) {
    return <Space size={4}><CheckCircleOutlined className="success-icon" /><Typography.Text type="success">可导入</Typography.Text></Space>;
  }
  return (
    <Space orientation="vertical" size={2} className="full-width">
      {errors.map((error) => (
        <Typography.Text key={error} type="danger" className="batch-issue"><CloseCircleOutlined /> {error}</Typography.Text>
      ))}
    </Space>
  );
}

function VerifyCell({ state }: Readonly<{ state: VerifyState | undefined }>) {
  if (!state || state.status === 'pending') {
    return <Space size={4}><Spin indicator={<LoadingOutlined spin />} size="small" /> 验证中…</Space>;
  }
  if (state.status === 'error') {
    return (
      <Space size={4}>
        <StatusTag label="FAIL" />
        <Tooltip title={`${state.code ? `[${state.code}] ` : ''}${state.message}`}>
          <Typography.Text type="secondary" ellipsis className="verify-fail-text">{state.message}</Typography.Text>
        </Tooltip>
      </Space>
    );
  }
  const verification = state.verification;
  return (
    <Space orientation="vertical" size={2}>
      <Space size={4}>
        <StatusTag label={verification.status} />
        <Typography.Text type="secondary">身份一致：{verification.identityMatched ? '是' : '否'} · {verification.durationMs} ms</Typography.Text>
      </Space>
      {verification.error ? (
        <Typography.Text type="danger" className="batch-issue"><code>{verification.error.code}</code> {verification.error.message}</Typography.Text>
      ) : (
        <Typography.Text type="secondary" className="wrap-value">{verification.salesforceUsername ?? '—'}</Typography.Text>
      )}
    </Space>
  );
}

function VerifySummary({ entries, states }: Readonly<{ entries: readonly CommittedRoute[]; states: Record<string, VerifyState> }>) {
  const passed = entries.filter((entry) => isPassed(states[entry.route.id])).length;
  const failed = entries.filter((entry) => {
    const state = states[entry.route.id];
    return state !== undefined && state.status !== 'pending' && !isPassed(state);
  }).length;
  return (
    <Space size="middle">
      <Typography.Text>共 {entries.length} 条</Typography.Text>
      <Tag color="success">通过 {passed}</Tag>
      <Tag color={failed > 0 ? 'error' : 'default'}>失败 {failed}</Tag>
    </Space>
  );
}

function isPassed(state: VerifyState | undefined): boolean {
  return state?.status === 'done' && state.verification.status === 'PASS';
}
