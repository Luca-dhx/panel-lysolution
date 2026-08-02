/**
 * Gestion des certificats TLS (Let's Encrypt via certbot).
 *
 * Hôte principal :
 *   - sous-domaine wildcard : le certificat *.base existe déjà, on le réutilise
 *     (aucune émission, le moteur ne touche jamais le DNS) ;
 *   - domaine client : certificat dédié via challenge HTTP-01 (webroot).
 *
 * Hôtes DÉRIVÉS (`<sous-domaine>.<host>`, quel que soit le rôle qui les
 * déclare) : TOUJOURS un certificat DÉDIÉ — un wildcard *.base à un seul niveau
 * ne couvre pas deux niveaux. Émis/réutilisé via HTTP-01 (le DNS wildcard, lui,
 * résout bien plusieurs niveaux).
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
 * S'assure que l'hôte principal ET chaque hôte dérivé disposent d'un certificat.
 *
 * La liste des hôtes dérivés vient de la TOPOLOGIE (donc du profil) : le module
 * ne connaît aucun nom d'application.
 *
 * @param {object} opts
 * @param {string[]} [opts.dedicatedHosts] Hôtes exigeant un certificat dédié.
 * @returns {Promise<{obtained:boolean, reused:boolean, certName:string, primary:object, dedicated:Record<string,object>}>}
 */
export async function ensureCertificate(transport, target, { email, webroot = '/var/www/certbot', dedicatedHosts = [] } = {}) {
  const paths = certPaths(target);
  let primary;

  // Hôte principal : wildcard réutilisé (sous-domaine) ou cert dédié (domaine client).
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
    primary = { host: target.host, obtained: false, reused: true, wildcard: true, certName: paths.certName };
  } else {
    primary = { ...(await ensureHostCert(transport, target.host, { email, webroot })), certName: paths.certName };
  }

  // Chaque hôte dérivé (front sur sous-domaine, domaine API…) : certificat
  // DÉDIÉ, jamais couvert par un wildcard à un seul niveau.
  const dedicated = {};
  for (const h of dedicatedHosts) {
    if (!h || h === target.host) continue;
    dedicated[h] = { ...(await ensureHostCert(transport, h, { email, webroot })), certName: legacyDedicatedCertPaths(h).certName };
  }

  return { obtained: primary.obtained, reused: primary.reused, certName: primary.certName, primary, dedicated };
}

export default { ensureCertificate };
