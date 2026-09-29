// export-agent-skill.mjs — generate a self-contained, zero-credential AgentSkills package
// that connects an arbitrary agent host (OpenClaw or any SKILL.md-compatible harness) to the
// SFoA enterprise MCP runtime over Streamable HTTP.
//
// Methodology absorbed from the MuleRun "MCP-to-Skill" packaging (fastmcp generate-cli +
// mcp.json + SKILL.md tool tables), with the credential model inverted: this package never
// carries Salesforce credentials. Identity resolution, Tool/DML governance, and P7 audit stay
// server-side; the generated mcp.json only points at the endpoint URL.
//
// Single source of truth for the tool table: packages/sfoa-agent-playbook/src/capabilities.ts
// (AGENT_RECOGNIZED_TOOL_NAMES). This script is self-contained by toolkit convention — it
// parses the TypeScript source directly instead of importing build output, so it works on a
// clean checkout without `yarn build`.
//
// Usage (via the maintainer toolkit):
//   yarn skill:export [--endpoint <url>] [--output <dir>] [--server-name <name>]
// Direct:
//   node skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs --endpoint http://127.0.0.1:8080/mcp

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { exists, findProjectRoot, parseCliArguments } from './shared/project.mjs';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8080/mcp';
export const DEFAULT_OUTPUT_DIR = 'out/sfoa-openclaw-package';
export const DEFAULT_SERVER_NAME = 'sfoa';

// The export clears its output root before writing, so --output is only accepted under the
// repository's two generated-output roots (both Git-ignored and disposable), or outside the
// checkout entirely. See assertSafeOutputRoot.
export const GENERATED_OUTPUT_ROOTS = Object.freeze(['out', '.temp']);

// Tools whose results carry trusted record links. Deliberately NOT derived from
// AGENT_INFRASTRUCTURE_TOOL_NAMES: get_agent_playbook returns a capability snapshot, not links, so
// deriving the hard boundary from the infrastructure group would advertise a link source that
// cannot produce one. resolveRecognizedTools still drift-checks this list against the playbook.
export const TRUSTED_LINK_TOOL_NAMES = Object.freeze(['get_record_links']);
export const CAPABILITIES_RELATIVE_PATH = path.join('packages', 'sfoa-agent-playbook', 'src', 'capabilities.ts');
export const PLAYBOOK_VERSION_RELATIVE_PATH = path.join('packages', 'sfoa-agent-playbook', 'src', 'version.ts');

// Static presentation map: one row per recognized tool. Names are cross-checked against
// AGENT_RECOGNIZED_TOOL_NAMES on every run, so the table can never drift silently from the
// playbook's tool surface.
export const TOOL_PRESENTATION = Object.freeze({
  get_username: { group: '基础', purpose: '当前平台用户身份（route-only，不建立 Salesforce 连接）' },
  run_soql_query: { group: '查询', purpose: 'SOQL 查询；READ 访问独立于 DML policy' },
  create_record: { group: '变更', purpose: '单条 CREATE（对象受 DML governance 约束）' },
  update_record: { group: '变更', purpose: '单条 UPDATE（最小 Patch，对象受 DML governance 约束）' },
  create_records: { group: '变更', purpose: '批量 CREATE（同对象分组，每批至多 200 条）' },
  update_records: { group: '变更', purpose: '批量 UPDATE（同对象分组，每批至多 200 条）' },
  resolve_field_display_values: { group: '上下文', purpose: 'Picklist / MultiPicklist API 值到当前 Label 的解析' },
  get_record_relationship_context: { group: '上下文', purpose: '有界关系证据（关系字段、CREATE 治理的子对象）' },
  get_record_action_context: { group: '上下文', purpose: 'CREATE / UPDATE 字段事实（必填、可见性、依赖、Record Type）' },
  get_record_display_context: { group: '上下文', purpose: '记录展示字段、Label 与布局事实' },
  run_diagnostic_tooling_query: { group: '诊断', purpose: 'Tooling API 只读诊断查询（治理可见时）' },
  get_metadata_component_context: { group: '诊断', purpose: 'Metadata 组件上下文' },
  upload_files_to_record: { group: '附件', purpose: '上传本地文件为记录附件' },
  list_sobjects: { group: '数据', purpose: '对象清单与可查询性（describeGlobal），用于自助探索' },
  describe_sobject: { group: '数据', purpose: '对象字段/关系/picklist 元数据（describe），用于查询前核对字段' },
  query_records: { group: '数据', purpose: '有界自动翻页 SOQL（totalSize/fetched/truncated），用于完整性声明' },
  search_records: { group: '数据', purpose: 'SOSL 跨对象关键词检索，结果有界' },
  submit_bulk_query: { group: '数据', purpose: 'Bulk API 2.0 查询作业提交，返回 jobId（服务端不保存作业状态）' },
  get_bulk_query_results: { group: '数据', purpose: 'Bulk 查询作业状态与结果页读取（一次一页 + 游标）' },
  get_org_limits: { group: '诊断', purpose: 'org limits 快照（API/Bulk 配额），由 DIAGNOSTIC 身份执行' },
  get_agent_playbook: { group: '基础设施', purpose: '当前 Playbook 与能力快照' },
  get_record_links: { group: '基础设施', purpose: '可信记录链接；不猜测或拼接 Salesforce URL' },
});

