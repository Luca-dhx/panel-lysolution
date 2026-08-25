// HISTORIQUE D'UN TEMPLATE LÉGAL — une ligne par PUBLICATION.
//
// ══ POURQUOI PAR PUBLICATION, ET NON PAR SAUVEGARDE ═════════════════════════
//
// L'historique des modèles d'e-mail retient chaque sauvegarde, parce qu'il n'y
// a pas de brouillon : enregistrer, c'est publier. Un document juridique, lui,
// s'écrit en plusieurs passes — un historique par frappe serait une liste de
// cinquante entrées sans signification dans laquelle personne ne retrouverait
// la version qui était en ligne le mois dernier.
//
// Une ligne d'ici répond donc à UNE question, et c'est la seule qui compte
// quand on enquête : « qu'affichaient les sites entre telle et telle date ? ».
//
// ══ L'HISTORIQUE N'EST JAMAIS RÉÉCRIT ═══════════════════════════════════════
//
// Une version est un FAIT. Restaurer n'efface rien : cela crée une version DE
// PLUS portant l'ancien contenu, et l'on peut donc revenir sur une restauration
// malheureuse. Même doctrine que `PanelEmailTemplateVersion`, pour la même
// raison — la ligne du temps ne doit jamais mentir.
//
// ══ POURQUOI UNE COLLECTION SÉPARÉE ═════════════════════════════════════════
//
// Un document légal est petit ; l'embarquer ne dépasserait aucune limite. Mais
// la lecture chaude de ce modèle est la RÉSOLUTION — celle qui sert un document
// à un projet — et elle n'a que faire de l'historique. Le porter dans le
// document ferait tirer toutes les versions à chaque publication vers un site.
import mongoose from 'mongoose';

const legalTemplateVersionSchema = new mongoose.Schema(
  {
    legalTemplateId: { type: String, required: true },
    version: { type: Number, required: true, min: 1 },

    /** Le contenu COMPLET publié. Un diff serait illisible à la relecture. */
    name: { type: String, default: '' },
    type: { type: String, default: '' },
    description: { type: String, default: '' },
    content: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Qui a publié. Identifiant et libellé — un compte peut disparaître. */
    changedBy: { type: String, default: null },
    changedByLabel: { type: String, default: '' },

    origin: { type: String, enum: ['SEED', 'PUBLISH', 'RESTORE'], default: 'PUBLISH' },
    restoredFromVersion: { type: Number, default: null },

    createdAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * UNE VERSION EST UNIQUE POUR UN TEMPLATE.
 *
 * Sans cet index, deux publications concurrentes lisant `version: 3`
 * écriraient toutes deux une « version 4 », et l'historique porterait deux
 * contenus sous le même numéro — c'est-à-dire qu'il deviendrait inutilisable
 * exactement le jour où l'on en aurait besoin.
 */
legalTemplateVersionSchema.index(
  { legalTemplateId: 1, version: 1 },
  { unique: true, name: 'uniq_legal_template_version' },
);

/** Consultation de l'historique : le plus récent d'abord. */
legalTemplateVersionSchema.index(
  { legalTemplateId: 1, createdAt: -1 },
  { name: 'legal_history_recent' },
);

export const PanelLegalTemplateVersion = mongoose.model(
  'PanelLegalTemplateVersion',
  legalTemplateVersionSchema,
);

export default PanelLegalTemplateVersion;
