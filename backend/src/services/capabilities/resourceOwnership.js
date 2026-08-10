// APPARTENANCE DES RESSOURCES — « ce nom est-il à ce projet ? » (L9).
//
// docs/architecture/HOSTINGER_CONTROL_PLANE.md §« Ownership ».
//
// ── LE PIÈGE QUE CE MODULE FERME ────────────────────────────────────────────
//
//   UN CREDENTIAL GLOBAL N'EST PAS UN ACCÈS GLOBAL.
//
// Le compte Hostinger du Panel détient le portefeuille de TOUS les clients. Une
// capacité DNS qui accepterait un nom d'hôte quelconque donnerait à n'importe
// quel projet appairé le pouvoir de réécrire le DNS de n'importe quel autre —
// c'est-à-dire de détourner son trafic. Le jeton n'aurait plus besoin d'être
// volé : il suffirait de le demander poliment, une ressource à la fois.
//
// C'est la différence exacte entre L1 (« le secret ne sort pas ») et L9 (« le
// POUVOIR du secret ne sort pas non plus »). Centraliser sans ce module aurait
// aggravé la situation d'origine, où chaque projet détenait au moins une clé
// qui n'ouvrait que son propre compte.
//
// ── D'OÙ VIENT LA VÉRITÉ ────────────────────────────────────────────────────
//
// De `PanelProjectDestination` : la relation canonique projectId → hôte, que le
// Panel tient déjà et que le projet ne peut pas écrire lui-même (elle naît de
// l'appairage et des annonces de déploiement, arbitrées côté Panel).
//
// PAS du nom que le projet envoie. Un demandeur ne prouve jamais son droit en
// nommant la ressource qu'il convoite.
import PanelProjectDestination, { DESTINATION_STATUS } from '../../models/PanelProjectDestination.model.js';

/** Pourquoi un nom est refusé. Codes fermés — l'écran les traduit un à un. */
export const OWNERSHIP_CODES = Object.freeze({
  OK: 'OK',
  /** Le projet n'a aucune destination connue : rien ne lui appartient encore. */
  NO_DESTINATION: 'NO_DESTINATION',
  /** Le nom existe, mais il relève d'un autre projet (ou d'aucun). */
  NOT_OWNED: 'NOT_OWNED',
  /** Le nom est syntaxiquement inexploitable. */
  INVALID_HOSTNAME: 'INVALID_HOSTNAME',
});

/**
 * Statuts de destination qui FONDENT un droit.
 *
 * `ACTIVE` seulement : une destination `RETIRED` est un souvenir de migration,
 * et une `EMPTY` un constat d'abandon. Fonder un droit d'écriture DNS sur l'une
 * d'elles laisserait un projet réécrire le domaine qu'il vient de quitter —
 * possiblement repris par quelqu'un d'autre depuis.
 *
 * `PENDING` est exclu aussi, et c'est le choix le plus discutable de ce module :
 * il signifie qu'un projet ne peut pas créer le DNS d'une destination qu'il
 * vient d'annoncer et qui n'est pas encore arbitrée. C'est délibéré — sinon
 * l'annonce, qui vient du projet, deviendrait la preuve de son propre droit.
 */
const OWNING_STATUSES = Object.freeze([DESTINATION_STATUS.ACTIVE]);

