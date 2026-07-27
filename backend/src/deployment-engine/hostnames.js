/**
 * Dérivation des hostnames d'un déploiement à partir du SEUL domaine choisi.
 *
 * Règle : le domaine fourni est l'unique entrée ; tous les autres hôtes en
 * découlent mécaniquement, d'après le profil de projet (`config/project.profile.js`).
 * Une application de rôle `web-sub` est servie sur `<subdomain>.<host>` ;
 * l'API dispose de son propre sous-domaine.
 *
 * Ex. hôte principal `demo.exemple.com`
 *     → application `manager` : `manager.demo.exemple.com`
 *     → API                   : `api.demo.exemple.com`
 *
 * Note wildcard : un certificat `*.base` ne couvre qu'UN niveau. Un hôte
 * dérivé à deux niveaux (`manager.demo.base`) n'est donc pas couvert par le
 * wildcard de la base ; le rapport HTTPS le signale explicitement pour qu'une
 * équipe technique décide (certificat dédié, ou wildcard imbriqué). Le DNS
 * wildcard, lui, résout bien les deux (il matche plusieurs niveaux).
 */
import { API_SUBDOMAIN, APPS } from './config/project.profile.js';

/** Hostname dérivé pour un sous-domaine donné. */
export function deriveSubHost(siteHost, subdomain) {
  if (!siteHost || typeof siteHost !== 'string' || !subdomain) return null;
  return `${subdomain}.${siteHost.toLowerCase()}`;
}

/** Applications du profil servies sur un sous-domaine dérivé. */
export function subHostedApps() {
  return APPS.filter((app) => app.role === 'web-sub' && app.subdomain);
}

/**
 * Tous les hôtes d'un déploiement, dérivés du domaine principal :
 *   { site, api, apps: { <appId>: <host> } }
 */
export function deriveHosts(siteHost) {
  if (!siteHost || typeof siteHost !== 'string') return null;
  const site = siteHost.toLowerCase();
  const apps = {};
  for (const app of subHostedApps()) {
    apps[app.id] = deriveSubHost(site, app.subdomain);
  }
  return { site, api: deriveSubHost(site, API_SUBDOMAIN), apps };
}

/**
 * Hostname du Manager dérivé du hostname de la vitrine.
 * Conservé pour compatibilité : s'appuie désormais sur le profil.
 */
export function deriveManagerHost(siteHost) {
  const app = subHostedApps().find((a) => a.id === 'manager');
  if (!app) return null;
  return deriveSubHost(siteHost, app.subdomain);
}

/** URL HTTPS du Manager dérivée du hostname de la vitrine. */
export function deriveManagerUrl(siteHost) {
  const h = deriveManagerHost(siteHost);
  return h ? `https://${h}` : null;
}

/**
 * Un certificat `*.base` couvre-t-il ce hostname ? (un seul niveau sous `base`).
 * Utilisé pour signaler dans le rapport si un hôte dérivé est couvert par le
 * certificat wildcard de la base.
 */
export function isCoveredByWildcard(host, base) {
  if (!host || !base) return false;
  if (!host.endsWith(`.${base}`)) return false;
  const prefix = host.slice(0, host.length - base.length - 1);
  return prefix.length > 0 && !prefix.includes('.');
}

export default {
  deriveSubHost,
  subHostedApps,
  deriveHosts,
  deriveManagerHost,
  deriveManagerUrl,
  isCoveredByWildcard,
};
