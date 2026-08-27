import {
  ApiOutlined,
  BookOutlined,
  CloudServerOutlined,
  CopyOutlined,
  LinkOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import {
  AGENT_PLAYBOOK_VERSION,
  renderFullPlaybook,
  renderServerInstructions,
  renderWorkBuddySystemPrompt,
} from '@sfoa/agent-playbook';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Row,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import skillMarkdown from '../../../../.codebuddy/skills/sfoa-salesforce-assistant/SKILL.md?raw';
import { adminApi } from '../api/client.js';
import {
  bindHostGuidance,
  buildDifyConnectionExample,
  buildInternalConnectionExample,
  buildWorkBuddyConnectionExample,
  deriveMcpConnectivity,
  lanMcpUrl,
  loopbackMcpUrl,
  validateExternalMcpUrl,
  type McpConnectivityConfig,
} from '../agent/connectivity.js';
import {
  deriveDifyInstructionFacts,
  generateDifyAgentInstruction,
  type AdminManagedDmlFieldFact,
} from '../agent/instruction-generator.js';
import { ErrorState, LoadingState } from '../components/QueryState.js';
import { PageFrame } from '../components/PageFrame.js';
import { StatusTag } from '../components/StatusTag.js';

const DEFAULT_EXTERNAL_URL = 'http://127.0.0.1:8080/mcp';
const SKILL_REPO_PATH = '.codebuddy/skills/sfoa-salesforce-assistant/';

export default function AgentIntegrationPage() {
  const { message } = App.useApp();
  const [externalUrl, setExternalUrl] = useState(DEFAULT_EXTERNAL_URL);
  const [externalUrlTouched, setExternalUrlTouched] = useState(false);
  const [instruction, setInstruction] = useState('');
  const status = useQuery({ queryKey: ['system-status'], queryFn: adminApi.systemStatus });
  const tools = useQuery({ queryKey: ['tools'], queryFn: adminApi.tools });
  const policies = useQuery({ queryKey: ['dml-policies', 'all'], queryFn: adminApi.allDmlPolicies });
  const managedFields = useQuery({
    queryKey: ['managed-dml-fields', 'all', policies.data?.map((policy) => `${policy.id}:${policy.rowVersion}`).join('|')],
    enabled: policies.data !== undefined,
    queryFn: async (): Promise<readonly AdminManagedDmlFieldFact[]> => {
      if (!policies.data) return Object.freeze([]);
      const pages = await Promise.all(policies.data.map(async (policy) => ({
        policy,
        rules: await adminApi.allManagedDmlFieldRules(policy.id),
      })));
      return Object.freeze(pages.flatMap(({ policy, rules }) => rules.map((rule) => Object.freeze({
        ...rule,
        objectApiName: policy.objectApiName,
      }))));
    },
  });
  const generatorInput = useMemo(() => status.data && tools.data && policies.data && managedFields.data ? Object.freeze({
    tools: tools.data.items,
    dmlPolicies: policies.data,
    diagnostic: status.data.diagnostic,
    managedDmlFields: managedFields.data,
  }) : null, [managedFields.data, policies.data, status.data, tools.data]);
  const facts = useMemo(
    () => generatorInput ? deriveDifyInstructionFacts(generatorInput) : null,
    [generatorInput],
  );

  useEffect(() => {
    if (!status.data || externalUrlTouched) return;
    setExternalUrl(loopbackMcpUrl(deriveMcpConnectivity(status.data)));
  }, [externalUrlTouched, status.data]);

  useEffect(() => {
    if (generatorInput) setInstruction(generateDifyAgentInstruction(generatorInput));
  }, [generatorInput]);

  const pending = status.isPending || tools.isPending || policies.isPending || (policies.data !== undefined && managedFields.isPending);
  const error = status.error ?? tools.error ?? policies.error ?? managedFields.error;
  const refresh = async (): Promise<void> => {
    await Promise.all([status.refetch(), tools.refetch(), policies.refetch(), managedFields.refetch()]);
  };
  const copy = async (value: string, successMessage: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      void message.success(successMessage);
    } catch {
      void message.error('复制失败，请手动选择文本。');
    }
  };

  return (
    <PageFrame
      title="智能体接入"
      description={`Playbook ${AGENT_PLAYBOOK_VERSION} 统一分发 MCP 原生指引、小犇/Dify 指令与 WorkBuddy Skill；运行时能力来自当前 Tool、DML 策略和诊断状态。`}
      action={<Button icon={<ReloadOutlined />} loading={status.isFetching || tools.isFetching || policies.isFetching || managedFields.isFetching} onClick={() => void refresh()}>刷新当前状态</Button>}
    >
      {pending ? <LoadingState rows={8} /> : error ? <ErrorState error={error} onRetry={() => void refresh()} /> : status.data && facts && generatorInput ? (
        <Tabs
          destroyOnHidden={false}
          items={[
            {
              key: 'mcp-access',
              label: 'MCP 接入',
              children: (
                <McpAccessTab
                  config={deriveMcpConnectivity(status.data)}
                  externalUrl={externalUrl}
                  onExternalUrlChange={(value) => { setExternalUrlTouched(true); setExternalUrl(value); }}
                  onCopy={copy}
                />
              ),
            },
            {
              key: 'agent-playbook',
              label: 'Agent Playbook',
              children: (
                <AgentPlaybookTab
                  facts={facts}
                  playbook={renderFullPlaybook(facts.capabilities)}
                  onCopy={copy}
                />
              ),
            },
            {
              key: 'dify',
              label: '小犇 / Dify',
              children: (
                <DifyTab
                  externalUrl={externalUrl}
                  instruction={instruction}
                  facts={facts}
                  onGenerate={() => {
                    setInstruction(generateDifyAgentInstruction(generatorInput));
                    void message.success('已根据当前 Tool、DML 策略与 Diagnostic verification 重新生成。');
                  }}
                  onCopy={copy}
                />
              ),
            },
            {
              key: 'workbuddy',
              label: 'WorkBuddy',
              children: (
                <WorkBuddyTab
                  externalUrl={externalUrl}
                  systemPrompt={renderWorkBuddySystemPrompt(facts.capabilities)}
                  onCopy={copy}
                />
              ),
            },
            {
              key: 'mcp-native',
              label: 'MCP 原生指引',
              children: (
                <McpNativeTab
                  instructions={renderServerInstructions(facts.capabilities)}
                  playbookToolEnabled={facts.availableTools.includes('get_agent_playbook')}
                  recordLinksEnabled={facts.availableTools.includes('get_record_links')}
                  onCopy={copy}
                />
              ),
            },
          ]}
        />
      ) : null}
    </PageFrame>
  );
}

