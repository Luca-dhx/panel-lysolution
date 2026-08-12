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

/* ══════════════════════════════════════════════════════════════════════════
   DOCUMENTS — le second genre de média, ajouté au lot L10.2.

   ══ POURQUOI ILS NE PASSENT PAS PAR LA TABLE DES IMAGES ═══════════════════

   Une image est DÉCODÉE, pivotée, redimensionnée et réencodée en WebP : ce que
   le Panel sert n'est jamais le fichier reçu. C'est le bon traitement pour un
   logo — et le pire possible pour une facture. Réencoder un justificatif, ce
   serait produire un document qui n'est plus celui que le fournisseur a émis,
   avec une empreinte qui ne correspond plus à rien d'opposable.

   Un document est donc stocké OCTET POUR OCTET. Sa politique porte d'autres
   questions : quels types réels accepter, quelle taille, et rien sur les
   dimensions — un PDF n'en a pas.

   ══ POURQUOI DANS CE FICHIER, ET PAS DANS UN AUTRE ════════════════════════

   « La politique d'import des médias du Panel » est ce fichier. Une seconde
   table ailleurs finirait par diverger de celle-ci sur la seule chose qu'elles
   partagent vraiment : le plafond de transport, qui borne Nginx.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * TYPES DE DOCUMENT ACCEPTÉS — vérifiés sur les OCTETS.
 *
 * ── POURQUOI PAS DE SVG, ALORS QU'IL EST UNE IMAGE ACCEPTÉE ────────────────
 * Un SVG est un document XML qui peut porter du script. Servi en pièce jointe
 * il est inoffensif ; ouvert dans un onglet sur l'origine du Panel, il ne l'est
 * plus. Les images de justificatif sont donc les formats RASTER, et le SVG
 * reste réservé aux médias publics, qui ne se téléchargent pas.
 */
export const ACCEPTED_DOCUMENT_TYPES = Object.freeze([
  { mime: 'application/pdf', extension: 'pdf', label: 'PDF' },
  { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG' },
  { mime: 'image/png', extension: 'png', label: 'PNG' },
  { mime: 'image/webp', extension: 'webp', label: 'WebP' },
  { mime: 'image/heic', extension: 'heic', label: 'HEIC' },
]);

/**
 * POLITIQUE PAR RÔLE DOCUMENTAIRE.
 *
 * `receipt` — le justificatif d'un mouvement financier : facture fournisseur,
 * reçu, note. Dix mégaoctets couvrent très largement un PDF de facture, y
 * compris scanné en couleur.
 *
 * La valeur reste SOUS le plafond des images (12 Mo) : le plafond de transport
 * ne bouge donc pas, et la borne Nginx du profil de déploiement n'a pas à être
 * renégociée pour ce lot. Le jour où un document devra dépasser 12 Mo, le
 * contrôle de dérive de `media-upload-limits` le signalera — c'est son rôle.
 */
export const DOCUMENT_POLICIES = Object.freeze({
  receipt: { maxInputBytes: 10 * 1024 * 1024 },
});

const DEFAUT_DOCUMENT = Object.freeze({ maxInputBytes: 8 * 1024 * 1024 });

export function documentPolicyFor(role) {
  return DOCUMENT_POLICIES[role] ?? DEFAUT_DOCUMENT;
}

/** Le type documentaire correspondant à un MIME mesuré, ou `null`. */
export function documentTypeOf(mime) {
  return ACCEPTED_DOCUMENT_TYPES.find((t) => t.mime === mime) ?? null;
}

/**
 * LE PLAFOND DE TRANSPORT — le plus permissif de TOUTES les tables.
 *
 * `multer` coupe le flux AVANT que le corps ne soit lu, donc avant qu'on sache
 * de quel rôle il s'agit. On laisse entrer jusqu'au plafond, puis on refuse par
 * rôle — avec un message qui nomme la bonne limite.
 *
 * Il couvre images ET documents depuis L10.2 : un plafond qui ignorerait l'une
 * des deux familles ferait couper le flux d'un fichier pourtant accepté par la
 * politique, et le refus arriverait en 413 nu, sans code métier.
 */
export const MAX_INPUT_BYTES = Math.max(
  ...Object.values(MEDIA_POLICIES).map((p) => p.maxInputBytes),
  ...Object.values(DOCUMENT_POLICIES).map((p) => p.maxInputBytes),
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
  DOCUMENT_POLICIES,
  ACCEPTED_DOCUMENT_TYPES,
  documentPolicyFor,
  documentTypeOf,
  MAX_INPUT_BYTES,
  HTTP_BODY_LIMIT_BYTES,
  HTTP_BODY_LIMIT_MB,
  humanBytes,
};
