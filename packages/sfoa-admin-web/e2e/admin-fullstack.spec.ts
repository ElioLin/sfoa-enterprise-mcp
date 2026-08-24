import { expect, test } from '@playwright/test';

test('real Admin browser workflow persists governance and audit through MySQL', async ({ page }) => {
  const username = requiredEnvironment('SFOA_P5_E2E_ADMIN_USERNAME');
  const password = requiredEnvironment('SFOA_P5_E2E_ADMIN_PASSWORD');

  await page.goto('/login');
  await page.getByLabel('管理员用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '安全登录' }).click();
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeVisible();
  await expect(page.getByText('MySQL', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '用户身份路由' }).click();
  await page.getByRole('button', { name: '新建路由', exact: true }).click();
  await page.getByLabel('平台用户 ID').fill('p5-fullstack-user');
  await page.getByLabel('Salesforce Username').fill('p5-fullstack@example.invalid');
  await page.getByLabel('备注').fill('created through real browser and API');
  await page.getByRole('button', { name: '保存路由' }).click();
  await expect(page.getByText('p5-fullstack-user')).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('备注').fill('updated through real browser and API');
  await page.getByRole('button', { name: '保存路由' }).click();
  await expect(page.getByText('updated through real browser and API')).toBeVisible();

  await page.getByRole('link', { name: '工具治理' }).click();
  const toolToggle = page.getByRole('switch', { name: '启用 get_record_action_context' });
  await toolToggle.click();
  await expect(page.getByRole('switch', { name: '停用 get_record_action_context' })).toBeChecked();

  await page.getByRole('link', { name: 'DML 操作策略' }).click();
  await page.getByRole('button', { name: '添加对象策略', exact: true }).click();
  await page.getByLabel('对象 API 名称').fill('Lead');
  let policyDialog = page.getByRole('dialog', { name: '添加对象策略' });
  await policyDialog.getByRole('switch').nth(0).click();
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect(page.getByText('Lead')).toBeVisible();
  await page.getByRole('button', { name: /编辑/u }).click();
  policyDialog = page.getByRole('dialog', { name: '编辑对象策略' });
  await policyDialog.getByRole('switch').nth(1).click();
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect(page.getByRole('cell', { name: '已允许' })).toHaveCount(2);

  await page.getByRole('link', { name: '调用审计' }).click();
  await expect(page.getByText('CREATE_IDENTITY_ROUTE')).toBeVisible();
  await expect(page.getByText('UPDATE_TOOL_CONTROL')).toBeVisible();
  await expect(page.getByText('UPDATE_DML_POLICY')).toBeVisible();

  await page.getByRole('link', { name: '系统状态' }).click();
  await expect(page.getByText('数据库与凭据就绪状态')).toBeVisible();
  await expect(page.getByText('001_p5_control_plane, 002_p5_indexes')).toBeVisible();
  await expect(page.getByText('MYSQL').first()).toBeVisible();

  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the P5 full-stack E2E orchestrator.`);
  return value;
}
