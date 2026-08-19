import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const app = read('frontend/src/App.tsx');
const authContext = read('frontend/src/auth/AuthContext.tsx');
const loginPage = read('frontend/src/pages/LoginPage.tsx');
const forgotPage = read('frontend/src/pages/ForgotPasswordPage.tsx');
const resetPage = read('frontend/src/pages/ResetPasswordPage.tsx');
const api = read('frontend/src/lib/api.ts');
const toastProvider = read('frontend/src/components/ToastProvider.tsx');
const main = read('frontend/src/main.tsx');
const styles = read('frontend/src/styles.css');
const passwordPolicy = read('frontend/src/lib/passwordPolicy.ts');

section('Routes publiques du parcours');
{
  check('la page login reste publique', app.includes('path="/login" element={<LoginPage />}'));
  check('la page mot de passe oublie est routee',
    app.includes('path="/forgot-password" element={<ForgotPasswordPage />}'));
  check('la page reset est routee',
    app.includes('path="/reset-password" element={<ResetPasswordPage />}'));
  check('les routes publiques restent hors RequireAuth',
    app.indexOf('path="/reset-password" element={<ResetPasswordPage />}') < app.indexOf('<RequireAuth>'));
}

section('Lien depuis le login');
{
  check('le login propose "Mot de passe oublie ?"',
    /Mot de passe oubli/i.test(loginPage) && loginPage.includes('to="/forgot-password"'));
}

section('Page mot de passe oublie');
{
  check('le texte UX attendu est present',
    /Mot de passe oubli/i.test(forgotPage)
    && /adresse e-mail associ/i.test(forgotPage));
  check('lâ€™input email et le CTA existent',
    forgotPage.includes('Adresse e-mail')
    && /Envoyer le lien de r/i.test(forgotPage));
  check('la page appelle bien lâ€™API dediee',
    forgotPage.includes('api.forgotPassword(email)'));
  check('le succes reste generique, sans reveler lâ€™existence du compte',
    /Si un compte correspond/i.test(forgotPage));
  check('un retour vers /login est propose',
    forgotPage.includes('to="/login"') && /Retour .* connexion/i.test(forgotPage));
}

section('Page nouveau mot de passe');
{
  check('le token est lu depuis lâ€™URL',
    resetPage.includes('useSearchParams') && resetPage.includes("searchParams.get('token')"));
  check('les deux champs mot de passe existent',
    resetPage.includes('Nouveau mot de passe')
    && /Confirmer le nouveau mot de passe/i.test(resetPage));
  check('la policy est affichee clairement',
    passwordPolicy.includes('PANEL_PASSWORD_MIN_LENGTH = 10')
    && resetPage.includes('passwordPolicyMessage()'));
  check('la validation locale bloque le mismatch avant lâ€™API',
    /password !== passwordConfirmation[\s\S]{0,160}toast\.error\('Les mots de passe ne correspondent pas\.'\)[\s\S]{0,80}return;/.test(resetPage));
  check('la validation locale bloque aussi un mot de passe trop court',
    resetPage.includes('isPasswordPolicyValid(password)')
    && /toast\.error\(`Le mot de passe doit contenir au moins \$\{PANEL_PASSWORD_MIN_LENGTH\}/.test(resetPage));
  check('lâ€™API reset dediee est appelee',
    resetPage.includes('api.resetPassword(token, password, passwordConfirmation)'));
  check('les erreurs metier deviennent des messages comprehensibles',
    resetPage.includes('PASSWORD_RESET_TOKEN_EXPIRED')
    && resetPage.includes('PASSWORD_RESET_TOKEN_INVALID'));
  check('succes = toast + vue succes + CTA login',
    /toast\.success\('Mot de passe r/i.test(resetPage)
    && /Mot de passe modifi/i.test(resetPage)
    && /Se connecter/i.test(resetPage)
    && resetPage.includes('to="/login"'));
  check('un lien permet de redemander un lien si besoin',
    /Demander un nouveau lien/i.test(resetPage) && resetPage.includes('to="/forgot-password"'));
}

section('Toast minimal et garde-fou bootstrap');
{
  check('un provider toast global enveloppe lâ€™application',
    main.includes('<ToastProvider>') && main.includes('</ToastProvider>'));
  check('le provider expose succes et erreur',
    toastProvider.includes("pushToast('success'") && toastProvider.includes("pushToast('error'"));
  check('les styles auth/toast existent',
    styles.includes('.auth-link')
    && styles.includes('.auth-success')
    && styles.includes('.toast-viewport')
    && styles.includes('.toast-success')
    && styles.includes('.toast-error'));
  check('le client API expose les deux endpoints auth publics',
    api.includes("'/api/auth/forgot-password'")
    && api.includes("'/api/auth/reset-password'"));
  check('la relance silencieuse de /api/auth/me nâ€™impose plus /login sur une route publique',
    api.includes('redirectOnUnauthorized?: boolean')
    && /me:\s*\(\)\s*=>\s*request<\{ user: PanelUser \}>\('\/api\/auth\/me',\s*\{ redirectOnUnauthorized: false \}\)/.test(api)
    && authContext.includes('api')
    && authContext.includes('.me()'));
}

finish();
