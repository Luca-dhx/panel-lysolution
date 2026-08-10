// TEMPLATE E-MAIL DU PANEL — le contenu, et qui a le droit de le réécrire (L8.3).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Templates ».
//
// ── LA PORTÉE, ET POURQUOI CELLE-LÀ ─────────────────────────────────────────
//
// Trois portées étaient possibles. Le choix n'est pas neutre, et l'audit
// demandé par le lot le tranche champ par champ :
//
//   `templateCode`        → GLOBAL, code-first. L'ensemble des codes valides
//                           vit dans `panelEmailTemplateRegistry.js`. Rien en
//                           base ne peut en inventer un : un code inconnu
//                           produirait un template que personne n'appelle, ou
//                           un trou à l'exécution.
//
//   contenu (sujet, HTML) → PAR PROJET, avec un DÉFAUT DE PLATEFORME.
//                           Chaque garage écrit à ses clients sous son propre
//                           ton ; imposer un contenu unique à tout le parc
//                           serait techniquement plus simple et
//                           commercialement absurde. `projectId: null` porte
//                           le défaut, dont chaque projet hérite tant qu'il
//                           n'a rien réécrit.
//
//   environnement         → AUCUNE portée. C'est délibéré, et c'est la
//                           décision la plus discutable des trois, donc celle
//                           qui mérite d'être écrite : un contenu qui diffère
//                           entre TEST et PROD signifie qu'on ne relit jamais
//                           ce qu'on expédie. Le monde décide de la CLÉ et de
//                           l'EXPÉDITEUR — jamais du texte.
//
// ── CE MODÈLE NE FAIT PAS AUTORITÉ SUR CE QUI EXISTE ────────────────────────
//
// Un document dont le `templateCode` a disparu du registre reste en base : il
// n'est simplement plus servi. On ne l'efface pas — le contenu a été écrit par
// un humain, et un déploiement ne doit pas détruire son travail sans qu'il
// l'ait demandé.
//
// ── AUCUN DESTINATAIRE, JAMAIS ──────────────────────────────────────────────
//
// Il n'y a pas de champ d'adresse ici, et il ne doit jamais y en avoir. Le
// destinataire est fourni à l'exécution par le projet. L'écrire dans un
// template le rendrait modifiable depuis une interface web, et figerait dans
// du contenu ce qui est une décision métier.
import mongoose from 'mongoose';

import {
  MAX_SUBJECT_LENGTH,
  MAX_HTML_LENGTH,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from '../utils/panelEmailTemplateConstants.js';

const panelEmailTemplateSchema = new mongoose.Schema(
  {
    /** Code métier STABLE. Doit exister au registre — vérifié par le service. */
    templateCode: { type: String, required: true, trim: true },

    /**
     * `null` = le DÉFAUT DE PLATEFORME, celui dont hérite tout projet qui n'a
     * rien réécrit. Une valeur = la version propre à ce projet.
     */
    projectId: { type: String, default: null },

    name: { type: String, required: true, trim: true, maxlength: MAX_NAME_LENGTH },
    description: { type: String, default: '', trim: true, maxlength: MAX_DESCRIPTION_LENGTH },

    subject: { type: String, required: true, maxlength: MAX_SUBJECT_LENGTH },
    /** Document HTML complet, édité tel quel — jamais assemblé par blocs. */
    html: { type: String, required: true, maxlength: MAX_HTML_LENGTH },

    /**
     * Un template désactivé n'est JAMAIS rendu ni envoyé : l'exécution est
     * REFUSÉE, pas silencieusement ignorée. C'est l'interrupteur qui permet de
     * couper un e-mail sans toucher au code.
     */
    enabled: { type: Boolean, default: true },

    /** Incrémentée à chaque sauvegarde réussie. Sert aussi de jeton d'édition. */
    version: { type: Number, default: 1, min: 1 },

    updatedBy: { type: String, default: null },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * UNICITÉ — un seul contenu par (code, projet).
 *
 * Mongo traite deux `null` comme égaux dans un index unique : il ne peut donc
 * exister qu'UN défaut de plateforme par code, ce qui est exactement la
 * garantie voulue. Sans cet index, deux défauts concurrents coexisteraient et
 * le rendu dépendrait de l'ordre de lecture.
 */
panelEmailTemplateSchema.index(
  { templateCode: 1, projectId: 1 },
  { unique: true, name: 'uniq_template_project' },
);

export const PanelEmailTemplate = mongoose.model('PanelEmailTemplate', panelEmailTemplateSchema);
export default PanelEmailTemplate;
