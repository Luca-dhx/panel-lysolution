import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '@/lib/api';
import { usePanelBranding, panelTitleFor } from '@/lib/usePanelBranding';
import { useToast } from '@/components/ToastProvider';
import { PANEL_PASSWORD_MIN_LENGTH, isPasswordPolicyValid, passwordPolicyMessage } from '@/lib/passwordPolicy';

function resetErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'PASSWORD_RESET_TOKEN_EXPIRED') {
      return 'Ce lien de réinitialisation a expiré. Veuillez demander un nouveau lien.';
    }
    if (error.code === 'PASSWORD_RESET_TOKEN_INVALID') {
      return 'Ce lien de réinitialisation n’est plus valide.';
    }
    if (error.code === 'PASSWORD_RESET_PASSWORD_POLICY') {
      return `Le mot de passe doit contenir au moins ${PANEL_PASSWORD_MIN_LENGTH} caractères.`;
    }
    if (error.code === 'PASSWORD_RESET_PASSWORD_MISMATCH') {
      return 'Les mots de passe ne correspondent pas.';
    }
    return error.message;
  }
  return 'Impossible de réinitialiser le mot de passe. Veuillez réessayer.';
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const branding = usePanelBranding();
  const title = panelTitleFor(branding.companyName);
  const toast = useToast();

  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [pageError, setPageError] = useState<string | null>(token ? null : 'Lien de réinitialisation incomplet.');

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) {
      const message = 'Ce lien de réinitialisation est invalide ou a expiré.';
      setPageError(message);
      toast.error(message);
      return;
    }
    if (!password || !passwordConfirmation) {
      toast.error('Veuillez saisir et confirmer le nouveau mot de passe.');
      return;
    }
    if (password !== passwordConfirmation) {
      toast.error('Les mots de passe ne correspondent pas.');
      return;
    }
    if (!isPasswordPolicyValid(password)) {
      toast.error(`Le mot de passe doit contenir au moins ${PANEL_PASSWORD_MIN_LENGTH} caractères.`);
      return;
    }

    setSubmitting(true);
    setPageError(null);
    try {
      await api.resetPassword(token, password, passwordConfirmation);
      toast.success('Mot de passe réinitialisé avec succès.');
      setSuccess(true);
    } catch (error) {
      const message = resetErrorMessage(error);
      setPageError(message);
      toast.error(message);
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

        {success ? (
          <>
            <h1 className="login-title">Mot de passe modifié</h1>
            <div className="auth-success">
              <p className="auth-success-title">Votre mot de passe a bien été réinitialisé.</p>
              <p className="login-subtitle">
                Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.
              </p>
            </div>
            <Link className="btn btn-primary btn-block" to="/login">
              Se connecter
            </Link>
          </>
        ) : (
          <>
            <h1 className="login-title">Définir un nouveau mot de passe</h1>
            <p className="login-subtitle">
              Choisissez un nouveau mot de passe pour votre compte.
            </p>

            {pageError ? <div className="alert alert-error">{pageError}</div> : null}

            <label className="field">
              <span className="field-label">Nouveau mot de passe</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>

            <label className="field">
              <span className="field-label">Confirmer le nouveau mot de passe</span>
              <input
                type="password"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>

            <p className="auth-footnote">{passwordPolicyMessage()}</p>

            <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
              {submitting ? 'Réinitialisation…' : 'Réinitialiser mon mot de passe'}
            </button>

            <div className="auth-actions">
              <Link className="auth-link" to="/forgot-password">
                Demander un nouveau lien
              </Link>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
