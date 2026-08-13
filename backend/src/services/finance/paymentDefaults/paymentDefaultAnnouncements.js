/**
 * L10.6B-2 — CE QU'ON DIT UNE FOIS QU'UN IMPAYÉ A RÉELLEMENT FERMÉ UN SITE.
 *
 * ══ LES ANNONCES SONT UNE CONSÉQUENCE, JAMAIS UNE CONDITION ═════════════════
 *
 * Rien ici ne peut défaire une suspension. Aucune fonction de ce module
 * n'écrit sur `PanelPaymentDefault`, n'annule une confirmation, ne remet un
 * incident en `GRACE_EXPIRED`, ni ne rejoue une transition métier pour forcer
 * le départ d'un e-mail. Si Brevo est à terre, le site reste fermé, la
 * confirmation reste écrite, l'activité reste au journal — et l'envoi est
 * tracé en échec. C'est tout.
 *
 * ══ LE DÉCLENCHEUR, ET LUI SEUL ════════════════════════════════════════════
 *
 * Ce module n'est appelé qu'avec des incidents que `confirmFromSiteStatus`
 * vient de faire basculer ATOMIQUEMENT vers `suspensionConfirmedAt`. Ce n'est
 * ni `invoice.payment_failed`, ni `GRACE_EXPIRED`, ni `suspensionRequestedAt`,
 * ni l'émission de la cause : c'est le retour du projet, prouvant que le site
 * est réellement fermé.
 *
 * On ne lit JAMAIS `suspensionSource` : sous maintenance, la cause dominante
 * reste `TECHNICAL` alors que notre cause financière est bel et bien appliquée.
 * La preuve est `causes.paymentDefault`, et elle a déjà été faite en amont.
 *
 * ══ EXACTEMENT UNE FOIS, SANS INVENTER DE PRIMITIVE ════════════════════════
 *
 * Deux verrous se superposent, et aucun des deux n'est neuf :
 *
 *  1. LA TRANSITION. `findOneAndUpdate({suspensionConfirmedAt: null})` : un
 *     seul appelant gagne la bascule, donc un seul entre ici. Huit snapshots
 *     identiques ne produisent qu'une seule entrée dans ce module.
 *  2. L'ACTE D'ENVOI. `PanelCapabilityOperation` porte un index unique
 *     `(projectId, capability, operationId)`. Notre `operationId` est dérivé de
 *     l'INCIDENT, de la TRANSITION et du DESTINATAIRE — jamais d'une horloge,
 *     jamais d'un compteur recalculé. Rejoué, il rend `ALREADY_SENT` sans
 *     rien réenvoyer.
 */
import logger from '../../../utils/logger.js';
import registryStore from '../../registry/registryStore.js';
import { invokeCapability } from '../../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../capabilities/invocationContext.js';
import { EVENT_TYPES } from '../../../models/PanelSupervision.model.js';
import { recordEvent } from '../../supervision/timeline.service.js';
import {
  PanelProjectMember,
  PanelProjectPresentation,
} from '../../../models/PanelProjectProjection.model.js';
import PanelUser from '../../../models/PanelUser.model.js';

const CAPABILITY = 'email.send_template';

export const SUSPENSION_TEMPLATES = Object.freeze({
  CLIENT: 'SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT',
  TEAM: 'SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM',
});

/**
 * LE MOTIF CANONIQUE. Une seule chaîne, définie une seule fois.
 *
 * Jamais un message brut du prestataire de paiement : « Your card was
 * declined » n'est ni du français, ni une information que le client peut
 * exploiter, et il peut porter des détails qui ne le regardent pas.
 */
export const PAYMENT_DEFAULT_REASON = 'PAYMENT_DEFAULT';
export const PAYMENT_DEFAULT_REASON_LABEL = 'Défaut de paiement';

/** Les deux publics. Un `operationId` par incident ET par public. */
export const AUDIENCE = Object.freeze({ CLIENT: 'client', TEAM: 'team' });

/* -------------------------------------------------------------------------- */
/*  IDENTITÉ D'ACTE                                                           */
/* -------------------------------------------------------------------------- */

/**
 * L'identité durable d'un envoi — exportée parce que la recette doit pouvoir
 * la recalculer sans la deviner.
 *
 * `pd-susp` nomme la TRANSITION (suspension confirmée d'un défaut de
 * paiement) ; `paymentDefaultId` nomme l'INCIDENT ; `audience` et l'index
 * nomment le DESTINATAIRE LOGIQUE.
 *
 * Aucune horloge n'entre dans cette clé. Un `Date.now()` produirait un acte
 * neuf à chaque projection, et huit snapshots enverraient huit e-mails.
 */
