import { Router } from 'express';
import multer from 'multer';
import { requirePanelDev } from '../middlewares/panelAuth.middleware.js';
import { processImage } from '../services/upload/upload.service.js';

/**
 * MÉDIAS DU PANEL — import du logo de l'entreprise.
 *
 * Le fichier ne touche jamais le disque avant d'être validé : multer le garde
 * en mémoire, sharp le relit, le redimensionne et le réécrit en WebP. Un
 * fichier déposé n'est donc jamais servi tel quel — ce qui interdit d'héberger
 * autre chose qu'une image sous une extension d'image.
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
// Écriture réservée aux DEV, comme la fiche d'entreprise : ce logo s'affiche
// sur l'ensemble du parc.
router.use(requirePanelDev);

router.post('/image', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { code: 'PANEL_UPLOAD_EMPTY', message: 'Aucun fichier reçu.' } });
    }
    // Le préfixe ne sert qu'à nommer le fichier. On le réduit à un jeton
    // alphanumérique : aucun séparateur de chemin ne doit pouvoir s'y glisser.
    const brut = String(req.query.prefix || 'img');
    const prefix = brut.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'img';
    const result = await processImage(req.file.buffer, { prefix });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

export default router;
