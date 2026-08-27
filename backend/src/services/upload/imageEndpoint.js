/**
 * L'IMPORT D'UNE IMAGE — la chaîne complète, montable sur plusieurs adresses.
 *
 * ══ POURQUOI CE FICHIER EXISTE ══════════════════════════════════════════════
 *
 * Tout ce qui suit vivait dans `routes/upload.routes.js`, sous une garde
 * `requirePanelDev`. C'était le bon arbitrage pour les médias de la MARQUE :
 * un logo importé s'affiche en pied de page de tout le parc, et cette écriture
 * n'a rien à faire entre les mains d'un compte de gestion.
 *
 * La prospection a le besoin inverse. Une photo de devanture collée sur une
 * fiche de prospect ne sort jamais du Panel, ne s'affiche chez personne, et
 * c'est l'équipe commerciale — pas le développeur — qui la prend. Réserver ce
 * geste aux comptes DEV aurait donné un bouton « ajouter une image » qui répond
 * 403 à la moitié de ceux qui le voient.
 *
 * ── CE QUI N'EST PAS DUPLIQUÉ, ET C'EST TOUT L'INTÉRÊT ─────────────────────
 * Le relais vers l'AUTORITÉ média, la validation sur les OCTETS, la politique
 * de taille par rôle, la traduction des refus de `multer` : une seule
 * implémentation. Recopier trente lignes dans la prospection aurait produit
 * deux chemins d'import qui divergent — l'un valide les octets, l'autre les
 * oublie — et l'écart ne se serait vu que le jour d'un fichier hostile.
 *
 * Ce module ne décide donc PAS qui a le droit : il fait le travail. La garde
 * reste sur la route, où elle se lit.
 */
import multer from 'multer';
import ApiError from '../../utils/ApiError.js';
import { processImage, deleteImage } from './upload.service.js';
import { resolveMediaAuthority, relayToAuthority } from './mediaAuthority.js';
import { validateImage } from './mediaValidation.js';
import { MAX_INPUT_BYTES, humanBytes, policyFor } from './mediaPolicy.js';

/**
 * LA BORNE VIENT DE LA POLITIQUE — plus jamais d'un nombre écrit ici.
 *
 * `multer` coupe le flux AVANT que le corps ne soit lu : on ne sait pas encore
 * de quel rôle il s'agit. On laisse donc entrer jusqu'au plafond de la table,
 * puis `validateImage` refuse par RÔLE, avec la bonne limite dans le message.
 *
 * Le filtre MIME ne porte aucune sécurité : `file.mimetype` est DÉCLARÉ par le
 * navigateur d'après l'extension. Le vrai contrôle lit les octets.
 */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INPUT_BYTES },
  fileFilter(req, file, cb) {
    if (!String(file.mimetype || '').startsWith('image/')) {
      return cb(ApiError.badRequest(
        'PANEL_MEDIA_TYPE_UNSUPPORTED',
        'Seules les images sont autorisées.',
      ));
    }
    cb(null, true);
  },
});

/**
 * TRADUIT LES REFUS DE `multer` EN ERREURS MÉTIER.
 *
 * ══ CE QUI S'AFFICHAIT AVANT ════════════════════════════════════════════════
 *
 *     Erreur interne.
 *     MulterError: File too large
 *
 * Un rejet PRÉVU se présentait comme une panne du serveur, sans dire la limite
 * ni quoi faire. Un utilisateur ne peut rien faire d'une panne ; il peut
 * réduire une image — encore faut-il lui dire de combien.
 */
export function translateUploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(
        413,
        'PANEL_MEDIA_TOO_LARGE',
        `Cette image dépasse la taille maximale acceptée (${humanBytes(MAX_INPUT_BYTES)}).`,
        { maxBytes: MAX_INPUT_BYTES },
      ));
    }
    return next(ApiError.badRequest(
      'PANEL_MEDIA_INVALID',
      `Envoi de fichier invalide (${err.code}).`,
    ));
  }
  return next(err);
}

/** Le seul en-tête relayé : l'identité de l'appelant. */
const identite = (req) => {
  const jeton = req.get('authorization');
  return jeton ? { authorization: jeton } : {};
};

