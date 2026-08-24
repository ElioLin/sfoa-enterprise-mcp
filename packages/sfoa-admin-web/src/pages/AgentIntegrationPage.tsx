import {
  ApiOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  LinkOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
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
import workBuddySystemPrompt from '../../../../docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md?raw';
import { adminApi } from '../api/client.js';
import {
  bindHostGuidance,
  buildDifyConnectionExample,
  buildWorkBuddyConnectionExample,
  deriveMcpConnectivity,
  lanMcpUrl,
  loopbackMcpUrl,
  validateExternalMcpUrl,
  type McpConnectivityConfig,
} from '../agent/connectivity.js';
import { deriveDifyInstructionFacts, generateDifyAgentInstruction } from '../agent/instruction-generator.js';
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
  const generatorInput = useMemo(() => status.data && tools.data && policies.data ? Object.freeze({
    tools: tools.data.items,
    dmlPolicies: policies.data,
    diagnostic: status.data.diagnostic,
  }) : null, [policies.data, status.data, tools.data]);

  useEffect(() => {
    if (!status.data || externalUrlTouched) return;
    setExternalUrl(loopbackMcpUrl(deriveMcpConnectivity(status.data)));
  }, [externalUrlTouched, status.data]);

  useEffect(() => {
    if (generatorInput) setInstruction(generateDifyAgentInstruction(generatorInput));
  }, [generatorInput]);

  const pending = status.isPending || tools.isPending || policies.isPending;
  const error = status.error ?? tools.error ?? policies.error;
  const refresh = async (): Promise<void> => {
    await Promise.all([status.refetch(), tools.refetch(), policies.refetch()]);
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
      description="为 Dify 与 WorkBuddy 生成安全的 MCP 连接示例、当前 Tool/策略驱动的 Agent 指令，以及 Salesforce 专项 Skill 安装指引。"
      action={<Button icon={<ReloadOutlined />} loading={status.isFetching || tools.isFetching || policies.isFetching} onClick={() => void refresh()}>刷新当前状态</Button>}
    >
      {pending ? <LoadingState rows={8} /> : error ? <ErrorState error={error} onRetry={() => void refresh()} /> : status.data && tools.data && policies.data && generatorInput ? (
        <Tabs
          destroyOnHidden={false}
          items={[
            {
              key: 'mcp',
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
              key: 'dify',
              label: 'Dify 指令',
              children: (
                <DifyTab
                  instruction={instruction}
                  facts={deriveDifyInstructionFacts(generatorInput)}
                  onGenerate={() => {
                    setInstruction(generateDifyAgentInstruction(generatorInput));
                    void message.success('已根据当前 Tool、DML 策略与 Diagnostic verification 重新生成。');
                  }}
                  onCopy={() => copy(instruction, '已复制 Dify Agent 指令。')}
                />
              ),
            },
            {
              key: 'workbuddy',
              label: 'WorkBuddy',
              children: <WorkBuddyTab externalUrl={externalUrl} systemPrompt={workBuddySystemPrompt} onCopy={copy} />,
            },
            {
              key: 'skill',
              label: 'Skill',
              children: <SkillTab onCopy={() => copy(skillMarkdown, '已复制 SKILL.md。')} />,
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
  const difyExample = buildDifyConnectionExample(exampleUrl);
  const workBuddyExample = buildWorkBuddyConnectionExample(exampleUrl);
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
          此页仅显示安全配置与“已配置 / 未配置”状态，不返回 MCP_CLIENT_TOKEN、数据库密码、JWT private key、access token 或 Admin session secret。
        </Typography.Paragraph>
      </Card>

      <Alert type="info" showIcon title="本机地址与网络可达性" description={bindHostGuidance(config)} />
      <Row gutter={[16, 16]}>
        <GuidanceCard title="本机接入" icon={<ApiOutlined />}>
          <CodeBlock value={loopbackMcpUrl(config)} />
          <Typography.Paragraph>该地址仅适用于与 MCP Runtime 位于同一台主机的客户端。外部 Dify / WorkBuddy 无法通过它们自己的 127.0.0.1 访问本机 MCP。</Typography.Paragraph>
        </GuidanceCard>
        <GuidanceCard title="LAN 测试" icon={<LinkOutlined />}>
          <CodeBlock value={[
            'MCP_BIND_HOST=0.0.0.0',
            `MCP_ALLOWED_HOSTS=<YOUR_LAN_IP>:${config.port}`,
            'MCP_AUTH_MODE=internal_bearer',
            '',
            `Endpoint: ${lanMcpUrl(config)}`,
          ].join('\n')} />
          <Typography.Paragraph>需要 Windows/Linux Firewall 放通 TCP {config.port}。只有与该 IP 网络可达的 Dify/WorkBuddy Runtime 才能连接。本页不会自动修改 firewall、.env.local 或开启 0.0.0.0。</Typography.Paragraph>
        </GuidanceCard>
        <GuidanceCard title="生产 HTTPS" icon={<SafetyCertificateOutlined />}>
          <CodeBlock value={'https://mcp.example.com/mcp\n        ↓\nNginx/TLS\n        ↓\nhttp://127.0.0.1:8080/mcp'} />
          <Typography.Paragraph>生产不建议直接公开 8080。请按 <code>docs/sfoa/P2_REVERSE_PROXY.md</code> 与 <code>docs/sfoa/P5_DEPLOYMENT.md</code> 配置 reverse proxy 与 TLS；本任务不会自动部署 Nginx。</Typography.Paragraph>
        </GuidanceCard>
      </Row>

      <Alert
        type="warning"
        showIcon
        title="0.0.0.0 不等于互联网可访问"
        description="127.0.0.1 = 本机；0.0.0.0 = 监听所有本机网络接口。实际访问仍取决于 route、firewall、security group、reverse proxy 与 DNS。"
      />
      <Alert
        type="warning"
        showIcon
        title="X-Platform-User-Id 是当前 authoritative input"
        description="P6 内部测试可以由一个受控 connector 使用一个固定 platformUserId，但这不等于 WorkBuddy/Dify 每个终端用户的动态 Salesforce 身份。未来需要 trusted gateway / authenticated claim 派生 platformUserId 并覆盖入站 Header；本任务不实现该 Gateway。"
      />

      <Card title="外部地址测试输入" className="surface-card">
        <Typography.Paragraph type="secondary">仅用于在浏览器中生成连接配置示例；默认不持久化，也不作为 Runtime Authority。</Typography.Paragraph>
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
        <Col xs={24} xl={12}>
          <ConnectionExample title="Dify 连接示例" value={difyExample} disabled={!validation.valid} onCopy={() => onCopy(difyExample, '已复制 Dify 连接示例。')} />
        </Col>
        <Col xs={24} xl={12}>
          <ConnectionExample title="WorkBuddy 连接示例" value={workBuddyExample} disabled={!validation.valid} onCopy={() => onCopy(workBuddyExample, '已复制 WorkBuddy 连接示例。')} />
        </Col>
      </Row>
    </Space>
  );
}

function DifyTab({
  instruction,
  facts,
  onGenerate,
  onCopy,
}: Readonly<{
  instruction: string;
  facts: ReturnType<typeof deriveDifyInstructionFacts>;
  onGenerate(): void;
  onCopy(): Promise<void>;
}>) {
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Alert type="info" showIcon title="确定性生成" description="指令仅由当前可执行 Tool 目录、数据库 Tool enabled state、DML 操作策略与 Diagnostic verification 生成，不调用 LLM。" />
      <Card title="当前生成依据" className="surface-card">
        <Space wrap>
          {facts.availableTools.map((name) => <Tag key={name}><code>{name}</code></Tag>)}
          <Tag>CREATE 对象 {facts.createObjects.length}</Tag>
          <Tag>UPDATE 对象 {facts.updateObjects.length}</Tag>
          <StatusTag label={facts.diagnosticReady ? 'READY' : facts.diagnosticEnabledButUnverified ? 'NOT_VERIFIED' : 'DISABLED'} />
        </Space>
      </Card>
      <Space wrap>
        <Button type="primary" icon={<ReloadOutlined />} onClick={onGenerate}>生成指令</Button>
        <Button icon={<CopyOutlined />} disabled={!instruction} onClick={() => void onCopy()}>复制指令</Button>
      </Space>
      <CodeBlock value={instruction} tall />
      <Recommendation title="Dify 推荐步骤" items={[
        '添加 MCP。',
        '填写可达的 MCP URL。',
        '配置 Bearer token。',
        '配置 platformUserId。',
        '加载当前允许的 MCP Tools。',
        '将生成的 Dify Agent Instruction 复制到 Agent 指令。',
        '执行 P6 Test Dataset。',
      ]} />
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
      <Row gutter={[16, 16]}>
        <RelationCard title="Connector" description="负责网络连接、认证与 MCP Tool 发现。" />
        <RelationCard title="System Prompt" description="定义 Agent 全局行为与高风险 DML 安全原则。" />
        <RelationCard title="Skill" description="提供 Salesforce 专项 Tool 工作流与安全边界。" />
      </Row>
      <Alert type="warning" showIcon title="Connector 不会自动教会业务流程" description="配置 Connector 后仍需要精简 System Prompt 与 sfoa-salesforce-assistant Skill。静态 Connector Header 也不等于每个 WorkBuddy 终端用户的动态 Salesforce 身份。" />
      <Recommendation title="WorkBuddy 推荐步骤" items={[
        '创建自定义 MCP Connector。',
        '配置 Streamable HTTP Endpoint。',
        '配置 Authorization。',
        '配置 X-Platform-User-Id。',
        '创建或配置 Agent。',
        '添加精简 System Prompt。',
        '安装并启用 sfoa-salesforce-assistant Skill。',
        '执行 Test Run。',
      ]} />
      <ConnectionExample title="WorkBuddy Connector 示例" value={example} disabled={!validation.valid} onCopy={() => onCopy(example, '已复制 WorkBuddy Connector 示例。')} />
      <Card title="精简 System Prompt" className="surface-card" extra={<Button icon={<CopyOutlined />} onClick={() => void onCopy(systemPrompt, '已复制 WorkBuddy System Prompt。')}>复制 System Prompt</Button>}>
        <CodeBlock value={systemPrompt} tall />
      </Card>
    </Space>
  );
}

function SkillTab({ onCopy }: Readonly<{ onCopy(): Promise<void> }>) {
  return (
    <Space orientation="vertical" size="large" className="full-width">
      <Card title="sfoa-salesforce-assistant" className="surface-card">
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="Skill 名称"><code>sfoa-salesforce-assistant</code></Descriptions.Item>
          <Descriptions.Item label="用途">通过企业 SFoA MCP 查询、创建、更新或诊断 Salesforce/SFoA 数据与配置。</Descriptions.Item>
          <Descriptions.Item label="SKILL.md 摘要">路由 READ / CREATE / UPDATE / DIAGNOSIS 工作流，并强制身份、Salesforce 规则与 UNKNOWN outcome 安全边界。</Descriptions.Item>
          <Descriptions.Item label="Repo 路径"><code>{SKILL_REPO_PATH}</code></Descriptions.Item>
        </Descriptions>
      </Card>
      <Recommendation title="安装 / 导入说明" items={[
        `保留 Repo 中的 ${SKILL_REPO_PATH} 目录结构。`,
        '在 WorkBuddy / CodeBuddy Skill 管理页选择项目级 Skill 导入，或将该目录复制到目标工作区的 .codebuddy/skills/。',
        '确认 SKILL.md 与 references/ 两个参考文件同时存在。',
        '启用 Skill 后执行一次只读 Test Run，再进入 DML 测试。',
      ]} />
      <Button type="primary" icon={<CopyOutlined />} onClick={() => void onCopy()}>复制 SKILL.md</Button>
      <CodeBlock value={skillMarkdown} tall />
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
      <Typography.Paragraph type="secondary" className="credential-note">Token 始终使用 placeholder，真实 secret 不进入浏览器。</Typography.Paragraph>
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

function CodeBlock({ value, tall = false }: Readonly<{ value: string; tall?: boolean }>) {
  return <pre className={tall ? 'json-summary integration-code-block integration-code-block-tall' : 'json-summary integration-code-block'}>{value}</pre>;
}
