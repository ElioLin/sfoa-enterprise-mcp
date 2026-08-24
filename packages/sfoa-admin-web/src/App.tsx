import { lazy, Suspense, useEffect, useState } from 'react';
import { App as AntApp, Button, ConfigProvider, Result, theme } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { adminApi, ApiError, UNAUTHORIZED_EVENT } from './api/client.js';
import { AdminShell } from './components/AdminShell.js';
import { LoadingState } from './components/QueryState.js';
import { ADMIN_ANT_LOCALE } from './localization.js';
import { LoginPage } from './pages/LoginPage.js';

const DashboardPage = lazy(() => import('./pages/DashboardPage.js'));
const IdentityRoutesPage = lazy(() => import('./pages/IdentityRoutesPage.js'));
const ToolGovernancePage = lazy(() => import('./pages/ToolGovernancePage.js'));
const DmlPoliciesPage = lazy(() => import('./pages/DmlPoliciesPage.js'));
const DiagnosticPage = lazy(() => import('./pages/DiagnosticPage.js'));
const AuditPage = lazy(() => import('./pages/AuditPage.js'));
const SystemPage = lazy(() => import('./pages/SystemPage.js'));
const AgentIntegrationPage = lazy(() => import('./pages/AgentIntegrationPage.js'));

export function App() {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  return (
    <ConfigProvider
      locale={ADMIN_ANT_LOCALE}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1e40af',
          colorInfo: '#1e40af',
          colorWarning: '#b45309',
          colorError: '#dc2626',
          borderRadius: 8,
          controlHeight: 44,
          fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", "Segoe UI", system-ui, sans-serif',
        },
      }}
    >
      <AntApp>
        <div className={dark ? 'sfoa-app theme-dark' : 'sfoa-app'}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedShell dark={dark} onToggleTheme={() => setDark((value) => !value)} />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/identity-routes" element={<IdentityRoutesPage />} />
              <Route path="/tool-governance" element={<ToolGovernancePage />} />
              <Route path="/dml-policies" element={<DmlPoliciesPage />} />
              <Route path="/diagnostic" element={<DiagnosticPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/system" element={<SystemPage />} />
              <Route path="/agent-integration" element={<AgentIntegrationPage />} />
            </Route>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Result status="404" title="页面不存在" subTitle="该控制平面路由不存在。" />} />
          </Routes>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}

function ProtectedShell({ dark, onToggleTheme }: Readonly<{ dark: boolean; onToggleTheme(): void }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useQuery({ queryKey: ['auth', 'me'], queryFn: adminApi.me, retry: false, staleTime: 60_000 });
  useEffect(() => {
    const unauthorized = (): void => {
      queryClient.clear();
      void navigate('/login', { replace: true, state: { from: location.pathname } });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized);
  }, [location.pathname, navigate, queryClient]);

  if (session.isPending) return <div className="full-page-state"><LoadingState rows={3} /></div>;
  if (session.error instanceof ApiError && session.error.status === 401) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (session.isError) {
    return <Result status="500" title="Admin API 不可用" subTitle="请检查 /admin/api/ready 后重试。" extra={<Button onClick={() => void session.refetch()}>重试</Button>} />;
  }
  return (
    <AdminShell session={session.data} dark={dark} onToggleTheme={onToggleTheme}>
      <Suspense fallback={<LoadingState />}>
        <Outlet />
      </Suspense>
    </AdminShell>
  );
}
