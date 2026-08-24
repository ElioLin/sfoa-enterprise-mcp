import { expect, test } from '@playwright/test';

test('real Admin browser workflow persists governance and audit through MySQL', async ({ page }) => {
  const username = requiredEnvironment('SFOA_P5_E2E_ADMIN_USERNAME');
  const password = requiredEnvironment('SFOA_P5_E2E_ADMIN_PASSWORD');

  await page.goto('/login');
  await page.getByLabel('Admin username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Operational overview' })).toBeVisible();
  await expect(page.getByText('MySQL', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Identity routes' }).click();
  await page.getByRole('button', { name: 'Create route', exact: true }).click();
  await page.getByLabel('Platform user ID').fill('p5-fullstack-user');
  await page.getByLabel('Salesforce username').fill('p5-fullstack@example.invalid');
  await page.getByLabel('Remark').fill('created through real browser and API');
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page.getByText('p5-fullstack-user')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Remark').fill('updated through real browser and API');
  await page.getByRole('button', { name: 'Save route' }).click();
  await expect(page.getByText('updated through real browser and API')).toBeVisible();

  await page.getByRole('link', { name: 'Tool governance' }).click();
  const toolToggle = page.getByRole('switch', { name: 'Enable get_record_action_context' });
  await toolToggle.click();
  await expect(page.getByRole('switch', { name: 'Disable get_record_action_context' })).toBeChecked();

  await page.getByRole('link', { name: 'DML policies' }).click();
  await page.getByRole('button', { name: 'Add object policy', exact: true }).click();
  await page.getByLabel('Object API name').fill('Lead');
  let policyDialog = page.getByRole('dialog', { name: 'Add object policy' });
  await policyDialog.getByRole('switch').nth(0).click();
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText('Lead')).toBeVisible();
  await page.getByRole('button', { name: /Edit/u }).click();
  policyDialog = page.getByRole('dialog', { name: 'Edit object policy' });
  await policyDialog.getByRole('switch').nth(1).click();
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('cell', { name: 'ALLOWED' })).toHaveCount(2);

  await page.getByRole('link', { name: 'Audit' }).click();
  await expect(page.getByText('CREATE_IDENTITY_ROUTE')).toBeVisible();
  await expect(page.getByText('UPDATE_TOOL_CONTROL')).toBeVisible();
  await expect(page.getByText('UPDATE_DML_POLICY')).toBeVisible();

  await page.getByRole('link', { name: 'System' }).click();
  await expect(page.getByText('Database and credential readiness')).toBeVisible();
  await expect(page.getByText('001_p5_control_plane, 002_p5_indexes')).toBeVisible();
  await expect(page.getByText('MYSQL').first()).toBeVisible();

  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the P5 full-stack E2E orchestrator.`);
  return value;
}
