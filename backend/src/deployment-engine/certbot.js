/**
 * Gestion des certificats TLS (Let's Encrypt via certbot).
 *
 * Vitrine :
 *   - sous-domaine wildcard : le certificat *.base existe déjà, on le réutilise
 *     (aucune émission, le moteur ne touche jamais le DNS) ;
 *   - domaine client : certificat dédié via challenge HTTP-01 (webroot).
 *
 * Manager (`manager.<host>`) : TOUJOURS un certificat DÉDIÉ — un wildcard
 * *.base à un seul niveau ne couvre pas `manager.<host>` (deux niveaux). Il est
 * émis/réutilisé via HTTP-01 (le DNS wildcard résout bien plusieurs niveaux).
 */
import { certPaths, legacyDedicatedCertPaths } from './nginx.js';

/** Réutilise un certificat s'il existe, sinon l'émet via webroot (HTTP-01). */
async function ensureHostCert(transport, host, { email, webroot }) {
  const fullchain = `/etc/letsencrypt/live/${host}/fullchain.pem`;
  const existing = await transport.exec(`test -f ${fullchain} && echo OK || echo NO`);
  if (existing.stdout.trim().endsWith('OK')) {
    return { host, obtained: false, reused: true };
  }
  await transport.exec(`sudo mkdir -p ${webroot}`);
  const emailArg = email ? `--email ${email}` : '--register-unsafely-without-email';
  const res = await transport.exec(
    `sudo certbot certonly --webroot -w ${webroot} -d ${host} ${emailArg} --agree-tos --non-interactive --keep-until-expiring`,
    { timeoutMs: 180_000 }
  );
  if (res.code !== 0) {
    const { DeploymentError } = await import('./errors.js');
    throw new DeploymentError('CERT_ISSUANCE_FAILED', `Échec d'obtention du certificat pour ${host}.`, {
      step: 'certbot',
      details: { host, output: (res.stderr || res.stdout).slice(0, 500) },
    });
  }
  return { host, obtained: true, reused: false };
}

/**
 * S'assure que la vitrine ET le Manager disposent d'un certificat valide.
 * @returns {Promise<{obtained:boolean, reused:boolean, certName:string, vitrine:object, manager:object|null}>}
 */
export async function ensureCertificate(transport, target, { email, webroot = '/var/www/certbot', managerHost, apiHost } = {}) {
  const paths = certPaths(target);
  let vitrine;

  // Vitrine : wildcard réutilisé (sous-domaine) ou cert dédié (domaine client).
  if (target.type === 'subdomain') {
    const check = await transport.exec(`test -f ${paths.fullchain} && echo OK || echo NO`);
    if (!check.stdout.trim().endsWith('OK')) {
      const { DeploymentError } = await import('./errors.js');
      throw new DeploymentError(
        'WILDCARD_CERT_MISSING',
        `Le certificat wildcard *.${target.wildcardBase} est introuvable sur le VPS.`,
        { step: 'certbot', details: { expected: paths.fullchain } }
      );
    }
    vitrine = { host: target.host, obtained: false, reused: true, wildcard: true, certName: paths.certName };
  } else {
    vitrine = { ...(await ensureHostCert(transport, target.host, { email, webroot })), certName: paths.certName };
  }

  // Manager : certificat dédié (émis ou réutilisé).
  let manager = null;
  if (managerHost) {
    manager = { ...(await ensureHostCert(transport, managerHost, { email, webroot })), certName: legacyDedicatedCertPaths(managerHost).certName };
  }

  // API : certificat dédié (domaine `api.<host>`, jamais couvert par un wildcard 1 niveau).
  let api = null;
  if (apiHost) {
    api = { ...(await ensureHostCert(transport, apiHost, { email, webroot })), certName: legacyDedicatedCertPaths(apiHost).certName };
  }

  return { obtained: vitrine.obtained, reused: vitrine.reused, certName: vitrine.certName, vitrine, manager, api };
}

export default { ensureCertificate };
