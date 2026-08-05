/**
 * Gestion des certificats TLS (Let's Encrypt via certbot).
 *
 * UN CERTIFICAT PAR HÔTE, sans exception — principal comme dérivés.
 *
 * Tous sont émis ou réutilisés via le challenge HTTP-01 (webroot). Le moteur ne
 * dépend d'aucun certificat wildcard : celui-ci ne couvrirait qu'un seul niveau
 * et ne pourrait de toute façon pas servir `manager.demo.base` ni
 * `api.demo.base`. Le DNS wildcard, lui, résout bien tous les niveaux — c'est
 * lui, et lui seul, qui rend un nouveau domaine déployable sans configuration.
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

  /**
   * HÔTE PRINCIPAL — émis comme les autres, sans prérequis.
   *
   * Un hôte reconnu comme sous-domaine d'une base gérée exigeait ici un
   * certificat `*.base` DÉJÀ présent sur le VPS, faute de quoi le déploiement
   * s'arrêtait. Un domaine vierge était donc indéployable : le seul moyen
   * d'obtenir ce fichier aurait été un déploiement antérieur.
   *
   * `ensureHostCert` réutilise un certificat existant et n'émet que s'il
   * manque : un parc déjà déployé ne repasse pas par Let's Encrypt, et un
   * domaine neuf s'installe seul.
   */
  primary = { ...(await ensureHostCert(transport, target.host, { email, webroot })), certName: paths.certName };

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
