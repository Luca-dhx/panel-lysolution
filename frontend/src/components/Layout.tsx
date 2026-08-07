/**
 * COQUILLE DE L'APPLICATION — barre latérale à gauche, contenu à droite.
 *
 * ── SUR MOBILE, LA BARRE DEVIENT UN TIROIR ──────────────────────────────────
 * Une barre latérale fixe de 250 px sur un écran de 320 px, c'est 78 % de la
 * largeur perdue. Sous 900 px elle se replie : une barre supérieure porte le
 * bouton de menu, et la navigation s'ouvre par-dessus le contenu.
 *
 * Le tiroir se ferme dès qu'on choisit une page — sinon il faut deux gestes
 * pour un seul déplacement — ainsi qu'à Échap et au clic sur le voile. Le
 * défilement du fond est bloqué pendant l'ouverture.
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { SECTION_LABELS, SECTION_ORDER, navItemsFor } from '@/config/nav';
import { usePanelVersion } from '@/lib/usePanelVersion';
import { panelTitleFor, usePanelBranding } from '@/lib/usePanelBranding';

export function Layout() {
  const { user, logout } = useAuth();
  const { version } = usePanelVersion();
  /**
   * LA MARQUE VIENT DE LA FICHE ENTREPRISE — plus d'une chaîne écrite en dur.
   * Trois cas, dans cet ordre : le logo s'il est exploitable, sinon
   * « Panel <entreprise> », sinon « Panel ».
   */
  const branding = usePanelBranding();
  const titrePanel = panelTitleFor(branding.companyName);
  const navigate = useNavigate();
  const location = useLocation();
  const [tiroir, setTiroir] = useState(false);

  // Changer de page ferme le tiroir : on a obtenu ce qu'on venait chercher.
  useEffect(() => { setTiroir(false); }, [location.pathname]);

  useEffect(() => {
    if (!tiroir) return undefined;
    const clavier = (e: KeyboardEvent) => { if (e.key === 'Escape') setTiroir(false); };
    document.addEventListener('keydown', clavier);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', clavier);
      document.body.classList.remove('no-scroll');
    };
  }, [tiroir]);

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className={tiroir ? 'app-shell drawer-open' : 'app-shell'}>
      {/* Barre supérieure — mobile et tablette uniquement. */}
      <header className="topbar">
        <button
          type="button"
          className="topbar-burger"
          aria-label={tiroir ? 'Fermer le menu' : 'Ouvrir le menu'}
          aria-expanded={tiroir}
          aria-controls="navigation-principale"
          onClick={() => setTiroir((o) => !o)}
        >
          <span aria-hidden="true">{tiroir ? '✕' : '☰'}</span>
        </button>
        {branding.logoUrl ? (
          <img className="topbar-logo" src={branding.logoUrl} alt={titrePanel} />
        ) : (
          <span className="topbar-title">{titrePanel}</span>
        )}
      </header>

      {/* Voile : ferme le tiroir et empêche de cliquer au travers. */}
      <div className="drawer-scrim" role="presentation" onClick={() => setTiroir(false)} />

      <aside className="sidebar" id="navigation-principale">
        <div className="sidebar-header">
          {/*
            LE LOGO REMPLACE LE TITRE, il ne s'y ajoute pas : afficher les deux
            ferait dire deux fois la même chose à un endroit où la place est
            comptée. Le titre reste porté par `alt` — un lecteur d'écran
            l'entend, et une image qui ne charge pas laisse un texte lisible.
            Le `<h1>` demeure dans les deux cas : la page garde son titre.
          */}
          <h1 className="sidebar-title">
            {branding.logoUrl ? (
              <img className="sidebar-logo" src={branding.logoUrl} alt={titrePanel} />
            ) : (
              titrePanel
            )}
          </h1>
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
