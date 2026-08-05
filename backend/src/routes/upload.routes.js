import { Router } from 'express';
import multer from 'multer';
import { requirePanelDev } from '../middlewares/panelAuth.middleware.js';
import { processImage, deleteImage } from '../services/upload/upload.service.js';
import { resolveMediaAuthority, relayToAuthority } from '../services/upload/mediaAuthority.js';

/**
 * MÉDIAS DU PANEL — import et retrait.
 *
 * Le fichier ne touche jamais le disque avant d'être validé : multer le garde
 * en mémoire, sharp le relit, le redimensionne et le réécrit en WebP. Un
 * fichier déposé n'est donc jamais servi tel quel — ce qui interdit d'héberger
 * autre chose qu'une image sous une extension d'image.
 *
 * ── UNE SEULE AUTORITÉ ──────────────────────────────────────────────────────
 * Chaque instance écrivait autrefois dans son propre dossier : un logo importé
 * depuis un poste de développement n'existait que sur ce poste, et le Panel
 * déployé ne l'avait jamais vu. Désormais une seule instance STOCKE ; les
 * autres RELAIENT, sans jamais rien conserver.
 *
 * Le relais porte le jeton de l'appelant — les instances partagent la clé de
 * signature, donc rien n'est à provisionner, et aucun secret n'approche le
 * navigateur : il ne parle qu'à son propre backend.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!String(file.mimetype || '').startsWith('image/')) {
      const err = new Error('Seules les images sont autorisées.');
      err.status = 400;
      err.code = 'PANEL_UPLOAD_NOT_AN_IMAGE';
      return cb(err);
    }
    cb(null, true);
  },
});

const router = Router();
// Écriture réservée aux DEV, comme la fiche d'entreprise : ces médias
// s'affichent sur l'ensemble du parc.
router.use(requirePanelDev);

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

router.post('/image', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { code: 'PANEL_UPLOAD_EMPTY', message: 'Aucun fichier reçu.' } });
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

      const amont = await relayToAuthority(
        authority,
        `/api/uploads/image?prefix=${encodeURIComponent(prefix)}`,
        { method: 'POST', headers: identite(req), body: corps },
      );
      return rendreAmont(res, amont);
    }

    const result = await processImage(req.file.buffer, { prefix });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * RETRAIT D'UN MÉDIA — une opération unique sur l'autorité.
 *
 * Ce n'est pas une synchronisation entre deux dossiers : il n'y a qu'un
 * dossier. Retirer depuis un poste de développement supprime donc le fichier
 * là où il vit réellement, et toutes les interfaces cessent de le voir au
 * même instant.
 */
router.delete('/image/:filename', async (req, res, next) => {
  try {
    const nom = String(req.params.filename || '');
    const { authority, isAuthority } = await resolveMediaAuthority();

    if (!isAuthority) {
      const amont = await relayToAuthority(
        authority,
        `/api/uploads/image/${encodeURIComponent(nom)}`,
        { method: 'DELETE', headers: identite(req) },
      );
      return rendreAmont(res, amont);
    }

    return res.status(200).json(await deleteImage(nom));
  } catch (err) {
    return next(err);
  }
});

export default router;