/** Un nom d'hôte plausible. Volontairement strict — pas de wildcard, pas d'IP. */
const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function normalizeHostname(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

export function isPlausibleHostname(value) {
  const host = normalizeHostname(value);
  return host.length > 0 && host.length <= 253 && HOSTNAME_RE.test(host);
}

/**
 * `candidate` est-il couvert par `owned` ?
 *
 * Égalité, ou sous-domaine STRICT (`a.example.com` est couvert par
 * `example.com`). La comparaison se fait sur une frontière de label — sans le
 * point, `notexample.com` serait « couvert » par `example.com`, ce qui est
 * exactement le genre de faille qu'on cherche à éviter.
 */
export function isCoveredBy(candidate, owned) {
  const host = normalizeHostname(candidate);
  const root = normalizeHostname(owned);
  if (!host || !root) return false;
  return host === root || host.endsWith(`.${root}`);
}

/**
 * Les hôtes qu'un projet possède, selon le registre des destinations.
 *
 * @returns {Promise<string[]>}
 */
export async function ownedHosts(projectId) {
  const destinations = await PanelProjectDestination.find({
    projectId,
    status: { $in: OWNING_STATUSES },
  }).select('host').lean();
  return [...new Set(destinations.map((d) => normalizeHostname(d.host)).filter(Boolean))];
}

/**
 * Ce projet peut-il administrer ce nom d'hôte ?
 *
 * Ne LÈVE pas : l'appelant décide si le refus est une erreur d'entrée ou une
 * tentative à tracer. Rendre un verdict structuré permet aussi à un écran de
 * diagnostic d'expliquer POURQUOI, sans rejouer la logique.
 *
 * @returns {Promise<{allowed: boolean, code: string, hostname: string,
 *   matchedHost: string|null, ownedHosts: string[]}>}
 */
export async function describeHostnameOwnership(projectId, hostname) {
  const host = normalizeHostname(hostname);
  if (!isPlausibleHostname(host)) {
    return { allowed: false, code: OWNERSHIP_CODES.INVALID_HOSTNAME, hostname: host, matchedHost: null, ownedHosts: [] };
  }

  const owned = await ownedHosts(projectId);
  if (owned.length === 0) {
    return { allowed: false, code: OWNERSHIP_CODES.NO_DESTINATION, hostname: host, matchedHost: null, ownedHosts: [] };
  }

  /**
   * On retient la correspondance la PLUS SPÉCIFIQUE.
   *
   * Sans cela, un projet possédant `example.com` et un autre `a.example.com`
   * verraient le premier couvrir le second par simple ordre de lecture. Trier
   * par longueur décroissante rend le verdict indépendant de l'ordre de la
   * base — et donc reproductible.
   */
  const matched = owned
    .filter((candidate) => isCoveredBy(host, candidate))
    .sort((a, b) => b.length - a.length)[0] ?? null;

  if (!matched) {
    return { allowed: false, code: OWNERSHIP_CODES.NOT_OWNED, hostname: host, matchedHost: null, ownedHosts: owned };
  }
  return { allowed: true, code: OWNERSHIP_CODES.OK, hostname: host, matchedHost: matched, ownedHosts: owned };
}

/**
 * Réduit une liste d'enregistrements DNS à ce que CE projet a le droit de voir.
 *
 * ── POURQUOI ON NE REND PAS LA ZONE ENTIÈRE ─────────────────────────────────
 *
 * Une zone peut héberger plusieurs clients (`a.example.com`, `b.example.com`).
 * La rendre entière révélerait à chacun l'infrastructure des autres : leurs
 * sous-domaines, leurs adresses IP, donc leur hébergeur et leur volumétrie.
 * Rien de secret pris isolément, et pourtant un inventaire qu'on ne leur a
 * jamais promis.
 *
 * ── POURQUOI LA WILDCARD RESTE ──────────────────────────────────────────────
 *
 * `*.<zone>` est retenue même si elle n'appartient à personne en particulier :
 * le moteur de déploiement s'en sert pour constater qu'un hôte est DÉJÀ couvert
 * et qu'il n'a rien à écrire. La masquer ferait créer un enregistrement inutile
 * — une écriture réelle causée par un aveuglement volontaire.
 *
 * @param {object[]} records  enregistrements normalisés (`name` relatif à la zone)
 * @param {string} zone
 * @param {string[]} owned    hôtes possédés par le projet
 */
export function filterRecordsForProject(records, zone, owned) {
  const zoneName = normalizeHostname(zone);
  return (records ?? []).filter((record) => {
    const name = String(record?.name ?? '');
    if (name === '*') return true;
    const fqdn = name === '@' || name === '' ? zoneName : `${normalizeHostname(name)}.${zoneName}`;
    return owned.some((candidate) => isCoveredBy(fqdn, candidate));
  });
}

export default {
  OWNERSHIP_CODES,
  normalizeHostname,
  isPlausibleHostname,
  isCoveredBy,
  ownedHosts,
  describeHostnameOwnership,
  filterRecordsForProject,
};
