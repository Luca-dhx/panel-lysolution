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

    /**
     * QUI A LE DROIT DE LIRE CE FICHIER — ajouté au lot L10.2.
     *
     * ══ POURQUOI CE CHAMP EXISTE SUR LE MÉDIA, ET NON DANS LES FINANCES ═════
     *
     * Le protocole Media n'avait servi qu'à des images PUBLIABLES : un logo, un
     * favicon, un portrait — des fichiers dont tout l'intérêt est d'être servis
     * à des visiteurs anonymes, depuis `/uploads`, en statique.
     *
     * Un justificatif de coût est l'exact opposé : une facture fournisseur ne
     * doit jamais être joignable par une URL devinable. Le lot L10.1 avait
     * refusé de la livrer pour cette raison précise.
     *
     * Il aurait été plus rapide d'écrire un stockage de fichiers propre aux
     * finances. C'eût été une seconde pile : deux façons de nommer un objet,
     * deux façons d'en mesurer l'empreinte, deux dossiers à sauvegarder — et le
     * jour où un contrat ou une facture client aurait eu le même besoin, une
     * troisième. Le manque n'était pas un service de fichiers : c'était UN
     * CHAMP. On l'ajoute là où il manquait.
     *
     * ══ CE QUE CHAQUE VALEUR ENGAGE ═════════════════════════════════════════
     *
     *   PUBLIC   le fichier vit sous `uploads/`, est servi en statique, et peut
     *            être transféré vers la destination d'un déploiement pour être
     *            affiché par les projets. C'est le défaut, et c'est ce qu'ÉTAIENT
     *            tous les médias existants — d'où la valeur par défaut, qui rend
     *            la reprise des documents antérieurs inutile.
     *
     *   PRIVATE  le fichier vit sous `storage/media/`, qu'aucun bloc `location`
     *            d'Nginx ne dessert et qu'aucun `express.static` ne monte. Il ne
     *            sort QUE par une route authentifiée, décidée par le domaine
     *            qui le possède. Il n'est jamais transféré vers `shared/uploads`
     *            — voir `publishPanelMediaOnDestination`.
     *
     * La visibilité n'est pas modifiable après coup : un fichier privé qui
     * deviendrait public par une écriture de champ resterait, lui, dans le
     * dossier privé — l'état annoncé et l'emplacement réel divergeraient. Un
     * changement de visibilité est un nouvel import.
     */
    visibility: { type: String, enum: ['PUBLIC', 'PRIVATE'], default: 'PUBLIC', index: true },

    /**
     * LE NOM QUE L'UTILISATEUR A DÉPOSÉ — pour le lui rendre au téléchargement.
     *
     * Il n'est JAMAIS un chemin : la clé d'objet est calculée
     * (`<mediaId>-<empreinte>.<ext>`), et ce champ ne sert qu'à remplir
     * l'en-tête `Content-Disposition`. Confondre les deux — écrire le fichier
     * sous le nom fourni — est la faille de traversée de répertoire classique.
     *
     * `null` pour les images du parc : leur nom d'origine n'a jamais eu de
     * lecteur, et personne ne les télécharge.
     */
    originalFilename: { type: String, default: null },

    /**
     * L'ENVIRONNEMENT PROPRIÉTAIRE — TEST ou PROD, jamais les deux.
     *
     * ── POURQUOI IL EST OBLIGATOIRE ──────────────────────────────────────
     * Les deux environnements ont leur base, leurs destinations et leur
     * stockage. Un média sans environnement pourrait être résolu contre la
     * destination de l'autre : le logo d'une recette s'afficherait en
     * production, ou l'inverse. Passer de TEST à PROD est une PROMOTION
     * explicite, jamais un effet de bord d'une résolution d'URL.
     */
    environment: { type: String, enum: ['TEST', 'PROD'], required: true, index: true },

    /**
     * OÙ CE MÉDIA EXISTE RÉELLEMENT.
     *
     *   LOCAL_ONLY  le fichier n'existe que sur la machine qui l'a importé.
     *               Ce n'est PAS une erreur : un Panel de recette se configure
     *               entièrement avant son premier déploiement.
     *   PUBLISHED   le fichier a été transféré vers le `shared/uploads` d'une
     *               destination, et son empreinte y a été vérifiée.
     *
     * C'est cet état, et lui seul, qui autorise la publication d'une URL
     * absolue vers les projets : tant qu'un média est LOCAL_ONLY, aucune
     * adresse ne peut être annoncée à SB Auto — elle ne mènerait nulle part.
     */
    publicationState: {
      type: String,
      enum: ['LOCAL_ONLY', 'PUBLISHED'],
      default: 'LOCAL_ONLY',
      index: true,
    },
    /** Hôte de la destination où le fichier a été vérifié présent. */
    publishedHost: { type: String, default: null },
    publishedAt: { type: String, default: null },

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
