// REGISTRE CANONIQUE DES TEMPLATES — l’autorité du Panel (L8.3).
//
// ══ CE FICHIER EST UN DÉPLACEMENT D'AUTORITÉ, PAS UNE COPIE ══════════════════
//
// L8 a tranché : `TEMPLATE_AUTHORITIES.PANEL`. Le contenu des e-mails vit
// désormais ICI — versionné, validé, rendu par le Panel — et le corps envoyé à
// Brevo porte `subject` + `htmlContent`, jamais un `templateId` du fournisseur
// qui ferait sortir le contenu de nos versions.
//
// Ce module vient du dépôt PROJET (`backend/src/utils/emailTemplateRegistry.js`). Il n'est PAS
// dupliqué pour le plaisir : l'autorité change de côté, et le moteur suit le
// contenu qu'il rend. Le jour où l'envoi projet sera retiré (L10), l'exemplaire
// d'origine partira avec lui — c'est le sens du déplacement.
//
// Aucune règle n'a été assouplie au passage. Ce qui suit est le module éprouvé
// du projet, à l'identique sauf ses imports.

import { VARIABLE_TYPE, RETENTION_CLASS } from '../../utils/panelEmailTemplateConstants.js';

/**
 * Registre CANONIQUE des templates e-mail — hardcodé, code-first.
 *
 * ─── CE QUE LE CODE DÉTIENT, CE QUE LA BASE DÉTIENT ──────────────────────────
 *
 *   CODE (ce fichier)          │ BASE (EmailTemplate)
 *   ───────────────────────────┼──────────────────────────
 *   templateId                 │ name
 *   variables autorisées       │ description
 *   types des variables        │ subject
 *   caractère obligatoire      │ html
 *   valeurs par défaut         │ enabled
 *   données d'exemple          │ version
 *
 * Le Manager peut réécrire entièrement le contenu ; il ne peut NI inventer un
 * identifiant, NI inventer une variable. Les deux produiraient une erreur
 * silencieuse : un template que personne n'appelle, ou un trou à l'exécution.
 *
 * ─── LE TEMPLATE NE CONNAÎT JAMAIS LE DESTINATAIRE ───────────────────────────
 *
 * Aucune définition ne porte d'adresse. Le destinataire est résolu à l'exécution
 * par `recipientResolver` (cf. domainEventActionRegistry). Un même template peut
 * donc partir à des personnes différentes selon l'événement — et une adresse ne
 * peut pas se retrouver figée dans un contenu éditable depuis le Manager.
 *
 * ─── LES VALEURS NE SONT PAS ICI ─────────────────────────────────────────────
 *
 * `sampleVariables` sert UNIQUEMENT à l'aperçu et à l'envoi de test. Les valeurs
 * réelles sont fournies à l'exécution par la fonction métier (cf.
 * emailVariableResolvers). Aucune variable ne lit un objet arbitrairement.
 */

/**
 * @typedef {object} VariableDefinition
 * @property {string} key       Clé du placeholder (`{{contact.email}}`).
 * @property {string} label     Libellé Manager.
 * @property {string} description
 * @property {string} type      VARIABLE_TYPE — décide conversion ET échappement.
 * @property {boolean} required Le rendu échoue si elle manque.
 */

/**
 * @typedef {object} EmailTemplateDefinition
 * @property {string} templateId
 * @property {string} defaultName
 * @property {string} defaultDescription
 * @property {string} defaultSubject
 * @property {string} defaultHtml
 * @property {VariableDefinition[]} variables
 * @property {string} [retentionClass]
 * @property {Record<string, unknown>} sampleVariables Données FICTIVES (aperçu/test).
 */

const BRAND = '#111111';
const MUTED = '#71717a';
const BORDER = '#e4e4e7';

/**
 * Enveloppe HTML commune aux templates par défaut.
 *
 * Construite ici plutôt que recopiée quatre fois : la valeur STOCKÉE reste une
 * chaîne HTML complète et autonome, que le DEV peut réécrire de fond en comble.
 * Cette fonction ne sert qu'à produire le défaut — elle n'est jamais rejouée sur
 * un template personnalisé.
 *
 * Choix imposés par les clients e-mail (Outlook/Gmail) :
 *  - mise en page en `<table>`, pas en flexbox/grid ;
 *  - styles INLINE (Gmail supprime une partie du `<style>`) ;
 *  - `<style>` réservé aux requêtes média, seul moyen d'être responsive.
 */
