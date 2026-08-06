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
import { config } from '../../config/env.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { UPLOADS_PUBLIC_PREFIX } from './upload.service.js';

/** Hôtes qui ne désignent que la machine courante — jamais publiables. */
const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/* -------------------------------------------------------------------------- */
/*  LE RÉSOLVEUR CENTRAL D'ADRESSE                                            */
/* -------------------------------------------------------------------------- */

/**
 * LA DESTINATION OÙ CE PANEL EST EN LIGNE, pour un environnement donné.
 *
 * ── CE QU'ELLE N'EST PAS ────────────────────────────────────────────────────
 * Ni une destination retirée, ni une destination vidée, ni une destination en
 * cours de retrait. Une adresse tirée de l'une d'elles mènerait à une
 * quarantaine 410 ou à un domaine rendu — c'est-à-dire à une image cassée
 * présentée comme publiée.
 *
 * `null` quand ce Panel n'est pas encore déployé dans cet environnement :
 * c'est le cas NORMAL d'une recette qu'on configure avant sa mise en ligne.
 */
export async function activePanelDestination(environment) {
  if (!environment) return null;
  const PanelDeploymentTarget = (await import('../../models/PanelDeploymentTarget.model.js')).default;
  return PanelDeploymentTarget.findOne({
    environment,
    lifecycleStatus: 'ACTIVE',
    state: 'DEPLOYED',
  }).sort({ lastDeployedAt: -1 }).lean();
}

/**
 * L'adresse publique que CE Panel déclare, écrite par le déploiement.
 *
 * Repli de la destination ACTIVE, jamais son remplaçant : elle ne connaît ni
 * le cycle de vie d'une destination, ni l'environnement. On ne s'en sert que
 * lorsqu'aucune destination n'est enregistrée.
 */
