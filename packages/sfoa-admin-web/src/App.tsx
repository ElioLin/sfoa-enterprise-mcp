import { lazy, Suspense, useEffect, useState } from 'react';
import { App as AntApp, Button, ConfigProvider, Result, theme } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { adminApi, ApiError, UNAUTHORIZED_EVENT } from './api/client.js';
import { AdminShell } from './components/AdminShell.js';
import { LoadingState } from './components/QueryState.js';
import { LoginPage } from './pages/LoginPage.js';

const DashboardPage = lazy(() => import('./pages/DashboardPage.js'));
const IdentityRoutesPage = lazy(() => import('./pages/IdentityRoutesPage.js'));
const ToolGovernancePage = lazy(() => import('./pages/ToolGovernancePage.js'));
const DmlPoliciesPage = lazy(() => import('./pages/DmlPoliciesPage.js'));
const DiagnosticPage = lazy(() => import('./pages/DiagnosticPage.js'));
const AuditPage = lazy(() => import('./pages/AuditPage.js'));
const SystemPage = lazy(() => import('./pages/SystemPage.js'));

export function App() {
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1e40af',
          colorInfo: '#1e40af',
          colorWarning: '#b45309',
          colorError: '#dc2626',
          borderRadius: 8,
          controlHeight: 44,
          fontFamily: '"Segoe UI", "Fira Sans", system-ui, sans-serif',
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
            </Route>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Result status="404" title="Page not found" subTitle="This Control Plane route does not exist." />} />
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
    return <Result status="500" title="Admin API unavailable" subTitle="Check /admin/api/ready and retry." extra={<Button onClick={() => void session.refetch()}>Retry</Button>} />;
  }
  return (
    <AdminShell session={session.data} dark={dark} onToggleTheme={onToggleTheme}>
      <Suspense fallback={<LoadingState />}>
        <Outlet />
      </Suspense>
    </AdminShell>
  );
}