function McpAccessTab({
  config,
  externalUrl,
  onExternalUrlChange,
  onCopy,
}: Readonly<{
  config: McpConnectivityConfig;
  externalUrl: string;
  onExternalUrlChange(value: string): void;
  onCopy(value: string, successMessage: string): Promise<void>;
}>) {
  const validation = validateExternalMcpUrl(externalUrl);
  const exampleUrl = validation.valid ? validation.url : externalUrl.trim();
  const examples = [
    {
      title: '小犇 / Dify（BUNTU_TOKEN）',
      value: buildDifyConnectionExample(exampleUrl),
      success: '已复制小犇 / Dify 连接示例。',
    },
    {
      title: 'WorkBuddy（USER_BOUND_TOKEN）',
      value: buildWorkBuddyConnectionExample(exampleUrl),
      success: '已复制 WorkBuddy 连接示例。',
    },
    {
      title: 'Internal / Inspector',
      value: buildInternalConnectionExample(exampleUrl),
      success: '已复制 Internal / Inspector 连接示例。',
    },
  ] as const;
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Card title="当前 Runtime 安全配置" className="surface-card">
        <Descriptions bordered size="small" column={{ xs: 1, lg: 2 }}>
          <Descriptions.Item label="MCP_BIND_HOST"><code>{config.bindHost}</code></Descriptions.Item>
          <Descriptions.Item label="MCP_PORT"><code>{config.port}</code></Descriptions.Item>
          <Descriptions.Item label="MCP_PATH"><code>{config.path}</code></Descriptions.Item>
          <Descriptions.Item label="MCP_AUTH_MODE"><code>{config.authMode}</code></Descriptions.Item>
          <Descriptions.Item label="MCP_ALLOWED_HOSTS"><SafeList values={config.allowedHosts} /></Descriptions.Item>
          <Descriptions.Item label="MCP_ALLOWED_ORIGINS"><SafeList values={config.allowedOrigins} /></Descriptions.Item>
          <Descriptions.Item label="MCP_CLIENT_TOKEN"><StatusTag label={config.tokenConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED'} /></Descriptions.Item>
          <Descriptions.Item label="Runtime Endpoint"><code>{config.runtimeEndpoint}</code></Descriptions.Item>
        </Descriptions>
        <Typography.Paragraph type="secondary" className="credential-note">
          此页只显示安全状态和 placeholder，不返回 MCP token、Buntu token、USER_BOUND token、数据库密码、JWT private key 或 Admin session secret。
        </Typography.Paragraph>
      </Card>

      <Alert type="info" showIcon title="本机地址与网络可达性" description={bindHostGuidance(config)} />
      <Row gutter={[16, 16]}>
        <GuidanceCard title="本机接入" icon={<ApiOutlined />}>
          <CodeBlock value={loopbackMcpUrl(config)} />
          <Typography.Paragraph>仅适用于与 MCP Runtime 位于同一台主机的客户端。</Typography.Paragraph>
        </GuidanceCard>
        <GuidanceCard title="LAN 测试" icon={<LinkOutlined />}>
          <CodeBlock value={[
            'MCP_BIND_HOST=0.0.0.0',
            `MCP_ALLOWED_HOSTS=<YOUR_LAN_IP>:${config.port}`,
            '',
            `Endpoint: ${lanMcpUrl(config)}`,
          ].join('\n')} />
          <Typography.Paragraph>还需要 route 与 firewall 放通 TCP {config.port}；本页不修改部署配置。</Typography.Paragraph>
        </GuidanceCard>
        <GuidanceCard title="生产 HTTPS" icon={<SafetyCertificateOutlined />}>
          <CodeBlock value={'https://mcp.example.com/mcp\n        ↓\nReverse proxy / TLS\n        ↓\nhttp://127.0.0.1:8080/mcp'} />
          <Typography.Paragraph>按 P2 reverse proxy 与 P5 deployment 文档配置 TLS、DNS、Host 和 Origin 策略。</Typography.Paragraph>
        </GuidanceCard>
      </Row>

      <Alert
        type="warning"
        showIcon
        title="三种身份来源不可混用"
        description="小犇/Dify 使用 Buntu 当前用户 Token；WorkBuddy 使用 Identity Route 绑定的 USER_BOUND Token；只有受控 Internal/Inspector 客户端使用 MCP_CLIENT_TOKEN + X-Platform-User-Id。客户端不得通过 Tool 参数选择 Salesforce Username。"
      />

      <Card title="外部 MCP 地址" className="surface-card">
        <Typography.Paragraph type="secondary">仅用于生成浏览器内连接示例；不持久化，也不作为 Runtime Authority。</Typography.Paragraph>
        <Input
          aria-label="外部 MCP 地址"
          value={externalUrl}
          status={validation.valid ? undefined : 'error'}
          onChange={(event) => onExternalUrlChange(event.target.value)}
          placeholder="https://mcp.company.com/mcp"
          maxLength={2_048}
        />
        {!validation.valid ? <Typography.Text type="danger" className="input-error-copy">{validation.message}</Typography.Text> : null}
      </Card>

      <Row gutter={[16, 16]}>
        {examples.map((example) => (
          <Col xs={24} xl={8} key={example.title}>
            <ConnectionExample
              title={example.title}
              value={example.value}
              disabled={!validation.valid}
              onCopy={() => onCopy(example.value, example.success)}
            />
          </Col>
        ))}
      </Row>
    </Space>
  );
}