export function suspensionOperationId(paymentDefaultId, audience, index = 0) {
  return `pd-susp-${paymentDefaultId}-${audience}-${index}`.slice(0, 64);
}

/* -------------------------------------------------------------------------- */
/*  DESTINATAIRES                                                             */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise, valide et DÉDUPLIQUE une liste d'adresses.
 *
 * ══ POURQUOI CETTE FONCTION EXISTE ═════════════════════════════════════════
 *
 * `resolveRecipients` de L10.5 ne déduplique pas : deux membres ADMIN
 * partageant une adresse recevaient deux fois le même message, avec deux
 * `operationId` distincts — l'index d'unicité ne pouvait rien y faire,
 * puisqu'il porte sur l'acte, pas sur l'adresse. Il faut trancher AVANT de
 * fabriquer les actes, donc ici.
 *
 * Une adresse invalide n'est pas une erreur : c'est un non-destinataire. On
 * ne fait pas échouer une annonce parce qu'une fiche est mal remplie.
 */
export function normalizeRecipients(candidats) {
  const vus = new Set();
  const sortie = [];
  for (const c of candidats) {
    const email = String(c?.email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) continue;
    if (vus.has(email)) continue;
    vus.add(email);
    const name = String(c?.name || '').trim();
    sortie.push(name ? { email, name } : { email });
  }
  return sortie;
}

/**
 * LES ADMINISTRATEURS DU PROJET — ceux du projet, publiés par lui.
 *
 * `PanelProjectMember` est une projection en lecture seule de ce que le projet
 * déclare : un gérant qui part cesse de recevoir les messages sans que
 * personne n'ait à y penser. Aucune liste parallèle n'est créée.
 *
 * Les comptes DEV sont exclus — ce sont des opérateurs techniques, souvent
 * nous. Repli sur l'adresse de contact publiée par le site.
 */
export async function resolveProjectAdmins(projectId) {
  const membres = await PanelProjectMember.find({ projectId, role: 'ADMIN' })
    .select('email name').lean();
  const admins = normalizeRecipients(membres);
  if (admins.length > 0) return admins;

  const presentation = await PanelProjectPresentation.findOne({ projectId })
    .select('contacts').lean();
  return normalizeRecipients([{ email: presentation?.contacts?.email }]);
}

/**
 * L'ÉQUIPE L.Y SOLUTION — les comptes réels du Panel.
 *
 * ══ AUCUNE ADRESSE EN DUR ══════════════════════════════════════════════════
 *
 * Une adresse écrite dans le code survit à la personne : elle continue de
 * recevoir des alertes après son départ, et le nouveau venu n'en reçoit
 * aucune. La liste se recalcule donc à chaque envoi depuis `PanelUser`.
 *
 * ══ SUR LES COMPTES « INACTIFS » ═══════════════════════════════════════════
 *
 * `PanelUser` ne porte ni `active`, ni `disabled`, ni `suspended` : un compte
 * existe ou n'existe pas. Aucun filtre n'est donc appliqué, et il ne faut pas
 * en inventer un — un champ créé ici serait ignoré partout ailleurs,
 * authentification comprise, et ferait croire à une désactivation qui n'existe
 * pas. Le jour où la notion apparaîtra, `activePanelUserFilter()` est le seul
 * point à modifier.
 *
 * Les deux rôles sont prévenus : un impayé qui ferme un site du parc est une
 * information d'exploitation, pas une information technique.
 */
export function activePanelUserFilter() {
  return {};
}

export async function resolvePanelTeam() {
  // `displayName` et non `name` : c'est le champ que porte réellement le
  // modèle. Lire un champ inexistant aurait produit des destinataires anonymes
  // sans que rien ne le signale.
  const comptes = await PanelUser.find(activePanelUserFilter())
    .select('email displayName').lean();
  return normalizeRecipients(comptes.map((c) => ({ email: c.email, name: c.displayName })));
}

/* -------------------------------------------------------------------------- */
/*  MISE EN FORME                                                             */
/* -------------------------------------------------------------------------- */

const dateFr = (valeur) => {
  if (!valeur) return '';
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris',
  }).format(d);
};

/**
 * Les montants sont déjà en CENTIMES ; la division par cent n'a lieu qu'ici,
 * au moment de l'affichage. Et le contrat de la capacité n'accepte que des
 * chaînes, des nombres ou des booléens : une variable monétaire structurée
 * serait refusée. On formate donc en amont.
 */
const montantFr = (cents, devise = 'EUR') => {
  if (!Number.isInteger(cents)) return '';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: devise })
    .format(cents / 100);
};

