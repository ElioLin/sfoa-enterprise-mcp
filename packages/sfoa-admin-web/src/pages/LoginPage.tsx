import { ApiOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { adminApi } from '../api/client.js';
import { ErrorDetailContent, errorDetails } from '../components/QueryState.js';

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
  const loginError = login.error ? errorDetails(login.error) : null;

  return (
    <main className="login-page" aria-labelledby="login-title">
      <section className="login-intro">
        <span className="login-mark" aria-hidden="true"><ApiOutlined /></span>
        <Typography.Text className="eyebrow">SFoA Enterprise MCP</Typography.Text>
        <Typography.Title id="login-title">精简、可见、可追责的企业治理。</Typography.Title>
        <Typography.Paragraph>
          配置 SFoA 自有的身份路由与 Runtime 策略。Salesforce 仍是 CRUD、FLS、Sharing、Validation Rule、Flow 与 Trigger 行为的权威来源。
        </Typography.Paragraph>
        <Space wrap>
          <span className="trust-pill">签名会话</span>
          <span className="trust-pill">CSRF 保护</span>
          <span className="trust-pill">浏览器无 secret</span>
        </Space>
      </section>
      <Card className="login-card" variant="borderless">
        <Typography.Title level={2}>管理员登录</Typography.Title>
        <Typography.Paragraph type="secondary">使用 Admin API 中配置的受限 bootstrap 管理员。</Typography.Paragraph>
        {loginError ? <Alert type="error" showIcon role="alert" title="登录失败" description={<ErrorDetailContent detail={loginError} />} /> : null}
        <Form<LoginFields>
          layout="vertical"
          requiredMark="optional"
          onFinish={(values) => login.mutate(values)}
          initialValues={{ username: '' }}
          size="large"
        >
          <Form.Item
            name="username"
            label="管理员用户名"
            rules={[{ required: true, whitespace: true, message: '请输入已配置的管理员用户名。' }]}
          >
            <Input prefix={<UserOutlined />} autoComplete="username" maxLength={128} disabled={login.isPending} />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入管理员密码。' }]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" maxLength={1024} disabled={login.isPending} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={login.isPending}>安全登录</Button>
        </Form>
        <Typography.Paragraph className="login-note" type="secondary">
          凭据仅发送到同源 Admin API，永不写入 localStorage 或 sessionStorage。
        </Typography.Paragraph>
      </Card>
    </main>
  );
}

function isLocationState(value: unknown): value is Readonly<{ from?: string }> {
  return typeof value === 'object' && value !== null && (!('from' in value) || typeof value.from === 'string');
}
