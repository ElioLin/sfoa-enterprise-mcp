import { ApiOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { adminApi, ApiError } from '../api/client.js';

type LoginFields = Readonly<{ username: string; password: string }>;

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: adminApi.login,
    onSuccess: async (session) => {
      queryClient.setQueryData(['auth', 'me'], session);
      const state = isLocationState(location.state) ? location.state : undefined;
      await navigate(state?.from && state.from !== '/login' ? state.from : '/dashboard', { replace: true });
    },
  });
  const errorMessage = login.error instanceof ApiError
    ? login.error.status === 429
      ? 'Too many attempts. Wait for the login window to reset, then retry.'
      : login.error.message
    : login.error ? 'Login failed safely. Verify Admin API readiness.' : null;

  return (
    <main className="login-page" aria-labelledby="login-title">
      <section className="login-intro">
        <span className="login-mark" aria-hidden="true"><ApiOutlined /></span>
        <Typography.Text className="eyebrow">SFoA Enterprise MCP</Typography.Text>
        <Typography.Title id="login-title">Governance that stays thin, visible, and accountable.</Typography.Title>
        <Typography.Paragraph>
          Configure SFoA-owned identity routes and runtime policy. Salesforce remains the authority for CRUD, FLS,
          sharing, validation, Flow, and Trigger behavior.
        </Typography.Paragraph>
        <Space wrap>
          <span className="trust-pill">Signed session</span>
          <span className="trust-pill">CSRF protected</span>
          <span className="trust-pill">No browser secrets</span>
        </Space>
      </section>
      <Card className="login-card" variant="borderless">
        <Typography.Title level={2}>Administrator sign in</Typography.Title>
        <Typography.Paragraph type="secondary">Use the bounded bootstrap administrator configured on the Admin API.</Typography.Paragraph>
        {errorMessage ? <Alert type="error" showIcon role="alert" title="Sign in unsuccessful" description={errorMessage} /> : null}
        <Form<LoginFields>
          layout="vertical"
          requiredMark="optional"
          onFinish={(values) => login.mutate(values)}
          initialValues={{ username: '' }}
          size="large"
        >
          <Form.Item
            name="username"
            label="Admin username"
            rules={[{ required: true, whitespace: true, message: 'Enter the configured Admin username.' }]}
          >
            <Input prefix={<UserOutlined />} autoComplete="username" maxLength={128} disabled={login.isPending} />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, message: 'Enter the Admin password.' }]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" maxLength={1024} disabled={login.isPending} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={login.isPending}>Sign in securely</Button>
        </Form>
        <Typography.Paragraph className="login-note" type="secondary">
          Credentials are sent only to the same-origin Admin API and are never stored in localStorage or sessionStorage.
        </Typography.Paragraph>
      </Card>
    </main>
  );
}

function isLocationState(value: unknown): value is Readonly<{ from?: string }> {
  return typeof value === 'object' && value !== null && (!('from' in value) || typeof value.from === 'string');
}