function AgentPlaybookTab({
  facts,
  playbook,
  onCopy,
}: Readonly<{
  facts: ReturnType<typeof deriveDifyInstructionFacts>;
  playbook: string;
  onCopy(value: string, successMessage: string): Promise<void>;
}>) {
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Alert
        type="success"
        showIcon
        title={`Canonical Agent Playbook ${AGENT_PLAYBOOK_VERSION}`}
        description="规则由 @sfoa/agent-playbook 单一维护；MCP、Dify、WorkBuddy 与 checked-in 生成物使用同一版本。"
      />
      <Row gutter={[16, 16]}>
        <RelationCard title="Canonical Source" description="纯 TypeScript 定义与 renderer；不读取网络、数据库、Connection 或 secret。" />
        <RelationCard title="Runtime Facts" description="当前可用 Tool、CREATE/UPDATE 对象策略、Diagnostic readiness；按请求隔离。" />
        <RelationCard title="Deterministic Artifacts" description="yarn agent:sync 生成，yarn agent:check 检测手工修改与版本漂移。" />
      </Row>
      <Card title="当前分发状态" className="surface-card">
        <Space wrap>
          <StatusTag label="ENABLED" /><span>MCP Instructions</span>
          <StatusTag label="ENABLED" /><span>Playbook Resource</span>
          <StatusTag label="ENABLED" /><span>Capabilities Resource</span>
          <StatusTag label="ENABLED" /><span>MCP Prompt</span>
          <StatusTag label={facts.availableTools.includes('get_agent_playbook') ? 'ENABLED' : 'DISABLED'} /><span>Tool fallback</span>
          <StatusTag label={facts.availableTools.includes('get_record_links') ? 'ENABLED' : 'DISABLED'} /><span>Record links</span>
          <StatusTag label="SYNCED" tone="success" /><span>WorkBuddy Skill</span>
          <StatusTag label="GENERATED" tone="success" /><span>Dify Instruction</span>
          <StatusTag label="NOT_AVAILABLE" /><span>Dynamic Forms evidence</span>
        </Space>
      </Card>
      <Card title="当前能力事实" className="surface-card">
        <Space wrap>
          {facts.availableTools.map((name) => <Tag key={name}><code>{name}</code></Tag>)}
          {facts.availableTools.length === 0 ? <Tag>无可用 Tool</Tag> : null}
          <Tag>CREATE 对象 {facts.createObjects.length}</Tag>
          <Tag>UPDATE 对象 {facts.updateObjects.length}</Tag>
          <Tag>MCP 托管字段 {facts.managedDmlFieldCount}</Tag>
          <StatusTag label={facts.diagnosticReady ? 'READY' : facts.diagnosticEnabledButUnverified ? 'NOT_VERIFIED' : 'DISABLED'} />
        </Space>
      </Card>
      <Alert
        type="info"
        showIcon
        title="MCP 托管字段由服务端负责"
        description="Agent 能力仅公开对象、字段、操作范围和安全策略别名，不公开 Lookup 对象、匹配字段或派生值。Agent 不询问、不推荐、不提交这些字段，普通成功回答也不展示技术标记。"
      />
      <Space wrap>
        <Button icon={<BookOutlined />} href="#agent-playbook-full">查看完整规范</Button>
        <Button type="primary" icon={<CopyOutlined />} onClick={() => void onCopy(playbook, '已复制当前 Agent Playbook。')}>复制当前 Playbook</Button>
        <Button icon={<CopyOutlined />} onClick={() => void onCopy(skillMarkdown, '已复制生成的 SKILL.md。')}>复制 WorkBuddy Skill</Button>
      </Space>
      <CodeBlock id="agent-playbook-full" value={playbook} tall />
    </Space>
  );
}

