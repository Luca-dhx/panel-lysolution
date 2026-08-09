/**
 * POLITIQUE D'IMPORT DES MÉDIAS DU PANEL — une seule table, et elle fait autorité.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * Un import trop lourd rendait, à l'écran, « Erreur interne » suivi de
 * `MulterError: File too large`. Un rejet parfaitement PRÉVU — l'utilisateur a
 * déposé un fichier trop gros — se présentait comme une panne du serveur, sans
 * dire ni la limite, ni quoi faire.
 *
 * La limite elle-même vivait en dur dans la déclaration de `multer`, sans
 * relation avec ce que le traitement d'image sait faire, ni avec ce que la
 * couche HTTP laisse passer une fois déployé.
 *
 * ══ SYMÉTRIE AVEC LE PROJET MODÈLE ══════════════════════════════════════════
 *
 * Ce fichier est le pendant de `SB Auto 06/backend/src/services/media/mediaPolicy.js`.
 * Les TYPES diffèrent — le Panel publie l'identité du développeur, un projet
 * publie l'identité de son client — mais la FORME et le plafond de transport
 * sont les mêmes, et un contrôle de dérive le vérifie.
 */

/** Formats d'image réellement acceptés — vérifiés sur les OCTETS, pas sur le nom. */
export const ACCEPTED_IMAGE_FORMATS = Object.freeze([
  'jpeg', 'png', 'webp', 'gif', 'avif', 'tiff', 'svg',
]);

/**
 * LA POLITIQUE PAR RÔLE MÉTIER.
 *
 * Les rôles du Panel sont ceux de l'identité DÉVELOPPEUR : la marque affichée
 * sur l'ensemble du parc, et les portraits de son équipe.
 */
export const MEDIA_POLICIES = Object.freeze({
  logo: { maxInputBytes: 12 * 1024 * 1024, maxWidth: 1024, format: 'webp' },
  'logo-dark': { maxInputBytes: 12 * 1024 * 1024, maxWidth: 1024, format: 'webp' },
  favicon: { maxInputBytes: 4 * 1024 * 1024, maxWidth: 256, format: 'webp' },
  portrait: { maxInputBytes: 8 * 1024 * 1024, maxWidth: 800, format: 'webp' },
  signature: { maxInputBytes: 4 * 1024 * 1024, maxWidth: 600, format: 'webp' },
});

/**
 * Repli d'un rôle non listé.
 *
 * Le Panel accepte un import sans rôle déclaré (`role` est optionnel sur la
 * route) : on ne peut donc pas refuser faute de table. On applique la valeur
 * la plus PRUDENTE plutôt que la plus permissive.
 */
const DEFAUT = Object.freeze({ maxInputBytes: 8 * 1024 * 1024, maxWidth: 1920, format: 'webp' });

export function policyFor(role) {
  return MEDIA_POLICIES[role] ?? DEFAUT;
}

/**
 * LE PLAFOND DE TRANSPORT — le plus permissif de la table.
 *
 * `multer` coupe le flux AVANT que le corps ne soit lu, donc avant qu'on sache
 * de quel rôle il s'agit. On laisse entrer jusqu'au plafond, puis on refuse par
 * rôle — avec un message qui nomme la bonne limite.
 */
export const MAX_INPUT_BYTES = Math.max(
  ...Object.values(MEDIA_POLICIES).map((p) => p.maxInputBytes),
);

/**
 * CE QUE LA COUCHE HTTP DOIT LAISSER PASSER.
 *
 * Un envoi `multipart/form-data` transporte plus que le fichier. Aligner Nginx
 * au kilo-octet près ferait refuser, par le serveur web, un fichier que
 * l'application accepte — et ce refus serait un 413 nu, sans code métier,
 * puisqu'il n'atteindrait jamais Node. La DÉCISION doit rester à l'application.
 */
export const HTTP_BODY_LIMIT_BYTES = MAX_INPUT_BYTES + 4 * 1024 * 1024;

/** La même valeur, en mégaoctets entiers — l'unité qu'écrit Nginx. */
export const HTTP_BODY_LIMIT_MB = Math.ceil(HTTP_BODY_LIMIT_BYTES / (1024 * 1024));

/** Lisible par un humain : « 12 Mo », jamais « 12582912 ». */
export function humanBytes(bytes) {
  const mo = bytes / (1024 * 1024);
  return `${Number.isInteger(mo) ? mo : mo.toFixed(1)} Mo`;
}

export default {
  MEDIA_POLICIES,
  ACCEPTED_IMAGE_FORMATS,
  policyFor,
  MAX_INPUT_BYTES,
  HTTP_BODY_LIMIT_BYTES,
  HTTP_BODY_LIMIT_MB,
  humanBytes,
};