function layout({ preheader, heading, bodyHtml, footerHtml = '' }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
  @media only screen and (max-width: 600px) {
    .wrap { width: 100% !important; }
    .pad { padding: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;">
        <tr>
          <td class="pad" style="padding:32px;">
            <h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:${BRAND};">${heading}</h1>
${bodyHtml}
          </td>
        </tr>
      </table>
${footerHtml ? `      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;">
        <tr>
          <td style="padding:16px 32px;font-size:12px;line-height:1.5;color:${MUTED};text-align:center;">
${footerHtml}
          </td>
        </tr>
      </table>` : ''}
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Ligne « libellé / valeur » d'un tableau récapitulatif. */
function row(label, value) {
  return `            <tr>
              <td style="padding:8px 0;font-size:14px;color:${MUTED};width:45%;">${label}</td>
              <td style="padding:8px 0;font-size:14px;color:${BRAND};font-weight:600;">${value}</td>
            </tr>`;
}

function button(label, urlPlaceholder) {
  return `            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
              <tr>
                <td style="background:${BRAND};border-radius:6px;">
                  <a href="${urlPlaceholder}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a>
                </td>
              </tr>
            </table>`;
}

/** @type {Record<string, EmailTemplateDefinition>} */
export const EMAIL_TEMPLATE_REGISTRY = Object.freeze({
  // ───────────────────────────────────────────────────────────────────────────
  PASSWORD_RESET_REQUEST: {
    templateId: 'PASSWORD_RESET_REQUEST',
    defaultName: 'Compte — réinitialisation du mot de passe',
    defaultDescription:
      "Envoyé quand un utilisateur demande la réinitialisation de son mot de passe. Contient un lien tokenisé à durée limitée et usage unique. Aucun mot de passe n'est jamais transmis.",
    defaultSubject: 'Réinitialisation de votre mot de passe — {{company.name}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du site.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'user.name', label: "Nom de l'utilisateur", description: "Nom du compte concerné (ou son adresse à défaut).", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'auth.resetUrl', label: 'Lien de réinitialisation', description: 'Lien tokenisé, à durée limitée et usage unique.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'auth.expiresMinutes', label: 'Validité (minutes)', description: 'Durée de validité du lien, en minutes.', type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'user.name': 'Jean Dupont (exemple)',
      'auth.resetUrl': 'https://manager.exemple.fr/reinitialiser-mot-de-passe?token=exemple',
      'auth.expiresMinutes': '60',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Réinitialisez votre mot de passe — lien valable {{auth.expiresMinutes}} minutes.',
        heading: 'Réinitialisation du mot de passe',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{user.name}},
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Une réinitialisation du mot de passe de votre compte {{company.name}} a été demandée.
              Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.
            </p>
${button('Réinitialiser mon mot de passe', '{{auth.resetUrl}}')}
            <p style="margin:24px 0 8px;font-size:13px;line-height:1.6;color:${MUTED};">
              Ce lien est valable {{auth.expiresMinutes}} minutes et ne peut être utilisé qu'une seule fois.
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
              Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail :
              votre mot de passe actuel reste inchangé.
            </p>
            <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">
              Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>{{auth.resetUrl}}
            </p>`,
        footerHtml: `            Message envoyé automatiquement par {{company.name}} — aucun mot de passe ne vous sera jamais demandé par e-mail.`,
      });
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  /**
   * L'ACTIVATION DU PREMIER ACCÈS D'ADMINISTRATION D'UN PROJET (LOT 2C).
   *
   * Jumeau de `PASSWORD_RESET_REQUEST` par la mécanique — lien tokenisé, durée
   * limitée, usage unique — et distinct par ce qu'il dit : son destinataire n'a
   * jamais eu de mot de passe. Le confondre avec une réinitialisation
   * demanderait à quelqu'un de retrouver un secret qui n'a jamais existé.
   *
   * Portée PROJECT (voir `panelEmailTemplateDefinitions.js`) : chaque projet
   * peut réécrire ce HTML sous son propre branding, et aucun ne peut inventer
   * une variable — le contrat ci-dessous est plateforme.
   */
  DEV_ACCOUNT_ACTIVATION: {
    templateId: 'DEV_ACCOUNT_ACTIVATION',
    defaultName: 'Compte — activation du premier accès',
    defaultDescription:
      "Envoyé à la création d'un compte d'administration sans mot de passe (duplication d'un projet, ou migration d'un compte hérité). Contient un lien tokenisé à durée limitée et usage unique, par lequel le titulaire CHOISIT son mot de passe. Aucun mot de passe n'est jamais transmis.",
    defaultSubject: 'Activez votre accès — {{company.name}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: 'Nom du projet', description: 'Identité du projet à administrer.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'user.name', label: 'Nom du destinataire', description: 'Nom du compte concerné (ou son adresse à défaut).', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'auth.activationUrl', label: "Lien d'activation", description: 'Lien tokenisé, à durée limitée et usage unique.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'auth.expiresMinutes', label: 'Validité (minutes)', description: 'Durée de validité du lien, en minutes.', type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'user.name': 'Jean Dupont (exemple)',
      'auth.activationUrl': 'https://manager.exemple.fr/activer-mon-compte?token=exemple',
      'auth.expiresMinutes': '60',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Choisissez votre mot de passe — lien valable {{auth.expiresMinutes}} minutes.',
        heading: 'Activez votre accès',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{user.name}},
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Un accès d'administration vient d'être ouvert à votre nom pour {{company.name}}.
              Il ne possède pas encore de mot de passe : cliquez ci-dessous pour choisir le vôtre.
            </p>
${button('Choisir mon mot de passe', '{{auth.activationUrl}}')}
            <p style="margin:24px 0 8px;font-size:13px;line-height:1.6;color:${MUTED};">
              Ce lien est valable {{auth.expiresMinutes}} minutes et ne peut être utilisé qu'une seule fois.
              Passé ce délai, demandez-en un nouveau depuis la page de connexion.
            </p>
            <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
              Si vous n'attendiez pas cet accès, ignorez cet e-mail : sans mot de passe,
              le compte reste inutilisable.
            </p>
            <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">
              Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>{{auth.activationUrl}}
            </p>`,
        footerHtml: `            Message envoyé automatiquement par {{company.name}} — aucun mot de passe ne vous sera jamais demandé par e-mail.`,
      });
    },
  },

  CONTACT_ADMIN_NOTIFICATION: {
    templateId: 'CONTACT_ADMIN_NOTIFICATION',
    defaultName: 'Contact — notification aux administrateurs',
    defaultDescription:
      "Prévient les administrateurs qu'une demande de contact a été déposée depuis le site. Le message est affiché tel quel, jamais interprété.",
    defaultSubject: 'Nouvelle demande de contact — {{contact.name}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: "Raison sociale du site ayant reçu la demande.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contact.name', label: 'Nom du contact', description: 'Nom saisi par le visiteur.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contact.email', label: 'E-mail du contact', description: 'Adresse saisie par le visiteur.', type: VARIABLE_TYPE.EMAIL, required: true },
      { key: 'contact.phone', label: 'Téléphone du contact', description: 'Téléphone saisi (facultatif).', type: VARIABLE_TYPE.PHONE, required: false },
      { key: 'contact.reason', label: 'Motif', description: 'Motif de la demande.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'contact.message', label: 'Message', description: 'Message libre. Rendu en texte : les retours à la ligne sont préservés, le HTML ne l’est pas.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contact.submittedAt', label: 'Date de dépôt', description: 'Date et heure de la soumission.', type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'contact.pageUrl', label: 'Page d’origine', description: 'URL de la page depuis laquelle le formulaire a été envoyé.', type: VARIABLE_TYPE.URL, required: false },
      { key: 'manager.contactSubmissionUrl', label: 'Lien Manager', description: 'Lien direct vers la demande dans le Manager.', type: VARIABLE_TYPE.URL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contact.name': 'Jean Dupont (exemple)',
      'contact.email': 'jean.dupont@exemple.fr',
      'contact.phone': '+33 6 12 34 56 78',
      'contact.reason': 'Demande de devis',
      'contact.message':
        "Bonjour,\n\nJe souhaite un devis pour la révision d'une Clio IV.\n\nCordialement,\nJean Dupont",
      'contact.submittedAt': '2026-07-17T12:32:00.000Z',
      'contact.pageUrl': 'https://exemple.fr/contact',
      'manager.contactSubmissionUrl': 'https://manager.exemple.fr/contacts/demo-1234',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Nouvelle demande de contact reçue depuis votre site.',
        heading: 'Nouvelle demande de contact',
        bodyHtml: `            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${BRAND};">
              Une demande de contact vient d'être déposée sur le site de {{company.name}}.
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
${row('Nom', '{{contact.name}}')}
${row('E-mail', '{{contact.email}}')}
${row('Téléphone', '{{contact.phone}}')}
${row('Motif', '{{contact.reason}}')}
${row('Reçue le', '{{contact.submittedAt}}')}
${row('Page', '{{contact.pageUrl}}')}
            </table>
            <p style="margin:24px 0 8px;font-size:14px;font-weight:600;color:${BRAND};">Message</p>
            <div style="padding:16px;background:#f4f4f5;border-radius:6px;font-size:14px;line-height:1.6;color:${BRAND};white-space:pre-line;">{{contact.message}}</div>
${button('Ouvrir dans le Manager', '{{manager.contactSubmissionUrl}}')}`,
        footerHtml: `            Message envoyé automatiquement par le site de {{company.name}}.<br>
            Répondez directement à {{contact.email}} pour joindre le demandeur.`,
      });
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  CONTRACT_CANCELLATION_ADMIN_CONFIRMATION: {
    templateId: 'CONTRACT_CANCELLATION_ADMIN_CONFIRMATION',
    defaultName: 'Résiliation — confirmation au client',
    defaultDescription:
      "Confirme à l'entreprise cliente la prise en compte de sa résiliation, et rappelle jusqu'à quand le service reste actif.",
    defaultSubject: 'Votre résiliation a été prise en compte — {{contract.reference}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Raison sociale du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat (CTR-AAAA-NNNN).', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.name', label: 'Nom du contrat', description: 'Nom donné au contrat.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'contract.cancelledAt', label: 'Date de la demande', description: 'Date et heure de la demande de résiliation.', type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'contract.currentPeriodEnd', label: 'Fin de période', description: 'Date jusqu’à laquelle le service reste actif.', type: VARIABLE_TYPE.DATE, required: true },
      { key: 'contract.cancelledBy', label: 'Demandé par', description: 'Auteur de la demande.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'subscription.amountExcludingTax', label: 'Montant HT', description: 'Montant HT de l’abonnement (centimes).', type: VARIABLE_TYPE.MONEY, required: false },
      { key: 'subscription.taxAmount', label: 'TVA', description: 'Montant de TVA (centimes).', type: VARIABLE_TYPE.MONEY, required: false },
      { key: 'subscription.amountIncludingTax', label: 'Montant TTC', description: 'Montant TTC de l’abonnement (centimes).', type: VARIABLE_TYPE.MONEY, required: false },
      { key: 'subscription.currency', label: 'Devise', description: 'Code ISO de la devise (EUR).', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'manager.contractUrl', label: 'Lien Manager', description: 'Lien vers le contrat dans le Manager.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom de l’entreprise développeur.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.supportEmail', label: 'Support', description: 'Adresse de support du prestataire.', type: VARIABLE_TYPE.EMAIL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contract.reference': 'CTR-2026-0042',
      'contract.name': 'Contrat de démonstration 2026',
      'contract.cancelledAt': '2026-07-17T12:32:00.000Z',
      'contract.currentPeriodEnd': '2026-08-31T21:59:59.000Z',
      'contract.cancelledBy': 'Marie Martin (exemple)',
      'subscription.amountExcludingTax': { amount: 9900, currency: 'EUR' },
      'subscription.taxAmount': { amount: 1980, currency: 'EUR' },
      'subscription.amountIncludingTax': { amount: 11880, currency: 'EUR' },
      'subscription.currency': 'EUR',
      'manager.contractUrl': 'https://manager.exemple.fr/contrat',
      'developer.companyName': 'Studio Démonstration',
      'developer.supportEmail': 'support@exemple.fr',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Votre résiliation est enregistrée. Votre service reste actif jusqu’à la fin de la période en cours.',
        heading: 'Votre résiliation est enregistrée',
        bodyHtml: `            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{company.name}},<br><br>
              Nous confirmons la prise en compte de votre demande de résiliation.
              <strong>Votre service reste pleinement actif jusqu'au {{contract.currentPeriodEnd}}</strong> :
              aucune interruption n'aura lieu avant cette date, et aucun nouveau prélèvement ne sera effectué.
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
${row('Contrat', '{{contract.reference}}')}
${row('Intitulé', '{{contract.name}}')}
${row('Demande enregistrée le', '{{contract.cancelledAt}}')}
${row('Demandée par', '{{contract.cancelledBy}}')}
${row('Service actif jusqu’au', '{{contract.currentPeriodEnd}}')}
${row('Abonnement HT', '{{subscription.amountExcludingTax}}')}
${row('TVA', '{{subscription.taxAmount}}')}
${row('Abonnement TTC', '{{subscription.amountIncludingTax}}')}
            </table>
${button('Voir mon contrat', '{{manager.contractUrl}}')}`,
        footerHtml: `            {{developer.companyName}} — une question ? Écrivez à {{developer.supportEmail}}.`,
      });
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  CONTRACT_CANCELLATION_DEV_NOTIFICATION: {
    templateId: 'CONTRACT_CANCELLATION_DEV_NOTIFICATION',
    defaultName: 'Résiliation — alerte équipe technique',
    defaultDescription:
      "Prévient l'équipe de développement qu'un client a demandé la résiliation de son contrat, avec la date de fin de service.",
    defaultSubject: 'Résiliation demandée — {{company.name}} ({{contract.reference}})',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: 'Client', description: 'Raison sociale du client résiliant.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'company.email', label: 'E-mail du client', description: 'Adresse de contact du client.', type: VARIABLE_TYPE.EMAIL, required: false },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.name', label: 'Nom du contrat', description: 'Nom donné au contrat.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'contract.cancelledAt', label: 'Date de la demande', description: 'Date et heure de la demande.', type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'contract.currentPeriodEnd', label: 'Fin de service', description: 'Date de fin effective du service.', type: VARIABLE_TYPE.DATE, required: true },
      { key: 'contract.cancelledBy', label: 'Demandé par', description: 'Auteur de la demande.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'subscription.amountExcludingTax', label: 'Montant HT', description: 'Montant HT (centimes).', type: VARIABLE_TYPE.MONEY, required: false },
      { key: 'subscription.taxAmount', label: 'TVA', description: 'Montant de TVA (centimes).', type: VARIABLE_TYPE.MONEY, required: false },
      { key: 'subscription.amountIncludingTax', label: 'Montant TTC', description: 'Montant TTC (centimes).', type: VARIABLE_TYPE.MONEY, required: false },
      { key: 'subscription.currency', label: 'Devise', description: 'Code ISO de la devise.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'manager.contractUrl', label: 'Lien Manager', description: 'Lien vers la fiche contrat (DEV).', type: VARIABLE_TYPE.URL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'company.email': 'contact@exemple.fr',
      'contract.reference': 'CTR-2026-0042',
      'contract.name': 'Contrat de démonstration 2026',
      'contract.cancelledAt': '2026-07-17T12:32:00.000Z',
      'contract.currentPeriodEnd': '2026-08-31T21:59:59.000Z',
      'contract.cancelledBy': 'Marie Martin (exemple)',
      'subscription.amountExcludingTax': { amount: 9900, currency: 'EUR' },
      'subscription.taxAmount': { amount: 1980, currency: 'EUR' },
      'subscription.amountIncludingTax': { amount: 11880, currency: 'EUR' },
      'subscription.currency': 'EUR',
      'manager.contractUrl': 'https://manager.exemple.fr/dev/contrats',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Un client a demandé la résiliation de son contrat.',
        heading: 'Résiliation demandée',
        bodyHtml: `            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${BRAND};">
              <strong>{{company.name}}</strong> a demandé la résiliation de son contrat.
              Le service reste actif jusqu'au <strong>{{contract.currentPeriodEnd}}</strong>.
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
${row('Client', '{{company.name}}')}
${row('Contact', '{{company.email}}')}
${row('Contrat', '{{contract.reference}}')}
${row('Intitulé', '{{contract.name}}')}
${row('Demandée le', '{{contract.cancelledAt}}')}
${row('Demandée par', '{{contract.cancelledBy}}')}
${row('Fin de service', '{{contract.currentPeriodEnd}}')}
${row('Abonnement HT', '{{subscription.amountExcludingTax}}')}
${row('TVA', '{{subscription.taxAmount}}')}
${row('Abonnement TTC', '{{subscription.amountIncludingTax}}')}
            </table>
${button('Ouvrir la fiche contrat', '{{manager.contractUrl}}')}`,
        footerHtml: `            Notification automatique — aucune action immédiate n'est requise.`,
      });
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  EMAIL_SENDER_VERIFICATION_TEST: {
    templateId: 'EMAIL_SENDER_VERIFICATION_TEST',
    defaultName: 'Test technique — vérification de la configuration',
    defaultDescription:
      "Sert UNIQUEMENT à prouver que la chaîne d'envoi fonctionne de bout en bout (clé Brevo, mode actif, expéditeur vérifié). N'est branché à aucun événement métier.",
    defaultSubject: 'Test de configuration e-mail — {{email.providerMode}}',
    retentionClass: RETENTION_CLASS.TRANSIENT,
    variables: [
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom de l’entreprise développeur.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'email.senderName', label: 'Nom expéditeur', description: 'Nom d’affichage utilisé pour cet envoi.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'email.senderAddress', label: 'Adresse expéditrice', description: 'Adresse From réellement utilisée.', type: VARIABLE_TYPE.EMAIL, required: true },
      { key: 'email.providerMode', label: 'Mode Brevo', description: 'Mode IntegratedAPI actif (TEST ou PROD).', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'email.sentAt', label: 'Date d’envoi', description: 'Date et heure de l’envoi de test.', type: VARIABLE_TYPE.DATETIME, required: true },
    ],
    sampleVariables: {
      'developer.companyName': 'Studio Démonstration',
      'email.senderName': 'Entreprise Démonstration',
      'email.senderAddress': 'contact@exemple.fr',
      'email.providerMode': 'TEST',
      'email.sentAt': '2026-07-17T12:32:00.000Z',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Votre configuration e-mail fonctionne : cet e-mail en est la preuve.',
        heading: 'Votre configuration e-mail fonctionne',
        bodyHtml: `            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${BRAND};">
              Si vous lisez ce message, la chaîne d'envoi est opérationnelle : la clé Brevo est
              acceptée, le mode est actif et l'adresse expéditrice est vérifiée.
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
${row('Expéditeur', '{{email.senderName}}')}
${row('Adresse', '{{email.senderAddress}}')}
${row('Mode Brevo', '{{email.providerMode}}')}
${row('Envoyé le', '{{email.sentAt}}')}
            </table>
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Cet e-mail est un test technique déclenché manuellement. Il n'est lié à aucun contrat
              ni à aucune demande client.
            </p>`,
        footerHtml: `            {{developer.companyName}} — test de configuration.`,
      });
    },
  },

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * L10.5 — LES DEUX MESSAGES D'UNE PRESTATION FACTURÉE.
   *
   * Deux templates et non un seul avec un drapeau : ce qu'on écrit à quelqu'un
   * la première fois et ce qu'on lui écrit la quatrième ne se ressemblent pas,
   * et un DEV doit pouvoir adoucir l'un sans toucher à l'autre.
   *
   * Aucun n'appelle Brevo lui-même. Ils sont RENDUS par l'autorité Panel puis
   * envoyés par la capacité `email.send_template`, comme tout message du parc
   * depuis L8.4C.
   * ───────────────────────────────────────────────────────────────────────────
   */
  PAYMENT_REQUEST_CREATED: {
    templateId: 'PAYMENT_REQUEST_CREATED',
    defaultName: 'Prestation — nouvelle demande de paiement',
    defaultDescription:
      "Envoyé quand une prestation ponctuelle est facturée au client. Contient le nom de la prestation, son montant et un lien vers l'espace de facturation, où le paiement se fait. Aucun lien de paiement direct n'est mis dans l'e-mail : il serait périssable.",
    defaultSubject: 'Nouvelle prestation à régler — {{payment.label}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du site du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.label', label: 'Nom de la prestation', description: 'Intitulé saisi par l’équipe.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.description', label: 'Description', description: 'Détail de la prestation. Peut être vide.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'payment.amount', label: 'Montant', description: 'Montant à régler, déjà formaté.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.url', label: 'Lien vers la facturation', description: 'Page « Facturation & abonnement » du Manager. Jamais un lien Stripe.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Votre société', description: 'Émetteur de la demande.', type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'payment.label': 'Ajout formulaire personnalisé',
      'payment.description': 'Développement et intégration du formulaire demandé.',
      'payment.amount': '500,00 €',
      'payment.url': 'https://manager.exemple.fr/factures',
      'developer.companyName': 'L.Y Solution',
    },
    get defaultHtml() {
      return layout({
        preheader: '{{payment.label}} — {{payment.amount}} à régler.',
        heading: 'Nouvelle prestation à régler',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour,
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Une prestation vient d'être ajoutée à votre espace de facturation.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:${BRAND};">{{payment.label}}</p>
                  <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:${MUTED};">{{payment.description}}</p>
                  <p style="margin:0;font-size:20px;font-weight:700;color:${BRAND};">{{payment.amount}}</p>
                </td>
              </tr>
            </table>
${button('Régler cette prestation', '{{payment.url}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Le règlement se fait depuis votre espace, par paiement sécurisé. Votre facture
              y sera disponible dès le paiement effectué.
            </p>`,
        footerHtml: '            {{developer.companyName}} — {{company.name}}.',
      });
    },
  },

  PAYMENT_REQUEST_REMINDER: {
    templateId: 'PAYMENT_REQUEST_REMINDER',
    defaultName: 'Prestation — relance de paiement',
    defaultDescription:
      "Envoyé automatiquement, à l'intervalle configuré sur la prestation, tant qu'elle n'est ni payée, ni annulée, ni échue. La relance s'arrête d'elle-même dès que l'un de ces états est atteint : aucune tâche n'a à être annulée.",
    defaultSubject: 'Rappel — {{payment.label}} reste à régler',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du site du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.label', label: 'Nom de la prestation', description: 'Intitulé saisi par l’équipe.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.amount', label: 'Montant', description: 'Montant à régler, déjà formaté.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.url', label: 'Lien vers la facturation', description: 'Page « Facturation & abonnement » du Manager.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'payment.issuedOn', label: 'Émise le', description: 'Date d’envoi de la demande, déjà formatée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.companyName', label: 'Votre société', description: 'Émetteur de la demande.', type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'payment.label': 'Ajout formulaire personnalisé',
      'payment.amount': '500,00 €',
      'payment.url': 'https://manager.exemple.fr/factures',
      'payment.issuedOn': '12 août 2026',
      'developer.companyName': 'L.Y Solution',
    },
    get defaultHtml() {
      return layout({
        preheader: '{{payment.label}} — {{payment.amount}} en attente de règlement.',
        heading: 'Une prestation reste à régler',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour,
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              La prestation ci-dessous, émise le {{payment.issuedOn}}, n'a pas encore été réglée.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:${BRAND};">{{payment.label}}</p>
                  <p style="margin:0;font-size:20px;font-weight:700;color:${BRAND};">{{payment.amount}}</p>
                </td>
              </tr>
            </table>
${button('Régler maintenant', '{{payment.url}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Si le règlement vient d'être effectué, ce message peut se croiser avec lui —
              dans ce cas, merci de ne pas en tenir compte.
            </p>`,
        footerHtml: '            {{developer.companyName}} — {{company.name}}.',
      });
    },
  },

  /* ───────────────────────────────────────────────────────────────────────────
   * L10.6B-2 — QUAND UN IMPAYÉ A RÉELLEMENT FERMÉ UN SITE.
   *
   * Deux modèles, deux publics, et ils ne disent pas la même chose :
   *
   *   · le CLIENT doit comprendre pourquoi son site ne répond plus et comment
   *     y remédier — c'est un message d'action ;
   *   · l'ÉQUIPE doit disposer du dossier — dates, montant, référence — pour
   *     décider quoi faire. C'est un message d'exploitation.
   *
   * Les fondre en un seul aurait donné soit un client noyé sous des détails
   * internes, soit une équipe privée de ce qu'il lui faut. Ils ne partent
   * qu'APRÈS confirmation réelle de la fermeture par le projet lui-même.
   *
   * Aucun des deux n'appelle Brevo : rendus par l'autorité Panel, envoyés par
   * `email.send_template`, comme tout message du parc depuis L8.4C.
   * ───────────────────────────────────────────────────────────────────────────
   */
  SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT: {
    templateId: 'SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT',
    defaultName: 'Impayé — site suspendu (client)',
    defaultDescription:
      "Envoyé aux administrateurs du projet APRÈS que le site a réellement été fermé pour un abonnement impayé — jamais à la simple demande de suspension. Explique la cause et renvoie vers l'espace de facturation. Aucun détail technique du prestataire de paiement.",
    defaultSubject: 'Votre site est suspendu — {{suspension.reasonLabel}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du site concerné.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'suspension.reasonLabel', label: 'Motif', description: 'Motif canonique, toujours « Défaut de paiement ». Jamais un message du prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'suspension.confirmedOn', label: 'Suspendu le', description: 'Date de fermeture confirmée par le site lui-même, déjà formatée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'billing.url', label: 'Lien vers la facturation', description: 'Page « Facturation & abonnement » du Manager. Jamais un lien du prestataire de paiement.', type: VARIABLE_TYPE.URL, required: false },
      { key: 'developer.companyName', label: 'Votre société', description: 'Émetteur du message.', type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'suspension.reasonLabel': 'Défaut de paiement',
      'suspension.confirmedOn': '13 août 2026',
      'billing.url': 'https://manager.exemple.fr/factures',
      'developer.companyName': 'L.Y Solution',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Votre site est temporairement suspendu — {{suspension.reasonLabel}}.',
        heading: 'Votre site est suspendu',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour,
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Le site de {{company.name}} a été suspendu le {{suspension.confirmedOn}}.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Motif', '{{suspension.reasonLabel}}')}
${row('Depuis le', '{{suspension.confirmedOn}}')}
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Un règlement d'abonnement n'a pas pu être encaissé. Dès que la situation
              sera régularisée, le site sera rétabli.
            </p>
${button('Voir ma facturation', '{{billing.url}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Si vous pensez qu'il s'agit d'une erreur, répondez à ce message : nous
              regarderons ensemble.
            </p>`,
        footerHtml: '            {{developer.companyName}} — {{company.name}}.',
      });
    },
  },

  SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM: {
    templateId: 'SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM',
    defaultName: 'Impayé — site suspendu (équipe)',
    defaultDescription:
      "Envoyé à l'équipe L.Y Solution quand la fermeture d'un site pour impayé est confirmée par le projet. Porte le dossier : identifiant stable, premier échec, échéance de grâce, date de confirmation. Aucune donnée n'est allée la chercher chez le prestataire de paiement — tout vient de l'incident local.",
    defaultSubject: 'Site suspendu pour impayé — {{project.name}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'project.name', label: 'Projet', description: 'Nom lisible du projet.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'project.id', label: 'Identifiant du projet', description: 'Identifiant stable, celui du registre.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'suspension.reasonLabel', label: 'Motif', description: 'Motif canonique, toujours « Défaut de paiement ».', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.firstFailedOn', label: 'Premier échec', description: 'Date du premier prélèvement refusé, déjà formatée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.graceDeadlineOn', label: 'Échéance de grâce', description: 'Date d’échéance. Vide si aucune politique n’était configurée.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'suspension.confirmedOn', label: 'Fermeture confirmée le', description: 'Date à laquelle le projet a confirmé la fermeture.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.amountDue', label: 'Montant dû', description: 'Montant de la facture impayée, déjà formaté. Vide si inconnu.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'incident.reference', label: 'Référence', description: 'Identifiant de l’incident. Jamais une référence du prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'project.name': 'Entreprise Démonstration',
      'project.id': 'entreprise-demonstration',
      'suspension.reasonLabel': 'Défaut de paiement',
      'incident.firstFailedOn': '1 août 2026',
      'incident.graceDeadlineOn': '8 août 2026',
      'suspension.confirmedOn': '13 août 2026',
      'incident.amountDue': '249,00 €',
      'incident.reference': '7f3c1a20-5b9e-4d11-9f42-8c0a1b2d3e4f',
    },
    get defaultHtml() {
      return layout({
        preheader: '{{project.name}} — fermeture confirmée pour impayé.',
        heading: 'Site suspendu pour impayé',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              La fermeture du site de <strong>{{project.name}}</strong> vient d'être
              confirmée par le projet lui-même.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Projet', '{{project.id}}')}
${row('Motif', '{{suspension.reasonLabel}}')}
${row('Premier échec', '{{incident.firstFailedOn}}')}
${row('Échéance de grâce', '{{incident.graceDeadlineOn}}')}
${row('Fermeture confirmée', '{{suspension.confirmedOn}}')}
${row('Montant dû', '{{incident.amountDue}}')}
${row('Incident', '{{incident.reference}}')}
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
              Les tentatives de prélèvement restent pilotées par le prestataire de
              paiement. Ce message constate une fermeture, il n'en déclenche aucune.
            </p>`,
        footerHtml: '            Notification interne — L.Y Solution.',
      });
    },
  },

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * L10.6 FINAL — LA SUSPENSION MANUELLE, ANNONCÉE AUX ADMINISTRATEURS.
   *
   * ══ POURQUOI IL N'EST PAS UN TROISIÈME MESSAGE D'IMPAYÉ ═══════════════════
   *
   * Les deux modèles ci-dessus annoncent une fermeture que le client peut LEVER
   * en réglant sa facture, et le renvoient vers sa facturation. Celui-ci
   * annonce une décision de NOTRE équipe : le client n'a aucune prise dessus,
   * et lui proposer de payer quoi que ce soit laisserait croire à un impayé
   * qui n'existe pas.
   *
   * ══ QUI LE DÉCLENCHE ═════════════════════════════════════════════════════
   *
   * Le PROJET, pas le Panel. Un développeur suspend depuis le Manager, et le
   * projet demande le verbe `email.send_template`. Le contenu, l'expéditeur et
   * la clé restent ici : le projet n'a jamais touché Brevo depuis L8.4C.
   *
   * ══ « Aucun » EST UNE VALEUR, PAS UN DÉFAUT D'AFFICHAGE ══════════════════
   *
   * `suspension.reason` est REQUIS et vaut « Aucun » quand personne n'a saisi
   * de motif. Le rendre facultatif aurait laissé une ligne vide dans le
   * tableau, que le lecteur aurait prise pour un bogue. La chaîne naît au rendu
   * côté projet ; aucune base ne la stocke.
   * ───────────────────────────────────────────────────────────────────────────
   */
  SITE_SUSPENDED_MANUAL_ADMIN: {
    templateId: 'SITE_SUSPENDED_MANUAL_ADMIN',
    defaultName: 'Suspension manuelle — information aux administrateurs',
    defaultDescription:
      "Prévient les administrateurs d'un projet que l'équipe technique a suspendu leur site à la main. Envoyé UNIQUEMENT si la case « notifier les administrateurs » a été cochée au moment de la suspension. Jamais utilisé pour une fermeture automatique — impayé et contrat ont leurs propres messages.",
    defaultSubject: 'Votre site est temporairement suspendu',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du site concerné.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'suspension.reason', label: 'Motif', description: 'Motif saisi par l’équipe technique. Vaut « Aucun » quand aucun motif n’a été communiqué — la chaîne n’est jamais persistée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'suspension.suspendedOn', label: 'Suspendu le', description: 'Date et heure de la suspension, déjà formatées par le projet.', type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'suspension.reason': 'Aucun',
      'suspension.suspendedOn': '13 août 2026 à 14:05',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Votre site est temporairement suspendu par l’équipe technique.',
        heading: 'Votre site est temporairement suspendu',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour,
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Le site de {{company.name}} a été suspendu par notre équipe technique
              le {{suspension.suspendedOn}}. Il n'est plus accessible à vos visiteurs
              pour le moment.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Motif', '{{suspension.reason}}')}
${row('Suspendu le', '{{suspension.suspendedOn}}')}
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
              Cette suspension a été décidée par notre équipe : aucune action n'est
              attendue de votre part, et aucun règlement n'est en cause. Nous vous
              préviendrons dès le rétablissement.
            </p>`,
        footerHtml: '            {{company.name}} — information technique.',
      });
    },
  },

  /**
   * L'E-MAIL DE TEST DE L'EXPÉDITEUR GLOBAL (R10.4).
   *
   * ── POURQUOI UN VRAI MODÈLE, ET PAS UN CORPS FABRIQUÉ À LA VOLÉE ──────────
   *
   * Parce que le test doit emprunter la chaîne RÉELLE. Un corps construit dans
   * le service de test contournerait la résolution de modèle, le rendu, la
   * validation des variables et le versionnement — c'est-à-dire quatre des
   * étapes qui peuvent casser un envoi de production. Le test réussirait alors
   * là où un envoi réel échouerait, ce qui est exactement l'inverse de ce qu'on
   * lui demande.
   *
   * ── CE QU'IL AFFICHE, ET POURQUOI ─────────────────────────────────────────
   *
   * L'expéditeur et l'environnement. Le destinataire tient dans sa main la
   * preuve de CE QUI A ÉTÉ RÉSOLU, sans avoir à croire l'écran qui l'a
   * déclenché. Aucun secret, aucun identifiant de compte, aucune URL interne :
   * ce message part chez un humain, et le contenu d'un e-mail voyage.
   */
  PANEL_EMAIL_SENDER_TEST: {
    templateId: 'PANEL_EMAIL_SENDER_TEST',
    defaultName: 'Panel — test de l’expéditeur global',
    defaultDescription:
      "Message envoyé depuis l'écran « Expéditeur e-mail » pour éprouver la chaîne d'envoi de bout en bout : configuration, modèle, capacité, coffre, fournisseur, puis webhook de livraison. Il ne concerne aucun projet et n'informe d'aucun événement métier.",
    defaultSubject: 'Test d’expédition — {{sender.name}}',
    /** Un test n'a aucune valeur au-delà de sa lecture immédiate. */
    retentionClass: RETENTION_CLASS.TRANSIENT,
    variables: [
      { key: 'sender.name', label: 'Nom d’expéditeur', description: 'Nom global résolu au moment de l’envoi.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'sender.email', label: 'Adresse d’expédition', description: 'Adresse globale résolue au moment de l’envoi.', type: VARIABLE_TYPE.EMAIL, required: true },
      { key: 'test.environment', label: 'Environnement', description: 'Monde fournisseur servi par ce Panel (TEST ou PROD).', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'test.requestedAt', label: 'Demandé le', description: 'Date et heure de la demande d’envoi.', type: VARIABLE_TYPE.DATETIME, required: true },
    ],
    sampleVariables: {
      'sender.name': 'L.Y Solution',
      'sender.email': 'support@exemple.fr',
      'test.environment': 'TEST',
      'test.requestedAt': '2026-08-13T12:32:00.000Z',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Test d’expédition — la chaîne d’envoi fonctionne.',
        heading: 'Test d’expédition',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Ce message confirme que la chaîne d'envoi du Panel fonctionne de bout
              en bout : configuration de l'expéditeur, modèle, capacité, coffre et
              fournisseur.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Expéditeur', '{{sender.name}}')}
${row('Adresse', '{{sender.email}}')}
${row('Environnement', '{{test.environment}}')}
${row('Demandé le', '{{test.requestedAt}}')}
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:13px;line-height:1.6;color:${MUTED};">
              Aucune action n'est attendue. Si vous recevez ce message sans l'avoir
              demandé, prévenez l'équipe technique.
            </p>`,
        footerHtml: '            Message de test — aucun contenu commercial.',
      });
    },
  },

  /* ═════════════════════════════════════════════════════════════════════════
     LE CYCLE DE VIE D'UN PAIEMENT, VU PAR LE CLIENT D'UN PROJET.

     ══ POURQUOI CES QUATRE CODES VIVENT ICI ═══════════════════════════════

     Le registre est PLATEFORME : un code que le Panel ne connaît pas ne peut
     pas partir, quelle que soit la qualité de sa déclaration côté projet.
     C'est la leçon d'une recette réelle — le modèle existait dans le projet,
     son résolveur produisait ses variables, le rendu passait, et l'envoi
     échouait en `CAPABILITY_INPUT_INVALID : Modèle inconnu`.

     ══ CE QU'ILS NE DOUBLENT PAS ══════════════════════════════════════════

     `SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT` parle APRÈS la fermeture, au nom
     de L.Y Solution. Ces quatre-là parlent AVANT, au nom du site : un
     encaissement confirmé, un prélèvement refusé, un dernier avertissement,
     une régularisation. Aucun instant n'est couvert deux fois.
     ═════════════════════════════════════════════════════════════════════════ */

  CONTRACT_PAYMENT_RECEIVED_ADMIN: {
    templateId: 'CONTRACT_PAYMENT_RECEIVED_ADMIN',
    defaultName: 'Paiement — encaissement confirmé au client',
    defaultDescription:
      "Confirme au client d'un projet que son règlement a bien été encaissé. Distinct du reçu du prestataire de paiement, qui prouve un débit sans dire ce qui a été acheté ni où retrouver son contrat.",
    defaultSubject: 'Paiement reçu — {{contract.reference}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat (CTR-AAAA-NNNN).', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.name', label: 'Nom du contrat', description: 'Nom donné au contrat.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'payment.amountIncludingTax', label: 'Montant TTC', description: 'Montant encaissé, en centimes.', type: VARIABLE_TYPE.MONEY, required: true },
      { key: 'payment.paidOn', label: 'Payé le', description: "Date et heure de l'encaissement constaté.", type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'payment.label', label: 'Objet du paiement', description: 'Ce qui a été réglé (frais de lancement, abonnement…).', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'manager.contractUrl', label: 'Lien Manager', description: 'Lien vers le contrat dans le Manager du projet.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom du prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.supportEmail', label: 'Support', description: 'Adresse de support du prestataire.', type: VARIABLE_TYPE.EMAIL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contract.reference': 'CTR-2026-0042',
      'contract.name': 'Contrat de démonstration 2026',
      'payment.amountIncludingTax': { amount: 1200, currency: 'EUR' },
      'payment.paidOn': '2026-08-18T15:58:49.000Z',
      'payment.label': 'Frais de lancement',
      'manager.contractUrl': 'https://manager.exemple.fr/contrat',
      'developer.companyName': 'Studio Démonstration',
      'developer.supportEmail': 'support@exemple.fr',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Votre règlement a bien été encaissé.',
        heading: 'Votre paiement est bien reçu',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{company.name}},
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Nous confirmons l'encaissement de votre règlement. Aucune action
              n'est attendue de votre part.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Objet', '{{payment.label}}')}
