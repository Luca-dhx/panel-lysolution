// IDENTITÉ EXPÉDITRICE D'UN PROJET — « au nom de qui écrit-on ? » (L8.3).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Expéditeurs ».
//
// ── LA CONFUSION QUE CE MODÈLE REND IMPOSSIBLE ──────────────────────────────
//
//   AUTORITÉ DE CREDENTIAL   « avec quel compte Brevo parle-t-on ? »
//                            → une par ENVIRONNEMENT, dans le coffre chiffré,
//                              jamais visible d'un projet.
//
//   IDENTITÉ EXPÉDITRICE     « au nom de qui écrit-on ? »   ← CE MODÈLE
//                            → une par PROJET et par environnement, purement
//                              métier, sans aucun secret, parfaitement lisible.
//
// Centraliser la clé n'oblige en RIEN à uniformiser l'expéditeur. Un seul
// compte Brevo peut légitimement porter dix identités : chaque garage écrit à
// ses clients sous son propre nom. Les confondre produirait un plan de contrôle
// qui envoie tous les e-mails du parc depuis la même adresse — techniquement
// propre, commercialement absurde.
//
// ── POURQUOI L'ENVIRONNEMENT COMPTE ICI, ET PAS DANS LE TEMPLATE ────────────
//
// Le TEXTE d'un e-mail doit être identique en TEST et en PROD, sans quoi on ne
// relit jamais ce qu'on expédie. L'ADRESSE, elle, doit différer : une recette
// qui écrit depuis l'adresse de production abîme la réputation d'un domaine
// réel, et ses messages de test atterrissent chez de vrais clients si un
// destinataire fuit.
//
// ── AUCUN SECRET, PAR CONSTRUCTION ──────────────────────────────────────────
//
// `SENDER_IDENTITY_SHAPE.forbidden` (L8) nomme les champs qui n'ont rien à
// faire ici — `apiKey`, `webhookSecret`, `secretKey`… Le service les refuse à
// l'écriture. Si l'un d'eux apparaissait, il traverserait le pont le jour où un
// écran de projet afficherait son expéditeur.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

const panelProjectSenderIdentitySchema = new mongoose.Schema(
  {
    /** Le projet AUTHENTIFIÉ, jamais celui que demanderait une charge utile. */
    projectId: { type: String, required: true },
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    fromEmail: { type: String, required: true, trim: true, lowercase: true },
    fromName: { type: String, required: true, trim: true, maxlength: 120 },

    /** À qui répondre. Distinct de l'expéditeur — et facultatif. */
    replyToEmail: { type: String, default: '', trim: true, lowercase: true },
    replyToName: { type: String, default: '', trim: true, maxlength: 120 },

    /**
     * L'adresse est-elle reconnue par le fournisseur ?
     *
     * Un constat, pas une autorisation : Brevo refuse d'expédier depuis une
     * adresse non validée sur son compte. Le stocker permet de le DIRE avant
     * l'envoi plutôt que de le découvrir dans un refus fournisseur, dont le
     * message n'apprend rien à un exploitant.
     */
    verifiedAtProvider: { type: Boolean, default: false },
    verifiedAt: { type: String, default: null },

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
