import { useState } from 'react';
import { usePanelBranding, panelTitleFor } from '@/lib/usePanelBranding';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthContext';
import { errorMessage } from '@/lib/api';

interface LocationState {
  from?: { pathname?: string };
}

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as LocationState | null)?.from?.pathname ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return <div className="fullscreen-loader">Chargement de la session…</div>;
  }

  if (user) {
    return <Navigate to={from} replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Connexion impossible. Réessayez.'));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * La marque vient de `/api/public/branding` — la MÊME fiche entreprise que
   * la barre latérale, restreinte à ce qui est public par nature. Le cache
   * l'a déjà peinte avant le premier rendu : ce hook ne fait que la confirmer.
   */
  const branding = usePanelBranding();
  const titre = panelTitleFor(branding.companyName);

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void onSubmit(e)}>
        {/*
          ── LA MARQUE DE L'AGENCE, PAS LA NÔTRE ─────────────────────────────

          ══ CE QUI ÉTAIT ÉCRIT ICI ═══════════════════════════════════════════

          « Panel L.Y Solution », en dur. Le nom de l'agence était pourtant
          saisi dans « Mon entreprise », son logo téléversé, résolu et publié
          aux projets — et l'écran qui la représente en premier n'en lisait
          rien. Un produit qui affiche une marque codée en dur ne peut pas être
          livré à une autre agence.

          Le repli est celui de la barre latérale, mot pour mot : logo si on en
          a un, sinon « Panel <entreprise> », sinon « Panel ». Deux écrans qui
          nomment le produit différemment donneraient l'impression de deux
          produits.
        */}
        {branding.logoUrl ? (
          <img className="login-logo" src={branding.logoUrl} alt={titre} />
        ) : null}
        <h1 className="login-title">{titre}</h1>
        <p className="login-subtitle">Connexion à l’administration du parc</p>

        {error ? <div className="alert alert-error">{error}</div> : null}

        <label className="field">
          <span className="field-label">Adresse e-mail</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span className="field-label">Mot de passe</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