async function adressePubliqueDeclaree() {
  try {
    const { resolveBackendUrl } = await import('../network/networkConfig.service.js');
    const { url } = await resolveBackendUrl();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * ADRESSE D'UN MÉDIA — la SEULE fonction autorisée à en produire une.
 *
 * ══ POURQUOI L'URL N'EST PLUS UNE IDENTITÉ ══════════════════════════════════
 *
 * L'adresse absolue était enregistrée dans les fiches. Deux conséquences, et
 * les deux se sont produites :
 *
 *   · un Panel de RECETTE non encore déployé n'avait aucune adresse publique,
 *     donc aucun logo enregistrable — on ne pouvait plus le configurer avant
 *     sa première mise en ligne ;
 *   · le jour où le Panel change de domaine, toutes les fiches pointaient
 *     encore sur l'ancien.
 *
 * L'identité d'un média est son DESCRIPTEUR — clé d'objet, empreinte,
 * environnement. L'adresse en est DÉRIVÉE, à la lecture, contre la destination
 * active du moment. Une fiche n'a donc plus jamais à être réécrite.
 *
 * @param {object} media        descripteur (`PanelMedia` ou sa projection)
 * @param {string} environment  environnement du LECTEUR — jamais celui deviné
 * @returns {Promise<{url:string|null, absolute:boolean, reason:string}>}
 */
export async function resolvePanelMediaUrl(media, environment) {
  if (!media?.objectKey) return { url: null, absolute: false, reason: 'AUCUN_MEDIA' };

  /**
   * AUCUN MÉLANGE D'ENVIRONNEMENTS. Un média de recette n'a rien à faire en
   * production, et réciproquement. Le résoudre « quand même » ferait afficher
   * l'image d'un monde dans l'autre — sans que rien ne le signale.
   */
  if (media.environment && environment && media.environment !== environment) {
    return { url: null, absolute: false, reason: 'ENVIRONNEMENT_DIFFERENT' };
  }
  if (media.deletedAt) return { url: null, absolute: false, reason: 'MEDIA_SUPPRIME' };

  const chemin = media.path ?? `${UPLOADS_PUBLIC_PREFIX}/${media.objectKey}`;
  const env = media.environment ?? environment;
  const destination = await activePanelDestination(env);

  /**
   * DEUX SOURCES D'ADRESSE, DANS CET ORDRE, ET AUCUNE AUTRE.
   *
   *   1. la destination ACTIVE de cet environnement — l'autorité. Elle cesse
   *      d'exister dès qu'elle est retirée, ce qui interdit par construction
   *      d'annoncer l'adresse d'une destination rendue ou en quarantaine ;
   *   2. à défaut, l'adresse publique inscrite dans la configuration réseau
   *      par le déploiement — mais UNIQUEMENT si aucune destination n'est
   *      enregistrée pour cet environnement. Un Panel mis en ligne avant que
   *      le registre des destinations n'existe n'a pas de fiche : sans ce
   *      repli, son logo cesserait d'être publié du jour au lendemain, alors
   *      qu'il est bien servi.
   *
   * La condition « aucune destination » n'est pas un détail : dès qu'une
   * destination existe, son cycle de vie fait autorité. Un Panel dont la
   * destination a été RETIRÉE doit redevenir local — s'appuyer alors sur une
   * configuration réseau devenue périmée publierait l'adresse d'un site rendu.
   *
   * Aucune adresse codée en dur, et jamais celle d'un autre environnement :
   * la configuration réseau est propre à la base de CET environnement.
   */
  const aucuneDestination = !destination
    && (await (await import('../../models/PanelDeploymentTarget.model.js')).default
      .countDocuments({ environment: env })) === 0;

  const candidats = [
    [destination?.url, 'DESTINATION_ACTIVE'],
    [aucuneDestination ? await adressePubliqueDeclaree() : null, 'CONFIGURATION_RESEAU'],
  ];

  for (const [brut, raison] of candidats) {
    if (!brut) continue;
    const base = String(brut).trim().replace(/\/+$/, '');
    const absolue = `${base}${chemin}`;
    if (isCanonicalMediaUrl(absolue).ok) return { url: absolue, absolute: true, reason: raison };
  }

  // Aucune adresse publiable : l'adresse LOCALE est la bonne réponse. Le Panel
  // se sert lui-même ses médias, et l'aperçu fonctionne. C'est l'état NORMAL
  // d'une recette qu'on configure avant sa première mise en ligne.
  return { url: chemin, absolute: false, reason: 'LOCAL_SANS_DESTINATION' };
}

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
  environment = config.env,
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
    environment,
    // Un média neuf n'existe que sur la machine qui vient de l'écrire. Ce
    // n'est pas un défaut : c'est l'état normal d'une recette qu'on configure
    // avant de la déployer.
    publicationState: 'LOCAL_ONLY',
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
 * LE DESCRIPTEUR STABLE — ce qu'une FICHE conserve.
 *
 * Aucune adresse : l'identité d'un média ne dépend pas du domaine courant.
 * Tous ces champs sont IMMUABLES pour une clé d'objet donnée — le nom porte
 * l'empreinte du contenu depuis le versionnement par empreinte — ce qui rend
 * leur recopie dans une fiche sans risque de dérive.
 */
export function stableDescriptorOf(media) {
  if (!media?.objectKey) return null;
  return {
    mediaId: media.mediaId,
    objectKey: media.objectKey,
    environment: media.environment ?? null,
    sha256: media.sha256,
    mime: media.mime,
    size: media.size,
    width: media.width ?? null,
    height: media.height ?? null,
    version: media.version ?? 1,
  };
}

/**
 * Le descripteur d'un média que le Panel CONNAÎT, résolu contre la destination
 * active du moment.
 *
 * L'adresse est toujours recomposée — jamais reprise telle quelle de la fiche.
 * C'est ce qui fait qu'un changement de domaine du Panel se répercute partout
 * à la publication suivante, sans qu'aucune fiche n'ait à être réécrite.
 *
 * ── AUCUNE ADRESSE LOCALE NE PART VERS UN PROJET ────────────────────────────
 * Tant qu'aucune destination active ne sert cet environnement, le média n'est
 * PAS publiable : `/uploads/…` ou `http://localhost` n'existent pas depuis le
 * serveur d'un client. On rend `null` — le projet garde alors sa projection
 * précédente, ce qui vaut mieux qu'une image cassée.
 */
async function descriptorOfKnownMedia(media, role) {
  const { url: absolue, absolute } = await resolvePanelMediaUrl(media, media.environment ?? config.env);
  if (!absolute) {
    logger.warn(`[media] Descripteur « ${media.objectKey} » non publié : `
      + 'aucune destination active ne le sert encore (média local à cet environnement).');
    return null;
  }
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

/* -------------------------------------------------------------------------- */
/*  TRANSFERT VERS UNE DESTINATION — au déploiement                           */
/* -------------------------------------------------------------------------- */

/** L'empreinte du fichier telle que LE SERVEUR la calcule — ou `ABSENT`. */
async function empreinteDistante(transport, chemin) {
  const res = await transport
    .exec(`sha256sum ${chemin} 2>/dev/null | cut -d' ' -f1 || echo ABSENT`)
    .catch(() => ({ stdout: 'ABSENT' }));
  const valeur = String(res.stdout ?? '').trim();
  return valeur === '' ? 'ABSENT' : valeur;
}

/**
 * TRANSFÈRE les médias de cet environnement vers la destination, VÉRIFIE ce
 * qui est arrivé, et ne marque PUBLIÉ que ce qui est prouvé.
 *
 * ══ POURQUOI CETTE ÉTAPE TRANSFÈRE, ET NE SE CONTENTE PAS DE CONSTATER ══════
 *
 * Le pipeline synchronise déjà le dossier `uploads` vivant vers le
 * `shared/uploads` de la destination — mais c'est une copie de dossier, tentée
 * au mieux et dont l'échec est absorbé (`.catch`), qui ne connaît aucun média
 * en particulier. S'en remettre à elle, c'était faire dépendre la publication
 * d'un effet de bord : le jour où le dossier local n'existe pas, où la copie
 * échoue, ou où un média a été importé après elle, le fichier n'arrive jamais
 * et rien ne le dit. Le premier déploiement d'un Panel configuré en local est
 * exactement ce jour-là.
 *
 * L'étape prend donc la responsabilité complète, média par média :
 *
 *   1. lire l'empreinte SUR LE SERVEUR ;
 *   2. si le fichier est ABSENT, l'ENVOYER depuis le stockage local ;
 *   3. relire l'empreinte sur le serveur — après transfert, jamais avant ;
 *   4. comparer taille et empreinte à ce qui a été mesuré à l'import ;
 *   5. seulement alors, marquer PUBLISHED.
 *
 * L'ordre compte : publier sur la foi de ce qu'on vient d'envoyer reviendrait
 * à prouver qu'on a appelé une fonction, pas qu'un fichier est arrivé intact.
 *
 * ── CE QU'ELLE NE FAIT JAMAIS ───────────────────────────────────────────────
 * Écraser un fichier distant. Un contenu déjà présent sous la même clé mais
 * d'empreinte différente signifie qu'une hypothèse est fausse quelque part :
 * on le SIGNALE et on laisse le média local. Le corriger d'office effacerait
 * la trace du problème.
 *
 * Idempotente : relancée, elle ne retouche que ce qui n'est pas déjà publié
 * sur cet hôte, et ne retransfère que ce qui manque réellement.
 *
 * @param {object} args
 * @param {object} args.transport      transport ouvert sur la destination
 * @param {string} args.sharedUploads  chemin distant du dossier partagé
 * @param {string} args.host           hôte de la destination
 * @param {string} [args.environment]  environnement déployé
 */
export async function publishPanelMediaOnDestination({
  transport, sharedUploads, host, environment = config.env,
}) {
  const rapport = {
    environment,
    host,
    scanned: 0,
    published: 0,
    /** Médias réellement ENVOYÉS pendant cette passe — le premier déploiement. */
    transferred: [],
    /** Introuvables des DEUX côtés : plus rien à transférer. */
    missing: [],
    mismatched: [],
    alreadyPublished: 0,
  };
  if (!transport || !sharedUploads || !host) return rapport;

  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const { uploadsDir } = await import('./upload.service.js');

  const medias = await PanelMedia.find({ environment, deletedAt: null }).lean();
  rapport.scanned = medias.length;

  for (const media of medias) {
    if (media.publicationState === 'PUBLISHED' && media.publishedHost === host) {
      rapport.alreadyPublished += 1;
      continue;
    }

    const distant = `${sharedUploads}/${media.objectKey}`;
    let empreinte = await empreinteDistante(transport, distant);

    /**
     * LE FICHIER N'EST PAS LÀ — on l'ENVOIE.
     *
     * C'est le cas nominal du premier déploiement : le média n'a jamais existé
     * ailleurs que dans le stockage local du Panel. Sans cet envoi, il resterait
     * LOCAL_ONLY indéfiniment et l'opérateur devrait le réimporter depuis
     * l'interface déployée — précisément ce qu'on supprime.
     */
    if (empreinte === 'ABSENT') {
      const local = pathMod.join(uploadsDir(), media.objectKey);
      const presentEnLocal = await fs.access(local).then(() => true).catch(() => false);
      if (!presentEnLocal) {
        // Absent des deux côtés : il n'y a rien à transférer, et le dire vaut
        // mieux que de laisser croire à un transfert manqué.
        rapport.missing.push(media.objectKey);
        continue;
      }

      if (typeof transport.uploadFile !== 'function') {
        rapport.missing.push(media.objectKey);
        continue;
      }
      await transport.uploadFile(local, distant);
      rapport.transferred.push(media.objectKey);

      // On RELIT l'empreinte sur le serveur. Se fier au transfert lui-même
      // prouverait qu'on a appelé une fonction, pas qu'un fichier est arrivé.
      empreinte = await empreinteDistante(transport, distant);
      if (empreinte === 'ABSENT') {
        rapport.missing.push(media.objectKey);
        continue;
      }
    }

    if (empreinte !== media.sha256) {
      rapport.mismatched.push({ objectKey: media.objectKey, expected: media.sha256, found: empreinte });
      continue;
    }

    /**
     * LA TAILLE AUSSI — relevée sur le serveur.
     *
     * L'empreinte suffirait en théorie. En pratique, une taille distante qui
     * diverge alors que l'empreinte correspond signale un `sha256sum` qui n'a
     * pas mesuré ce qu'on croit (lien, montage, troncature silencieuse). Le
     * contrôle est gratuit ; l'illusion de preuve ne l'est pas.
     */
    const tailleRes = await transport
      .exec(`stat -c %s ${distant} 2>/dev/null || echo ABSENT`)
      .catch(() => ({ stdout: 'ABSENT' }));
    const taille = String(tailleRes.stdout ?? '').trim();
    if (taille !== 'ABSENT' && Number.isFinite(Number(taille)) && Number(taille) !== media.size) {
      rapport.mismatched.push({
        objectKey: media.objectKey,
        expected: `${media.size} octets`,
        found: `${taille} octets`,
      });
      continue;
    }

    const at = nowIso();
    await PanelMedia.updateOne(
      { objectKey: media.objectKey },
      { $set: { publicationState: 'PUBLISHED', publishedHost: host, publishedAt: at, updatedAt: at } },
    );
    rapport.published += 1;
  }

  if (rapport.transferred.length) {
    logger.info(`[media] ${rapport.transferred.length} média(s) ${environment} transféré(s) vers ${host}.`);
  }
  if (rapport.published) {
    logger.info(`[media] ${rapport.published} média(s) ${environment} vérifié(s) sur ${host} et publiés.`);
  }
  if (rapport.missing.length) {
    logger.warn(`[media] ${rapport.missing.length} média(s) ${environment} introuvables pour ${host} : `
      + `${rapport.missing.slice(0, 5).join(', ')}. Ils restent locaux et ne seront pas publiés aux projets.`);
  }
  for (const m of rapport.mismatched) {
    logger.error(`[media] Divergence pour « ${m.objectKey} » sur ${host} : `
      + `attendu ${String(m.expected).slice(0, 20)}, trouvé ${String(m.found).slice(0, 20)}. Média NON publié.`);
  }
  return rapport;
}

/**
 * DÉPUBLICATION — la destination ne sert plus ces médias.
 *
 * ── POURQUOI CE N'EST PAS FACULTATIF ────────────────────────────────────────
 * Un média restait `PUBLISHED` avec, pour `publishedHost`, un hôte qui
 * n'existait plus. Le champ mentait : il affirmait une présence constatée sur
 * un serveur dont on venait d'effacer les fichiers. Toute décision prise
 * ensuite sur cet état reposait sur une affirmation fausse.
 *
 * Appelée à la fin d'un retrait. Le média n'est pas supprimé : il redevient
 * ce qu'il était avant la mise en ligne — présent ici, nulle part ailleurs.
 */
export async function unpublishPanelMediaOfDestination({ host = null, environment }) {
  const filtre = { environment, publicationState: 'PUBLISHED' };
  // Un hôte donné ne dépublie que CE qu'il servait : deux destinations d'un
  // même environnement ne doivent pas se dépublier l'une l'autre.
  if (host) filtre.publishedHost = host;

  const at = nowIso();
  const res = await PanelMedia.updateMany(filtre, {
    $set: { publicationState: 'LOCAL_ONLY', publishedHost: null, publishedAt: null, updatedAt: at },
  });
  const nombre = res.modifiedCount ?? 0;
  if (nombre) {
    logger.info(`[media] ${nombre} média(s) ${environment} redeviennent locaux : `
      + `${host ?? 'la destination'} ne les sert plus.`);
  }
  return { environment, host, unpublished: nombre };
}

export default {
  sha256Of,
  SHORT_HASH_LENGTH,
  objectKeyFor,
  objectKeyOf,
  shortHashOf,
  findMediaByContent,
  isCanonicalMediaUrl,
  activePanelDestination,
  resolvePanelMediaUrl,
  stableDescriptorOf,
  registerMedia,
  markMediaDeleted,
  findMedia,
  publishableDescriptor,
  publishPanelMediaOnDestination,
  unpublishPanelMediaOfDestination,
};