export function extractStringArray(source, arrayName) {
  const pattern = new RegExp(`export const ${arrayName} = \\[([\\s\\S]*?)\\] as const;`, 'u');
  const body = pattern.exec(source)?.[1];
  if (body === undefined) throw new Error(`Could not locate "export const ${arrayName} = [ ... ] as const;" in the playbook source.`);
  const names = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    if (/^\.\.\.[A-Za-z0-9_]+,$/u.test(trimmed)) continue; // spreads are validated by extractSpreadArrays
    const literal = /^'([A-Za-z0-9_]+)',$/u.exec(trimmed);
    if (literal) {
      names.push(literal[1]);
      continue;
    }
    throw new Error(`Unsupported entry in ${arrayName}: "${trimmed}". Only quoted names and the AGENT_INFRASTRUCTURE_TOOL_NAMES spread are expected; update the export generator parser.`);
  }
  return names;
}

export function extractSpreadArrays(source, arrayName) {
  const pattern = new RegExp(`export const ${arrayName} = \\[([\\s\\S]*?)\\] as const;`, 'u');
  const body = pattern.exec(source)?.[1];
  if (body === undefined) throw new Error(`Could not locate "export const ${arrayName}" in the playbook source.`);
  const spreads = [];
  for (const match of body.matchAll(/\.\.\.([A-Za-z0-9_]+)/gu)) spreads.push(match[1]);
  return [...new Set(spreads)];
}

export function extractPlaybookVersion(source) {
  const version = /export const AGENT_PLAYBOOK_VERSION = '([^']+)' as const;/u.exec(source)?.[1];
  if (version === undefined) throw new Error('Could not locate AGENT_PLAYBOOK_VERSION in the playbook version source.');
  return version;
}

export function resolveRecognizedTools(capabilitiesSource) {
  const infrastructure = extractStringArray(capabilitiesSource, 'AGENT_INFRASTRUCTURE_TOOL_NAMES');
  const spreads = extractSpreadArrays(capabilitiesSource, 'AGENT_RECOGNIZED_TOOL_NAMES');
  const unexpectedSpreads = spreads.filter((name) => name !== 'AGENT_INFRASTRUCTURE_TOOL_NAMES');
  if (unexpectedSpreads.length > 0) {
    throw new Error(`AGENT_RECOGNIZED_TOOL_NAMES contains unexpected spreads: ${unexpectedSpreads.join(', ')}.`);
  }
  const direct = extractStringArray(capabilitiesSource, 'AGENT_RECOGNIZED_TOOL_NAMES');
  const names = [...direct, ...(spreads.includes('AGENT_INFRASTRUCTURE_TOOL_NAMES') ? infrastructure : [])];
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) throw new Error(`Duplicate tool names recognized by the playbook: ${duplicates.join(', ')}.`);
  if (names.length === 0) throw new Error('AGENT_RECOGNIZED_TOOL_NAMES resolved to an empty tool surface.');
  const missingPresentation = names.filter((name) => !(name in TOOL_PRESENTATION));
  const stalePresentation = Object.keys(TOOL_PRESENTATION).filter((name) => !names.includes(name));
  const unknownLinkTools = TRUSTED_LINK_TOOL_NAMES.filter((name) => !names.includes(name));
  const drift = [
    ...missingPresentation.map((name) => `tool missing from TOOL_PRESENTATION: ${name}`),
    ...stalePresentation.map((name) => `TOOL_PRESENTATION entry no longer recognized by the playbook: ${name}`),
    ...unknownLinkTools.map((name) => `TRUSTED_LINK_TOOL_NAMES entry no longer recognized by the playbook: ${name}`),
  ];
  if (drift.length > 0) throw new Error(`Tool presentation drift detected:\n${drift.map((line) => `- ${line}`).join('\n')}`);
  return Object.freeze({ names: Object.freeze(names), infrastructure: Object.freeze(infrastructure) });
}

