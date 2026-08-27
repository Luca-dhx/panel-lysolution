import { Router } from 'express';
import { requirePanelDev } from '../middlewares/panelAuth.middleware.js';
import {
  imageUpload,
  receiveImage,
  removeImage,
  translateUploadErrors,
} from '../services/upload/imageEndpoint.js';

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
 * ── LA MÉCANIQUE A DÉMÉNAGÉ, PAS LA GARDE ───────────────────────────────────
 * Le relais, la validation sur les octets et la politique de taille vivent
 * maintenant dans `services/upload/imageEndpoint.js` : la prospection importe
 * elle aussi des images, et deux copies de cette chaîne auraient fini par
 * diverger. Ce qui reste ICI est ce qui est propre à CETTE adresse — la garde
 * DEV, parce que ces médias-là s'affichent sur l'ensemble du parc.
 */
const router = Router();
router.use(requirePanelDev);

router.post('/image', imageUpload.single('file'), translateUploadErrors, receiveImage());
router.delete('/image/:filename', removeImage());

export default router;
