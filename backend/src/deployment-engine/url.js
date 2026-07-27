import { DEFAULT_WILDCARD_BASES as PROFILE_WILDCARD_BASES } from './config/project.profile.js';

/**
 * Analyse d'URL de cible de déploiement.
 *
 * Règle du cahier des charges : l'utilisateur renseigne TOUJOURS l'URL complète.
 * Jamais « sous-domaine + domaine » séparément. Le moteur déduit tout le reste.
 *
 * Deux cas fonctionnels :
 *   - Cas 1 (wildcard géré)   : https://demo-sbauto.ly-solution.com
 *                               l'hôte est un sous-domaine DIRECT (un seul label)
 *                               d'une « base wildcard » gérée (ex: ly-solution.com),
 *                               couverte UNE FOIS par un DNS wildcard
 *                               *.ly-solution.com et un certificat *.ly-solution.com.
 *                               AUCUN enregistrement DNS à créer par site : on
 *                               exploite le wildcard existant.
 *   - Cas 2 (domaine client)  : https://sbauto06.fr
 *                               l'hôte n'appartient à aucune base wildcard : il
 *                               faut un vrai certificat dédié + une résolution
 *                               DNS pointant sur le VPS.
 *
 * Un hôte n'est reconnu comme « sous-domaine wildcard » que si le préfixe devant
 * la base est un SEUL label (ex. demo-sbauto). En effet, *.ly-solution.com ne
 * couvre qu'un niveau : a.b.ly-solution.com N'EST PAS couvert et retombe en
 * domaine client (cert dédié + contrôle DNS).
 *
 * La détermination du domaine « enregistrable » sans Public Suffix List complète
 * est heuristique (2 derniers labels). C'est suffisant pour les cas visés et
 * documenté comme limite. Les bases wildcard sont, elles, configurées
 * explicitement — donc exactes.
 */
import { ValidationError } from './errors.js';

/**
 * Bases wildcard gérées par défaut (surchargées par DEPLOY_WILDCARD_BASES).
 * Architecture officielle : un unique wildcard *.ly-solution.com configuré une
 * seule fois couvre toutes les démos/sites sous ly-solution.com.
 */
export const DEFAULT_WILDCARD_BASES = [...PROFILE_WILDCARD_BASES];

/** Lit les bases wildcard depuis l'environnement (liste séparée par des virgules). */
export function wildcardBasesFromEnv(env = process.env) {
  const raw = env.DEPLOY_WILDCARD_BASES;
  if (!raw) return [...DEFAULT_WILDCARD_BASES];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const HOSTNAME_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Analyse une URL complète de cible.
 *
 * @param {string} rawUrl  URL complète (avec ou sans protocole).
 * @param {object} [opts]
 * @param {string[]} [opts.wildcardBases] Bases wildcard gérées.
 * @returns {{
 *   raw: string, protocol: string, host: string, labels: string[],
 *   registrableDomain: string, subdomain: string|null,
 *   type: 'subdomain'|'domain', wildcardBase: string|null,
 *   requiresDedicatedCert: boolean, requiresDnsCheck: boolean,
 *   canonicalUrl: string
 * }}
 */
export function parseTargetUrl(rawUrl, opts = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new ValidationError('URL de cible manquante.');
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new ValidationError('URL de cible vide.');

  // Tolère l'absence de protocole : on force https par défaut (HTTPS obligatoire).
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withProto);
  } catch {
    throw new ValidationError(`URL de cible invalide : ${rawUrl}`);
  }

  const protocol = parsed.protocol.replace(':', '').toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    throw new ValidationError(`Protocole non supporté (${protocol}). Utilisez https.`);
  }
  if (parsed.port) {
    throw new ValidationError('L’URL de cible ne doit pas comporter de port explicite.');
  }

  const host = parsed.hostname.toLowerCase();
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => !HOSTNAME_LABEL_RE.test(l))) {
    throw new ValidationError(`Nom d’hôte invalide : ${host}`);
  }

  const wildcardBases = (opts.wildcardBases || DEFAULT_WILDCARD_BASES).map((b) => b.toLowerCase());

  // Cas 1 : l'hôte est un sous-domaine à UN SEUL label d'une base wildcard gérée.
  // *.base ne couvre qu'un niveau : le préfixe devant `.base` ne doit pas
  // contenir de point (ex. « demo-sbauto » ok, « a.b » non).
  let wildcardBase = null;
  for (const base of wildcardBases) {
    if (host === base) continue; // la base nue n'est pas un sous-domaine déployable
    if (host.endsWith(`.${base}`)) {
      const prefix = host.slice(0, host.length - base.length - 1);
      if (prefix.length === 0 || prefix.includes('.')) continue; // pas couvert par *.base
      // On retient la base la plus longue (la plus spécifique).
      if (!wildcardBase || base.length > wildcardBase.length) wildcardBase = base;
    }
  }

  let type;
  let subdomain;
  let registrableDomain;

  if (wildcardBase) {
    type = 'subdomain';
    subdomain = host.slice(0, host.length - wildcardBase.length - 1); // retire ".base"
    registrableDomain = wildcardBase;
  } else {
    // Cas 2 : domaine client. Domaine enregistrable = 2 derniers labels (heuristique).
    registrableDomain = labels.slice(-2).join('.');
    subdomain = labels.length > 2 ? labels.slice(0, -2).join('.') : null;
    type = 'domain';
  }

  return {
    raw: rawUrl,
    protocol,
    host,
    labels,
    registrableDomain,
    subdomain,
    type,
    wildcardBase,
    // Un sous-domaine de wildcard est déjà couvert par *.base : pas de cert dédié.
    requiresDedicatedCert: type === 'domain',
    // Le wildcard existe déjà (DNS géré par nous) : pas de contrôle DNS client.
    // Un domaine client DOIT résoudre vers le VPS avant tout déploiement.
    requiresDnsCheck: type === 'domain',
    canonicalUrl: `https://${host}`,
  };
}

export default parseTargetUrl;
