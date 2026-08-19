import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '@/lib/api';
import { usePanelBranding, panelTitleFor } from '@/lib/usePanelBranding';

export function ForgotPasswordPage() {
  const branding = usePanelBranding();
  const title = panelTitleFor(branding.companyName);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.forgotPassword(email);
      setSuccess(result.message);
    } catch (err) {
      setError(errorMessage(err, 'Impossible de traiter la demande. Veuillez réessayer.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => { void onSubmit(event); }}>
        {branding.logoUrl ? (
          <img className="login-logo" src={branding.logoUrl} alt={title} />
        ) : null}
        <h1 className="login-title">Mot de passe oublié</h1>
        <p className="login-subtitle">
          Entrez l’adresse e-mail associée à votre compte.
          Nous vous enverrons un lien sécurisé permettant de définir un nouveau mot de passe.
        </p>

        {error ? <div className="alert alert-error">{error}</div> : null}
        {success ? (
          <div className="alert alert-success">
            <strong>E-mail envoyé</strong>
            <br />
            Si un compte correspond à cette adresse,
            vous recevrez un lien de réinitialisation.
          </div>
        ) : null}

        <label className="field">
          <span className="field-label">Adresse e-mail</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>

        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Envoi…' : 'Envoyer le lien de réinitialisation'}
        </button>

        <div className="auth-actions">
          <Link className="auth-link" to="/login">
            Retour à la connexion
          </Link>
        </div>
      </form>
    </div>
  );
}
