// Configuration système du Panel — document SINGLETON, même principe que le
// `SystemConfiguration` des Managers vitrines : les URLs publiques vivent en
// base (modifiables sans redéploiement), le `.env` ne porte qu'un repli.
// Voir docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md §3 (règle de priorité).
import mongoose from 'mongoose';

// Un champ non renseigné vaut null — « non configuré » doit rester
// distinguable de « configuré sur une valeur locale », sans quoi la règle
// de priorité du résolveur n'aurait plus de sens.
const networkSchema = new mongoose.Schema(
  {
    // URL publique du backend du Panel (API + pont) — c'est l'adresse que
    // les projets appellent.
    backendUrl: { type: String, default: null },
    // URL publique de l'interface du Panel — origine CORS de référence.
    frontendUrl: { type: String, default: null },
  },
  { _id: false },
);

/**
 * L'EXPÉDITEUR DE TOUT LE PARC — une seule adresse, un seul nom (R10.4).
 *
 * ── POURQUOI ICI, ET PAS PAR PROJET ─────────────────────────────────────────
 *
 * L8.3 donnait à chaque projet son identité expéditrice, avec un argument
 * sérieux : « chaque garage écrit à ses clients sous son propre nom ». Ce que
 * cet argument ratait, c'est que l'adresse d'expédition est aussi l'adresse de
 * SUPPORT — celle qui doit être surveillée, authentifiée SPF/DKIM sur un
 * domaine qu'on possède, et changée d'un seul geste le jour d'une migration.
 * Dispersée en N copies, elle n'était plus administrable : ouvrir un projet
 * demandait de saisir une adresse de plus, et la corriger partout demandait de
 * les retrouver toutes.
 *
 * Le besoin métier que L8.3 protégeait ne disparaît pas pour autant — il
 * change simplement de champ : le REPLY-TO reste par projet. Le message part
 * du support de la plateforme, la réponse arrive chez le garage. C'est la
 * séparation que RFC 5322 prévoit exactement pour ce cas.
 *
 * ── AUCUN SECRET, ET AUCUN LIEN AVEC LE COFFRE ──────────────────────────────
 *
 * Deux champs métier, lisibles, publics par nature — l'adresse figure dans
 * chaque e-mail envoyé. La clé Brevo, elle, vit dans le coffre chiffré et n'a
 * aucun rapport : le compte qui expédie et l'adresse au nom de laquelle on
 * expédie sont deux questions distinctes, et les confondre ferait dériver
 * l'expéditeur du credential — ce que R10.4 interdit explicitement.
 */
const emailSenderSchema = new mongoose.Schema(
  {
    /** Adresse support / `From`. `null` = jamais configurée, et l'envoi refuse. */
    senderEmail: { type: String, default: null, trim: true, lowercase: true },
    /** Nom affiché / `From name`. Sans lui, le destinataire voit l'adresse brute. */
    senderName: { type: String, default: null, trim: true, maxlength: 120 },
    updatedAt: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { _id: false },
);

const systemConfigurationSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'SINGLETON', unique: true },
    network: { type: networkSchema, default: () => ({}) },
    /**
     * L'expéditeur GLOBAL. Un seul document, un seul couple — c'est
     * l'invariant que `GLOBAL_PANEL_EMAIL_FROM_CONFIGURATION = 1` désigne.
     */
    email: { type: emailSenderSchema, default: () => ({}) },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, minimize: false, versionKey: false },
);

export default mongoose.model('SystemConfiguration', systemConfigurationSchema);
