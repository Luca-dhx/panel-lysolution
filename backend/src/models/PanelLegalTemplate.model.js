// LE TEMPLATE DE DOCUMENT LÉGAL — le contenu commun, sans les données.
//
// ══ POURQUOI CE N'EST PAS UNE PAGE DE LA VITRINE ════════════════════════════
//
// Parce qu'une vitrine change de gabarit graphique, et qu'un document juridique
// ne doit pas disparaître avec lui. Tant que les mentions légales étaient une
// page du thème, chaque duplication en produisait une COPIE indépendante :
// vingt sites, vingt textes, et la correction d'une phrase devenait une
// opération de masse dont personne ne pouvait dire si elle avait été complète.
//
// Le Panel est donc l'AUTORITÉ du texte, et la vitrine n'en détient qu'un
// rendu résolu (voir `legalDocumentResolver.js`). Changer de thème ne touche
// plus au document ; corriger le document ne touche plus au thème.
//
// ══ POURQUOI DES BLOCS, ET NI DU HTML NI UN TRAITEMENT DE TEXTE ════════════
//
// Un gros HTML opaque aurait trois défauts : il faut le sanitiser à chaque
// lecture, il transporte de la mise en forme que la vitrine devrait respecter
// alors qu'elle a son propre design, et il devient illisible en base. Un
// éditeur riche complet, à l'inverse, demande une bibliothèque, un schéma de
// document, et une migration à chaque évolution — pour un besoin qui tient en
// quatre formes.
//
// Le contenu est donc une STRUCTURE FERMÉE et minuscule :
//
//     document := { title, sections[] }
//     section  := { heading, blocks[] }
//     block    := PARAGRAPH { text }
//               | LIST      { items[] }
//               | FIELDS    { items[{ label, value }] }
//
// Le texte porte des `{{cle}}` du registre, et RIEN d'autre : ni balise, ni
// lien, ni style. La vitrine reçoit des chaînes déjà résolues et les rend comme
// du texte — l'injection est impossible par construction, pas par filtrage.
//
// `FIELDS` mérite un mot : c'est le bloc « Identification légale », celui qui
// aligne « SIRET » et sa valeur. Il aurait pu s'écrire en paragraphes, mais
// c'est LUI qui rend la conditionnalité utilisable — chaque LIGNE disparaît
// seule quand sa donnée manque, là où un paragraphe entier aurait sauté.
//
// ══ BROUILLON, ACTIF, ARCHIVÉ — et pourquoi trois états suffisent ══════════
//
//   DRAFT     en cours d'écriture. Jamais servi à un projet, jamais assignable.
//   ACTIVE    publié. Assignable, servi, et c'est le SEUL état qui l'est.
//   ARCHIVED  retiré du catalogue actif. Reste lisible ; les projets qui
//             l'utilisent ENCORE continuent d'être servis — retirer un document
//             juridique sous les pieds d'un site en production serait pire que
//             de le laisser vieillir.
//
// Il n'y a pas de quatrième état, et surtout pas de suppression d'un template
// utilisé : le service la REFUSE et propose l'archivage (voir
// `legalTemplate.service.js`).
import mongoose from 'mongoose';

export const LEGAL_DOCUMENT_TYPES = Object.freeze({
  LEGAL_NOTICE: 'LEGAL_NOTICE',
  PRIVACY_POLICY: 'PRIVACY_POLICY',
});

export const LEGAL_DOCUMENT_TYPE_VALUES = Object.freeze(Object.values(LEGAL_DOCUMENT_TYPES));

export const LEGAL_TEMPLATE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
});

export const LEGAL_TEMPLATE_STATUS_VALUES = Object.freeze(
  Object.values(LEGAL_TEMPLATE_STATUS),
);

export const LEGAL_BLOCK_TYPES = Object.freeze({
  PARAGRAPH: 'PARAGRAPH',
  LIST: 'LIST',
  FIELDS: 'FIELDS',
});

export const LEGAL_BLOCK_TYPE_VALUES = Object.freeze(Object.values(LEGAL_BLOCK_TYPES));

/** Une ligne de bloc `FIELDS` — un libellé fixe, une valeur qui porte les variables. */
const fieldItemSchema = new mongoose.Schema(
  {
    label: { type: String, default: '', trim: true },
    value: { type: String, default: '' },
  },
  { _id: false },
);

