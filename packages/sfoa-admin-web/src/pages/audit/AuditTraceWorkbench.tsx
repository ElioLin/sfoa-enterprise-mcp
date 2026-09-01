import {
  ApiOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DatabaseOutlined,
  ExclamationCircleOutlined,
  FieldTimeOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Alert, Button, Descriptions, Empty, Segmented, Space, Tag, Typography, message } from 'antd';
import { useRef, useState, type ReactNode } from 'react';
import type {
  AdminAuditTraceDto,
  AuditEventRecord,
  AuditPayloadEvidenceSummaryRecord,
  IdentitySource,
  SalesforceApiCallRecord,
} from '@sfoa/control-plane';
import { StatusTag } from '../../components/StatusTag.js';
import { formatDateTime } from '../../localization.js';
import { PayloadEvidenceViewer, formatBytes, payloadTypeLabel } from './PayloadEvidenceViewer.js';

export function AuditTraceWorkbench({ trace }: Readonly<{ trace: AdminAuditTraceDto }>) {
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('ALL');
  const [payload, setPayload] = useState<AuditPayloadEvidenceSummaryRecord | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const audit = trace.audit;
  if (audit.auditKind !== 'MCP_TOOL_CALL') return <SimpleAuditDetail trace={trace} />;
  const timeline = buildTimeline(trace.events, trace.salesforceApiCalls).filter((entry) => matchesTimelineFilter(entry, timelineFilter));
  const soqlCalls = trace.salesforceApiCalls.filter((api) => Boolean(api.queryType));
  const dmlCalls = trace.salesforceApiCalls.filter((api) => Boolean(api.dmlOperation));
  const maxDuration = Math.max(1, ...trace.salesforceApiCalls.map((api) => api.durationMs ?? 0));
  const outcomeUnknown = audit.outcome === 'UNKNOWN';
  const jumpToFailure = (): void => {
    const sequence = trace.firstFailure?.sequence;
    if (sequence === null || sequence === undefined) return;
    setTimelineFilter('ALL');
    window.setTimeout(() => {
      timelineRef.current?.querySelector<HTMLElement>(`[data-sequence="${sequence}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  };
  return (
    <div className="audit-workbench">
      <section className="audit-overview-card">
        <div className="audit-overview-heading">
          <div>
            <Space size="small" wrap>
              <Typography.Title level={3} className="audit-tool-title">{audit.toolName ?? 'MCP Tool'}</Typography.Title>
              <StatusTag label={audit.outcome ?? audit.result} />
            </Space>
            <Typography.Paragraph type="secondary" className="audit-overview-subtitle">
              {audit.operation ?? '工具调用'}{audit.objectApiName ? ` · ${audit.objectApiName}` : ''}{audit.recordId ? ` · ${audit.recordId}` : ''}
            </Typography.Paragraph>
          </div>
          <Space wrap>
            <CopyButton value={audit.publicAuditId} label="Audit ID" />
            <CopyButton value={audit.correlationId} label="Correlation ID" />
          </Space>
        </div>
        {outcomeUnknown ? (
          <Alert
            type="warning"
            showIcon
            title="操作结果未知（UNKNOWN）"
            description="无法确认 Salesforce 最终提交状态；这不代表 Salesforce 操作失败。请先通过独立读取核实，避免直接重试。"
          />
        ) : null}
        {audit.auditIntegrityStatus !== 'COMPLETE' || trace.summary.detailsTruncated ? (
          <Alert
            type="warning"
            showIcon
            title={audit.auditIntegrityStatus === 'DEGRADED' ? '审计持久化已降级' : '审计证据不完整'}
            description="部分 Event、API 或 Payload 可能因有界采集/查询上限而未展示。排障结论应结合审计完整性状态。"
          />
        ) : null}
        <div className="audit-stat-grid">
          <StatItem icon={<ClockCircleOutlined />} label="总耗时" value={formatDuration(audit.durationMs)} />
          <StatItem icon={<ApiOutlined />} label="Salesforce API" value={String(trace.summary.apiCount)} />
          <StatItem icon={<CodeOutlined />} label="SOQL" value={String(trace.summary.soqlCount)} />
          <StatItem icon={<DatabaseOutlined />} label="DML" value={String(trace.summary.dmlCount)} />
          <StatItem icon={<ExclamationCircleOutlined />} label="错误节点" value={String(trace.summary.errorCount)} danger={trace.summary.errorCount > 0} />
          <StatItem icon={<SafetyCertificateOutlined />} label="审计完整性" value={integrityLabel(audit.auditIntegrityStatus)} />
        </div>
        <div className="audit-identity-grid">
          <IdentityFact icon={<UserOutlined />} label="平台用户" value={audit.platformUserId ?? '—'} copy={audit.platformUserId} />
          <IdentityFact icon={<UserOutlined />} label="Salesforce 执行用户" value={audit.salesforceUsername ?? '—'} copy={audit.salesforceUsername} />
          <IdentityFact label="身份来源" value={identitySourceLabel(audit.identitySource)} />
          <IdentityFact label="执行角色" value={audit.executionRole ?? '—'} />
          <IdentityFact label="对象" value={audit.objectApiName ?? '—'} copy={audit.objectApiName} />
          <IdentityFact label="Record ID" value={audit.recordId ?? '—'} copy={audit.recordId} />
        </div>
      </section>

      <section className="audit-section-card audit-error-center">
        <SectionTitle title="问题定位" subtitle="确定性展示首个失败节点，不使用 AI 推测根因。" />
        {trace.firstFailure ? (
          <Alert
            type={trace.firstFailure.status === 'UNKNOWN' ? 'warning' : 'error'}
            showIcon
            title={`${trace.firstFailure.title} · ${trace.firstFailure.status}`}
            description={
              <Space orientation="vertical" size={4}>
                <span>{trace.firstFailure.errorCode ? `错误码：${trace.firstFailure.errorCode}` : '未记录错误码'}</span>
                {trace.firstFailure.message ? <span>{trace.firstFailure.message}</span> : null}
                {trace.firstFailure.sequence !== null ? <span>执行序号：#{trace.firstFailure.sequence}</span> : null}
              </Space>
            }
            action={trace.firstFailure.sequence !== null ? <Button size="small" onClick={jumpToFailure}>跳转到失败节点</Button> : undefined}
          />
        ) : (
          <div className="audit-success-strip"><CheckCircleOutlined /> 未发现执行错误</div>
        )}
      </section>

      <section className="audit-section-card" ref={timelineRef}>
        <div className="audit-section-heading audit-section-heading-responsive">
          <SectionTitle title="执行时间线（Execution Timeline）" subtitle="按请求级 sequence 还原 MCP 与 Salesforce 的实际执行顺序。" />
          <Segmented
            size="small"
            value={timelineFilter}
            onChange={(value) => setTimelineFilter(value as TimelineFilter)}
            options={[
              { label: '全部', value: 'ALL' },
              { label: '错误', value: 'ERROR' },
              { label: 'Salesforce API', value: 'API' },
              { label: 'SOQL', value: 'SOQL' },
              { label: 'DML', value: 'DML' },
              { label: 'MCP', value: 'MCP' },
            ]}
          />
        </div>
        {timeline.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选没有执行节点。" /> : (
          <div className="audit-timeline">
            {timeline.map((entry) => <TimelineRow key={`${entry.kind}-${entry.id}`} entry={entry} />)}
          </div>
        )}
      </section>

      <section className="audit-section-card">
        <SectionTitle title="Salesforce API" subtitle="每一行对应一个真实 Salesforce 调用事实；URL、状态与耗时均可直接用于排障。" />
        {trace.salesforceApiCalls.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此调用没有 Salesforce API 证据。" /> : (
          <div className="api-table" role="table" aria-label="Salesforce API 调用">
            <div className="api-table-row api-table-header" role="row">
              <span>#</span><span>API / 用途</span><span>方法</span><span>HTTP</span><span>耗时</span><span>相对耗时</span>
            </div>
            {trace.salesforceApiCalls.map((api) => (
              <div className="api-table-row" role="row" key={api.id}>
                <span>#{api.sequence}</span>
                <span className="api-main-cell">
                  <strong>{apiCategoryLabel(api.apiCategory)}</strong>
                  <small>{api.purpose}</small>
                  <code title={api.requestUrl ?? api.operationName ?? ''}>{api.endpointPath ?? api.operationName ?? '—'}</code>
                  <Space size={4} wrap>
                    {api.requestUrl ? <CopyButton compact value={api.requestUrl} label="URL" /> : null}
                    {api.salesforceErrorCode ? <CopyButton compact value={api.salesforceErrorCode} label="错误码" /> : null}
                  </Space>
                </span>
                <span>{api.httpMethod ?? '—'}</span>
                <span><StatusTag label={api.httpStatus === null ? api.result : String(api.httpStatus)} tone={api.result === 'FAILED' ? 'error' : api.result === 'UNKNOWN' ? 'warning' : 'success'} /></span>
                <span>{formatDuration(api.durationMs)}</span>
                <span><span className="api-waterfall"><i style={{ width: `${Math.max(4, ((api.durationMs ?? 0) / maxDuration) * 100)}%` }} /></span></span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="audit-section-card">
        <SectionTitle title="SOQL 查询证据" subtitle="直接查看查询语句、用途与返回规模，不需要自行解码 URL。" />
        {soqlCalls.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此调用未执行 SOQL 查询。" /> : (
          <div className="evidence-card-grid">
            {soqlCalls.map((api) => <SoqlCard key={api.id} api={api} />)}
          </div>
        )}
      </section>

      <section className="audit-section-card">
        <SectionTitle title="DML 变更证据" subtitle="对比智能体请求、MCP 服务端托管字段与真正提交给 Salesforce 的最终值。" />
        {dmlCalls.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此调用没有 CREATE / UPDATE 证据。" /> : (
          <div className="evidence-card-grid">
            {dmlCalls.map((api) => <DmlCard key={api.id} api={api} />)}
          </div>
        )}
      </section>

      <section className="audit-section-card">
        <SectionTitle title="请求与响应载荷（Payload Evidence）" subtitle="正文按需加载，打开审计详情不会预读大型 Payload。" />
        {trace.payloadMetadata.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="此调用没有保存 Payload Evidence。" /> : (
          <div className="payload-metadata-grid">
            {trace.payloadMetadata.map((item) => (
              <button className="payload-metadata-card" type="button" key={item.id} onClick={() => setPayload(item)}>
                <div><strong>{payloadTypeLabel(item.payloadType)}</strong>{item.truncated ? <Tag color="warning">已截断</Tag> : null}</div>
                <span>{item.contentType}</span>
                <span>{formatBytes(String(item.storedSizeBytes))}{item.originalSizeBytes ? ` / 原始 ${formatBytes(item.originalSizeBytes)}` : ''}</span>
                <small>{payloadOwnerLabel(item, trace.salesforceApiCalls)}</small>
              </button>
            ))}
          </div>
        )}
      </section>
      <PayloadEvidenceViewer payload={payload} open={payload !== null} onClose={() => setPayload(null)} />
    </div>
  );
}

type TimelineFilter = 'ALL' | 'ERROR' | 'API' | 'SOQL' | 'DML' | 'MCP';
type TimelineEntry = Readonly<{
  kind: 'EVENT' | 'API';
  id: string;
  sequence: number;
  category: string;
  title: string;
  subtitle: string;
  status: string;
  error: boolean;
  unknown: boolean;
  durationMs: number | null;
  detail: AuditEventRecord | SalesforceApiCallRecord;
}>;

function buildTimeline(events: readonly AuditEventRecord[], apis: readonly SalesforceApiCallRecord[]): readonly TimelineEntry[] {
  const rows: TimelineEntry[] = [
    ...events.map((event) => Object.freeze({
      kind: 'EVENT' as const,
      id: event.id,
      sequence: event.sequence,
      category: event.eventCategory,
      title: event.eventName,
      subtitle: event.eventType,
      status: event.status,
      error: event.status === 'FAILED' || event.status === 'BLOCKED' || event.status === 'UNKNOWN',
      unknown: event.status === 'UNKNOWN',
      durationMs: event.durationMs,
      detail: event,
    })),
    ...apis.map((api) => Object.freeze({
      kind: 'API' as const,
      id: api.id,
      sequence: api.sequence,
      category: api.queryType ? 'SOQL' : api.dmlOperation ? 'DML' : 'SALESFORCE',
      title: api.queryType
        ? `${api.queryType} · ${api.objectApiName ?? api.apiCategory}`
        : api.dmlOperation
          ? `${api.dmlOperation} · ${api.objectApiName ?? 'Salesforce'}`
          : `${apiCategoryLabel(api.apiCategory)} · ${api.purpose}`,
      subtitle: api.endpointPath ?? api.operationName ?? api.purpose,
      status: api.result,
      error: api.result !== 'SUCCESS',
      unknown: api.result === 'UNKNOWN',
      durationMs: api.durationMs,
      detail: api,
    })),
  ];
  return Object.freeze(rows.sort((left, right) => left.sequence - right.sequence || (left.kind === 'EVENT' ? -1 : 1)));
}

function matchesTimelineFilter(entry: TimelineEntry, filter: TimelineFilter): boolean {
  switch (filter) {
    case 'ERROR': return entry.error;
    case 'API': return entry.kind === 'API';
    case 'SOQL': return entry.category === 'SOQL';
    case 'DML': return entry.category === 'DML';
    case 'MCP': return entry.category === 'MCP';
    default: return true;
  }
}

function TimelineRow({ entry }: Readonly<{ entry: TimelineEntry }>) {
  return (
    <details className={`timeline-row timeline-${entry.category.toLocaleLowerCase()}${entry.error ? ' timeline-error' : ''}${entry.unknown ? ' timeline-unknown' : ''}`} data-sequence={entry.sequence}>
      <summary>
        <span className="timeline-dot" />
        <span className="timeline-sequence">#{entry.sequence}</span>
        <span className="timeline-title"><strong>{entry.title}</strong><small>{entry.subtitle}</small></span>
        <span><StatusTag label={entry.status} tone={entry.unknown ? 'warning' : entry.error ? 'error' : undefined} /></span>
        <span className="timeline-duration"><FieldTimeOutlined /> {formatDuration(entry.durationMs)}</span>
      </summary>
      <div className="timeline-detail">
        {entry.kind === 'EVENT' ? <EventDetail event={entry.detail as AuditEventRecord} /> : <ApiDetail api={entry.detail as SalesforceApiCallRecord} />}
      </div>
    </details>
  );
}

function EventDetail({ event }: Readonly<{ event: AuditEventRecord }>) {
  return (
    <Descriptions size="small" column={{ xs: 1, md: 2 }}>
      <Descriptions.Item label="类别">{event.eventCategory}</Descriptions.Item>
      <Descriptions.Item label="事件类型">{event.eventType}</Descriptions.Item>
      <Descriptions.Item label="开始时间">{formatDateTime(event.startedAt)}</Descriptions.Item>
      <Descriptions.Item label="耗时">{formatDuration(event.durationMs)}</Descriptions.Item>
      <Descriptions.Item label="错误码" span={{ xs: 1, md: 2 }}>{event.errorCode ? <Typography.Text copyable code>{event.errorCode}</Typography.Text> : '—'}</Descriptions.Item>
      <Descriptions.Item label="结构化摘要" span={{ xs: 1, md: 2 }}><pre className="audit-code-block compact-code-block">{formatUnknown(event.safeSummary)}</pre></Descriptions.Item>
    </Descriptions>
  );
}

function ApiDetail({ api }: Readonly<{ api: SalesforceApiCallRecord }>) {
  return (
    <Descriptions size="small" column={{ xs: 1, md: 2 }}>
      <Descriptions.Item label="API 类型">{apiCategoryLabel(api.apiCategory)}</Descriptions.Item>
      <Descriptions.Item label="用途">{api.purpose}</Descriptions.Item>
      <Descriptions.Item label="HTTP">{api.httpStatus ?? api.result}</Descriptions.Item>
      <Descriptions.Item label="耗时">{formatDuration(api.durationMs)}</Descriptions.Item>
      <Descriptions.Item label="完整 URL" span={{ xs: 1, md: 2 }}>{api.requestUrl ? <Typography.Text copyable code className="wrap-value">{api.requestUrl}</Typography.Text> : '不可观测'}</Descriptions.Item>
      {api.salesforceErrorCode ? <Descriptions.Item label="Salesforce 错误码" span={{ xs: 1, md: 2 }}><Typography.Text copyable code>{api.salesforceErrorCode}</Typography.Text></Descriptions.Item> : null}
      {api.salesforceErrorMessageSafe ? <Descriptions.Item label="Salesforce 错误" span={{ xs: 1, md: 2 }}>{api.salesforceErrorMessageSafe}</Descriptions.Item> : null}
    </Descriptions>
  );
}

function SoqlCard({ api }: Readonly<{ api: SalesforceApiCallRecord }>) {
  return (
    <article className="semantic-evidence-card">
      <div className="semantic-evidence-heading">
        <div><CodeOutlined /> <strong>{api.queryType ?? 'SOQL'}</strong> · {api.objectApiName ?? '对象未解析'}</div>
        <StatusTag label={api.result} />
      </div>
      <Descriptions size="small" column={{ xs: 1, md: 3 }}>
        <Descriptions.Item label="用途">{api.purpose}</Descriptions.Item>
        <Descriptions.Item label="totalSize">{api.totalSize ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="本次返回">{api.returnedRecords ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="是否结束">{api.done === null ? '—' : api.done ? '是' : '否'}</Descriptions.Item>
        <Descriptions.Item label="还有下一页">{api.hasNextRecords === null ? '—' : api.hasNextRecords ? '是' : '否'}</Descriptions.Item>
        <Descriptions.Item label="HTTP">{api.httpStatus ?? api.result}</Descriptions.Item>
        <Descriptions.Item label="耗时">{formatDuration(api.durationMs)}</Descriptions.Item>
      </Descriptions>
      <div className="code-block-heading"><span>SOQL</span>{api.soqlStatementSafe ? <CopyButton compact value={api.soqlStatementSafe} label="SOQL" /> : null}</div>
      <pre className="audit-code-block soql-code-block">{api.soqlStatementSafe ?? '未记录 SOQL 原文。'}</pre>
    </article>
  );
}

function DmlCard({ api }: Readonly<{ api: SalesforceApiCallRecord }>) {
  const requested = objectValue(api.requestedFields);
  const managed = objectValue(api.managedFields);
  const submitted = objectValue(api.submittedFields);
  const fields = [...new Set([...Object.keys(requested), ...Object.keys(managed), ...Object.keys(submitted)])].sort();
  return (
    <article className="semantic-evidence-card">
      <div className="semantic-evidence-heading">
        <div><DatabaseOutlined /> <strong>{api.dmlOperation}</strong> · {api.objectApiName ?? '—'}</div>
        <StatusTag label={api.result} />
      </div>
      <Space wrap className="dml-meta-row">
        <span>Record ID：{api.recordId ? <Typography.Text copyable code>{api.recordId}</Typography.Text> : '—'}</span>
        <span>HTTP：{api.httpStatus ?? '—'}</span>
        <span>耗时：{formatDuration(api.durationMs)}</span>
      </Space>
      {fields.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有结构化字段证据。" /> : (
        <div className="dml-field-table" role="table" aria-label={`${api.dmlOperation ?? 'DML'} 字段证据`}>
          <div className="dml-field-row dml-field-header" role="row"><span>字段</span><span>智能体请求</span><span>MCP 托管</span><span>最终提交</span></div>
          {fields.map((field) => (
            <div className="dml-field-row" role="row" key={field}>
              <code>{field}</code>
              <span>{displayValue(requested[field])}</span>
              <span>{displayValue(managed[field])}</span>
              <span>{displayValue(submitted[field])}</span>
            </div>
          ))}
        </div>
      )}
      {api.salesforceErrorMessageSafe ? <Alert type="error" showIcon title={api.salesforceErrorCode ?? 'Salesforce DML错误'} description={api.salesforceErrorMessageSafe} /> : null}
    </article>
  );
}

function SimpleAuditDetail({ trace }: Readonly<{ trace: AdminAuditTraceDto }>) {
  const record = trace.audit;
  const buntuRequest = isRecord(record.requestSummary) ? record.requestSummary : undefined;
  const buntuResponse = isRecord(record.responseSummary) ? record.responseSummary : undefined;
  const hasOptInBuntuRawToken = record.operation === 'BUNTU_TOKEN_VALIDATE' && typeof buntuRequest?.rawToken === 'string';
  return (
    <div className="audit-workbench">
      <section className="audit-section-card">
        <SectionTitle title={record.auditKind === 'IDENTITY_VALIDATION' ? '身份验证审计' : record.auditKind === 'ADMIN_ACTION' ? '管理操作审计' : '运行审计'} subtitle="此类审计保持简洁详情，不强行套用 MCP Salesforce 调用链。" />
        <Descriptions bordered size="small" column={{ xs: 1, lg: 2 }}>
          <Descriptions.Item label="发生时间">{formatDateTime(record.occurredAt)}</Descriptions.Item>
          <Descriptions.Item label="结果"><StatusTag label={record.result} /></Descriptions.Item>
          <Descriptions.Item label="身份来源">{identitySourceLabel(record.identitySource)}</Descriptions.Item>
          <Descriptions.Item label="执行角色">{record.executionRole ? <StatusTag label={record.executionRole} /> : '—'}</Descriptions.Item>
          <Descriptions.Item label="操作">{record.operation ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="平台用户">{record.platformUserId ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Salesforce 用户">{record.salesforceUsername ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Admin 操作人">{record.actorAdmin ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Client ID">{record.clientId ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="错误码">{record.errorCode ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Audit ID"><Typography.Text copyable code>{record.publicAuditId}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label="Correlation ID"><Typography.Text copyable code>{record.correlationId}</Typography.Text></Descriptions.Item>
        </Descriptions>
      </section>

      {record.operation === 'BUNTU_TOKEN_VALIDATE' ? (
        <section className="audit-section-card" aria-label="小犇 Token 校验详情">
          <SectionTitle title="小犇 Token 校验详情" subtitle="保留 P6 身份排障视图，同时纳入新的单页工作台。" />
          <Descriptions bordered size="small" column={{ xs: 1, lg: 2 }}>
            <Descriptions.Item label="校验结果">{buntuResponse?.valid === true ? <StatusTag label="PASS" /> : <StatusTag label={record.errorCode ?? 'DENIED'} />}</Descriptions.Item>
            <Descriptions.Item label="平台用户编号">{typeof buntuResponse?.userId === 'string' ? <code>{buntuResponse.userId}</code> : '—'}</Descriptions.Item>
            <Descriptions.Item label="上游 HTTP 状态">{typeof buntuResponse?.httpStatus === 'number' ? String(buntuResponse.httpStatus) : '未收到响应'}</Descriptions.Item>
            <Descriptions.Item label="校验耗时">{formatDuration(record.durationMs)}</Descriptions.Item>
            <Descriptions.Item label="Token 尾号">{typeof buntuRequest?.tokenLast4 === 'string' ? <code>{buntuRequest.tokenLast4}</code> : '—'}</Descriptions.Item>
            <Descriptions.Item label="Token Fingerprint">{typeof buntuRequest?.tokenFingerprint === 'string' ? <Typography.Text copyable code>{buntuRequest.tokenFingerprint}</Typography.Text> : '—'}</Descriptions.Item>
            <Descriptions.Item label="校验时间">{formatDateTime(record.occurredAt)}</Descriptions.Item>
            <Descriptions.Item label="校验接口地址">{typeof buntuRequest?.validationUrl === 'string' ? <Typography.Text copyable code>{buntuRequest.validationUrl}</Typography.Text> : '—'}</Descriptions.Item>
          </Descriptions>
          {hasOptInBuntuRawToken ? (
            <Alert
              type="warning"
              showIcon
              title="原始 Token 已记录"
              description="当前开发测试环境显式启用了高敏审计开关；仅用于授权排障。"
            />
          ) : null}
        </section>
      ) : null}

      <section className="audit-section-card" aria-label="安全请求摘要">
        <SectionTitle title="安全请求摘要" />
        <pre className="audit-code-block">{formatAuditSummary(record.requestSummary, hasOptInBuntuRawToken)}</pre>
      </section>
      <section className="audit-section-card" aria-label="安全响应摘要">
        <SectionTitle title="安全响应摘要" />
        <pre className="audit-code-block">{formatAuditSummary(record.responseSummary, false)}</pre>
      </section>
    </div>
  );
}

function SectionTitle({ title, subtitle }: Readonly<{ title: string; subtitle?: string }>) {
  return <div className="audit-section-title"><Typography.Title level={4}>{title}</Typography.Title>{subtitle ? <Typography.Text type="secondary">{subtitle}</Typography.Text> : null}</div>;
}
function StatItem({ icon, label, value, danger = false }: Readonly<{ icon: ReactNode; label: string; value: string; danger?: boolean }>) {
  return <div className={`audit-stat-item${danger ? ' audit-stat-danger' : ''}`}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}
function IdentityFact({ icon, label, value, copy }: Readonly<{ icon?: ReactNode; label: string; value: string; copy?: string | null }>) {
  return <div className="audit-identity-fact"><small>{icon} {label}</small>{copy ? <Typography.Text copyable={{ text: copy }} code>{value}</Typography.Text> : <strong>{value}</strong>}</div>;
}
function CopyButton({ value, label, compact = false }: Readonly<{ value: string; label: string; compact?: boolean }>) {
  return <Button aria-label={`复制${label}`} size="small" type={compact ? 'text' : 'default'} icon={<CopyOutlined />} onClick={() => void copyText(value, label)}>{compact ? `复制${label}` : label}</Button>;
}
function identitySourceLabel(source: IdentitySource | null): string {
  switch (source) {
    case 'INTERNAL_SERVICE_HEADER': return '内部服务凭据';
    case 'USER_BOUND_TOKEN': return '用户绑定 Token';
    case 'BUNTU_TOKEN': return '小犇 Token';
    default: return '—';
  }
}
function apiCategoryLabel(value: SalesforceApiCallRecord['apiCategory']): string {
  return ({ OAUTH: 'Salesforce OAuth', REST_API: 'Salesforce REST API', UI_API: 'Salesforce UI API', TOOLING_API: 'Salesforce Tooling API', COMPOSITE_API: 'Salesforce Composite API', BULK_API: 'Salesforce Bulk API', APEX_REST_API: 'Salesforce Apex REST API', METADATA_API: 'Salesforce Metadata API', SOAP_API: 'Salesforce SOAP API', SALESFORCE_CLI: 'Salesforce CLI', UNKNOWN: '未知 API' } as const)[value] ?? value;
}
function payloadOwnerLabel(
  payload: AuditPayloadEvidenceSummaryRecord,
  apiCalls: readonly SalesforceApiCallRecord[],
): string {
  if (!payload.salesforceApiCallId) return 'MCP / Audit 级证据';
  const api = apiCalls.find((candidate) => candidate.id === payload.salesforceApiCallId);
  return api ? `Salesforce API #${api.sequence} · ${apiCategoryLabel(api.apiCategory)}` : 'Salesforce API 证据';
}

function integrityLabel(value: AdminAuditTraceDto['audit']['auditIntegrityStatus']): string {
  return value === 'COMPLETE' ? '完整' : value === 'PARTIAL' ? '部分' : '降级';
}
function formatDuration(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s` : `${value} ms`;
}
function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function displayValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function formatAuditSummary(value: unknown, allowBuntuRawToken: boolean): string {
  if (value === null || value === undefined) return '未记录。';
  try {
    return JSON.stringify(value, (key, entry) => {
      const canonical = key.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
      if (canonical === 'tokenfingerprint' || canonical === 'tokenlast4') return entry;
      if (allowBuntuRawToken && canonical === 'rawtoken') return entry;
      return /(?:authorization|cookie|token|jwt|privatekey|secret|password|passphrase|dbpassword|apikey|credential)/u.test(canonical)
        ? '[REDACTED]'
        : entry;
    }, 2).slice(0, 16_384);
  } catch {
    return '摘要无法序列化。';
  }
}
function formatUnknown(value: unknown): string {
  if (value === null || value === undefined) return '未记录。';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
async function copyText(value: string, label: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); void message.success(`${label}已复制`); } catch { void message.error('复制失败，请手动复制。'); }
}
