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

const NAVIGATION = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/identity-routes', icon: <TeamOutlined />, label: 'Identity routes' },
  { key: '/tool-governance', icon: <ToolOutlined />, label: 'Tool governance' },
  { key: '/dml-policies', icon: <SafetyCertificateOutlined />, label: 'DML policies' },
  { key: '/diagnostic', icon: <ExperimentOutlined />, label: 'Diagnostic' },
  { key: '/audit', icon: <AuditOutlined />, label: 'Audit' },
  { key: '/system', icon: <DatabaseOutlined />, label: 'System' },
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
  const selected = NAVIGATION.find((entry) => location.pathname.startsWith(entry.key))?.key ?? '/dashboard';
  const title = NAVIGATION.find((entry) => entry.key === selected)?.label ?? 'Control Plane';
  const menuItems = useMemo(() => NAVIGATION.map((entry) => ({
    ...entry,
    label: <Link to={entry.key} onClick={() => setMobileOpen(false)}>{entry.label}</Link>,
  })), []);
  const logout = useMutation({
    mutationFn: adminApi.logout,
    onSuccess: async () => {
      queryClient.clear();
      await navigate('/login', { replace: true });
    },
    onError: () => void message.error('Logout failed safely. Retry before closing this browser.'),
  });

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  const navigation = <Menu mode="inline" selectedKeys={[selected]} items={menuItems} aria-label="Primary navigation" />;
  return (
    <Layout className="admin-layout">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {desktop ? (
        <Sider
          className="admin-sider"
          width={248}
          collapsedWidth={80}
          collapsed={collapsed}
          trigger={null}
          aria-label="SFoA navigation"
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
              aria-label={desktop ? (collapsed ? 'Expand navigation' : 'Collapse navigation') : 'Open navigation'}
              icon={desktop ? (collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />) : <MenuUnfoldOutlined />}
              onClick={() => desktop ? setCollapsed((value) => !value) : setMobileOpen(true)}
            />
            <div className="header-context">
              <Typography.Text type="secondary">SFoA governance</Typography.Text>
              <Typography.Title level={4}>{title}</Typography.Title>
            </div>
          </Space>
          <Space size="small">
            <StatusTag label="MYSQL" tone="processing" />
            <Button
              type="text"
              aria-label={dark ? 'Use light theme' : 'Use dark theme'}
              icon={dark ? <SunOutlined /> : <MoonOutlined />}
              onClick={onToggleTheme}
            />
            <span className="admin-identity" title={session.username}>{session.username}</span>
            <Button
              icon={<LogoutOutlined />}
              loading={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Logout
            </Button>
          </Space>
        </Header>
        <Content className="admin-content">
          <Breadcrumb items={[{ title: 'Control Plane' }, { title }]} />
          <main id="main-content" ref={mainRef} tabIndex={-1}>{children}</main>
        </Content>
      </Layout>
    </Layout>
  );
}

function Brand({ compact = false }: Readonly<{ compact?: boolean }>) {
  return (
    <div className={compact ? 'brand brand-compact' : 'brand'} aria-label="SFoA Control Plane">
      <span className="brand-mark" aria-hidden="true"><ApiOutlined /></span>
      {compact ? null : <span><strong>SFoA</strong><small>Control Plane</small></span>}
    </div>
  );
}