function DifyTab({
  externalUrl,
  instruction,
  facts,
  onGenerate,
  onCopy,
}: Readonly<{
  externalUrl: string;
  instruction: string;
  facts: ReturnType<typeof deriveDifyInstructionFacts>;
  onGenerate(): void;
  onCopy(value: string, successMessage: string): Promise<void>;
}>) {
  const validation = validateExternalMcpUrl(externalUrl);
  const example = buildDifyConnectionExample(validation.valid ? validation.url : externalUrl.trim());
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Alert
        type="info"
        showIcon
        title="小犇当前用户 Token → BUNTU_TOKEN"
        description="Dify 只传当前用户 bearer。MCP 每次调用 Buntu validate-token 获取 platformUserId，再经过 Identity Route；不要配置 X-Platform-User-Id。"
      />
      <ConnectionExample title="小犇 / Dify MCP 连接示例" value={example} disabled={!validation.valid} onCopy={() => onCopy(example, '已复制小犇 / Dify 连接示例。')} />
      <Recommendation title="小犇 / Dify 推荐步骤" items={[
        '添加 Streamable HTTP MCP Connector 并填写可达的 MCP URL。',
        'Authorization 使用当前登录用户的 Buntu Token：Bearer <CURRENT_USER_TOKEN>。',
        '不要配置 X-Platform-User-Id，也不要把 platformUserId 或 Salesforce Username 放入 Tool 参数。',
        '加载 MCP Instructions、Resources、Prompt 和当前允许的 Tools。',
        '将下面由当前能力事实生成的指令复制到 Agent 指令。',
        '先执行只读与身份测试，再执行允许的 DML Test Dataset。',
      ]} />
      <Card title="当前生成依据" className="surface-card">
        <Space wrap>
          {facts.availableTools.map((name) => <Tag key={name}><code>{name}</code></Tag>)}
          <Tag>CREATE 对象 {facts.createObjects.length}</Tag>
          <Tag>UPDATE 对象 {facts.updateObjects.length}</Tag>
          <Tag>MCP 托管字段 {facts.managedDmlFieldCount}</Tag>
          <StatusTag label={facts.diagnosticReady ? 'READY' : facts.diagnosticEnabledButUnverified ? 'NOT_VERIFIED' : 'DISABLED'} />
        </Space>
      </Card>
      <Space wrap>
        <Button type="primary" icon={<ReloadOutlined />} onClick={onGenerate}>重新生成指令</Button>
        <Button icon={<CopyOutlined />} disabled={!instruction} onClick={() => void onCopy(instruction, '已复制小犇 / Dify Agent 指令。')}>复制指令</Button>
      </Space>
      <CodeBlock value={instruction} tall />
    </Space>
  );
}

