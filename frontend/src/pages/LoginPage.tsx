import { useState } from 'react';
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

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void onSubmit(e)}>
        <h1 className="login-title">Panel L.Y Solution</h1>
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
