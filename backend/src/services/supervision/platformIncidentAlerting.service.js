// L'ALERTE D'INCIDENT TECHNIQUE — décidée et expédiée par le control plane.
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Templates » / §« Supervision ».
//
// ── CE QUE CE FICHIER REMPLACE, ET POURQUOI ─────────────────────────────────
//
// Le projet envoyait lui-même cette alerte : son registre d'actions branchait
// `platform.incident.raised` sur le modèle `PLATFORM_INCIDENT_DEV_ALERT`, et
// demandait la capacité `email.send_template` avec ce code.
//
// Cet appel ne pouvait PAS aboutir, et l'audit l'a montré de bout en bout :
// le modèle est classé de portée PANEL — c'est une communication de
// L.Y Solution, elle nomme des composants internes et ne porte jamais
// l'apparence d'un client — donc le projet ne le déclarait pas, donc
// `renderForSend` opposait EMAIL_TEMPLATE_NOT_DECLARED_BY_PROJECT, et l'alerte
// finissait en livraison FAILED que personne ne lisait. Aucun incident
// technique n'a jamais pu partir de SB Auto.
//
// ── POURQUOI ON NE L'A PAS « RÉPARÉ » EN BASCULANT LE MODÈLE EN PROJECT ─────
//
// C'était le geste le plus court, et c'était le mauvais. Il aurait fait entrer
// une communication interne de L.Y Solution dans le catalogue éditable d'un
// client — pour la seule raison que l'appel partait de chez lui. L'ownership
// suit la COMMUNICATION (qui parle, à qui), jamais l'origine des faits ; c'est
// la règle que `TEMPLATE_OWNERSHIP` écrit noir sur blanc, et un contre-exemple
// posé pour faire passer un appel l'aurait vidée de son sens.
//
// Le projet RAPPORTE donc un fait ; ce service décide s'il alerte, qui il
// alerte, et avec quel contenu. Le projet ne nomme aucun modèle.
//
// ── LE DESTINATAIRE, ET POURQUOI IL EST RÉSOLU ICI ──────────────────────────
//
// Les développeurs d'un projet sont connus du Panel par la projection
// `PanelProjectMember` (rôle DEV), que le projet pousse déjà. Quand elle est
// vide — projet neuf, équipe entièrement fédérée — l'alerte remonte aux
// SUPER_ADMIN du Panel plutôt que de se perdre : une panne durable sans
// destinataire est exactement la situation où le silence coûte le plus cher.

import crypto from 'node:crypto';

import logger from '../../utils/logger.js';
import PanelProject from '../../models/PanelProject.model.js';
import { PanelProjectMember } from '../../models/PanelProjectProjection.model.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import { recordEvent } from './timeline.service.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { resolveFrontendUrl } from '../network/networkConfig.service.js';
import { invokeCapability } from '../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../capabilities/invocationContext.js';
import { resolvePanelSuperAdmins } from '../finance/providerRevenue/paymentConfirmationAnnouncements.js';

const CAPABILITY = 'email.send_template';
export const INCIDENT_TEMPLATE = 'PLATFORM_INCIDENT_DEV_ALERT';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Une phrase par famille de panne — écrite ICI, pas côté projet.
 *
 * Le projet envoie un `kind` d'un vocabulaire fermé ; la formulation appartient
 * à celui qui parle. Laisser le projet rédiger le résumé aurait remis dans un
 * e-mail de L.Y Solution une phrase écrite ailleurs, et potentiellement un
 * fragment d'exception.
 */
const SUMMARY_BY_KIND = Object.freeze({
  CAPABILITY_FAILURE:
    'Une capacité de la plateforme est indisponible pour ce projet : les opérations qui en dépendent échouent.',
  PANEL_PROJECTION_FAILURE:
    'Une projection vers la plateforme est refusée de façon durable : les données du projet ne remontent plus.',
  DEPLOYMENT_FAILURE:
    'Un déploiement de ce projet a échoué de façon durable et demande une intervention.',
  SERVICE_UNAVAILABLE:
    'Un service dont ce projet dépend est indisponible de façon durable.',
});

const KIND_LABEL = Object.freeze({
  CAPABILITY_FAILURE: 'Capacité indisponible',
  PANEL_PROJECTION_FAILURE: 'Projection refusée',
  DEPLOYMENT_FAILURE: 'Déploiement en échec',
  SERVICE_UNAVAILABLE: 'Service indisponible',
});

/**
 * L'identité de l'ACTE, dérivée des faits — pas un UUID neuf à chaque passage.
 *
 * Un incident rejoué (file durable, rattrapage au pull) doit converger sur le
 * même envoi. `firstSeenAt` + composant + occurrences décrivent exactement un
 * palier d'alerte : deux rapports identiques ne produisent qu'un message.
 */
export function incidentOperationId({ projectId, component, firstSeenAt, occurrences }) {
  /**
   * ── POURQUOI UNE EMPREINTE, ET NON LA CONCATÉNATION TRONQUÉE ──────────────
   *
   * La première version concaténait les quatre faits puis coupait à 64
   * caractères — la borne du contrat. Avec un `projectId` en UUID (36
   * caractères) et un composant nommé, la coupe tombait AVANT le palier
   * d'occurrences : deux paliers distincts produisaient le même identifiant,
   * et la seconde alerte — celle qui dit « ça empire » — était silencieusement
   * absorbée comme un doublon.
   *
   * Le hachage garde les quatre faits significatifs quelle que soit leur
   * longueur, et tient dans la borne par construction. Le préfixe lisible reste
   * là pour qu'un identifiant croisé dans un journal se reconnaisse.
   */
  const empreinte = crypto
    .createHash('sha256')
    .update([projectId, component, firstSeenAt, occurrences].join('|'))
    .digest('hex')
    .slice(0, 40);
  return `incident-${empreinte}`;
}

