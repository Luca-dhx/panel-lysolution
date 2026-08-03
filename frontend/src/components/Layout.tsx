import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { SECTION_LABELS, SECTION_ORDER, navItemsFor } from '@/config/nav';
import { usePanelVersion } from '@/lib/usePanelVersion';

export function Layout() {
  const { user, logout } = useAuth();
  const { version } = usePanelVersion();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1 className="sidebar-title">Panel L.Y Solution</h1>
          <p className="sidebar-subtitle">Administration du parc</p>
        </div>

        {/* Deux espaces distincts. La section Développeur n'est rendue que
            pour un compte DEV — et ses routes sont gardées séparément, le
            menu ne fait que refléter la règle. */}
        <nav className="sidebar-nav">
          {SECTION_ORDER.map((section) => {
            const items = navItemsFor(user?.role ?? 'ADMIN').filter((i) => i.section === section);
            if (items.length === 0) return null;
            return (
              <div key={section} className="nav-section">
                <p className="nav-section-title">{SECTION_LABELS[section]}</p>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link')}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-version">
            {version ? (
              <>
                <span className={`badge ${version.environment === 'PROD' ? 'badge-ok' : 'badge-warn'}`}>
                  {version.environment}
                </span>
                <span className="sidebar-version-number">v{version.softwareVersion}</span>
              </>
            ) : (
              <span className="muted">Version indisponible</span>
            )}
          </div>
          {user ? <p className="sidebar-user" title={user.displayName}>{user.email}</p> : null}
          <button type="button" className="btn btn-secondary btn-block" onClick={handleLogout}>
            Déconnexion
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