function WorkBuddyTab({
  externalUrl,
  systemPrompt,
  onCopy,
}: Readonly<{
  externalUrl: string;
  systemPrompt: string;
  onCopy(value: string, successMessage: string): Promise<void>;
}>) {
  const validation = validateExternalMcpUrl(externalUrl);
  const example = buildWorkBuddyConnectionExample(validation.valid ? validation.url : externalUrl.trim());
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Alert
        type="info"
        showIcon
        title="USER_BOUND Token 已绑定 Identity Route"
        description="WorkBuddy Connector 只配置 USER_BOUND bearer；不要配置 X-Platform-User-Id。路由停用、重映射或 Token 重生成会在下一次请求生效。"
      />
      <Row gutter={[16, 16]}>
        <RelationCard title="Connector" description="负责 Streamable HTTP、USER_BOUND 认证与 MCP 能力发现。" />
        <RelationCard title="System Prompt" description={`使用当前能力事实渲染 Playbook ${AGENT_PLAYBOOK_VERSION}。`} />
        <RelationCard title="Skill" description="生成的 Salesforce 专项工作流与安全边界，支持 progressive disclosure。" />
      </Row>
      <Recommendation title="WorkBuddy 推荐步骤" items={[
        '创建自定义 Streamable HTTP MCP Connector。',
        '配置 Authorization: Bearer <USER_BOUND_TOKEN>。',
        '不要配置 X-Platform-User-Id。',
        '创建 Agent 并添加下面的精简 System Prompt。',
        `导入完整目录 ${SKILL_REPO_PATH}，保留 references/。`,
        '先执行只读 Test Run，再进入允许的 CREATE/UPDATE 测试。',
      ]} />
      <ConnectionExample title="WorkBuddy Connector 示例" value={example} disabled={!validation.valid} onCopy={() => onCopy(example, '已复制 WorkBuddy Connector 示例。')} />
      <Card title="精简 System Prompt" className="surface-card" extra={<Button icon={<CopyOutlined />} onClick={() => void onCopy(systemPrompt, '已复制 WorkBuddy System Prompt。')}>复制 System Prompt</Button>}>
        <CodeBlock value={systemPrompt} tall />
      </Card>
      <Card title="生成的 sfoa-salesforce-assistant Skill" className="surface-card" extra={<Button icon={<CopyOutlined />} onClick={() => void onCopy(skillMarkdown, '已复制 SKILL.md。')}>复制 SKILL.md</Button>}>
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="Playbook 版本"><code>{AGENT_PLAYBOOK_VERSION}</code></Descriptions.Item>
          <Descriptions.Item label="Repo 路径"><code>{SKILL_REPO_PATH}</code></Descriptions.Item>
          <Descriptions.Item label="同步命令"><code>yarn agent:sync</code></Descriptions.Item>
          <Descriptions.Item label="漂移检查"><code>yarn agent:check</code></Descriptions.Item>
        </Descriptions>
      </Card>
    </Space>
  );
}

