import { Button, Result } from 'antd';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { moduleForPath, resolveLanding } from '../consoleModules.js';
import { useSession } from '../session.js';
import { moduleLabel } from './AdminShell.js';

/**
 * ADR-0034: the Console-side half of the module boundary.
 *
 * The module a page belongs to is derived from the path, so a page added to the route table later
 * is guarded without a second annotation, and the guard renders in place rather than redirecting:
 * the address bar keeps showing what was actually requested. This is a usability boundary only —
 * the Admin API authorizes every request again, so a forged session here changes nothing.
 */
export function ModuleGuard() {
  const session = useSession();
  const location = useLocation();
  const module = moduleForPath(location.pathname);
  // The session is re-published to the guarded routes: `useOutletContext` reads the nearest
  // parent `<Outlet>`, so this layout route would otherwise cut the chain.
  if (module === undefined || session.modules.includes(module)) return <Outlet context={session} />;
  const landing = resolveLanding(undefined, session.modules);
  const landingModule = landing === '/login' ? undefined : moduleForPath(landing);
  return (
    <Result
      status="403"
      title="无权访问该模块"
      subTitle={`账号 ${session.username} 未启用「${moduleLabel(module)}」。如需使用，请管理员在 SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON 中为该账号补上此模块。`}
      extra={landingModule === undefined
        ? null
        : <Link to={landing}><Button type="primary">前往「{moduleLabel(landingModule)}」</Button></Link>}
    />
  );
}