/**
 * L'espace de facturation du client. Repli sur l'accueil du Manager plutôt
 * qu'une adresse fabriquée : mieux vaut une page qui existe.
 *
 * JAMAIS un lien du prestataire de paiement — ils sont périssables, et le
 * client cliquerait sur une page morte des semaines plus tard.
 */
function billingUrlOf(panelProject) {
  const manager = panelProject?.network?.manager ?? panelProject?.publicBackendUrl ?? '';
  const base = String(manager).replace(/\/+$/, '');
  return base ? `${base}/factures` : '';
}

/* -------------------------------------------------------------------------- */
/*  ENVOI                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Un envoi, et ce qu'on en retient.
 *
 * ══ CE QU'ON FAIT DES DEUX ISSUES D'ÉCHEC (doctrine L8.4C) ═════════════════
 *
 * La passerelle distingue déjà, et nous ne redécidons rien :
 *
 *   PROVIDER_UNAVAILABLE   le fournisseur a répondu NON — rien n'est parti,
 *                          l'acte est marqué FAILED et reste rejouable ;
 *   TIMEOUT                l'issue est INDÉCIDABLE — le message a peut-être
 *                          été accepté. L'acte est marqué UNKNOWN et ne sera
 *                          JAMAIS rejoué automatiquement.
 *
 * Rejouer aveuglément un envoi indécidable enverrait un second e-mail à un
 * client qui vient d'en recevoir un. On préfère un trou visible à un doublon
 * invisible.
 */
async function envoyer({ panelProject, templateRef, recipient, variables, operationId }) {
  try {
    const res = await invokeCapability({
      code: CAPABILITY,
      panelProject,
      source: INVOCATION_SOURCES.PANEL_INTERNAL,
      payload: { templateRef, recipient, variables, operationId },
    });
    return { ok: true, status: res?.result?.status ?? 'ACCEPTED', operationId };
  } catch (err) {
    return {
      ok: false,
      operationId,
      errorCode: err?.code ?? 'UNKNOWN_ERROR',
      // `replaySafe` est déjà dérivé de l'issue par la passerelle : `false`
      // pour un timeout, `true` pour un refus franc. On le RELAIE, on ne le
      // recalcule pas.
      replaySafe: err?.replaySafe !== false,
    };
  }
}

/** Envoie à une audience entière, sans jamais laisser un échec en arrêter un autre. */
async function envoyerAudience({ panelProject, templateRef, destinataires, variables, incidentId, audience }) {
  const resultats = [];
  for (const [index, recipient] of destinataires.entries()) {
    // eslint-disable-next-line no-await-in-loop
    resultats.push(await envoyer({
      panelProject,
      templateRef,
      recipient,
      variables,
      operationId: suspensionOperationId(incidentId, audience, index),
    }));
  }
  const envoyes = resultats.filter((r) => r.ok).length;
  return { audience, attempted: resultats.length, sent: envoyes, failed: resultats.length - envoyes, resultats };
}

/* -------------------------------------------------------------------------- */
/*  POINT D'ENTRÉE                                                            */
/* -------------------------------------------------------------------------- */

/**
 * ANNONCE une ou plusieurs suspensions QUI VIENNENT D'ÊTRE CONFIRMÉES.
 *
 * L'ordre compte : l'ACTIVITÉ D'ABORD, les notifications ensuite. Le journal
 * d'exploitation est la trace que l'opérateur relira ; il ne doit pas dépendre
 * de la disponibilité d'un fournisseur d'e-mails.
 *
 * @param {{projectId: string, incidents: object[]}} entree
 */
