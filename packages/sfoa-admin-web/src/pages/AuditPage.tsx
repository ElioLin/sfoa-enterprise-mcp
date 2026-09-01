import { FilterOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Form, Input, Pagination, Segmented, Select, Space, Typography } from 'antd';
import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AuditKind, AuditRecord } from '@sfoa/control-plane';
import { adminApi, type AuditFilters } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';
import { formatDateTime } from '../localization.js';
import { AuditTraceWorkbench } from './audit/AuditTraceWorkbench.js';
import './audit/audit-trace.css';

const PAGE_SIZE = 25;
type QuickResult = 'ALL' | 'ERROR' | 'BLOCKED' | 'UNKNOWN';
type AuditFilterForm = Readonly<{
  occurredFrom?: string;
  occurredTo?: string;
  auditId?: string;
  correlationId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  toolName?: string;
  result?: AuditFilters['result'];
  outcome?: AuditFilters['outcome'];
  errorCode?: string;
  objectApiName?: string;
  recordId?: string;
  auditKind?: AuditFilters['auditKind'];
  auditIntegrityStatus?: AuditFilters['auditIntegrityStatus'];
}>;

export default function AuditPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [form] = Form.useForm<AuditFilterForm>();
  const selectedId = searchParams.get('selected');
  const searchParamsKey = searchParams.toString();
  const filters = useMemo(
    () => filtersFromSearchParams(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
  const query = useQuery({ queryKey: ['audits', filters], queryFn: () => adminApi.audits(filters) });
  const trace = useQuery({
    queryKey: ['audit-trace', selectedId],
    queryFn: () => adminApi.auditTrace(selectedId ?? '0'),
    enabled: selectedId !== null,
    staleTime: 15_000,
  });

  useEffect(() => {
    form.setFieldsValue({
      occurredFrom: undefined, occurredTo: undefined, auditId: undefined, correlationId: undefined,
      platformUserId: undefined, salesforceUsername: undefined, toolName: undefined, result: undefined, outcome: undefined,
      errorCode: undefined, objectApiName: undefined, recordId: undefined, auditKind: undefined, auditIntegrityStatus: undefined,
      ...formValuesFromFilters(filters),
    });
  }, [filters, form]);

  useEffect(() => {
    if (selectedId || !query.data?.items[0]) return;
    updateSearchParams(setSearchParams, filters, query.data.items[0].id, true);
  }, [filters, query.data?.items, selectedId, setSearchParams]);

  const commitFilters = (next: AuditFilters, selected: string | null = null): void => {
    updateSearchParams(setSearchParams, next, selected);
  };
  const applyFilters = (values: AuditFilterForm): void => {
    commitFilters({ ...compactFilters(values), limit: PAGE_SIZE, offset: 0 });
  };
  const clearFilters = (): void => {
    form.setFieldsValue({
      occurredFrom: undefined, occurredTo: undefined, auditId: undefined, correlationId: undefined,
      platformUserId: undefined, salesforceUsername: undefined, toolName: undefined, result: undefined, outcome: undefined,
      errorCode: undefined, objectApiName: undefined, recordId: undefined, auditKind: undefined, auditIntegrityStatus: undefined,
    });
    commitFilters({ limit: PAGE_SIZE, offset: 0 });
  };
  const quickResult: QuickResult = filters.outcome === 'UNKNOWN' ? 'UNKNOWN' : filters.result === 'ERROR' ? 'ERROR' : filters.result === 'BLOCKED' ? 'BLOCKED' : 'ALL';
  const applyQuickResult = (value: QuickResult): void => {
    form.setFieldsValue({
      result: value === 'ERROR' || value === 'BLOCKED' ? value : undefined,
      outcome: value === 'UNKNOWN' ? 'UNKNOWN' : undefined,
    });
    const next: AuditFilters = {
      ...filtersWithoutQuickResult(filters),
      ...(value === 'ERROR' || value === 'BLOCKED' ? { result: value } : {}),
      ...(value === 'UNKNOWN' ? { outcome: 'UNKNOWN' as const } : {}),
      offset: 0,
    };
    commitFilters(next);
  };

  return (
    <PageFrame
      title="全链路审计工作台"
      description="从智能体请求、身份路由、Salesforce API、SOQL/DML 到 MCP 响应，在一个工作台中还原真实执行链路。"
      action={<Button aria-label="刷新审计数据" icon={<ReloadOutlined />} loading={query.isFetching || trace.isFetching} onClick={() => { void query.refetch(); if (selectedId) void trace.refetch(); }}>刷新</Button>}
    >
      <Space orientation="vertical" size="middle" className="full-width">
        <div className="surface-card audit-filter-card">
          <div className="audit-filter-topline">
            <Segmented
              value={quickResult}
              onChange={(value) => applyQuickResult(value as QuickResult)}
              options={[
                { label: '全部', value: 'ALL' },
                { label: '失败', value: 'ERROR' },
                { label: '已阻止', value: 'BLOCKED' },
                { label: 'UNKNOWN', value: 'UNKNOWN' },
              ]}
            />
            <Typography.Text type="secondary">失败排障优先：可先筛选失败，再从右侧“第一失败节点”直接定位。</Typography.Text>
          </div>
          <Form<AuditFilterForm> form={form} layout="vertical" onFinish={applyFilters} initialValues={formValuesFromFilters(filters)}>
            <div className="audit-filter-core-grid">
              <Form.Item name="toolName" label="快速搜索（Tool）"><Input allowClear maxLength={128} placeholder="例如 create_record" /></Form.Item>
              <Form.Item name="platformUserId" label="平台用户"><Input allowClear maxLength={128} /></Form.Item>
              <Form.Item name="salesforceUsername" label="Salesforce 执行用户"><Input allowClear maxLength={320} /></Form.Item>
              <Form.Item name="result" label="结果">
                <Select allowClear options={[
                  { value: 'PASS', label: '通过（PASS）' },
                  { value: 'BLOCKED', label: '已阻止（BLOCKED）' },
                  { value: 'ERROR', label: '错误（ERROR）' },
                ]} />
              </Form.Item>
            </div>
            <details className="audit-advanced-filters">
              <summary><FilterOutlined /> 更多筛选</summary>
              <div className="filter-grid audit-filter-advanced-grid">
                <Form.Item name="occurredFrom" label="开始时间"><Input type="datetime-local" /></Form.Item>
                <Form.Item name="occurredTo" label="结束时间"><Input type="datetime-local" /></Form.Item>
                <Form.Item name="auditId" label="Audit ID"><Input allowClear maxLength={36} /></Form.Item>
                <Form.Item name="correlationId" label="Correlation ID"><Input allowClear maxLength={128} /></Form.Item>
                <Form.Item name="outcome" label="调用结果（Outcome）">
                  <Select allowClear options={['SUCCESS', 'FAILED', 'DENIED', 'UNKNOWN'].map((value) => ({ value, label: value }))} />
                </Form.Item>
                <Form.Item name="errorCode" label="Error Code"><Input allowClear maxLength={128} /></Form.Item>
                <Form.Item name="objectApiName" label="对象 API 名称"><Input allowClear maxLength={128} /></Form.Item>
                <Form.Item name="recordId" label="Record ID"><Input allowClear maxLength={128} /></Form.Item>
                <Form.Item name="auditKind" label="审计类型">
                  <Select allowClear options={[
                    { value: 'MCP_TOOL_CALL', label: 'MCP Tool 调用' },
                    { value: 'ADMIN_ACTION', label: '管理操作' },
                    { value: 'IDENTITY_VALIDATION', label: '身份验证' },
                    { value: 'RUNTIME_EVENT', label: '运行事件' },
                  ]} />
                </Form.Item>
                <Form.Item name="auditIntegrityStatus" label="审计完整性">
                  <Select allowClear options={[
                    { value: 'COMPLETE', label: '完整（COMPLETE）' },
                    { value: 'PARTIAL', label: '部分（PARTIAL）' },
                    { value: 'DEGRADED', label: '降级（DEGRADED）' },
                  ]} />
                </Form.Item>
              </div>
            </details>
            <Space wrap>
              <Button aria-label="搜索审计" type="primary" htmlType="submit" icon={<SearchOutlined />}>搜索审计</Button>
              <Button aria-label="清除筛选" icon={<FilterOutlined />} onClick={clearFilters}>清除筛选</Button>
            </Space>
          </Form>
        </div>

        {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : (
          <div className="audit-split-workbench">
            <aside className="audit-list-pane" aria-label="审计记录列表">
              <div className="audit-list-pane-heading">
                <div><strong>调用记录</strong><small>当前页 {query.data.count} 条</small></div>
                {query.isFetching ? <Typography.Text type="secondary">正在刷新…</Typography.Text> : null}
              </div>
              {query.data.items.length === 0 ? <EmptyState description="没有匹配当前筛选条件的审计记录。" /> : (
                <div className="audit-card-list">
                  {query.data.items.map((record) => (
                    <AuditListCard
                      key={record.id}
                      record={record}
                      selected={record.id === selectedId}
                      onSelect={() => updateSearchParams(setSearchParams, filters, record.id)}
                    />
                  ))}
                </div>
              )}
              <Pagination
                className="audit-list-pagination"
                simple
                current={Math.floor(filters.offset / PAGE_SIZE) + 1}
                pageSize={PAGE_SIZE}
                total={filters.offset + query.data.count + (query.data.hasMore ? 1 : 0)}
                showSizeChanger={false}
                onChange={(page) => commitFilters({ ...filters, offset: (page - 1) * PAGE_SIZE })}
              />
            </aside>
            <main className="audit-detail-pane" aria-live="polite">
              {!selectedId ? <div className="audit-detail-empty"><Typography.Title level={4}>选择一条审计记录</Typography.Title><Typography.Text type="secondary">右侧将展示完整调用链、Salesforce API、SOQL/DML 与请求响应证据。</Typography.Text></div>
                : trace.isPending ? <LoadingState rows={10} />
                  : trace.isError ? <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />
                    : trace.data ? <AuditTraceWorkbench trace={trace.data} /> : null}
            </main>
          </div>
        )}
      </Space>
    </PageFrame>
  );
}

function AuditListCard({ record, selected, onSelect }: Readonly<{ record: AuditRecord; selected: boolean; onSelect(): void }>) {
  return (
    <button type="button" className={`audit-list-card${selected ? ' is-selected' : ''}`} onClick={onSelect}>
      <div className="audit-list-card-top"><strong>{record.toolName ?? kindLabel(record.auditKind)}</strong><StatusTag label={record.outcome ?? record.result} /></div>
      <div className="audit-list-card-meta"><span>{formatDateTime(record.occurredAt)}</span><span>{record.durationMs === null ? '—' : `${record.durationMs} ms`}</span></div>
      <div className="audit-list-card-user"><span>{record.platformUserId ?? record.actorAdmin ?? '—'}</span><span>→</span><span title={record.salesforceUsername ?? ''}>{record.salesforceUsername ?? '—'}</span></div>
      <div className="audit-list-card-context"><span>{identitySourceLabel(record.identitySource)}</span><code title={record.correlationId}>{record.correlationId}</code></div>
      {record.errorCode ? <code className="audit-list-error-code">{record.errorCode}</code> : record.objectApiName ? <span className="audit-list-object">{record.objectApiName}{record.recordId ? ` · ${record.recordId}` : ''}</span> : null}
      {record.auditIntegrityStatus !== 'COMPLETE' ? <span className="audit-list-integrity">审计：{record.auditIntegrityStatus}</span> : null}
    </button>
  );
}

function filtersWithoutQuickResult(filters: AuditFilters): AuditFilters {
  return {
    ...(filters.occurredFrom ? { occurredFrom: filters.occurredFrom } : {}),
    ...(filters.occurredTo ? { occurredTo: filters.occurredTo } : {}),
    ...(filters.auditId ? { auditId: filters.auditId } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(filters.platformUserId ? { platformUserId: filters.platformUserId } : {}),
    ...(filters.salesforceUsername ? { salesforceUsername: filters.salesforceUsername } : {}),
    ...(filters.toolName ? { toolName: filters.toolName } : {}),
    ...(filters.errorCode ? { errorCode: filters.errorCode } : {}),
    ...(filters.objectApiName ? { objectApiName: filters.objectApiName } : {}),
    ...(filters.recordId ? { recordId: filters.recordId } : {}),
    ...(filters.auditKind ? { auditKind: filters.auditKind } : {}),
    ...(filters.auditIntegrityStatus ? { auditIntegrityStatus: filters.auditIntegrityStatus } : {}),
    limit: filters.limit,
    offset: filters.offset,
  };
}

function compactFilters(values: AuditFilterForm): Omit<AuditFilters, 'limit' | 'offset'> {
  return {
    ...(values.occurredFrom ? { occurredFrom: new Date(values.occurredFrom).toISOString() } : {}),
    ...(values.occurredTo ? { occurredTo: new Date(values.occurredTo).toISOString() } : {}),
    ...(values.auditId?.trim() ? { auditId: values.auditId.trim() } : {}),
    ...(values.correlationId?.trim() ? { correlationId: values.correlationId.trim() } : {}),
    ...(values.platformUserId?.trim() ? { platformUserId: values.platformUserId.trim() } : {}),
    ...(values.salesforceUsername?.trim() ? { salesforceUsername: values.salesforceUsername.trim() } : {}),
    ...(values.toolName?.trim() ? { toolName: values.toolName.trim() } : {}),
    ...(values.result ? { result: values.result } : {}),
    ...(values.outcome ? { outcome: values.outcome } : {}),
    ...(values.errorCode?.trim() ? { errorCode: values.errorCode.trim() } : {}),
    ...(values.objectApiName?.trim() ? { objectApiName: values.objectApiName.trim() } : {}),
    ...(values.recordId?.trim() ? { recordId: values.recordId.trim() } : {}),
    ...(values.auditKind ? { auditKind: values.auditKind } : {}),
    ...(values.auditIntegrityStatus ? { auditIntegrityStatus: values.auditIntegrityStatus } : {}),
  };
}

function filtersFromSearchParams(params: URLSearchParams): AuditFilters {
  const limit = PAGE_SIZE;
  const offset = parsePositiveInt(params.get('offset')) ?? 0;
  return {
    ...stringParam(params, 'occurredFrom'),
    ...stringParam(params, 'occurredTo'),
    ...stringParam(params, 'auditId'),
    ...stringParam(params, 'correlationId'),
    ...stringParam(params, 'platformUserId'),
    ...stringParam(params, 'salesforceUsername'),
    ...stringParam(params, 'toolName'),
    ...enumParam(params, 'result', ['PASS', 'ERROR', 'BLOCKED'] as const),
    ...enumParam(params, 'outcome', ['SUCCESS', 'FAILED', 'DENIED', 'UNKNOWN'] as const),
    ...stringParam(params, 'errorCode'),
    ...stringParam(params, 'objectApiName'),
    ...stringParam(params, 'recordId'),
    ...enumParam(params, 'auditKind', ['MCP_TOOL_CALL', 'ADMIN_ACTION', 'IDENTITY_VALIDATION', 'RUNTIME_EVENT'] as const),
    ...enumParam(params, 'auditIntegrityStatus', ['COMPLETE', 'PARTIAL', 'DEGRADED'] as const),
    limit,
    offset,
  } as AuditFilters;
}

function formValuesFromFilters(filters: AuditFilters): AuditFilterForm {
  const occurredFrom = toLocalDateTime(filters.occurredFrom);
  const occurredTo = toLocalDateTime(filters.occurredTo);
  return {
    ...(filters.auditId ? { auditId: filters.auditId } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(filters.platformUserId ? { platformUserId: filters.platformUserId } : {}),
    ...(filters.salesforceUsername ? { salesforceUsername: filters.salesforceUsername } : {}),
    ...(filters.toolName ? { toolName: filters.toolName } : {}),
    ...(filters.result ? { result: filters.result } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    ...(filters.errorCode ? { errorCode: filters.errorCode } : {}),
    ...(filters.objectApiName ? { objectApiName: filters.objectApiName } : {}),
    ...(filters.recordId ? { recordId: filters.recordId } : {}),
    ...(filters.auditKind ? { auditKind: filters.auditKind } : {}),
    ...(filters.auditIntegrityStatus ? { auditIntegrityStatus: filters.auditIntegrityStatus } : {}),
    ...(occurredFrom ? { occurredFrom } : {}),
    ...(occurredTo ? { occurredTo } : {}),
  };
}
function updateSearchParams(setter: ReturnType<typeof useSearchParams>[1], filters: AuditFilters, selected: string | null, replace = false): void {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'limit' || value === undefined || value === '') continue;
    if (key === 'offset' && value === 0) continue;
    params.set(key, String(value));
  }
  if (selected) params.set('selected', selected);
  setter(params, { replace });
}
function stringParam(params: URLSearchParams, key: string): Record<string, string> {
  const value = params.get(key)?.trim();
  return value ? { [key]: value } : {};
}
function enumParam<T extends readonly string[]>(params: URLSearchParams, key: string, values: T): Record<string, T[number]> {
  const value = params.get(key);
  return value && (values as readonly string[]).includes(value) ? { [key]: value as T[number] } : {};
}
function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
function toLocalDateTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function identitySourceLabel(source: AuditRecord['identitySource']): string {
  switch (source) {
    case 'INTERNAL_SERVICE_HEADER': return '内部服务凭据';
    case 'USER_BOUND_TOKEN': return '用户绑定 Token';
    case 'BUNTU_TOKEN': return '小犇 Token';
    default: return '身份来源未记录';
  }
}

function kindLabel(kind: AuditKind): string {
  switch (kind) {
    case 'ADMIN_ACTION': return '管理操作';
    case 'IDENTITY_VALIDATION': return '身份验证';
    case 'RUNTIME_EVENT': return '运行事件';
    default: return 'MCP Tool';
  }
}