// exportAgentSkillPackage clears its output root before writing, so the target has to be a path we
// are allowed to delete: a generated-output root inside the checkout (out/ or .temp/), or a scratch
// directory outside it. The checkout itself, an ancestor of it, a source directory, another Git
// working tree, the home directory and filesystem roots are refused rather than cleared.
export async function assertSafeOutputRoot({ projectRoot, outputDir }) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(path.isAbsolute(outputDir) ? outputDir : path.join(root, outputDir));
  const guidance = `Pass a generated-output directory (${GENERATED_OUTPUT_ROOTS.map((name) => `${name}/<name>`).join(' or ')} inside the checkout, or a scratch directory outside it).`;
  const refuse = (reason) => {
    throw new Error(`Refusing to clear ${target}: ${reason}. ${guidance}`);
  };
  const moveUp = (from, to) => {
    const relative = path.relative(from, to);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  if (target === root) refuse('that is the project root itself');
  if (!moveUp(root, target)) {
    if (moveUp(target, root)) refuse('the project root lives inside that directory');
    if (target === path.parse(target).root) refuse('that is a filesystem root');
    if (target === path.resolve(os.homedir())) refuse('that is the home directory');
    if (await exists(path.join(target, '.git'))) refuse('that directory is a Git working tree');
    return target;
  }
  const [topLevel] = path.relative(root, target).split(path.sep);
  if (!GENERATED_OUTPUT_ROOTS.includes(topLevel)) {
    refuse(`"${topLevel}/" is repository source, not a generated-output root`);
  }
  return target;
}

