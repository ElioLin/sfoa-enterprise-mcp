import zhCN from 'antd/locale/zh_CN';

export const ADMIN_ANT_LOCALE = zhCN;
export const ADMIN_LOCALE_CODE = 'zh-CN';
const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ENABLED: '已启用',
  DISABLED: '已停用',
  PASS: '通过',
  FAIL: '失败',
  FAILED: '失败',
  READY: '就绪',
  FINAL_ACCEPTED: '最终接受',
  UP: '正常',
  DOWN: '不可用',
  DEGRADED: '降级',
  UNKNOWN: '未知',
  NOT_TESTED: '未测试',
  NOT_VERIFIED: '未验证',
  NOT_CONFIGURED: '未配置',
  READ: '只读',
  METADATA_READ: 'Metadata 只读',
  DIAGNOSTIC: '诊断',
  USER: '用户',
  AVAILABLE: '可用',
  ALLOWED: '已允许',
  DENIED: '已拒绝',
  BLOCKED: '已阻止',
  ERROR: '错误',
  SUCCESS: '成功',
  PARTIAL: '部分通过',
  CONFIGURED: '已配置',
  REVIEW_REQUIRED: '需要审查',
  UPSTREAM_REVIEW_REQUIRED: '上游需要审查',
  UNSUPPORTED: '不支持',
  PROCESSING: '处理中',
  IN_DEVELOPMENT: '开发中',
  GA: '正式可用',
  NON_GA: '非 GA',
  MUTATION: 'DML 操作',
  ADMIN: '管理',
  LOCAL_DEV: '本地开发',
  YES: '是',
  NO: '否',
});
const ERROR_EXPLANATIONS: Readonly<Record<string, string>> = Object.freeze({
  MCP_IDENTITY_ROUTE_NOT_FOUND: '未找到该平台用户对应的 Salesforce 身份路由。',
  MCP_IDENTITY_CREDENTIAL_INVALID: 'MCP 用户凭证无效，请重新复制当前 Token 或 WorkBuddy 配置。',
  MCP_IDENTITY_CREDENTIAL_REVOKED: 'MCP 用户凭证已失效，请使用管理员重新生成的新 Token。',
  MCP_IDENTITY_ROUTE_DISABLED: '该用户身份路由已停用，当前 Token 暂不可用。',
  MCP_IDENTITY_CONTEXT_MISMATCH: '请求身份与 Token 绑定的平台用户不一致。',
  MCP_IDENTITY_ROUTE_DELETE_REQUIRES_DISABLED: '必须先停用用户身份路由，才能永久删除。',
  MCP_DML_OBJECT_NOT_ALLOWED: '当前对象未启用对应的 DML 操作权限。',
  MCP_DML_OUTCOME_UNKNOWN: '无法确认 Salesforce 最终是否已提交本次操作，请勿直接重试。',
  MCP_ADMIN_AUTH_INVALID: '管理员用户名或密码不正确。',
  MCP_ADMIN_UNAUTHORIZED: '管理员会话无效或已过期，请重新登录。',
  MCP_ADMIN_REQUEST_FAILED: '管理端请求未获得结构化响应，请检查 Admin API 就绪状态。',
  MCP_ADMIN_RESPONSE_INVALID: 'Admin API 返回了无效的 JSON 响应。',
  MCP_ADMIN_CONCURRENT_MODIFICATION: '其他管理员已修改该配置，请刷新最新版本后重新确认。',
  MCP_CONTROL_PLANE_UNAVAILABLE: '控制平面当前不可用，请检查 MySQL 与 Admin API 就绪状态。',
  MCP_UPSTREAM_TOOL_CONTRACT_DRIFT: '检测到上游 Tool 契约变化，必须先完成维护者审查。',
});
const TOOL_DEPENDENCIES: Readonly<Record<string, string>> = Object.freeze({
  'request workspace': '请求级工作区',
  'CWD guard': 'CWD 隔离保护',
  'Object × CREATE/UPDATE policy': '对象 × CREATE/UPDATE 策略',
  'enabled Diagnostic configuration': '已启用的诊断配置',
  'audited official Tool contract': '已审计的官方 Tool 契约',
  'USER identity route': 'USER 身份路由',
});
const TOOL_DISABLED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'Upstream contract drift requires Maintainer review.': '上游契约发生变化，需要维护者审查。',
  'The audited Tool is not remote compatible.': '该已审计 Tool 不兼容远程调用。',
  'The audited Tool is NON-GA and is not enabled in this runtime.': '该已审计 Tool 当前为非 GA，当前 Runtime 不允许启用。',
  'The Tool has no audited upstream release contract.': '该 Tool 尚未完成上游发布契约审计。',
  'Database Tool name is absent from the audited executable catalog.': '该数据库 Tool 名不存在于已审计的可执行目录中。',
  'Unknown executable catalog entry.': '未知的可执行目录项。',
});
export function statusLabel(value: string): string {
  return STATUS_LABELS[normalizeStatus(value)] ?? value.replaceAll('_', ' ');
}

export function hasLocalizedStatus(value: string): boolean {
  return Object.hasOwn(STATUS_LABELS, normalizeStatus(value));
}
export function localizeErrorCode(errorCode: string, status?: number): Readonly<{ title: string; explanation: string }> {
  if (status === 409) {
    return Object.freeze({ title: '配置已变更', explanation: ERROR_EXPLANATIONS.MCP_ADMIN_CONCURRENT_MODIFICATION! });
  }
  if (status === 429) {
    return Object.freeze({ title: '请求过于频繁', explanation: '登录尝试次数过多，请等待限制时间窗重置后再试。' });
  }
  return Object.freeze({
    title: errorCode === 'MCP_ADMIN_REQUEST_FAILED' ? '请求失败' : '操作未完成',
    explanation: ERROR_EXPLANATIONS[errorCode] ?? '操作已安全失败，请根据下方技术详情检查配置或服务状态。',
  });
}
export function localizeToolDependency(value: string): string {
  return TOOL_DEPENDENCIES[value] ?? value;
}

export function localizeToolDisabledReason(value: string): string {
  if (TOOL_DISABLED_REASONS[value]) return TOOL_DISABLED_REASONS[value];
  const classification = /^Official classification (.+) is not Agent-safe in this runtime\.$/u.exec(value)?.[1];
  return classification
    ? `官方分类 ${classification} 在当前 Runtime 中不允许向 Agent 开放。`
    : value;
}
export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(ADMIN_LOCALE_CODE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function normalizeStatus(value: string): string {
  return value.trim().replaceAll(' ', '_').toLocaleUpperCase('en-US');
}