export async function announceConfirmedSuspensions({ projectId, incidents }) {
  if (!Array.isArray(incidents) || incidents.length === 0) return { announced: 0 };

  const panelProject = await registryStore.getById(projectId);
  const nomProjet = panelProject?.name || panelProject?.displayName || projectId;

  const rapports = [];
  for (const incident of incidents) {
    /* ── 1. L'ACTIVITÉ, en premier et quoi qu'il arrive ──────────────────── */
    // eslint-disable-next-line no-await-in-loop
    await recordEvent({
      projectId,
      type: EVENT_TYPES.PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT,
      /**
       * CONSTAT, et non acte d'opérateur : le Panel n'a pas fermé ce site, il
       * a lu l'état que le projet a publié après l'avoir fermé lui-même.
       */
      source: 'PANEL_OBSERVATION',
      severity: 'WARNING',
      summary: `Site suspendu — ${PAYMENT_DEFAULT_REASON_LABEL}.`,
      data: {
        projectId,
        paymentDefaultId: incident.paymentDefaultId,
        reason: PAYMENT_DEFAULT_REASON,
        reasonLabel: PAYMENT_DEFAULT_REASON_LABEL,
        firstFailedAt: incident.firstFailedAt ?? null,
        graceDeadlineAt: incident.graceDeadlineAt ?? null,
        suspensionConfirmedAt: incident.suspensionConfirmedAt ?? null,
      },
      occurredAt: new Date(incident.suspensionConfirmedAt ?? Date.now()).toISOString(),
    }).catch((err) => {
      // Le journal ne doit pas non plus pouvoir casser la suite : les
      // notifications restent dues même si la chronologie est indisponible.
      logger.error(`[finance] activité de suspension non journalisée (${projectId}) — ${err?.message}`);
    });

    /* ── 2. LES NOTIFICATIONS ────────────────────────────────────────────── */
    // eslint-disable-next-line no-await-in-loop
    const [admins, equipe] = await Promise.all([
      resolveProjectAdmins(projectId).catch(() => []),
      resolvePanelTeam().catch(() => []),
    ]);

    const confirmeLe = dateFr(incident.suspensionConfirmedAt);

    const versClient = {
      'company.name': nomProjet,
      'suspension.reasonLabel': PAYMENT_DEFAULT_REASON_LABEL,
      'suspension.confirmedOn': confirmeLe,
      'developer.companyName': panelProject?.developerCompanyName || 'L.Y Solution',
    };
    const lienFacturation = billingUrlOf(panelProject);
    // Variable FACULTATIVE : absente plutôt que vide. Le renderer rend une
    // chaîne vide pour une facultative non fournie ; envoyer `''` dans une
    // variable de type URL la ferait en revanche échouer à la validation.
    if (lienFacturation) versClient['billing.url'] = lienFacturation;

    const versEquipe = {
      'project.name': nomProjet,
      'project.id': projectId,
      'suspension.reasonLabel': PAYMENT_DEFAULT_REASON_LABEL,
      'incident.firstFailedOn': dateFr(incident.firstFailedAt),
      'incident.graceDeadlineOn': dateFr(incident.graceDeadlineAt),
      'suspension.confirmedOn': confirmeLe,
      'incident.amountDue': montantFr(incident.amountDueCents, incident.currency || 'EUR'),
      'incident.reference': incident.paymentDefaultId,
    };

    /**
     * AUCUN DESTINATAIRE N'EST UN ÉTAT, PAS UNE ERREUR.
     *
     * Un projet sans administrateur joignable ne doit pas faire échouer
     * l'annonce : la suspension est confirmée, l'activité est écrite, et
     * l'équipe reste prévenue. On trace l'absence, on ne la subit pas.
     */
    // eslint-disable-next-line no-await-in-loop
    const [rapportClient, rapportEquipe] = await Promise.all([
      admins.length === 0
        ? Promise.resolve({ audience: AUDIENCE.CLIENT, attempted: 0, sent: 0, failed: 0, reason: 'NO_RECIPIENT' })
        : envoyerAudience({
          panelProject,
          templateRef: SUSPENSION_TEMPLATES.CLIENT,
          destinataires: admins,
          variables: versClient,
          incidentId: incident.paymentDefaultId,
          audience: AUDIENCE.CLIENT,
        }),
      equipe.length === 0
        ? Promise.resolve({ audience: AUDIENCE.TEAM, attempted: 0, sent: 0, failed: 0, reason: 'NO_RECIPIENT' })
        : envoyerAudience({
          panelProject,
          templateRef: SUSPENSION_TEMPLATES.TEAM,
          destinataires: equipe,
          variables: versEquipe,
          incidentId: incident.paymentDefaultId,
          audience: AUDIENCE.TEAM,
        }),
    ]);

    if (rapportClient.reason === 'NO_RECIPIENT') {
      logger.warn(
        `[finance] suspension confirmée pour ${projectId} — AUCUN administrateur joignable. `
        + "L'équipe est prévenue ; la suspension reste acquise.",
      );
    }

    rapports.push({
      paymentDefaultId: incident.paymentDefaultId,
      client: rapportClient,
      team: rapportEquipe,
    });
  }

  return { announced: rapports.length, rapports };
}

export default {
  announceConfirmedSuspensions,
  suspensionOperationId,
  resolveProjectAdmins,
  resolvePanelTeam,
  normalizeRecipients,
  activePanelUserFilter,
  SUSPENSION_TEMPLATES,
  PAYMENT_DEFAULT_REASON,
  PAYMENT_DEFAULT_REASON_LABEL,
  AUDIENCE,
};