${row('Contrat', '{{contract.reference}}')}
${row('Intitulé', '{{contract.name}}')}
${row('Montant TTC', '{{payment.amountIncludingTax}}')}
${row('Payé le', '{{payment.paidOn}}')}
                  </table>
                </td>
              </tr>
            </table>
${button('Voir mon contrat', '{{manager.contractUrl}}')}`,
        footerHtml: '            {{developer.companyName}} — une question ? Écrivez à {{developer.supportEmail}}.',
      });
    },
  },

  CONTRACT_PAYMENT_OVERDUE_ADMIN: {
    templateId: 'CONTRACT_PAYMENT_OVERDUE_ADMIN',
    defaultName: 'Impayé — premier échec de prélèvement',
    defaultDescription:
      "Prévient le client qu'un prélèvement a échoué, PENDANT que son service fonctionne encore. Envoyé une seule fois à l'ouverture de l'incident : les tentatives suivantes appartiennent au prestataire de paiement, qui prévient déjà le porteur de la carte.",
    defaultSubject: 'Votre paiement n’a pas abouti — {{contract.reference}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.amountDue', label: 'Montant dû', description: 'Somme restant due, en centimes.', type: VARIABLE_TYPE.MONEY, required: true },
      { key: 'incident.invoiceNumber', label: 'Facture', description: 'Numéro de la facture concernée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.attemptCount', label: 'Tentatives', description: 'Nombre de tentatives observées.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.graceDeadline', label: 'Échéance', description: "Date jusqu'à laquelle le service reste assuré. Vaut une phrase explicite lorsqu'aucun délai n'est configuré.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'manager.billingUrl', label: 'Lien facturation', description: "Lien vers l'espace facturation du Manager.", type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom du prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.supportEmail', label: 'Support', description: 'Adresse de support du prestataire.', type: VARIABLE_TYPE.EMAIL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contract.reference': 'CTR-2026-0042',
      'incident.amountDue': { amount: 11880, currency: 'EUR' },
      'incident.invoiceNumber': 'QWSK7ZZY-0002',
      'incident.attemptCount': '1',
      'incident.graceDeadline': '24 août 2026',
      'manager.billingUrl': 'https://manager.exemple.fr/factures',
      'developer.companyName': 'Studio Démonstration',
      'developer.supportEmail': 'support@exemple.fr',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Un prélèvement n’a pas abouti — votre service fonctionne toujours.',
        heading: 'Votre paiement n’a pas abouti',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{company.name}},
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Un prélèvement n'a pas pu aboutir. <strong>Votre service fonctionne
              normalement</strong> : il vous reste le temps de régulariser.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Contrat', '{{contract.reference}}')}
${row('Facture', '{{incident.invoiceNumber}}')}
${row('Montant dû', '{{incident.amountDue}}')}
${row('Tentatives', '{{incident.attemptCount}}')}
${row('Service assuré jusqu’au', '{{incident.graceDeadline}}')}
                  </table>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:${MUTED};">
              La mise à jour de votre moyen de paiement suffit : la prochaine
              tentative est planifiée par notre prestataire de paiement.
            </p>
${button('Régulariser mon paiement', '{{manager.billingUrl}}')}`,
        footerHtml: '            {{developer.companyName}} — une question ? Écrivez à {{developer.supportEmail}}.',
      });
    },
  },

  CONTRACT_PAYMENT_OVERDUE_CRITICAL_ADMIN: {
    templateId: 'CONTRACT_PAYMENT_OVERDUE_CRITICAL_ADMIN',
    defaultName: 'Impayé — délai de grâce épuisé, action requise',
    defaultDescription:
      "Dernier avertissement avant fermeture : le délai de grâce est épuisé. « incident.serviceState » porte une phrase produite par le projet — elle n'affirme JAMAIS une fermeture qui n'a pas été confirmée.",
    defaultSubject: 'Action requise — votre service est menacé ({{contract.reference}})',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.amountDue', label: 'Montant dû', description: 'Somme restant due, en centimes.', type: VARIABLE_TYPE.MONEY, required: true },
      { key: 'incident.invoiceNumber', label: 'Facture', description: 'Numéro de la facture concernée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.graceDeadline', label: 'Échéance dépassée le', description: 'Date à laquelle le délai de grâce a expiré.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.serviceState', label: 'État du service', description: "Phrase EXACTE sur l'état du service. Distingue une suspension demandée d'une suspension confirmée : jamais une affirmation non prouvée.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'manager.billingUrl', label: 'Lien facturation', description: "Lien vers l'espace facturation du Manager.", type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom du prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.supportEmail', label: 'Support', description: 'Adresse de support du prestataire.', type: VARIABLE_TYPE.EMAIL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contract.reference': 'CTR-2026-0042',
      'incident.amountDue': { amount: 11880, currency: 'EUR' },
      'incident.invoiceNumber': 'QWSK7ZZY-0002',
      'incident.graceDeadline': '16 août 2026',
      'incident.serviceState': 'La suspension de votre site est en cours d’application.',
      'manager.billingUrl': 'https://manager.exemple.fr/factures',
      'developer.companyName': 'Studio Démonstration',
      'developer.supportEmail': 'support@exemple.fr',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Action requise — le délai accordé est dépassé.',
        heading: 'Votre service est menacé',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{company.name}},
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Le délai accordé pour régulariser votre règlement est dépassé.
              <strong>{{incident.serviceState}}</strong>
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Contrat', '{{contract.reference}}')}
${row('Facture', '{{incident.invoiceNumber}}')}
${row('Montant dû', '{{incident.amountDue}}')}
${row('Échéance dépassée le', '{{incident.graceDeadline}}')}
                  </table>
                </td>
              </tr>
            </table>
${button('Régulariser maintenant', '{{manager.billingUrl}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Dès réception du règlement, votre service est rétabli sans démarche
              supplémentaire.
            </p>`,
        footerHtml: '            {{developer.companyName}} — une question ? Écrivez à {{developer.supportEmail}}.',
      });
    },
  },

  /**
   * LA RELANCE — envoyée à CHAQUE nouvelle tentative réellement échouée.
   *
   * ══ CE QUI LA DISTINGUE DU PREMIER AVIS ══════════════════════════════════
   *
   * Le premier avis annonce une nouvelle. Celui-ci constate que la nouvelle
   * est restée sans effet, et compte ce qui reste de temps. Répéter le premier
   * texte à la troisième tentative dirait au client quelque chose qu'il sait
   * déjà, sans lui dire ce qui a changé — c'est-à-dire l'urgence.
   *
   * ══ LA PHRASE D'ÉCHÉANCE EST RÉDIGÉE PAR LE RÉSOLVEUR ════════════════════
   *
   * `incident.deadlineSentence` arrive tout écrit. Un contrat sans politique de
   * grâce n'a pas de date de fermeture : lui promettre « sans règlement avant
   * le … » serait une menace inventée. Un modèle n'a ni condition ni
   * branchement, et lui en demander produirait exactement le mensonge qu'on
   * cherche à éviter.
   *
   * ══ LE LIEN DE PAIEMENT EST CELUI DU PRESTATAIRE, QUAND IL EXISTE ════════
   *
   * `incident.paymentUrl` porte la page de facture hébergée par le prestataire
   * — celle qui permet de payer en trois clics avec une autre carte. À défaut,
   * le résolveur retombe sur l'espace facturation du Manager. Jamais une URL
   * fabriquée ici.
   */
  CONTRACT_PAYMENT_RETRY_FAILED_ADMIN: {
    templateId: 'CONTRACT_PAYMENT_RETRY_FAILED_ADMIN',
    defaultName: 'Impayé — relance après une nouvelle tentative échouée',
    defaultDescription:
      "Relance le client à chaque nouvelle tentative de prélèvement réellement refusée, entre le premier avis et l'échéance. Une tentative rejouée par le prestataire ne produit qu'un seul message : le compteur de tentatives fait foi.",
    defaultSubject: 'Rappel — votre paiement n’est toujours pas régularisé ({{contract.reference}})',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Raison sociale du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.amountDue', label: 'Montant restant dû', description: 'Somme restant à régler (centimes).', type: VARIABLE_TYPE.MONEY, required: true },
      { key: 'incident.purposeLabel', label: 'Prestation concernée', description: 'Ce que ce règlement paie — « votre abonnement », « les frais de lancement »…', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.invoiceNumber', label: 'Facture', description: 'Numéro de facture, ou « non communiqué ».', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.originalDueDate', label: 'Échéance d’origine', description: 'Date à laquelle le règlement était attendu.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.attemptCount', label: 'Tentatives', description: 'Nombre de tentatives observées chez le prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.deadlineSentence', label: 'Phrase d’échéance', description: 'Rédigée par le résolveur : annonce la date de suspension, ou son absence.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.paymentUrl', label: 'Lien de règlement', description: 'Page de paiement du prestataire, ou espace facturation du Manager.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom de l’entreprise développeur.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.supportEmail', label: 'Support', description: 'Adresse de support.', type: VARIABLE_TYPE.EMAIL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contract.reference': 'CTR-2026-0042',
      'incident.amountDue': { amount: 24900, currency: 'EUR' },
      'incident.purposeLabel': 'votre abonnement',
      'incident.invoiceNumber': 'QWSK7ZZY-0002',
      'incident.originalDueDate': '20 août 2026',
      'incident.attemptCount': '2',
      'incident.deadlineSentence':
        'Sans régularisation avant le 27 août 2026, votre site sera suspendu conformément aux conditions de votre contrat.',
      'incident.paymentUrl': 'https://facture.exemple.fr/i/test_ABC',
      'developer.companyName': 'Studio Démonstration',
      'developer.supportEmail': 'support@exemple.fr',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Une nouvelle tentative de prélèvement a été refusée.',
        heading: 'Votre paiement n’est toujours pas régularisé',
        bodyHtml: `            <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{company.name}},<br><br>
              Nous n’avons toujours pas reçu le règlement de
              <strong>{{incident.amountDue}}</strong> correspondant à
              {{incident.purposeLabel}}, dû le {{incident.originalDueDate}}.
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">
${row('Contrat', '{{contract.reference}}')}
${row('Facture concernée', '{{incident.invoiceNumber}}')}
${row('Montant restant dû', '{{incident.amountDue}}')}
${row('Échéance d’origine', '{{incident.originalDueDate}}')}
${row('Tentatives refusées', '{{incident.attemptCount}}')}
            </table>
            <p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:${BRAND};">
              {{incident.deadlineSentence}}
            </p>
${button('Régulariser mon paiement', '{{incident.paymentUrl}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              La cause la plus fréquente est une carte expirée ou un plafond atteint.
              Régler depuis le lien ci-dessus met fin immédiatement à la relance.
            </p>`,
        footerHtml: '            {{developer.companyName}} — une question ? Écrivez à {{developer.supportEmail}}.',
      });
    },
  },

  CONTRACT_PAYMENT_RECOVERED_ADMIN: {
    templateId: 'CONTRACT_PAYMENT_RECOVERED_ADMIN',
    defaultName: 'Impayé — régularisation confirmée',
    defaultDescription:
      "Referme le cycle : le règlement est passé. Sans ce message, un client averti deux fois d'un problème n'apprend jamais qu'il est résolu, et le dernier message qu'il conserve est une menace de fermeture.",
    defaultSubject: 'Paiement régularisé — {{contract.reference}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.amountDue', label: 'Montant régularisé', description: 'Somme régularisée, en centimes.', type: VARIABLE_TYPE.MONEY, required: true },
      { key: 'incident.resolvedOn', label: 'Régularisé le', description: 'Date de la régularisation.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.serviceState', label: 'État du service', description: "Phrase EXACTE : « rétabli » seulement si le site avait réellement été fermé, « resté accessible » sinon.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'manager.billingUrl', label: 'Lien facturation', description: "Lien vers l'espace facturation du Manager.", type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom du prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.supportEmail', label: 'Support', description: 'Adresse de support du prestataire.', type: VARIABLE_TYPE.EMAIL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contract.reference': 'CTR-2026-0042',
      'incident.amountDue': { amount: 11880, currency: 'EUR' },
      'incident.resolvedOn': '18 août 2026',
      'incident.serviceState': 'Votre site est de nouveau accessible.',
      'manager.billingUrl': 'https://manager.exemple.fr/factures',
      'developer.companyName': 'Studio Démonstration',
      'developer.supportEmail': 'support@exemple.fr',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Votre règlement est bien passé — l’incident est clos.',
        heading: 'Votre paiement est régularisé',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{company.name}},
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Votre règlement est bien passé et l'incident est clos.
              <strong>{{incident.serviceState}}</strong>
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Contrat', '{{contract.reference}}')}
${row('Montant régularisé', '{{incident.amountDue}}')}
${row('Régularisé le', '{{incident.resolvedOn}}')}
                  </table>
                </td>
              </tr>
            </table>
${button('Voir mes factures', '{{manager.billingUrl}}')}`,
        footerHtml: '            {{developer.companyName}} — merci de votre confiance. Une question ? {{developer.supportEmail}}',
      });
    },
  },

  /**
   * L'ALERTE TECHNIQUE — L.Y SOLUTION PARLE À SES DÉVELOPPEURS.
   *
   * ══ POURQUOI PANEL, ALORS QUE L'INCIDENT NAÎT DANS UN PROJET ═════════════
   *
   * Même raisonnement que `CONTRACT_CANCELLATION_DEV_NOTIFICATION` : la
   * propriété suit la COMMUNICATION, jamais l'origine des variables. Ici
   * l'émetteur est L.Y Solution, le destinataire est un développeur — natif du
   * projet ou fédéré — et le contenu nomme des composants internes. Rien de
   * tout cela n'appartient au client, et ce message ne doit jamais porter son
   * apparence.
   */
  PLATFORM_INCIDENT_DEV_ALERT: {
    templateId: 'PLATFORM_INCIDENT_DEV_ALERT',
    defaultName: 'Incident technique — alerte aux développeurs du projet',
    defaultDescription:
      "Alerte les développeurs responsables d'un projet — natifs ET fédérés — d'un incident technique DURABLE nécessitant une intervention. Jamais un journal d'erreurs : un échec transitoire qui se répare seul n'entre pas ici.",
    defaultSubject: '[{{incident.environment}}] Incident {{incident.kind}} — {{incident.component}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'incident.kind', label: 'Nature', description: "Famille d'incident (CAPABILITY_FAILURE, PANEL_PROJECTION_FAILURE, DEPLOYMENT_FAILURE, SERVICE_UNAVAILABLE).", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.component', label: 'Composant', description: 'Composant précis concerné.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.environment', label: 'Environnement', description: 'TEST ou PROD.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.occurrences', label: 'Occurrences', description: "Nombre de constats avant l'alerte.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.firstSeenOn', label: 'Premier constat', description: 'Date et heure du premier constat.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.errorCode', label: 'Code', description: "Code d'erreur stable.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.errorMessage', label: 'Message', description: "Message d'erreur borné — jamais une trace complète, jamais un secret.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'incident.summary', label: 'Résumé', description: 'Conséquence métier en une phrase.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'project.name', label: 'Projet', description: 'Projet concerné.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'manager.eventsUrl', label: 'Lien événements', description: 'Lien vers le journal des événements (vue DEV).', type: VARIABLE_TYPE.URL, required: true },
    ],
    sampleVariables: {
      'incident.kind': 'CAPABILITY_FAILURE',
      'incident.component': 'billing.checkout.create',
      'incident.environment': 'TEST',
      'incident.occurrences': '3',
      'incident.firstSeenOn': '18 août 2026 à 16:12',
      'incident.errorCode': 'BRIDGE_UNAVAILABLE',
      'incident.errorMessage': 'Le Panel n’a pas répondu après 3 tentatives.',
      'incident.summary': 'Une capacité du Panel est indisponible : les paiements ne peuvent plus être ouverts.',
      'project.name': 'Projet de démonstration',
      'manager.eventsUrl': 'https://manager.exemple.fr/dev/evenements',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Incident technique — une intervention est nécessaire.',
        heading: 'Incident technique',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              <strong>{{project.name}}</strong> — {{incident.summary}}
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Nature', '{{incident.kind}}')}
${row('Composant', '{{incident.component}}')}
${row('Environnement', '{{incident.environment}}')}
${row('Occurrences', '{{incident.occurrences}}')}
${row('Premier constat', '{{incident.firstSeenOn}}')}
${row('Code', '{{incident.errorCode}}')}
${row('Message', '{{incident.errorMessage}}')}
                  </table>
                </td>
              </tr>
            </table>
${button('Ouvrir le journal des événements', '{{manager.eventsUrl}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Cette alerte n'est émise que pour un incident DURABLE : une panne
              transitoire déjà réparée ne la déclenche pas.
            </p>`,
        footerHtml: '            Alerte technique automatique — destinée à l’équipe de développement.',
      });
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════════
     L12 — LA CONFIRMATION D'UN PAIEMENT, QUEL QU'IL SOIT.

     ══ POURQUOI UN SEUL MODÈLE POUR TOUS LES TYPES DE RÈGLEMENT ══════════

     Frais de lancement, abonnement, prestation ponctuelle : trois occasions, un
     seul message. La différence entre elles tient dans DEUX phrases — ce qui a
     été payé, et pour quelle période — et un modèle par type aurait produit trois
     textes à maintenir, trois relectures, trois occasions de diverger sur la
     même phrase de bas de page.

     `payment.kind` et `payment.period` portent cette différence. Le reste est
     rigoureusement identique, et c'est précisément ce qui justifie l'unicité.

     ══ POURQUOI `payment.invoiceUrl` EST OBLIGATOIRE ═══════════════════

     Parce qu'un bouton « Voir ma facture » qui ne mène nulle part est pire que
     pas de bouton du tout : le client clique, tombe sur une page vide, et doute
     du paiement qu'on vient de lui confirmer. En le déclarant OBLIGATOIRE, le
     contrat de variables refuse le message tant que le lien n'existe pas — le
     défaut devient un envoi manquant, visible et rejouable, jamais un envoi
     trompeur.

     Le lien pointe vers l'espace de facturation DU PROJET, jamais vers une
     adresse du prestataire de paiement : celles-ci sont signées et expirables,
     et le client les rouvrirait des mois plus tard sur une erreur.

     ══ CE MODÈLE REMPLACE `CONTRACT_PAYMENT_RECEIVED_ADMIN` ═════════════

     Lequel ne couvrait que les frais de lancement et ne portait aucun lien de
     facture. Il n'est pas supprimé — un code ne se supprime pas, son historique
     appartient aux projets qui l'ont utilisé — il cesse d'être déclaré par les
     projets. Voir docs/PROTOCOL.md § « RETIRER un modèle ».
     ══════════════════════════════════════════════════════════════════════════ */

  PAYMENT_CONFIRMED_ADMIN: {
    templateId: 'PAYMENT_CONFIRMED_ADMIN',
    defaultName: 'Paiement confirmé — au client du projet',
    defaultDescription:
      "Confirme au client d'un projet qu'un règlement a été encaissé, quel qu'en soit le type (frais de lancement, abonnement, prestation), et lui donne accès à sa facture. Distinct du reçu du prestataire de paiement, qui prouve un débit sans dire ce qui a été acheté.",
    defaultSubject: 'Paiement reçu — {{payment.kind}} — {{contract.reference}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'company.name', label: "Nom de l'entreprise", description: 'Identité du client.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.reference', label: 'Référence', description: 'Référence du contrat (CTR-AAAA-NNNN).', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'contract.name', label: 'Nom du contrat', description: 'Nom donné au contrat.', type: VARIABLE_TYPE.TEXT, required: false },
      { key: 'payment.kind', label: 'Type de paiement', description: "Ce qui a été réglé, en une expression : « Frais de lancement », « Abonnement ».", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.label', label: 'Objet du paiement', description: 'Libellé complet de la ligne réglée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.amountIncludingTax', label: 'Montant TTC', description: 'Montant encaissé, en centimes.', type: VARIABLE_TYPE.MONEY, required: true },
      { key: 'payment.paidOn', label: 'Payé le', description: "Date et heure de l'encaissement constaté.", type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'payment.period', label: 'Période couverte', description: "Période facturée, ou « paiement unique » lorsqu'il n'y en a pas.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.invoiceUrl', label: 'Lien facture', description: "Espace de facturation du client. OBLIGATOIRE : aucun message ne part sans facture consultable.", type: VARIABLE_TYPE.URL, required: true },
      { key: 'manager.contractUrl', label: 'Lien contrat', description: 'Lien vers le contrat dans le Manager du projet.', type: VARIABLE_TYPE.URL, required: true },
      { key: 'developer.companyName', label: 'Prestataire', description: 'Nom du prestataire.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'developer.supportEmail', label: 'Support', description: 'Adresse de support du prestataire.', type: VARIABLE_TYPE.EMAIL, required: true },
    ],
    sampleVariables: {
      'company.name': 'Entreprise Démonstration',
      'contract.reference': 'CTR-2026-0042',
      'contract.name': 'Contrat de démonstration 2026',
      'payment.kind': 'Abonnement',
      'payment.label': 'Abonnement mensuel — maintenance et hébergement',
      'payment.amountIncludingTax': { amount: 9599, currency: 'EUR' },
      'payment.paidOn': '2026-08-21T10:32:01.000Z',
      'payment.period': 'du 21 août 2026 au 21 septembre 2026',
      'payment.invoiceUrl': 'https://manager.exemple.fr/factures',
      'manager.contractUrl': 'https://manager.exemple.fr/contrat',
      'developer.companyName': 'Studio Démonstration',
      'developer.supportEmail': 'support@exemple.fr',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Votre règlement a bien été encaissé — votre facture est disponible.',
        heading: 'Votre paiement est bien reçu',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Bonjour {{company.name}},
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Nous confirmons l'encaissement de votre règlement. Aucune action
              n'est attendue de votre part.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Type', '{{payment.kind}}')}
${row('Objet', '{{payment.label}}')}
${row('Période', '{{payment.period}}')}
${row('Contrat', '{{contract.reference}}')}
${row('Intitulé', '{{contract.name}}')}
${row('Montant TTC', '{{payment.amountIncludingTax}}')}
${row('Payé le', '{{payment.paidOn}}')}
                  </table>
                </td>
              </tr>
            </table>
${button('Voir ma facture', '{{payment.invoiceUrl}}')}
            <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Vous retrouvez l'ensemble de votre dossier depuis
              <a href="{{manager.contractUrl}}" style="color:${BRAND};">votre contrat</a>.
            </p>`,
        footerHtml: '            {{developer.companyName}} — une question ? Écrivez à {{developer.supportEmail}}.',
      });
    },
  },

  /* ═══════════════════════════════════════════════════════════════════════════
     L12 — UN PROJET DU PARC A PAYÉ. De L.Y Solution à L.Y Solution.

     ══ POURQUOI PORTÉE `PANEL`, ET JAMAIS PROVISIONNÉ CHEZ UN PROJET ═══════

     Le critère est « QUI PARLE À QUI », et il ne souffre aucune ambiguïté ici :
     l'émetteur est le Panel, le destinataire est un exploitant de L.Y Solution,
     et le contenu nomme un CLIENT. En provisionner une instance chez chaque
     projet donnerait à chaque client le pouvoir d'éditer un message qui parle
     de lui à quelqu'un d'autre — et, accessoirement, autant de copies à
     maintenir que le parc compte de projets.

     ══ CE QU'IL DIT QUE LE LIVRET NE DIT PAS ════════════════════════

     Le registre financier montre l'encaissement à qui va le consulter. Ce
     message le PORTE : il arrive sans qu'on l'ait demandé, au moment où il se
     produit. C'est la seule façon d'apprendre qu'un client a payé sans ouvrir
     un écran toutes les heures.
     ══════════════════════════════════════════════════════════════════════════ */

  PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN: {
    templateId: 'PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN',
    defaultName: 'Encaissement — un projet du parc a payé',
    defaultDescription:
      "Prévient les SUPER_ADMIN du Panel qu'un règlement d'un projet du parc a été encaissé et projeté au registre financier. Porte le projet, le montant, le type de paiement et le lien vers le mouvement.",
    defaultSubject: '[{{payment.environment}}] {{project.name}} a payé {{payment.amountIncludingTax}} — {{payment.kind}}',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'project.name', label: 'Projet', description: 'Nom du projet qui a payé.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'project.id', label: 'Identifiant projet', description: 'Identifiant du projet au registre du Panel.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.kind', label: 'Type de paiement', description: "« Frais de lancement », « Abonnement », « Prestation »…", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.label', label: 'Libellé', description: 'Libellé du mouvement au registre financier.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'payment.amountIncludingTax', label: 'Montant', description: 'Montant encaissé, en centimes.', type: VARIABLE_TYPE.MONEY, required: true },
      { key: 'payment.paidOn', label: 'Encaissé le', description: 'Date et heure du règlement chez le fournisseur.', type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'payment.environment', label: 'Monde', description: 'TEST ou PROD — celui du runtime, jamais celui du corps reçu.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'transaction.id', label: 'Mouvement', description: 'Identifiant du mouvement au registre financier.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'transaction.url', label: 'Lien mouvement', description: "Lien vers le mouvement dans le Panel, d'où la facture se télécharge.", type: VARIABLE_TYPE.URL, required: true },
      { key: 'invoice.reference', label: 'Facture', description: "Numéro de la facture du fournisseur, ou « aucune » lorsqu'il n'en produit pas.", type: VARIABLE_TYPE.TEXT, required: true },
    ],
    sampleVariables: {
      'project.name': 'Projet de démonstration',
      'project.id': 'e43de003-c6ef-41ed-8ac7-72197f6abe59',
      'payment.kind': 'Abonnement',
      'payment.label': 'Abonnement — CTR-2026-0042',
      'payment.amountIncludingTax': { amount: 9599, currency: 'EUR' },
      'payment.paidOn': '2026-08-21T10:32:01.000Z',
      'payment.environment': 'TEST',
      'transaction.id': 'f4a800db-76bf-4e1d-8408-9c87830dab40',
      'transaction.url': 'https://panel.exemple.fr/finances',
      'invoice.reference': 'QWSK7ZZY-0004',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Un projet du parc vient de payer.',
        heading: 'Encaissement confirmé',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              <strong>{{project.name}}</strong> a réglé {{payment.amountIncludingTax}}.
              Le mouvement est inscrit au registre financier.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Projet', '{{project.name}}')}
${row('Type', '{{payment.kind}}')}
${row('Libellé', '{{payment.label}}')}
${row('Montant', '{{payment.amountIncludingTax}}')}
${row('Encaissé le', '{{payment.paidOn}}')}
${row('Monde', '{{payment.environment}}')}
${row('Facture', '{{invoice.reference}}')}
${row('Mouvement', '{{transaction.id}}')}
                  </table>
                </td>
              </tr>
            </table>
${button('Ouvrir le mouvement', '{{transaction.url}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Ce message est émis lorsque le fait fournisseur a été PROJETÉ au
              registre — jamais sur un retour de navigateur.
            </p>`,
        footerHtml: '            Notification interne L.Y Solution — {{project.id}}.',
      });
    },
  },

  /* ══════════════════════════════════════════════════════════════════════════
     LE PONT D'UN PROJET NE CONSOMME PLUS — et il ne le disait à personne.

     ══ POURQUOI CE MODÈLE EXISTE ═══════════════════════════════════════════

     Un projet du parc a tourné 91 cycles avec `applied: 0`, `lastError: null`
     et un état DEGRADED que rien ne lisait. Le seul mécanisme DURABLE de
     propagation Panel → projet était hors service, en silence, pendant des
     jours. Un écran l'aurait montré — encore aurait-il fallu que quelqu'un
     l'ouvre. Un message le PORTE.

     ══ POURQUOI IL EST DE PORTÉE PANEL ═════════════════════════════════════

     Le destinataire est un exploitant de L.Y Solution, et le contenu nomme des
     composants internes — un curseur, un journal, un rattrapage. Rien de tout
     cela n'appartient au client, et ce message ne porte jamais son apparence.
     Même raisonnement que `PLATFORM_INCIDENT_DEV_ALERT`.
     ══════════════════════════════════════════════════════════════════════════ */

  PROJECT_BRIDGE_DEGRADED_SUPER_ADMIN: {
    templateId: 'PROJECT_BRIDGE_DEGRADED_SUPER_ADMIN',
    defaultName: 'Pont — un projet ne consomme plus',
    defaultDescription:
      "Prévient les SUPER_ADMIN du Panel qu'un projet du parc ne consomme plus les écritures qui lui sont destinées : rattrapage en échec, écritures écartées, ou retard qui ne se résorbe pas. Ne part qu'après un seuil, et pas plus d'une fois par période de calme.",
    defaultSubject: '[{{bridge.environment}}] {{project.name}} — le pont ne consomme plus',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'project.name', label: 'Projet', description: 'Nom du projet concerné.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'project.id', label: 'Identifiant projet', description: 'Identifiant du projet au registre.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'bridge.environment', label: 'Monde', description: 'TEST ou PROD.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'bridge.summary', label: 'Constat', description: 'Ce qui ne va pas, en une phrase.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'bridge.pendingChanges', label: 'Écritures en attente', description: "Nombre d'écritures que le projet n'a pas consommées.", type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'bridge.backlogAgeMinutes', label: 'Âge du retard', description: 'Ancienneté, en minutes, de la plus ancienne écriture non consommée.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'bridge.since', label: 'Dégradé depuis', description: 'Depuis quand le Panel constate cette dégradation.', type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'bridge.url', label: 'Lien supervision', description: 'Lien vers la fiche de supervision du projet.', type: VARIABLE_TYPE.URL, required: true },
    ],
    sampleVariables: {
      'project.name': 'Projet de démonstration',
      'project.id': 'e43de003-c6ef-41ed-8ac7-72197f6abe59',
      'bridge.environment': 'TEST',
      'bridge.summary': '4 écriture(s) attendent d’être consommées, la plus ancienne depuis 62 minutes',
      'bridge.pendingChanges': '4',
      'bridge.backlogAgeMinutes': '62',
      'bridge.since': '2026-08-21T09:14:00.000Z',
      'bridge.url': 'https://panel.exemple.fr/supervision/e43de003-c6ef-41ed-8ac7-72197f6abe59',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Un projet ne consomme plus ce que le Panel lui envoie.',
        heading: 'Le pont d’un projet est dégradé',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              <strong>{{project.name}}</strong> répond au Panel, mais il ne consomme plus
              les écritures qui lui sont destinées : {{bridge.summary}}.
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              Le projet continue de fonctionner avec ce qu’il a déjà reçu — c’est
              l’autonomie qui le veut. Mais tout ce que le Panel publie depuis
              n’arrive plus : identité, contrat, entreprise cliente, prestations.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;">
              <tr>
                <td style="padding:16px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">
${row('Projet', '{{project.name}}')}
${row('Monde', '{{bridge.environment}}')}
${row('Écritures en attente', '{{bridge.pendingChanges}}')}
${row('Retard le plus ancien', '{{bridge.backlogAgeMinutes}} minutes')}
${row('Constaté depuis', '{{bridge.since}}')}
                  </table>
                </td>
              </tr>
            </table>
${button('Ouvrir la supervision', '{{bridge.url}}')}
            <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">
              Ce message ne se répète pas tant que la situation ne change pas.
              Un second message annoncera le rétablissement.
            </p>`,
        footerHtml: '            Notification interne L.Y Solution — {{project.id}}.',
      });
    },
  },

  /**
   * LE RÉTABLISSEMENT — et pourquoi il mérite son propre modèle.
   *
   * Sans lui, le dernier message qu'un exploitant conserverait d'un projet
   * serait une alerte. Il ouvrirait l'écran pour vérifier, à chaque fois, si
   * elle est encore vraie — c'est-à-dire exactement le travail que l'alerte
   * était censée lui épargner.
   *
   * Il est délibérément COURT : un rétablissement se lit en trois secondes.
   */
  PROJECT_BRIDGE_RECOVERED_SUPER_ADMIN: {
    templateId: 'PROJECT_BRIDGE_RECOVERED_SUPER_ADMIN',
    defaultName: 'Pont — un projet consomme à nouveau',
    defaultDescription:
      "Referme le cycle ouvert par l'alerte de dégradation : le projet consomme de nouveau les écritures du Panel. N'est envoyé que si une alerte a réellement été émise.",
    defaultSubject: '[{{bridge.environment}}] {{project.name}} — le pont consomme à nouveau',
    retentionClass: RETENTION_CLASS.OPERATIONAL,
    variables: [
      { key: 'project.name', label: 'Projet', description: 'Nom du projet concerné.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'project.id', label: 'Identifiant projet', description: 'Identifiant du projet au registre.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'bridge.environment', label: 'Monde', description: 'TEST ou PROD.', type: VARIABLE_TYPE.TEXT, required: true },
      { key: 'bridge.degradedSince', label: 'Dégradé depuis', description: 'Début de la dégradation.', type: VARIABLE_TYPE.DATETIME, required: true },
      { key: 'bridge.url', label: 'Lien supervision', description: 'Lien vers la fiche de supervision du projet.', type: VARIABLE_TYPE.URL, required: true },
    ],
    sampleVariables: {
      'project.name': 'Projet de démonstration',
      'project.id': 'e43de003-c6ef-41ed-8ac7-72197f6abe59',
      'bridge.environment': 'TEST',
      'bridge.degradedSince': '2026-08-21T09:14:00.000Z',
      'bridge.url': 'https://panel.exemple.fr/supervision/e43de003-c6ef-41ed-8ac7-72197f6abe59',
    },
    get defaultHtml() {
      return layout({
        preheader: 'Le pont d’un projet est rétabli.',
        heading: 'Le pont consomme à nouveau',
        bodyHtml: `            <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${BRAND};">
              <strong>{{project.name}}</strong> consomme de nouveau les écritures du Panel.
              Le retard signalé depuis {{bridge.degradedSince}} est résorbé.
            </p>
${button('Ouvrir la supervision', '{{bridge.url}}')}`,
        footerHtml: '            Notification interne L.Y Solution — {{project.id}}.',
      });
    },
  },
});


