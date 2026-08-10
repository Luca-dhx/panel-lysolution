// REGISTRE CANONIQUE DES TEMPLATES — l’autorité du Panel (L8.3).
//
// ══ CE FICHIER EST UN DÉPLACEMENT D'AUTORITÉ, PAS UNE COPIE ══════════════════
//
// L8 a tranché : `TEMPLATE_AUTHORITIES.PANEL`. Le contenu des e-mails vit
// désormais ICI — versionné, validé, rendu par le Panel — et le corps envoyé à
// Brevo porte `subject` + `htmlContent`, jamais un `templateId` du fournisseur
// qui ferait sortir le contenu de nos versions.
//
// Ce module vient de `SB Auto 06/backend/src/utils/emailTemplateRegistry.js`. Il n'est PAS
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
      'company.name': 'Garage Démonstration',
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
      'company.name': 'Garage Démonstration',
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
      'company.name': 'Garage Démonstration',
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
      'company.name': 'Garage Démonstration',
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
      'email.senderName': 'SB Auto',
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
