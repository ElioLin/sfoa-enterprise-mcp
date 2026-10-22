/**
 * CRM 身份绑定维护命令（管理员）。
 *
 *   yarn workspace @sfoa/crm-gateway crm:bind --list
 *   yarn workspace @sfoa/crm-gateway crm:bind \
 *     --org 00D... --user 005... --platform-user 61979 \
 *     --salesforce-username candy.zheng@runner-corp.com.cn.uat
 *   yarn workspace @sfoa/crm-gateway crm:bind --org ... --user ... --disable
 *
 * 该命令只写 sfoa_crm_identity_binding，不改 Salesforce、不止改 Identity Route。
 * 绑定前会核对：platformUserId 的 Identity Route 存在、已启用，且其
 * salesforce_username 与命令行给出的用户名逐字一致（忽略大小写）。
 */

import {
  createControlPlaneDatabase,
  MySqlCrmChatRepository,
  resolveSfoaProjectRoot,
} from '@sfoa/control-plane';
import { loadCrmGatewayConfig } from '../config.js';

type Args = Readonly<{
  list: boolean;
  org?: string;
  user?: string;
  platformUser?: string;
  salesforceUsername?: string;
  displayName?: string;
  disable: boolean;
}>;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = resolveSfoaProjectRoot(import.meta.url);
  const config = await loadCrmGatewayConfig(projectRoot);
  const database = createControlPlaneDatabase(config.database);
  const repository = new MySqlCrmChatRepository(database);
  try {
    if (args.list) {
      const bindings = await repository.listBindings(500);
      process.stdout.write(`${JSON.stringify({ bindings }, null, 2)}\n`);
      return;
    }
    const org = requireMatch(args.org, /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u, '--org');
    const user = requireMatch(args.user, /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u, '--user');
    const platformUser = requireMatch(args.platformUser, /^[^\s\u0000-\u001F\u007F]{1,128}$/u, '--platform-user');
    const route = await repository.findIdentityRoute(platformUser);
    if (!route) {
      throw new Error(`No Identity Route exists for platformUserId ${platformUser}. Create/enable it first.`);
    }
    if (!route.enabled) {
      throw new Error(`The Identity Route for platformUserId ${platformUser} is disabled.`);
    }
    const suppliedUsername = args.salesforceUsername?.trim();
    if (suppliedUsername === undefined || suppliedUsername.length === 0) {
      throw new Error('--salesforce-username is required so the binding can be verified against the route.');
    }
    if (route.salesforceUsername.trim().toLocaleLowerCase('en-US') !== suppliedUsername.toLocaleLowerCase('en-US')) {
      throw new Error(
        `Refusing to bind: the Identity Route executes as ${route.salesforceUsername}, not ${suppliedUsername}.`,
      );
    }
    const binding = await repository.upsertBinding({
      salesforceOrgId: org.toUpperCase(),
      salesforceUserId: user,
      platformUserId: platformUser,
      displayName: args.displayName?.trim() || null,
      enabled: !args.disable,
    });
    process.stdout.write(`${JSON.stringify({ binding }, null, 2)}\n`);
  } finally {
    await database.destroy();
  }
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let list = false;
  let disable = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--list') { list = true; continue; }
    if (token === '--disable') { disable = true; continue; }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
      values.set(key, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return Object.freeze({
    list,
    disable,
    org: values.get('org'),
    user: values.get('user'),
    platformUser: values.get('platform-user'),
    salesforceUsername: values.get('salesforce-username'),
    displayName: values.get('display-name'),
  });
}

function requireMatch(value: string | undefined, pattern: RegExp, name: string): string {
  if (value === undefined || !pattern.test(value)) throw new Error(`${name} is missing or invalid.`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    result: 'ERROR',
    message: error instanceof Error ? error.message : 'The CRM binding command failed.',
  })}\n`);
  process.exitCode = 1;
});
