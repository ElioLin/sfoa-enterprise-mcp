import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormContextEvidence } from '../pages/audit/FormContextEvidence.js';
import { renderAdmin } from './helpers.js';

describe('form audit facts', () => {
  it('shows computed readiness, required fields and client provenance without claiming user authorship', () => {
    renderAdmin(<FormContextEvidence truncated={false} text={JSON.stringify({
      formReadinessStatus: 'NEEDS_INPUT', missingRequired: ['Reason__c'], criticalUnknown: [],
      fields: [{ apiName: 'Reason__c', label: '原因', required: true, visibility: 'VISIBLE', writable: true,
        requiredSource: ['DYNAMIC_FORM'], valueState: 'EMPTY', valueSource: 'CLIENT_DRAFT' }],
      initialFacts: [{ path: 'Record.Active__c', value: false, source: 'CLIENT_DRAFT', resolutionStatus: 'RESOLVED' },
        { path: 'Record.Amount__c', value: 0, source: 'SAVED_RECORD', resolutionStatus: 'RESOLVED' },
        { path: 'Record.Reason__c', value: null, source: 'SAVED_RECORD', resolutionStatus: 'RESOLVED' },
        { path: 'Record.Unavailable__c', source: 'UNRESOLVED', resolutionStatus: 'UNKNOWN' },
        { apiName: 'ActionPreset__c', value: 'evaluated preset', valuePresent: true, source: 'SALESFORCE_ACTION_DEFAULT' }],
    })} />);
    expect(screen.getByText('表单尚缺必填值')).toBeInTheDocument();
    const fields = within(screen.getByRole('region', { name: '字段状态' }));
    expect(fields.getByText('DYNAMIC_FORM')).toBeInTheDocument();
    expect(fields.getByText('客户端草稿（作者未验证） · CLIENT_DRAFT')).toBeInTheDocument();
    const facts = within(screen.getByRole('region', { name: '参与计算的事实' }));
    for (const value of ['false', '0', 'null', '未记录值']) expect(facts.getByText(value)).toBeInTheDocument();
    expect(facts.getByText('ActionPreset__c')).toBeInTheDocument();
    expect(facts.getByText('evaluated preset')).toBeInTheDocument();
    expect(facts.getByText('SALESFORCE_ACTION_DEFAULT')).toBeInTheDocument();
  });

  it('renders the actual condition and dependency value from legacy rule evidence', () => {
    renderAdmin(<FormContextEvidence truncated={false} text={JSON.stringify({ fields: [],
      rules: [{ apiName: 'Reason__c', instanceId: 'field-1', ruleResult: 'UNKNOWN', evaluations: [{ scope: 'FIELD',
        state: 'UNKNOWN', criteria: [{ path: '{!Record.Active__c}', operator: 'EQUAL', expected: true, state: 'UNKNOWN', reasons: ['VALUE_UNAVAILABLE'] }],
        dependencies: [{ path: 'Record.Active__c', value: false, source: 'CLIENT_DRAFT' }] }] }],
    })} />);
    const rules = within(screen.getByRole('region', { name: '显隐规则计算' }));
    expect(rules.getByText('EQUAL')).toBeInTheDocument();
    expect(rules.getByText('true')).toBeInTheDocument();
    expect(rules.getByText('false')).toBeInTheDocument();
    expect(rules.getByText('VALUE_UNAVAILABLE')).toBeInTheDocument();
    expect(rules.getByText('客户端草稿（作者未验证） · CLIENT_DRAFT')).toBeInTheDocument();
  });

  it('keeps truncated and malformed evidence visibly incomplete', () => {
    const first = renderAdmin(<FormContextEvidence text='{"fields":' truncated />);
    expect(screen.getByText('无法呈现结构化表单依据')).toBeInTheDocument();
    first.unmount();
    const second = renderAdmin(<FormContextEvidence text={JSON.stringify({ fields: [] })} truncated />);
    expect(screen.getByText('表单依据不完整')).toBeInTheDocument();
    second.unmount();
    renderAdmin(<FormContextEvidence text={' '.repeat(262_145)} truncated={false} />);
    expect(screen.getByText('无法呈现结构化表单依据')).toBeInTheDocument();
  });

  it('shows recommendation denominators and never describes current values as recent manual input', () => {
    renderAdmin(<FormContextEvidence truncated={false} text={JSON.stringify({ recommendations: {
      status: 'AVAILABLE', windowStart: '2026-10-07T00:00:00.000Z', windowEnd: '2026-11-06T00:00:00.000Z',
      sampleCount: 20, sampleLimit: 200, minimumSamples: 20, minimumNonEmptyRatio: 0.8,
      population: 'BOUNDED_RECENT_SAMPLE', scope: 'CURRENT_USER_READABLE',
      recommendations: [{ apiName: 'Industry', nonEmptyCount: 17, sampleCount: 20, nonEmptyRatio: 0.85 }],
    } })} />);
    expect(screen.getByText(/不代表最近人工填写/u)).toBeInTheDocument();
    const stats = within(screen.getByRole('region', { name: '推荐字段统计' }));
    expect(stats.getByText('17')).toBeInTheDocument();
    expect(stats.getByText('20')).toBeInTheDocument();
    expect(stats.getByText('0.85')).toBeInTheDocument();
    expect(screen.getByText('BOUNDED_RECENT_SAMPLE')).toBeInTheDocument();
    expect(screen.getByText('2026-10-07T00:00:00.000Z')).toBeInTheDocument();
  });

  it('distinguishes promised managed values from observed values and keeps null requiredness unknown', () => {
    renderAdmin(<FormContextEvidence truncated={false} text={JSON.stringify({ fields: [
      { apiName: 'Planned', required: true, valueState: 'MANAGED_ON_WRITE', valueSource: 'MANAGED_POLICY' },
      { apiName: 'Observed', required: true, valueState: 'PROVIDED', valueSource: 'RUNTIME_MANAGED' },
      { apiName: 'Conditional', required: null, requiredSource: ['DYNAMIC_FORM'], writable: true },
    ] })} />);
    expect(screen.getByText('将在写入时解析 · MANAGED_ON_WRITE')).toBeInTheDocument();
    expect(screen.getByText('已配置写入时托管；并非已读取字段值 · MANAGED_POLICY')).toBeInTheDocument();
    expect(screen.getByText('提交前已解析的托管值 · RUNTIME_MANAGED')).toBeInTheDocument();
    const conditional = screen.getByRole('row', { name: /Conditional/u });
    expect(within(conditional).getByText('未确定')).toBeInTheDocument();
    expect(within(conditional).queryByText('必填')).not.toBeInTheDocument();
  });

  it('keeps default-on-write API requiredness without presenting an observed or initial value', () => {
    renderAdmin(<FormContextEvidence truncated={false} text={JSON.stringify({ formReadinessStatus: 'READY', fields: [
      { apiName: 'DefaultedFlag', required: true, requiredSource: ['API'], writable: true,
        valueState: 'DEFAULT_ON_WRITE', valueSource: 'SALESFORCE_DEFAULT_ON_WRITE' },
    ] })} />);
    const field = within(screen.getByRole('row', { name: /DefaultedFlag/u }));
    expect(field.getByText('必填')).toBeInTheDocument();
    expect(field.queryByText('可选')).not.toBeInTheDocument();
    expect(field.getByText('Salesforce 将在保存时补默认值 · DEFAULT_ON_WRITE')).toBeInTheDocument();
    expect(field.getByText('已确认保存时默认机制；并非页面初始值 · SALESFORCE_DEFAULT_ON_WRITE')).toBeInTheDocument();
    expect(field.queryByText('false')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '参与计算的事实' })).not.toBeInTheDocument();
    expect(screen.getByText('当前表单检查已就绪')).toBeInTheDocument();
  });
});
