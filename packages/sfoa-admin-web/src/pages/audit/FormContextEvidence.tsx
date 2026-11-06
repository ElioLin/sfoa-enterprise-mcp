import { Alert, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';

const MAX_TEXT_LENGTH = 262_144;
const MAX_ROWS = 400;
type Fact = Record<string, unknown>;

/** Only called after the existing authenticated, on-demand UI_CONTEXT payload read. */
export function FormContextEvidence({ text, truncated }: Readonly<{ text: string; truncated: boolean }>) {
  const parsed = parseEvidence(text);
  if (!parsed) return <Alert type="warning" showIcon title="无法呈现结构化表单依据"
    description="载荷为空、已截断或不符合对象格式；可查看下方已保存原文，不能据此判断表单完整。" />;
  const fields = rows(parsed.fields);
  const rules = rows(parsed.rules);
  const facts = rows(parsed.initialFacts);
  const missing = strings(parsed.missingRequired);
  const unknown = strings(parsed.criticalUnknown);
  const differences = rows(parsed.differences);
  const recommendations = record(parsed.recommendations);
  const recommendationFields = rows(recommendations?.fields ?? recommendations?.recommendations);
  const oversized = [parsed.fields, parsed.rules, parsed.initialFacts, parsed.differences]
    .some((value) => Array.isArray(value) && value.length > MAX_ROWS);
  const state = formReadinessStatus(parsed);
  return <Space orientation="vertical" size="middle" className="full-width">
    <Typography.Title level={5}>表单判定依据</Typography.Title>
    <Typography.Paragraph type="secondary">
      页面与字段配置来自 Salesforce；可见性、必填与缺项是 MCP 基于已记录事实的计算。客户端草稿和关联编号不证明用户原话、材料已读或已经获得写入授权。
    </Typography.Paragraph>
    {state ? <FormReadinessNotice status={state} /> : null}
    {truncated || oversized ? <Alert type="warning" showIcon title="表单依据不完整"
      description="保存或展示范围有截断；以下列出的事实不能代表整张表单。" /> : null}
    {missing.length || unknown.length ? <Descriptions bordered size="small" column={1}>
      {missing.length ? <Descriptions.Item label="缺少必填值">{missing.join('、')}</Descriptions.Item> : null}
      {unknown.length ? <Descriptions.Item label="影响必填判断的未知项">{unknown.join('、')}</Descriptions.Item> : null}
    </Descriptions> : null}
    <EvidenceTable title="字段状态" headers={['字段', '可见性', '必填来源', '值状态 / 来源', '可填写', '位置 / 依赖']}
      rows={fields.map((field) => [
        <><strong>{scalar(field.label ?? field.apiName)}</strong><br /><code>{scalar(field.apiName)}</code></>,
        <EvidenceState value={field.visibility ?? field.visibilityState} />,
        <><span>{requiredLabel(field)}</span><br /><span>{listText(field.requiredSource ?? field.sources)}</span></>,
        <><span>{valueStateLabel(field.valueState ?? field.status)}</span><br /><span>{sourceLabel(field.valueSource ?? field.source)}</span></>,
        booleanLabel(field.writable ?? field.effectiveEditable),
        <>{scalar(field.section)}<br />{listText(field.dependsOn)}</>,
      ])} />
    {rules.length ? <section aria-label="显隐规则计算">
      <Typography.Title level={5}>显隐规则计算</Typography.Title>
      {rules.map((rule, index) => <details key={index} className="form-context-rule">
        <summary><code>{scalar(rule.apiName ?? rule.fieldApiName)}</code> · {scalar(rule.instanceId)} · <EvidenceState value={rule.ruleResult ?? rule.state} /></summary>
        <RuleEvidence rule={rule} />
      </details>)}
    </section> : null}
    {facts.length ? <EvidenceTable title="参与计算的事实" headers={['事实路径', '已读取的值', '来源', '解析状态', '缺口']}
      rows={facts.map((fact) => [scalar(fact.path ?? fact.apiName), Object.hasOwn(fact, 'value') ? scalar(fact.value) : '未记录值',
        sourceLabel(fact.source), scalar(fact.resolutionStatus ?? (fact.valuePresent === true ? '已取得值'
          : fact.source === 'UNKNOWN' ? 'UNKNOWN' : fact.valuePresent === false ? '未提供' : undefined)), scalar(fact.reason)])} /> : null}
    {recommendations ? <section aria-label="可选字段推荐依据">
      <Typography.Title level={5}>可选字段推荐依据</Typography.Title>
      <Typography.Paragraph type="secondary">统计当前用户可读取、同对象同记录类型、指定创建时间范围内记录的当前非空值；不代表最近人工填写。</Typography.Paragraph>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
        {Object.entries({ status: '状态', windowDays: '创建时间窗口（天）', windowStart: '创建时间窗口起点', windowEnd: '创建时间窗口终点',
          sampleCount: '可用样本数', sampleSize: '可用样本数（旧契约）', sampledRecords: '已取样记录数', sampleLimit: '取样上限',
          minimumSamples: '最少样本', minimumNonEmptyRatio: '非空比例门槛', minimumRatio: '非空比例门槛（旧契约）',
          population: '取样范围', scope: '读取权限范围', truncated: '样本已截断', reason: '说明' })
          .filter(([key]) => recommendations[key] !== undefined)
          .map(([key, label]) => <Descriptions.Item key={key} label={label}>{scalar(recommendations[key])}</Descriptions.Item>)}
      </Descriptions>
      <EvidenceTable title="推荐字段统计" headers={['字段', '非空数', '分母', '非空比例']}
        rows={recommendationFields.map((field) => [scalar(field.label ?? field.apiName), scalar(field.nonEmptyCount),
          scalar(field.sampleCount ?? field.sampleSize ?? field.denominator), scalar(field.nonEmptyRatio ?? field.ratio)])} />
    </section> : null}
    {differences.length ? <EvidenceTable title="本轮重新计算的变化" headers={['字段 / 项目', '上轮', '本轮', '变化依据']}
      rows={differences.map((difference) => [scalar(difference.apiName ?? difference.path), scalar(difference.before),
        scalar(difference.after), scalar(difference.reason)])} /> : null}
  </Space>;
}

export function formReadinessStatus(value: unknown): 'READY' | 'NEEDS_INPUT' | 'UNKNOWN' | undefined {
  const summary = record(value);
  const status = summary?.formReadinessStatus ?? summary?.status;
  return status === 'READY' || status === 'NEEDS_INPUT' || status === 'UNKNOWN' ? status : undefined;
}

export function FormReadinessNotice({ status }: Readonly<{ status: 'READY' | 'NEEDS_INPUT' | 'UNKNOWN' }>) {
  return <Alert type={status === 'READY' ? 'info' : 'warning'} showIcon
    title={status === 'READY' ? '当前表单检查已就绪' : status === 'NEEDS_INPUT' ? '表单尚缺必填值' : '表单必填判断存在未知项'}
    description={status === 'READY'
      ? '本次读取与计算范围内已就绪；Salesforce 保存校验和实际提交结果需分别查看。'
      : '工具调用可以正常完成，但表单尚未达到提交条件。打开字段依据查看缺项与具体规则。'} />;
}

function RuleEvidence({ rule }: Readonly<{ rule: Fact }>) {
  const evaluations = Array.isArray(rule.evaluations) ? rows(rule.evaluations) : [rule];
  return <Space orientation="vertical" className="full-width">
    {evaluations.slice(0, 30).map((evaluation, index) => {
      const dependencies = rows(evaluation.dependencies);
      const criteria = rows(evaluation.criteria);
      return <section key={index}>
        <Typography.Paragraph>
          作用域：{scalar(evaluation.scope)} · 逻辑：{scalar(evaluation.booleanFilter ?? rule.booleanFilter)} · 结果：<EvidenceState value={evaluation.state} />
          {evaluation.evaluationBasis !== undefined ? <> · 求值依据：{scalar(evaluation.evaluationBasis)}</> : null}
        </Typography.Paragraph>
        <EvidenceTable title={`条件依据 ${index + 1}`} headers={['路径', '运算符', '比较值', '事实值', '事实来源', '结果', '未解析原因']}
          rows={criteria.map((criterion) => {
            const fact = dependencies.find((dependency) => normalizePath(dependency.path) === normalizePath(criterion.path));
            return [scalar(criterion.path), scalar(criterion.operator), scalar(criterion.expected),
              fact && Object.hasOwn(fact, 'value') ? scalar(fact.value) : '未记录值',
              sourceLabel(fact?.source), <EvidenceState value={criterion.state} />, listText(criterion.reasons)];
          })} />
      </section>;
    })}
  </Space>;
}

function EvidenceTable({ title, headers, rows: values }: Readonly<{ title: string; headers: readonly string[]; rows: readonly ReactNode[][] }>) {
  return <section aria-label={title}>
    <Typography.Title level={5}>{title}</Typography.Title>
    {!values.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未记录此类事实。" /> : <div className="form-context-table-wrap">
      <table className="form-context-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{values.map((cells, index) => <tr key={index}>{cells.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

function EvidenceState({ value }: Readonly<{ value: unknown }>) {
  const text = scalar(value);
  return <Tag color={text === 'UNKNOWN' || text === 'PENDING' ? 'warning' : undefined}>{text}</Tag>;
}
function parseEvidence(text: string): Fact | undefined {
  if (!text || text.length > MAX_TEXT_LENGTH) return undefined;
  try { return record(JSON.parse(text) as unknown); } catch { return undefined; }
}
function record(value: unknown): Fact | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fact : undefined;
}
function rows(value: unknown): Fact[] {
  return Array.isArray(value) ? value.slice(0, MAX_ROWS).flatMap((item: unknown) => { const row = record(item); return row ? [row] : []; }) : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.slice(0, MAX_ROWS).filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 512)) : [];
}
function listText(value: unknown): string { return strings(value).join('、') || '—'; }
function scalar(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.slice(0, 4096);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '[结构化值见原文]';
}
function booleanLabel(value: unknown): string { return value === true ? '是' : value === false ? '否' : '未确定'; }
function requiredLabel(field: Fact): string {
  const value = Object.hasOwn(field, 'required') ? field.required : field.effectiveRequired;
  if (value === true) return '必填';
  if (value === false) return '可选';
  if (value === null) return '未确定';
  return Array.isArray(field.requiredSource) && field.requiredSource.length ? '必填' : '未确定';
}
function valueStateLabel(value: unknown): string {
  if (value === 'MANAGED_ON_WRITE') return '将在写入时解析 · MANAGED_ON_WRITE';
  if (value === 'DEFAULT_ON_WRITE') return 'Salesforce 将在保存时补默认值 · DEFAULT_ON_WRITE';
  return scalar(value);
}
function sourceLabel(value: unknown): string {
  if (value === 'USER_EXPLICIT' || value === 'DRAFT' || value === 'CLIENT_DRAFT') return `客户端草稿（作者未验证） · ${value}`;
  if (value === 'MANAGED_POLICY') return '已配置写入时托管；并非已读取字段值 · MANAGED_POLICY';
  if (value === 'RUNTIME_MANAGED') return '提交前已解析的托管值 · RUNTIME_MANAGED';
  if (value === 'SALESFORCE_DEFAULT_ON_WRITE') return '已确认保存时默认机制；并非页面初始值 · SALESFORCE_DEFAULT_ON_WRITE';
  return scalar(value);
}
function normalizePath(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^\{!|\}$/gu, '').replace(/^\$Record\./u, 'Record.') : '';
}