async function eventsUrlFor(projectId) {
  const { url } = await resolveFrontendUrl().catch(() => ({ url: null }));
  if (!url) return null;
  return `${String(url).replace(/\/+$/, '')}/supervision/${encodeURIComponent(projectId)}`;
}

/**
 * À QUI l'alerte s'adresse. Les développeurs du projet d'abord ; les
 * exploitants du Panel en dernier recours.
 */
export async function resolveIncidentRecipients(projectId) {
  const membres = await PanelProjectMember
    .find({ projectId, role: 'DEV' })
    .select('email name')
    .lean();

  const vus = new Set();
  const sortie = [];
  for (const membre of membres) {
    const email = String(membre?.email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email) || vus.has(email)) continue;
    vus.add(email);
    const name = String(membre?.name || '').trim();
    sortie.push(name ? { email, name } : { email });
  }
  if (sortie.length) return { recipients: sortie, source: 'PROJECT_DEV_MEMBERS' };

  const exploitants = await resolvePanelSuperAdmins();
  return { recipients: exploitants, source: 'PANEL_SUPER_ADMINS' };
}

function formatFirstSeen(value) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

/**
 * Traite un incident rapporté par un projet.
 *
 * NE LÈVE JAMAIS : un incident mal expédié ne doit pas faire échouer la
 * synchronisation qui l'a apporté — le projet le rejouerait indéfiniment, et
 * une panne d'e-mail deviendrait une panne de pont.
 */
export async function handleProjectIncident({ projectId, incident }) {
  try {
    const project = await PanelProject.findOne({ projectId }).select('projectName').lean();
    const projectName = project?.projectName || projectId;

    await recordEvent({
      projectId,
      type: EVENT_TYPES.PLATFORM_INCIDENT_RAISED,
      source: 'PROJECT',
      severity: 'WARNING',
      summary: `${KIND_LABEL[incident.kind] ?? incident.kind} — ${incident.component} `
        + `(${incident.occurrences} occurrence${incident.occurrences > 1 ? 's' : ''}).`,
      data: {
        kind: incident.kind,
        component: incident.component,
        environment: incident.environment,
        occurrences: incident.occurrences,
        firstSeenAt: incident.firstSeenAt,
        errorCode: incident.error?.code ?? '',
      },
    }).catch(() => null);

    const { recipients, source } = await resolveIncidentRecipients(projectId);
    if (!recipients.length) {
      logger.warn(
        `[incident] ${projectId} — aucun destinataire exploitable : l'incident est inscrit `
        + 'au suivi, mais personne n\'est prévenu par e-mail.',
      );
      return { notified: false, reason: 'NO_RECIPIENT', recipients: 0 };
    }

    const eventsUrl = await eventsUrlFor(projectId);
    if (!eventsUrl) {
      logger.warn(
        `[incident] ${projectId} — aucune URL de supervision résolue : l'alerte n'est pas `
        + 'expédiée (le modèle exige un lien, et un lien inventé ne mène nulle part).',
      );
      return { notified: false, reason: 'NO_EVENTS_URL', recipients: recipients.length };
    }

    const variables = {
      'incident.kind': KIND_LABEL[incident.kind] ?? incident.kind,
      'incident.component': incident.component,
      'incident.environment': incident.environment,
      'incident.occurrences': String(incident.occurrences),
      'incident.firstSeenOn': formatFirstSeen(incident.firstSeenAt),
      'incident.errorCode': incident.error?.code || 'INCONNU',
      'incident.errorMessage': incident.error?.message || 'Aucun détail transmis.',
      'incident.summary': SUMMARY_BY_KIND[incident.kind] ?? SUMMARY_BY_KIND.SERVICE_UNAVAILABLE,
      'project.name': projectName,
      'manager.eventsUrl': eventsUrl,
    };

    const resultats = [];
    for (let index = 0; index < recipients.length; index += 1) {
      const recipient = recipients[index];
      const operationId = incidentOperationId({
        projectId,
        component: incident.component,
        firstSeenAt: incident.firstSeenAt,
        occurrences: `${incident.occurrences}-${index}`,
      });
      try {
        // eslint-disable-next-line no-await-in-loop
        await invokeCapability({
          code: CAPABILITY,
          // PANEL_SELF : la portée d'invocation est PANEL, donc le modèle résolu
          // est l'instance PANEL. C'est tout le point du lot.
          source: INVOCATION_SOURCES.PANEL_SELF,
          payload: { templateRef: INCIDENT_TEMPLATE, recipient, variables, operationId },
        });
        resultats.push({ recipient: recipient.email, ok: true });
      } catch (err) {
        resultats.push({ recipient: recipient.email, ok: false, errorCode: err?.code ?? 'UNKNOWN_ERROR' });
      }
    }

    const envoyes = resultats.filter((r) => r.ok).length;
    logger.info(
      `[incident] ${projectId} — ${incident.kind} sur ${incident.component} : `
      + `${envoyes}/${resultats.length} alerte(s) acceptée(s) (destinataires : ${source}).`,
    );
    return { notified: envoyes > 0, sent: envoyes, recipients: resultats.length, source, at: nowIso() };
  } catch (err) {
    logger.warn(
      `[incident] ${projectId ?? 'projet inconnu'} — traitement impossible : `
      + `${err?.message ?? 'erreur inconnue'}. L'incident reste enregistré côté projet.`,
    );
    return { notified: false, reason: 'HANDLING_FAILED' };
  }
}

export default {
  INCIDENT_TEMPLATE,
  handleProjectIncident,
  incidentOperationId,
  resolveIncidentRecipients,
};
