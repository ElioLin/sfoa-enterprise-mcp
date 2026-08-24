import {
  ApiOutlined,
  AuditOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SunOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App, Breadcrumb, Button, Drawer, Grid, Layout, Menu, Space, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { AdminSessionDto } from '@sfoa/control-plane';
import { adminApi } from '../api/client.js';
import { StatusTag } from './StatusTag.js';

const { Header, Sider, Content } = Layout;

export const ADMIN_NAVIGATION = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '运行概览' },
  { key: '/identity-routes', icon: <TeamOutlined />, label: '用户身份路由' },
  { key: '/tool-governance', icon: <ToolOutlined />, label: '工具治理' },
  { key: '/dml-policies', icon: <SafetyCertificateOutlined />, label: 'DML 操作策略' },
  { key: '/diagnostic', icon: <ExperimentOutlined />, label: '系统诊断' },
  { key: '/audit', icon: <AuditOutlined />, label: '调用审计' },
  { key: '/system', icon: <DatabaseOutlined />, label: '系统状态' },
  { key: '/agent-integration', icon: <RobotOutlined />, label: '智能体接入' },
] as const;

export function AdminShell({
  session,
  dark,
  onToggleTheme,
  children,
}: Readonly<{ session: AdminSessionDto; dark: boolean; onToggleTheme(): void; children: ReactNode }>) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const desktop = Boolean(screens.lg);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const selected = ADMIN_NAVIGATION.find((entry) => location.pathname.startsWith(entry.key))?.key ?? '/dashboard';
  const title = ADMIN_NAVIGATION.find((entry) => entry.key === selected)?.label ?? '控制平面';
  const menuItems = useMemo(() => ADMIN_NAVIGATION.map((entry) => ({
    ...entry,
    label: <Link to={entry.key} onClick={() => setMobileOpen(false)}>{entry.label}</Link>,
  })), []);
  const logout = useMutation({
    mutationFn: adminApi.logout,
    onSuccess: async () => {
      queryClient.clear();
      await navigate('/login', { replace: true });
    },
    onError: () => void message.error('安全退出失败，请重试后再关闭浏览器。'),
  });

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  const navigation = <Menu mode="inline" selectedKeys={[selected]} items={menuItems} aria-label="主导航" />;
  return (
    <Layout className="admin-layout">
      <a className="skip-link" href="#main-content">跳转到主内容</a>
      {desktop ? (
        <Sider
          className="admin-sider"
          width={248}
          collapsedWidth={80}
          collapsed={collapsed}
          trigger={null}
          aria-label="SFoA 导航"
        >
          <Brand compact={collapsed} />
          {navigation}
        </Sider>
      ) : (
        <Drawer
          placement="left"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          size={288}
          title={<Brand />}
          styles={{ body: { padding: 0 } }}
        >
          {navigation}
        </Drawer>
      )}
      <Layout>
        <Header className="admin-header">
          <Space size="middle">
            <Button
              type="text"
              aria-label={desktop ? (collapsed ? '展开导航' : '收起导航') : '打开导航'}
              icon={desktop ? (collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />) : <MenuUnfoldOutlined />}
              onClick={() => desktop ? setCollapsed((value) => !value) : setMobileOpen(true)}
            />
            <div className="header-context">
              <Typography.Text type="secondary">SFoA 治理</Typography.Text>
              <Typography.Title level={4}>{title}</Typography.Title>
            </div>
          </Space>
          <Space size="small">
            <StatusTag label="MySQL" tone="processing" />
            <Button
              type="text"
              aria-label={dark ? '使用浅色主题' : '使用深色主题'}
              icon={dark ? <SunOutlined /> : <MoonOutlined />}
              onClick={onToggleTheme}
            />
            <span className="admin-identity" title={session.username}>{session.username}</span>
            <Button
              icon={<LogoutOutlined />}
              loading={logout.isPending}
              onClick={() => logout.mutate()}
            >
              退出登录
            </Button>
          </Space>
        </Header>
        <Content className="admin-content">
          <Breadcrumb items={[{ title: '控制平面' }, { title }]} />
          <main id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
        </Content>
      </Layout>
    </Layout>
  );
}

function Brand({ compact = false }: Readonly<{ compact?: boolean }>) {
  return (
    <div className={compact ? 'brand brand-compact' : 'brand'} aria-label="SFoA 控制平面">
      <span className="brand-mark" aria-hidden="true"><ApiOutlined /></span>
      {compact ? null : <span><strong>SFoA</strong><small>控制平面</small></span>}
    </div>
  );
}
