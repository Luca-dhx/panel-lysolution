// VERSIONS DE CONFIGURATION D'ENTREPRISE — Phase 4, LOT 3.
//
// « Toutes les valeurs doivent être versionnées. »
//
// Une version est un INSTANTANÉ IMMUABLE de la configuration publiée : on ne
// la modifie jamais, on en publie une nouvelle. C'est ce qui permet de
// répondre à trois questions qu'aucun champ `updatedAt` ne sait traiter :
//
//   · qu'est-ce que le projet a reçu le 12 mars ?
//   · qui a changé la couleur primaire, et pourquoi ?
//   · comment revenir à la configuration d'avant ?
//
// Le numéro de version est un entier monotone par entreprise. Il voyage
// jusqu'aux projets : un projet sait donc quelle version il applique, et le
// Panel sait quel projet est en retard.
import mongoose from 'mongoose';

const companyVersionSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    // Entier monotone, jamais réutilisé, jamais réattribué.
    version: { type: Number, required: true },

    // L'instantané COMPLET. Volontairement dénormalisé : une version doit
    // rester lisible même si le modèle évolue, et se relire sans reconstruire
    // quoi que ce soit à partir d'un différentiel.
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    // Pourquoi cette version existe. Champ libre, mais exigé à la
    // publication : une version sans raison est une version qu'on ne saura
    // pas relire dans six mois.
    reason: { type: String, required: true },

    // Ce qui a changé par rapport à la version précédente — calculé à la
    // publication, jamais saisi. Sert à l'écran d'historique et à l'audit.
    changes: {
      type: [new mongoose.Schema({
        path: { type: String, required: true },
        from: { type: mongoose.Schema.Types.Mixed, default: null },
        to: { type: mongoose.Schema.Types.Mixed, default: null },
      }, { _id: false })],
      default: [],
    },

    publishedAt: { type: String, required: true },
    publishedBy: { type: String, default: null },
    publishedByEmail: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

// Un numéro de version est unique DANS une entreprise — pas globalement :
// deux tenants numérotent leurs configurations indépendamment.
companyVersionSchema.index({ companyId: 1, version: 1 }, { unique: true });
companyVersionSchema.index({ companyId: 1, publishedAt: -1 });

export default mongoose.model('PanelCompanyVersion', companyVersionSchema);