/** Identifiants connus. C'est la LISTE DE RÉFÉRENCE : la base n'en fait pas foi. */
export const EMAIL_TEMPLATE_IDS = Object.freeze(Object.keys(EMAIL_TEMPLATE_REGISTRY));

export function isKnownTemplateId(templateId) {
  return Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATE_REGISTRY, templateId);
}

/** Définition d'un template, ou `null`. Ne lève jamais — l'appelant décide. */
export function getTemplateDefinition(templateId) {
  return isKnownTemplateId(templateId) ? EMAIL_TEMPLATE_REGISTRY[templateId] : null;
}

/** Variables autorisées d'un template (tableau vide si inconnu). */
export function variablesFor(templateId) {
  return getTemplateDefinition(templateId)?.variables || [];
}

/** Ensemble des clés autorisées — pour une appartenance en O(1). */
export function allowedVariableKeys(templateId) {
  return new Set(variablesFor(templateId).map((v) => v.key));
}

/** Définition d'UNE variable d'un template, ou `null`. */
export function variableDefinition(templateId, key) {
  return variablesFor(templateId).find((v) => v.key === key) || null;
}

/**
 * Données d'exemple d'un template, sous forme de `Map`.
 *
 * Une `Map` et non un objet : elle n'a PAS de prototype, donc `get('__proto__')`
 * ou `get('constructor')` renvoient `undefined` au lieu d'une fonction native.
 * C'est la même protection que dans le renderer, appliquée à la source.
 */
