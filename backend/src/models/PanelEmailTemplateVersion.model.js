// HISTORIQUE D'UN TEMPLATE — une ligne par sauvegarde réussie (L8.3).
//
// Déplacé depuis le dépôt PROJET (`backend/src/models/EmailTemplateVersion.model.js`)
// avec l'autorité de contenu. Deux raisons de conserver ce mécanisme plutôt
// que de le simplifier au passage :
//
// ── POURQUOI UNE COLLECTION SÉPARÉE ─────────────────────────────────────────
//
// Un template pèse jusqu'à 100 ko de HTML. Cinquante versions embarquées dans
// le document dépasseraient la limite de 16 Mo de MongoDB — et surtout, chaque
// lecture du template courant tirerait tout l'historique avec elle, sur le
// chemin d'un envoi.
//
// ── L'HISTORIQUE N'EST JAMAIS RÉÉCRIT ───────────────────────────────────────
//
// Une version est un FAIT : « à cette date, ce contenu a été enregistré ». Une
// restauration ne remonte donc pas le temps, elle crée une version DE PLUS
// portant l'ancien contenu. La ligne du temps ne ment jamais, et l'on peut
// toujours revenir sur une restauration malheureuse.
import mongoose from 'mongoose';

const panelEmailTemplateVersionSchema = new mongoose.Schema(
  {
    templateCode: { type: String, required: true, trim: true },
    /** `null` = le défaut de plateforme. Même clé de portée que le template. */
    projectId: { type: String, default: null },
    version: { type: Number, required: true, min: 1 },

    /** Contenu COMPLET tel qu'enregistré. Un diff serait illisible à la relecture. */
    name: { type: String, default: '' },
    description: { type: String, default: '' },
    subject: { type: String, default: '' },
    html: { type: String, default: '' },
    enabled: { type: Boolean, default: true },

    /** Qui a écrit. Un identifiant et un libellé — le compte peut disparaître. */
    changedBy: { type: String, default: null },
    changedByLabel: { type: String, default: '' },

    /**
     * Origine — un humain doit pouvoir lire l'historique sans deviner.
     * `RESTORE` porte en plus la version d'où vient le contenu.
     */
    origin: { type: String, enum: ['BOOTSTRAP', 'EDIT', 'RESTORE'], default: 'EDIT' },
    restoredFromVersion: { type: Number, default: null },

    createdAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * Une version est unique pour un (code, projet). Sans cet index, deux
 * sauvegardes concurrentes lisant `version: 3` écriraient toutes deux une
 * « version 4 », et l'historique porterait deux contenus sous le même numéro.
 */
panelEmailTemplateVersionSchema.index(
  { templateCode: 1, projectId: 1, version: 1 },
  { unique: true, name: 'uniq_template_project_version' },
);
/** Consultation de l'historique : le plus récent d'abord. */
panelEmailTemplateVersionSchema.index(
  { templateCode: 1, projectId: 1, createdAt: -1 },
  { name: 'history_recent' },
);

export const PanelEmailTemplateVersion = mongoose.model(
  'PanelEmailTemplateVersion',
  panelEmailTemplateVersionSchema,
);
export default PanelEmailTemplateVersion;