const blockSchema = new mongoose.Schema(
  {
    /**
     * Identifiant STABLE d'un bloc, tiré à la création et jamais réattribué.
     *
     * L'index de position aurait suffi au rendu. Il ne suffit pas à l'écran :
     * React remonterait un bloc entier — donc perdrait le curseur et la
     * sélection — dès qu'on en insère un au-dessus. Une clé stable est ce qui
     * rend l'édition supportable.
     */
    blockId: { type: String, required: true },
    type: { type: String, enum: LEGAL_BLOCK_TYPE_VALUES, required: true },
    /** PARAGRAPH — le texte, variables comprises. Vide pour les autres types. */
    text: { type: String, default: '' },
    /** LIST — les puces. Vide pour les autres types. */
    items: { type: [String], default: [] },
    /** FIELDS — les lignes libellé / valeur. Vide pour les autres types. */
    fields: { type: [fieldItemSchema], default: [] },
  },
  { _id: false },
);

const sectionSchema = new mongoose.Schema(
  {
    sectionId: { type: String, required: true },
    /** Le titre de la section. Peut porter des variables ; rarement utile. */
    heading: { type: String, default: '', trim: true },
    blocks: { type: [blockSchema], default: [] },
  },
  { _id: false },
);

const contentSchema = new mongoose.Schema(
  {
    /**
     * Le TITRE DU DOCUMENT — « Mentions légales », « Politique de
     * confidentialité ». Édité, et non déduit du `type` : deux templates du
     * même type peuvent viser des intitulés différents, et un titre déduit
     * d'une énumération n'est pas traduisible.
     */
    title: { type: String, default: '', trim: true },
    sections: { type: [sectionSchema], default: [] },
  },
  { _id: false },
);

const legalTemplateSchema = new mongoose.Schema(
  {
    legalTemplateId: { type: String, required: true, unique: true },

    name: { type: String, required: true, trim: true, maxlength: 160 },
    type: { type: String, enum: LEGAL_DOCUMENT_TYPE_VALUES, required: true },
    description: { type: String, default: '', trim: true, maxlength: 500 },

    content: { type: contentSchema, default: () => ({ title: '', sections: [] }) },

    status: {
      type: String,
      enum: LEGAL_TEMPLATE_STATUS_VALUES,
      default: LEGAL_TEMPLATE_STATUS.DRAFT,
    },

    /**
     * LA VERSION — incrémentée à chaque PUBLICATION, pas à chaque frappe.
     *
     * ══ POURQUOI CE CHOIX-LÀ ═══════════════════════════════════════════════
     *
     * `PanelClientCompany` incrémente à chaque enregistrement, parce qu'une
     * entreprise cliente n'a pas de brouillon : la corriger, c'est la publier.
     * Un document juridique, lui, s'écrit en plusieurs passes — et chaque passe
     * ne doit pas se répandre sur les sites du parc.
     *
     * Le numéro qui voyage jusqu'aux vitrines est donc celui de la dernière
     * PUBLICATION. Un brouillon enregistré vingt fois reste en version 3 tant
     * qu'il n'est pas publié en 4.
     */
    version: { type: Number, default: 0, min: 0 },
    publishedAt: { type: String, default: null },

    /**
     * L'INSTANTANÉ SERVI — le contenu tel qu'il était à la publication.
     *
     * ══ LE DÉFAUT QUE CE CHAMP FERME ═══════════════════════════════════════
     *
     * Sans lui, `content` serait à la fois le brouillon en cours et ce que les
     * sites affichent. Ouvrir l'éditeur, effacer une section par mégarde et
     * enregistrer ferait donc DISPARAÎTRE cette section des mentions légales
     * de tous les projets qui utilisent le template — instantanément, sans
     * qu'aucun geste n'ait dit « publier ».
     *
     * `content` est le brouillon ; `publishedContent` est la vérité servie.
     * Publier, c'est recopier l'un dans l'autre — un seul geste, explicite,
     * daté, et qui incrémente la version.
     */
    publishedContent: { type: contentSchema, default: null },

    environment: { type: String, enum: ['TEST', 'PROD'], required: true },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * LE CATALOGUE — « les mentions légales actives de ce monde », la requête de
 * l'écran et celle du sélecteur de la fiche projet.
 */
legalTemplateSchema.index({ environment: 1, type: 1, status: 1, name: 1 });

export default mongoose.model('PanelLegalTemplate', legalTemplateSchema);
