// ADRESSE DE RÉPONSE D'UN PROJET — « à qui répond-on ? » (L8.3, réduit R10.4).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Expéditeurs ».
//
// ── TROIS QUESTIONS, TROIS AUTORITÉS, JAMAIS MÉLANGÉES ──────────────────────
//
//   AUTORITÉ DE CREDENTIAL   « avec quel compte Brevo parle-t-on ? »
//                            → une par ENVIRONNEMENT, dans le coffre chiffré,
//                              jamais visible d'un projet.
//
//   EXPÉDITEUR (`From`)      « au nom de qui écrit-on ? »
//                            → UNE SEULE, globale, dans
//                              `SystemConfiguration.email` (R10.4).
//
//   RÉPONSE (`Reply-To`)     « à qui la réponse arrive-t-elle ? »  ← CE MODÈLE
//                            → une par PROJET et par environnement, purement
//                              métier, sans aucun secret, parfaitement lisible.
//
// ── CE QUE R10.4 A DÉPLACÉ, ET CE QU'IL A PRÉSERVÉ ──────────────────────────
//
// L8.3 défendait ici un vrai besoin : « chaque garage écrit à ses clients sous
// son propre nom ». Ce besoin n'est pas abandonné, il change de champ. Le
// message part du support de la plateforme — une adresse qu'on possède, qu'on
// surveille, dont on maîtrise SPF et DKIM — et la réponse du client arrive chez
// le garage. `Reply-To` existe exactement pour cette séparation.
//
// Ce que L8.3 ratait, c'est que l'adresse d'expédition est aussi l'adresse de
// SUPPORT. Dispersée en N copies, elle n'était plus administrable : ouvrir un
// projet demandait d'en saisir une de plus, et la corriger partout demandait de
// les retrouver toutes.
//
// ── POURQUOI L'ENVIRONNEMENT COMPTE ENCORE ICI ──────────────────────────────
//
// Une recette ne doit pas router ses réponses vers la boîte réelle d'un client :
// un test mal ciblé y arriverait comme une vraie demande.
//
// ── AUCUN SECRET, PAR CONSTRUCTION ──────────────────────────────────────────
//
// `SENDER_IDENTITY_SHAPE.forbidden` (L8) nomme les champs qui n'ont rien à
// faire ici — `apiKey`, `webhookSecret`, `secretKey`… Le service les refuse à
// l'écriture. Si l'un d'eux apparaissait, il traverserait le pont le jour où un
// écran de projet afficherait sa configuration.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

const panelProjectSenderIdentitySchema = new mongoose.Schema(
  {
    /** Le projet AUTHENTIFIÉ, jamais celui que demanderait une charge utile. */
    projectId: { type: String, required: true },
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /**
     * ── CE QUI A DISPARU EN R10.4, ET POURQUOI ────────────────────────────────
     *
     * `fromEmail` et `fromName` vivaient ici. Ils vivent désormais UNE seule
     * fois, dans `SystemConfiguration.email` — voir
     * `services/email/panelGlobalSender.service.js`.
     *
     * Ce n'est pas l'abandon du besoin que L8.3 défendait (« chaque garage
     * écrit sous son propre nom »), c'est son déplacement vers le champ qui le
     * porte correctement : le REPLY-TO. Le message part du support de la
     * plateforme — une adresse qu'on possède, qu'on surveille, dont on maîtrise
     * SPF et DKIM — et la RÉPONSE arrive chez le projet. C'est précisément la
     * séparation que l'en-tête `Reply-To` existe pour exprimer.
     *
     * Les documents antérieurs peuvent encore porter les deux champs supprimés :
     * Mongo ne les efface pas, et le schéma ne les lit plus. Ils sont inertes,
     * et la purge est un geste d'exploitation, pas une migration bloquante.
     */

    /** À qui répondre. Distinct de l'expéditeur — et facultatif. */
    replyToEmail: { type: String, default: '', trim: true, lowercase: true },
    replyToName: { type: String, default: '', trim: true, maxlength: 120 },

    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * UNE identité par (projet, environnement).
 *
 * C'est ce qui rend « le projet A ne peut pas utiliser l'expéditeur de B »
 * vérifiable en base et non seulement en code : il n'existe pas d'identité
 * atteignable autrement que par le couple exact, et le service ne construit ce
 * couple qu'à partir du projet authentifié.
 */
panelProjectSenderIdentitySchema.index(
  { projectId: 1, environment: 1 },
  { unique: true, name: 'uniq_project_environment' },
);

export const PanelProjectSenderIdentity = mongoose.model(
  'PanelProjectSenderIdentity',
  panelProjectSenderIdentitySchema,
);
export default PanelProjectSenderIdentity;