export function sampleVariablesFor(templateId) {
  const def = getTemplateDefinition(templateId);
  if (!def) return new Map();
  return new Map(Object.entries(def.sampleVariables || {}));
}

/** Valeurs par défaut à écrire en base au bootstrap. */
export function defaultsFor(templateId) {
  const def = getTemplateDefinition(templateId);
  if (!def) return null;
  return {
    templateId: def.templateId,
    name: def.defaultName,
    description: def.defaultDescription,
    subject: def.defaultSubject,
    html: def.defaultHtml,
  };
}

/**
 * Cohérence du registre — exécutée par les tests.
 *
 * Vérifie ce qu'un humain casse en éditant ce fichier : une clé dupliquée, un
 * type inventé, une variable requise absente du HTML par défaut, une donnée
 * d'exemple manquante. Aucune de ces erreurs ne se verrait autrement avant
 * l'exécution.
 */
export function validateTemplateRegistry() {
  const problems = [];

  for (const [id, def] of Object.entries(EMAIL_TEMPLATE_REGISTRY)) {
    if (def.templateId !== id) {
      problems.push(`templateId incohérent : clé « ${id} », valeur « ${def.templateId} ».`);
    }
    for (const field of ['defaultName', 'defaultDescription', 'defaultSubject', 'defaultHtml']) {
      if (!def[field] || typeof def[field] !== 'string') {
        problems.push(`${id} : ${field} manquant ou non textuel.`);
      }
    }

    const keys = def.variables.map((v) => v.key);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (duplicates.length) {
      problems.push(`${id} : variable dupliquée — ${[...new Set(duplicates)].join(', ')}.`);
    }

    for (const v of def.variables) {
      if (!v.key) problems.push(`${id} : variable sans clé.`);
      if (!Object.values(VARIABLE_TYPE).includes(v.type)) {
        problems.push(`${id} : type inconnu pour « ${v.key} » — ${v.type}.`);
      }
      if (typeof v.required !== 'boolean') {
        problems.push(`${id} : « required » doit être explicite pour « ${v.key} ».`);
      }
      if (!v.label) problems.push(`${id} : libellé manquant pour « ${v.key} ».`);
      // Une variable sans donnée d'exemple casserait l'aperçu et l'envoi de test.
      if (!Object.prototype.hasOwnProperty.call(def.sampleVariables || {}, v.key)) {
        problems.push(`${id} : donnée d'exemple manquante pour « ${v.key} ».`);
      }
    }

    // Une variable REQUISE absente du HTML et du sujet par défaut est un signal
    // d'incohérence : soit elle n'est pas requise, soit le défaut l'oublie.
    const defaultContent = `${def.defaultSubject}\n${def.defaultHtml}`;
    for (const v of def.variables.filter((x) => x.required)) {
      if (!defaultContent.includes(`{{${v.key}}}`)) {
        problems.push(`${id} : variable requise « ${v.key} » absente du contenu par défaut.`);
      }
    }

    // Une donnée d'exemple sans variable correspondante est du code mort.
    for (const key of Object.keys(def.sampleVariables || {})) {
      if (!keys.includes(key)) {
        problems.push(`${id} : donnée d'exemple « ${key} » ne correspond à aucune variable.`);
      }
    }
  }

  return problems;
}

/** Introspection SÛRE pour les routes DEV (aucune valeur, aucun secret). */
export function describeTemplateRegistry() {
  return EMAIL_TEMPLATE_IDS.map((id) => {
    const def = EMAIL_TEMPLATE_REGISTRY[id];
    return {
      templateId: id,
      defaultName: def.defaultName,
      defaultDescription: def.defaultDescription,
      retentionClass: def.retentionClass || null,
      variables: def.variables.map((v) => ({
        key: v.key,
        label: v.label,
        description: v.description,
        type: v.type,
        required: v.required,
      })),
    };
  });
}

export default { EMAIL_TEMPLATE_REGISTRY, EMAIL_TEMPLATE_IDS, isKnownTemplateId, getTemplateDefinition };