function McpNativeTab({
  instructions,
  playbookToolEnabled,
  recordLinksEnabled,
  onCopy,
}: Readonly<{
  instructions: string;
  playbookToolEnabled: boolean;
  recordLinksEnabled: boolean;
  onCopy(value: string, successMessage: string): Promise<void>;
}>) {
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Alert
        type="success"
        showIcon
        title="优先使用 MCP 原生发现"
        description="支持 MCP 2025-06-18 的客户端可直接读取 initialize Instructions、Resources 与 Prompt；Tool fallback 仅用于不支持 Resource/Prompt 的客户端。"
      />
      <Row gutter={[16, 16]}>
        <GuidanceCard title="Instructions" icon={<CloudServerOutlined />}>
          <StatusTag label="AVAILABLE" />
          <Typography.Paragraph>initialize 响应携带精简核心规则与完整 Playbook 获取路径。</Typography.Paragraph>
        </GuidanceCard>
        <GuidanceCard title="Resources" icon={<BookOutlined />}>
          <CodeBlock value={'sfoa://agent-playbook/current\nsfoa://agent-capabilities/current'} />
        </GuidanceCard>
        <GuidanceCard title="Prompt / Tools" icon={<ToolOutlined />}>
          <CodeBlock value={[
            'Prompt: sfoa_salesforce_assistant',
            `get_agent_playbook: ${playbookToolEnabled ? 'ENABLED' : 'DISABLED'}`,
            `get_record_links: ${recordLinksEnabled ? 'ENABLED' : 'DISABLED'}`,
          ].join('\n')} />
        </GuidanceCard>
      </Row>
      <Card title={`Server Instructions · ${AGENT_PLAYBOOK_VERSION}`} className="surface-card" extra={<Button icon={<CopyOutlined />} onClick={() => void onCopy(instructions, '已复制 MCP Server Instructions。')}>复制 Instructions</Button>}>
        <CodeBlock value={instructions} tall />
      </Card>
      <Alert
        type="warning"
        showIcon
        title="协议指引不是授权"
        description="Tool enabled state、DML allowlist、请求身份、Salesforce CRUD/FLS/Sharing/Validation/Flow/Trigger 才是执行边界；Prompt 与 annotations 不能绕过这些检查。"
      />
    </Space>
  );
}

function SafeList({ values }: Readonly<{ values: readonly string[] }>) {
  return values.length ? <Space wrap>{values.map((value) => <Tag key={value}><code>{value}</code></Tag>)}</Space> : <span>未配置</span>;
}

function GuidanceCard({ title, icon, children }: Readonly<{ title: string; icon: ReactNode; children: ReactNode }>) {
  return <Col xs={24} xl={8}><Card title={<Space>{icon}<span>{title}</span></Space>} className="surface-card full-height">{children}</Card></Col>;
}

function RelationCard({ title, description }: Readonly<{ title: string; description: string }>) {
  return <Col xs={24} md={8}><Card className="relation-card full-height" title={title}>{description}</Card></Col>;
}

function ConnectionExample({
  title,
  value,
  disabled,
  onCopy,
}: Readonly<{ title: string; value: string; disabled: boolean; onCopy(): Promise<void> }>) {
  return (
    <Card title={title} className="surface-card full-height" extra={<Button icon={<CopyOutlined />} disabled={disabled} onClick={() => void onCopy()}>复制示例</Button>}>
      <CodeBlock value={value} />
      <Typography.Paragraph type="secondary" className="credential-note">Token 始终是 placeholder；真实 bearer 不进入浏览器。</Typography.Paragraph>
    </Card>
  );
}

function Recommendation({ title, items }: Readonly<{ title: string; items: readonly string[] }>) {
  return (
    <Card title={title} className="surface-card">
      <ol className="guidance-list">{items.map((item) => <li key={item}>{item}</li>)}</ol>
    </Card>
  );
}

function CodeBlock({ id, value, tall = false }: Readonly<{ id?: string; value: string; tall?: boolean }>) {
  return <pre id={id} className={tall ? 'json-summary integration-code-block integration-code-block-tall' : 'json-summary integration-code-block'}>{value}</pre>;
}
