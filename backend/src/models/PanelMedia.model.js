// DESCRIPTEUR DE MÉDIA — LOT 4.
//
// ══ POURQUOI UN OBJET, ET PAS UNE CHAÎNE ════════════════════════════════════
//
// Le Panel ne transportait qu'une URL. Un projet qui la recevait ne pouvait
// répondre à aucune des questions dont il a besoin :
//
//   · est-ce la même image qu'hier, ou une autre ? (aucune empreinte)
//   · quel type réel ? (une extension n'est pas un type)
//   · quelles dimensions, pour réserver la place et éviter le saut de mise en
//     page ? (inconnues)
//   · quelle taille, pour décider d'un chargement différé ? (inconnue)
//   · cette projection est-elle plus récente que celle que j'ai déjà ?
//     (aucune version)
//
// Faute de réponses, un projet ne pouvait que RECHARGER l'URL et espérer. Deux
// conséquences observées : une image remplacée continuait de s'afficher depuis
// le cache du navigateur, et une image supprimée laissait un lien mort dont
// personne ne savait dire s'il était rompu ou simplement lent.
//
// Un descripteur répond à tout cela — et il est ADDITIF : l'URL seule reste
// acceptée le temps que les projets migrent.
import mongoose from 'mongoose';

const mediaSchema = new mongoose.Schema(
  {
    /** Identité STABLE du média, indépendante de son emplacement. */
    mediaId: { type: String, required: true, unique: true },

    /**
     * Clé de l'objet stocké — le nom de fichier sous `/uploads`. C'est ce qui
     * change quand le contenu change ; `mediaId` ne bouge pas.
     */
    objectKey: { type: String, required: true, index: true },
    /** Chemin public RELATIF (`/uploads/<objectKey>`). L'absolu est résolu à la publication. */
    path: { type: String, required: true },

    // ── CE QUE LE FICHIER EST RÉELLEMENT ────────────────────────────────
    // Mesuré à l'import, jamais déduit d'une extension : un `.webp` peut être
    // n'importe quoi, et c'est le navigateur du CLIENT qui découvrirait le
    // mensonge.
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    /** Empreinte du CONTENU. C'est elle qui dit « même image » ou « autre ». */
    sha256: { type: String, required: true, index: true },

    /**
     * Version MONOTONE du média. Elle n'existe pas pour faire joli : c'est
     * elle qui permet à un projet de refuser une projection plus ancienne que
     * celle qu'il applique déjà — le cas normal après un rattrapage.
     */
    version: { type: Number, required: true, default: 1 },

    /** À quoi ce média appartient — jamais deviné depuis son nom. */
    scope: { type: String, default: 'DEVELOPER_IDENTITY' },
    /** Rôle métier : logo · favicon · portrait d'équipe… */
    role: { type: String, default: null },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    /** Retiré : le descripteur survit, pour que la suppression soit publiable. */
    deletedAt: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

mediaSchema.index({ scope: 1, role: 1 });

export default mongoose.model('PanelMedia', mediaSchema);
