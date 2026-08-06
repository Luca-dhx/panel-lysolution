// DESCRIPTEUR MÉDIA CANONIQUE — LOT 4.
//
// ══ LA CAUSE TRAITÉE ════════════════════════════════════════════════════════
//
// Le Bridge ne transportait qu'une URL. Un projet qui la recevait ne pouvait
// savoir ni si l'image avait changé, ni son type réel, ni ses dimensions, ni
// si la projection reçue était plus récente que celle qu'il appliquait déjà.
// Il ne pouvait que recharger l'adresse et espérer — d'où des images
// remplacées qui continuaient de s'afficher depuis le cache, et des liens
// morts qu'aucun écran ne savait qualifier.
//
// Ce module produit le descripteur qui répond à ces questions, et il le
// produit à UN SEUL endroit : au moment de l'import, quand le fichier est
// encore en main. Recalculer une empreinte à la publication supposerait que le
// fichier n'a pas bougé — supposition qu'on ne peut pas faire.
//
// ══ CE QU'IL REFUSE DE PUBLIER ══════════════════════════════════════════════
//
// Une URL non canonique : boucle locale, chemin disque, `blob:`, `data:`,
// adresse relative. Un projet affiche ces médias depuis une AUTRE origine que
// le Panel — une adresse locale y donne une image cassée, et un chemin relatif
// pointe sur le site du client. Publier `null` avec une raison lisible vaut
// mieux qu'une adresse qui ne marchera que sur la machine du développeur.
import { createHash, randomUUID } from 'node:crypto';

import PanelMedia from '../../models/PanelMedia.model.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { resolveBackendUrl } from '../network/networkConfig.service.js';
import { UPLOADS_PUBLIC_PREFIX } from './upload.service.js';

/** Hôtes qui ne désignent que la machine courante — jamais publiables. */
const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/** Empreinte du CONTENU — la seule chose qui distingue « même image » d'« autre ». */
export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Longueur de l'empreinte inscrite dans le nom : 48 bits, sans collision réaliste. */
export const SHORT_HASH_LENGTH = 12;

/**
 * NOM DE L'OBJET STOCKÉ — `<mediaId>-<empreinte courte>.webp`.
 *
 * ── POURQUOI L'EMPREINTE EST DANS LE NOM ────────────────────────────────────
 * Parce que l'adresse doit DÉPENDRE du contenu. Tant que ce n'était pas le
 * cas, rien ne permettait à un cache de savoir qu'il détenait une version
 * périmée : le seul recours était un paramètre temporel collé à l'URL,
 * c'est-à-dire une adresse qui change sans que l'image change — donc un cache
 * qui ne sert jamais.
 *
 * Avec l'empreinte dans le nom : un contenu différent a forcément une autre
 * adresse, et une adresse donnée ne peut plus jamais désigner autre chose. Le
 * fichier devient légitimement `immutable`.
 *
 * Le `mediaId` reste présent : deux médias de contenu identique mais de
 * portées différentes doivent rester deux objets distincts.
 */
export function objectKeyFor({ mediaId, sha256, extension = 'webp' }) {
  const court = String(sha256).slice(0, SHORT_HASH_LENGTH);
  return `${mediaId}-${court}.${extension}`;
}