/** Réémet la réponse de l'autorité sans la réinterpréter. */
async function rendreAmont(res, amont) {
  const texte = await amont.text();
  return res
    .status(amont.status)
    .type(amont.headers.get('content-type') || 'application/json')
    .send(texte);
}

/**
 * REÇOIT UNE IMAGE — relaie si l'on n'est pas l'autorité, écrit sinon.
 *
 * `relayPath` est l'adresse à appeler CHEZ L'AUTORITÉ. Elle est explicite
 * parce qu'elle n'est pas forcément celle qu'on sert : la prospection reçoit
 * ses images sur sa propre route, mais l'autorité, elle, n'en connaît qu'une.
 */
export function receiveImage({ relayPath = '/api/uploads/image' } = {}) {
  return async function handler(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: { code: 'PANEL_UPLOAD_EMPTY', message: 'Aucun fichier reçu.' },
        });
      }
      // Le préfixe ne sert qu'à nommer le fichier. On le réduit à un jeton
      // alphanumérique : aucun séparateur de chemin ne doit pouvoir s'y glisser.
      const brut = String(req.query.prefix || 'img');
      const prefix = brut.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'img';

      const { authority, isAuthority } = await resolveMediaAuthority();

      if (!isAuthority) {
        /**
         * INSTANCE CLIENTE — on relaie, on n'écrit pas.
         *
         * Le fichier est déjà en mémoire : on le réémet tel que l'appelant l'a
         * envoyé. Le réencodage a lieu chez l'autorité, une seule fois, au seul
         * endroit qui conserve le résultat — sinon deux réencodages successifs
         * dégraderaient l'image sans que personne ne s'en aperçoive.
         */
        const corps = new FormData();
        corps.append(
          'file',
          new Blob([req.file.buffer], { type: req.file.mimetype }),
          req.file.originalname || 'image',
        );

        const parametres = new URLSearchParams({ prefix });
        if (req.query.role) parametres.set('role', String(req.query.role));

        const amont = await relayToAuthority(
          authority,
          `${relayPath}?${parametres.toString()}`,
          { method: 'POST', headers: identite(req), body: corps },
        );
        return rendreAmont(res, amont);
      }

      /**
       * Le RÔLE métier accompagne le fichier — logo, favicon, portrait.
       *
       * Il n'est pas déduit du préfixe : un préfixe sert à nommer un fichier,
       * pas à décrire ce qu'il représente. Le descripteur publié porte ce rôle,
       * et c'est lui que le projet lit pour savoir quoi afficher où.
       */
      const role = String(req.query.role || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || null;

      /**
       * VALIDATION AVANT ÉCRITURE — chez l'AUTORITÉ, après le relais.
       *
       * Une instance cliente ne décide pas seule de ce que l'autorité acceptera :
       * deux versions du Panel pourraient sinon diverger sur ce qu'est un média
       * valide, et le refus dépendrait de l'instance par laquelle on passe.
       */
      await validateImage(req.file.buffer, { role });

      // La politique décide de la SORTIE — plus aucun appelant ne choisit.
      const { maxWidth } = policyFor(role);
      const result = await processImage(req.file.buffer, { prefix, role, maxWidth });
      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * RETRAIT D'UN MÉDIA — une opération unique sur l'autorité.
 *
 * Ce n'est pas une synchronisation entre deux dossiers : il n'y a qu'un
 * dossier. Retirer depuis un poste de développement supprime donc le fichier
 * là où il vit réellement, et toutes les interfaces cessent de le voir au
 * même instant.
 */
export function removeImage({ relayPath = '/api/uploads/image' } = {}) {
  return async function handler(req, res, next) {
    try {
      const nom = String(req.params.filename || '');
      const { authority, isAuthority } = await resolveMediaAuthority();

      if (!isAuthority) {
        const amont = await relayToAuthority(
          authority,
          `${relayPath}/${encodeURIComponent(nom)}`,
          { method: 'DELETE', headers: identite(req) },
        );
        return rendreAmont(res, amont);
      }

      return res.status(200).json(await deleteImage(nom));
    } catch (err) {
      return next(err);
    }
  };
}

export default { imageUpload, translateUploadErrors, receiveImage, removeImage };