export async function exportAgentSkillPackage({
  projectRoot,
  endpoint = DEFAULT_ENDPOINT,
  outputDir = DEFAULT_OUTPUT_DIR,
  serverName = DEFAULT_SERVER_NAME,
} = {}) {
  if (typeof endpoint !== 'string' || !/^https?:\/\/\S+$/u.test(endpoint)) {
    throw new Error(`--endpoint must be an http(s) URL (received: ${String(endpoint)}).`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(serverName) || serverName.length > 48) {
    throw new Error(`Invalid server name: ${serverName}`);
  }
  const root = projectRoot ?? await findProjectRoot();
  const capabilitiesSource = await readFile(path.join(root, ...CAPABILITIES_RELATIVE_PATH.split(path.sep)), 'utf8');
  const versionSource = await readFile(path.join(root, ...PLAYBOOK_VERSION_RELATIVE_PATH.split(path.sep)), 'utf8');
  const { names } = resolveRecognizedTools(capabilitiesSource);
  const playbookVersion = extractPlaybookVersion(versionSource);

  const packageRoot = await assertSafeOutputRoot({ projectRoot: root, outputDir });
  const skillDir = path.join(packageRoot, serverName);
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(skillDir, { recursive: true });

  await writeFile(path.join(skillDir, 'SKILL.md'), renderSkillMarkdown({ names, playbookVersion, serverName }), 'utf8');
  await writeFile(path.join(skillDir, 'mcp.json'), `${JSON.stringify(renderMcpJson({ endpoint, serverName }), null, 2)}\n`, 'utf8');
  await writeFile(path.join(packageRoot, 'README.md'), renderReadme({ endpoint, serverName, outputDir, playbookVersion, toolCount: names.length }), 'utf8');

  return Object.freeze({
    ok: true,
    endpoint,
    serverName,
    playbookVersion,
    toolCount: names.length,
    packageRoot: path.relative(root, packageRoot),
    files: Object.freeze([`${serverName}/SKILL.md`, `${serverName}/mcp.json`, 'README.md']),
  });
}

function renderSkillMarkdown({ names, playbookVersion, serverName }) {
  const rows = names.map((name) => `| ${name} | ${TOOL_PRESENTATION[name].group} | ${TOOL_PRESENTATION[name].purpose} |`);
  const linkSources = TRUSTED_LINK_TOOL_NAMES.map((name) => `\`${name}\``).join('、');
  return `---
name: ${serverName}
description: 连接 SFoA MCP 服务完成 Salesforce CRM 查询与受治理变更的入口 Skill。用于查询公司 CRM 数据、创建或修改记录、获取字段与关系上下文、可信记录链接与附件上传；不用于无 CRM 意图的闲聊或一般网页任务，也不承担 SFoA 仓库开发运维。
---

# SFoA Agent Connector

本 Skill 通过同目录 [mcp.json](mcp.json) 以 Streamable HTTP 连接 SFoA 企业 MCP Runtime（Agent Playbook ${playbookVersion} 工具面）。**本包不携带任何 Salesforce 凭证**：身份解析、Tool/DML governance 与审计全部在服务端执行。

## 硬边界

- 身份由服务端从认证主体解析（如 OpenClaw trusted requester → 企微身份链）；**MUST NOT** 从 Prompt、Tool argument 或本 Skill 选择 Salesforce 身份。
- **MUST** 只使用当前 tools/list 实际暴露的 Tool；Tool 不可见即当前无权限或未启用，**MUST NOT** 绕过治理用其它通道。
- Salesforce 对 CRUD、FLS、Sharing、Validation 的裁决最终权威。
- 写入结果为 UNKNOWN / OUTCOME_UNKNOWN 时**MUST NOT** 自动重试；先独立读取确认。
- 变更后的操作总结与记录导航：只使用 ${linkSources}（或变更 Tool 结果中直接返回）的可信链接，**MUST NOT** 自行拼接 Salesforce URL。

## 工具表（路由参考）

下表由 \`packages/sfoa-agent-playbook/src/capabilities.ts\` 生成，仅用于路由；**实际可用工具以当前连接的 tools/list 为准**（服务端治理可能禁用其中任意工具）。

| Tool | 类别 | 用途 |
| --- | --- | --- |
${rows.join('\n')}

## 安装与移除

见上级目录 [README.md](../README.md)。重新生成本包：\`yarn skill:export --endpoint <url>\`。
`;
}

function renderMcpJson({ endpoint, serverName }) {
  return {
    mcpServers: {
      [serverName]: {
        url: endpoint,
        description: 'SFoA enterprise MCP runtime (Streamable HTTP). Identity, Tool/DML governance and P7 audit are enforced server-side. No Salesforce credentials belong in this file.',
      },
    },
  };
}

function renderReadme({ endpoint, serverName, outputDir, playbookVersion, toolCount }) {
  return `# SFoA Agent Skill 导出包（${serverName}）

自包含、零凭证的 AgentSkills 分发包：把支持 SKILL.md 的智能体宿主（OpenClaw 等）接到 SFoA 企业 MCP Runtime。
「自包含」指本包内容自足（入口 Skill + 连接描述符 + 安装说明），**不指开箱即连**：endpoint 仍需宿主侧登记，
认证仍由服务端与企微适配器插件（SecretRef）承担；本包不含、也不生成任何凭据。

- 生成命令：\`yarn skill:export --endpoint <url>\`（本包由 Agent Playbook ${playbookVersion} 工具面 ${toolCount} 个 Tool 生成）
- 生成物：\`${serverName}/SKILL.md\`（入口与硬边界）、\`${serverName}/mcp.json\`（连接描述符，url 模式）、本 README
- 事实来源：\`packages/sfoa-agent-playbook/src/capabilities.ts\`；修改工具面后重新生成，不要手改本包

## 安装到 OpenClaw

1. 复制 \`${serverName}/\` 目录到 OpenClaw workspace 的 skills 目录（测试服务器即 \`/data/openclaw/workspace/skills/\`），或在宿主配置中按其 skills.load / skills.entries 机制登记。
2. MCP 连接：按宿主对 stdio / HTTP MCP server 的声明方式注册 \`${serverName}/mcp.json\` 中的 endpoint（\`${endpoint}\`）。企微身份链场景使用仓库内 \`integrations/openclaw/sfoa-wecom-mcp-adapter\` 插件（mcpUrl + SecretRef 凭证），不要把凭证写进本包。
3. 直接访问 endpoint 需要服务端当前认证配置要求的凭据；本包不内嵌、也不生成任何凭据。

## 边界与移除

- 本包不新增服务端工具面，不暴露 Tooling / Apex / 任意 REST 透传，也不携带 maintainer 诊断能力。
- 移除：删除 workspace 中的 \`${serverName}/\` 目录并注销宿主侧 MCP 注册即可；生成器与产物均可独立删除，不影响 canonical Skills 与 Runtime。
- 仓库内再生成与校验：\`yarn skill:export\`、\`yarn skill:test\`。
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  try {
    const result = await exportAgentSkillPackage({
      ...(arguments_.endpoint ? { endpoint: String(arguments_.endpoint) } : {}),
      ...(arguments_.output ? { outputDir: String(arguments_.output) } : {}),
      ...(arguments_['server-name'] ? { serverName: String(arguments_['server-name']) } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