/** L'empreinte lisible dans un nom d'objet, ou `null` pour un nom historique. */
export function shortHashOf(objectKey) {
  const m = /-([0-9a-f]{12})\.[a-z0-9]+$/i.exec(String(objectKey ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * UN MÉDIA DE MÊME CONTENU, DANS LA MÊME PORTÉE — pour la déduplication.
 *
 * La portée compte : dédupliquer sans elle ferait partager un objet entre deux
 * usages, et la suppression de l'un ferait disparaître l'autre. Un média
 * SUPPRIMÉ n'est jamais rendu — son fichier n'existe plus.
 */
export async function findMediaByContent({ sha256, scope = 'DEVELOPER_IDENTITY' }) {
  if (!sha256) return null;
  return PanelMedia.findOne({ sha256, scope, deletedAt: null }).lean();
}

/**
 * Une adresse est-elle CANONIQUE, c'est-à-dire publiable vers un autre projet ?
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export function isCanonicalMediaUrl(url) {
  const brut = String(url ?? '').trim();
  if (!brut) return { ok: false, reason: 'adresse vide' };
  if (/^blob:/i.test(brut)) return { ok: false, reason: 'URL blob — locale au navigateur' };
  if (/^data:/i.test(brut)) return { ok: false, reason: 'URL data — le contenu voyagerait dans la projection' };
  if (/^file:/i.test(brut)) return { ok: false, reason: 'chemin disque' };
  if (/^[a-zA-Z]:[\\/]/.test(brut) || brut.startsWith('\\\\')) return { ok: false, reason: 'chemin disque' };
  if (!/^https?:\/\//i.test(brut)) return { ok: false, reason: 'adresse relative — elle pointerait sur le site du client' };
  let hote;
  try {
    hote = new URL(brut).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'adresse illisible' };
  }
  if (HOTES_LOCAUX.has(hote)) {
    return { ok: false, reason: `hôte local (${hote}) — injoignable depuis un projet` };
  }
  return { ok: true };
}

/**
 * ENREGISTRE un média importé, avec toutes ses métadonnées mesurées.
 *
 * Appelé par l'import, une fois le fichier écrit. Le descripteur est persisté :
 * il doit survivre au redémarrage, et surtout à la publication — c'est lui, et
 * non le fichier, qui fait autorité sur ce que le Panel a publié.
 */
export async function registerMedia({
  mediaId = null, objectKey, path: chemin, mime, size, width, height, sha256,
  scope = 'DEVELOPER_IDENTITY', role = null, createdBy = null,
}) {
  const at = nowIso();
  const existant = await PanelMedia.findOne({ objectKey }).lean();

  // Un même objectKey réimporté (cas théorique : les noms sont uniques) fait
  // AVANCER la version. Elle est monotone par construction, jamais réutilisée.
  if (existant) {
    const doc = await PanelMedia.findOneAndUpdate(
      { objectKey },
      {
        $set: {
          mime, size, width, height, sha256, path: chemin, scope, role,
          deletedAt: null, updatedAt: at,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    return doc.toObject();
  }

  const doc = await PanelMedia.create({
    // L'identité est fournie par l'appelant quand elle a déjà servi à NOMMER
    // le fichier : la recréer ici ferait diverger le nom et le descripteur.
    mediaId: mediaId ?? randomUUID(),
    objectKey,
    path: chemin,
    mime,
    size,
    width: width ?? null,
    height: height ?? null,
    sha256,
    version: 1,
    scope,
    role,
    createdAt: at,
    updatedAt: at,
    createdBy,
  });
  return doc.toObject();
}

/** Marque un média retiré — le descripteur SURVIT, pour publier la suppression. */
export async function markMediaDeleted(objectKey) {
  const at = nowIso();
  const doc = await PanelMedia.findOneAndUpdate(
    { objectKey },
    { $set: { deletedAt: at, updatedAt: at } },
    { new: true },
  );
  return doc ? doc.toObject() : null;
}

/**
 * LA CLÉ D'OBJET contenue dans une valeur — nom nu, chemin relatif ou URL
 * ABSOLUE de l'autorité.
 *
 * ── POURQUOI L'ABSOLU DOIT ÊTRE RECONNU ─────────────────────────────────────
 * Les fiches conservent désormais l'adresse canonique complète (la validation
 * de l'entreprise exige une URL absolue). Ne reconnaître que le chemin relatif
 * ferait traiter nos PROPRES médias comme des URL externes : ils seraient
 * publiés sans empreinte, sans type et sans dimensions, alors que le Panel les
 * connaît parfaitement.
 */
export function objectKeyOf(valeur) {
  const brut = String(valeur ?? '').trim();
  if (!brut) return null;

  let chemin = brut;
  if (/^https?:\/\//i.test(brut)) {
    try {
      chemin = new URL(brut).pathname;
    } catch {
      return null;
    }
  }
  if (chemin.startsWith(`${UPLOADS_PUBLIC_PREFIX}/`)) {
    return chemin.slice(UPLOADS_PUBLIC_PREFIX.length + 1) || null;
  }
  // Un nom nu ne doit contenir aucun séparateur : sinon ce n'est pas une clé
  // d'objet, c'est un chemin qu'on n'a pas su lire.
  return chemin.includes('/') ? null : chemin;
}

/** Le descripteur stocké d'un chemin, d'un nom de fichier ou d'une URL absolue. */
export async function findMedia(valeur) {
  const objectKey = objectKeyOf(valeur);
  if (!objectKey) return null;
  return PanelMedia.findOne({ objectKey }).lean();
}

/**
 * LE DESCRIPTEUR TEL QU'IL PART VERS UN PROJET.
 *
 * Il n'est produit QUE si l'on peut le rendre entièrement vrai : une adresse
 * canonique, une empreinte, un type, une taille. Un descripteur partiel
 * laisserait le projet croire qu'il sait des choses qu'il ne sait pas — et
 * c'est cette illusion qu'on remplace.
 *
 * @param {string|null} valeur   chemin relatif stocké (`/uploads/…`) ou URL absolue
 * @param {object} [opts]
 * @param {string} [opts.role]   rôle métier annoncé dans le descripteur
 * @returns {Promise<object|null>} descripteur canonique, ou `null`
 */
export async function publishableDescriptor(valeur, { role = null } = {}) {
  const brut = String(valeur ?? '').trim();
  if (!brut) return null;

  /**
   * NOS PROPRES MÉDIAS D'ABORD, même donnés en absolu.
   *
   * Les fiches conservent l'adresse canonique complète. Si l'on testait
   * « absolu ⇒ externe », on publierait nos propres images sans empreinte, ni
   * type, ni dimensions — en se privant de tout ce que le descripteur apporte,
   * alors que le Panel les a mesurées à l'import.
   */
  const connu = await findMedia(brut);
  if (connu) {
    if (connu.deletedAt) return null;
    return descriptorOfKnownMedia(connu, role);
  }

  // Une URL EXTERNE déjà absolue reste acceptée : le champ l'autorise encore,
  // et le Panel n'a aucune métadonnée à son sujet. On publie ce qu'on sait —
  // l'adresse — et rien de plus, plutôt que d'inventer une empreinte.
  if (/^https?:\/\//i.test(brut)) {
    const verdict = isCanonicalMediaUrl(brut);
    if (!verdict.ok) {
      logger.warn(`[media] Média non publié : ${verdict.reason} (${brut}).`);
      return null;
    }
    return {
      mediaId: null, url: brut, mime: null, size: null,
      width: null, height: null, sha256: null, version: null,
      updatedAt: null, role, external: true,
    };
  }

  return null;
}

/**
 * Le descripteur d'un média que le Panel CONNAÎT, résolu contre l'adresse
 * canonique courante.
 *
 * L'adresse est toujours recomposée depuis `media.path` et l'autorité du
 * moment — jamais reprise telle quelle de la fiche. C'est ce qui fait qu'un
 * changement d'adresse du Panel se répercute partout à la publication
 * suivante, sans qu'aucune fiche n'ait à être réécrite.
 */
async function descriptorOfKnownMedia(media, role) {
  const { url: base } = await resolveBackendUrl();
  const racine = String(base ?? '').trim().replace(/\/+$/, '');
  const absolue = `${racine}${media.path}`;
  const verdict = isCanonicalMediaUrl(absolue);
  if (!verdict.ok) {
    // On le DIT. Un média absent d'une projection sans explication ferait
    // chercher le défaut du côté du projet, qui n'y est pour rien.
    logger.warn(`[media] Descripteur « ${media.objectKey} » non publié : ${verdict.reason}.`);
    return null;
  }

  return {
    mediaId: media.mediaId,
    url: absolue,
    mime: media.mime,
    size: media.size,
    width: media.width,
    height: media.height,
    sha256: media.sha256,
    version: media.version,
    updatedAt: media.updatedAt,
    role: role ?? media.role ?? null,
    external: false,
  };
}

export default {
  sha256Of,
  SHORT_HASH_LENGTH,
  objectKeyFor,
  objectKeyOf,
  shortHashOf,
  findMediaByContent,
  isCanonicalMediaUrl,
  registerMedia,
  markMediaDeleted,
  findMedia,
  publishableDescriptor,
};
