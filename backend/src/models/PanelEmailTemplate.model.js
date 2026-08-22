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
//   contenu (sujet, HTML) → PAR PORTÉE. Depuis L11.1, la portée est EXPLICITE
//                           (`scopeType`) et il n'y a plus d'héritage : une
//                           instance PANEL porte le contenu de L.Y Solution,
//                           une instance PROJECT porte celui d'un projet, et
//                           l'absence d'une instance PROJECT est une ERREUR
//                           d'envoi — jamais un repli sur le contenu du Panel.
//
//                           Ce qui a changé, et pourquoi : `projectId: null`
//                           portait auparavant un « défaut de plateforme dont
//                           chaque projet hérite ». L'audit d'ownership a
//                           montré que l'héritage avait été livré sans jamais
//                           livrer la surface permettant de le rompre — donc
//                           que tout le parc partageait un document unique.
//                           Un héritage qu'aucune interface ne peut surcharger
//                           n'est pas un héritage : c'est une valeur unique.
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
     * LA PORTÉE, DÉCLARÉE (L11.1).
     *
     * Elle était déductible — `projectId === null` ⇒ plateforme — et c'était
     * précisément le problème : une déduction ne se lit pas dans un `find()`,
     * ne s'indexe pas comme une intention, et ne distingue pas un contenu
     * VOULU plateforme d'un contenu plateforme FAUTE DE MIEUX. Les deux
     * étaient rigoureusement indiscernables en base (audit §OWNERSHIP).
     *
     * `default: 'PANEL'` sert au seul backfill : les documents antérieurs
     * portent tous `projectId: null`, donc tous la portée PANEL. La
     * correspondance est totale et déterministe, et `assertScopeCoherent()`
     * la revérifie à chaque lecture comme à chaque écriture.
     */
    scopeType: {
      type: String,
      enum: ['PANEL', 'PROJECT'],
      required: true,
      default: 'PANEL',
    },

    /**
     * L'IDENTIFIANT DE PORTÉE — `null` pour PANEL, le projet pour PROJECT.
     *
     * Le nom n'a pas changé (il aurait pu devenir `scopeId`) : la seule portée
     * non-PANEL est un projet, et une migration de deux collections et de deux
     * index uniques pour gagner un mot aurait été un risque pour rien. La
     * traduction portée → colonnes vit dans `panelEmailTemplateScope.js`, en un
     * seul endroit, prête pour ce renommage le jour où il paiera.
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

    /**
     * ── L'ARCHIVE, ET POURQUOI CE N'EST PAS UNE SUPPRESSION (L12.1) ─────────
     *
     * Un projet cesse de déclarer un modèle : son instance ne doit plus être
     * présentée comme utilisable, ni servie à l'envoi. Jusqu'ici la
     * réconciliation se contentait de la RECENSER dans `removed` — elle restait
     * donc active, éditable, et affichée comme si elle partait encore.
     *
     * Trois issues étaient possibles. La suppression détruirait l'historique
     * d'édition d'un contenu réellement expédié — un exploitant qui enquête sur
     * un e-mail d'il y a six mois perdrait la seule trace de ce qui est parti.
     * La désactivation (`enabled: false`) mentirait sur la cause : « désactivé »
     * est une décision d'exploitant, or personne n'a rien décidé — c'est le
     * projet qui a cessé d'en avoir besoin.
     *
     * Reste l'archive : l'instance et son historique demeurent, elle disparaît
     * des listes actives, l'envoi la refuse, et la RAISON est écrite. Une
     * nouvelle déclaration la réveille telle qu'elle était.
     */
    archivedAt: { type: String, default: null },
    archivedReason: { type: String, default: '' },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);

/**
 * UNICITÉ — un seul contenu par (portée, code).
 *
 * Mongo traite deux `null` comme égaux dans un index unique : il ne peut donc
 * exister qu'UNE instance PANEL par code, ce qui est exactement la garantie
 * voulue. Sans cet index, deux instances concurrentes coexisteraient et le
 * rendu dépendrait de l'ordre de lecture.
 *
 * ── POURQUOI `scopeType` N'EST PAS DANS L'INDEX ─────────────────────────────
 *
 * Il serait redondant : `scopeType` est une FONCTION de `projectId`
 * (null ⇔ PANEL), invariant tenu par `assertScopeCoherent()`. L'index actuel
 * est donc déjà, terme pour terme, l'index cible `unique(scopeType, scopeId,
 * templateCode)` du lot. L'y ajouter n'ajouterait aucune garantie et
 * imposerait une reconstruction d'index en production pour rien.
 */
panelEmailTemplateSchema.index(
  { templateCode: 1, projectId: 1 },
  { unique: true, name: 'uniq_template_project' },
);

/**
 * PARCOURIR UNE PORTÉE — le catalogue scopé de l'éditeur.
 *
 * Non unique : c'est un index de LISTE. « Tous les modèles de SB Auto » est la
 * requête de l'écran d'édition scopé, et sans lui elle balaierait la collection
 * entière du parc à chaque ouverture.
 */
panelEmailTemplateSchema.index(
  { scopeType: 1, projectId: 1 },
  { name: 'scope_catalogue' },
);

export const PanelEmailTemplate = mongoose.model('PanelEmailTemplate', panelEmailTemplateSchema);
export default PanelEmailTemplate;
