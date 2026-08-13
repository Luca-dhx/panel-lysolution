// EXPÉDITEUR E-MAIL GLOBAL — la surface interne (R10.4).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Expéditeurs ».
//
// ── CE QUE CE CONTRÔLEUR NE FAIT PAS ────────────────────────────────────────
//
// Aucune règle métier, aucune validation d'adresse, aucun appel fournisseur,
// aucune décision d'environnement. Il lit une requête, appelle une autorité et
// rend son verdict — comme les autres contrôleurs de cette surface. Le jour où
// l'un d'eux valide une adresse lui-même, il existe deux règles de validation
// et l'une des deux est fausse.
import { ok } from '../utils/apiResponse.js';
import { updateGlobalSender } from '../services/email/panelGlobalSender.service.js';
import {
  describeSenderScreen,
  describeTest,
  sendTestEmail,
} from '../services/email/panelEmailSenderTest.service.js';

/** GET — la configuration, l'environnement servi, et le dernier test. */
export async function getEmailSender(_req, res) {
  return ok(res, await describeSenderScreen());
}

/** PUT — enregistre l'expéditeur global. DEV uniquement (monté ainsi). */
export async function putEmailSender(req, res) {
  await updateGlobalSender(req.body ?? {}, {
    userId: req.panelUser?.userId ?? null,
    userEmail: req.panelUser?.email ?? null,
  });
  // On rend l'ÉCRAN complet, pas seulement la configuration : c'est la même
  // forme qu'au chargement, donc l'interface n'a qu'un seul cas à traiter.
  return ok(res, await describeSenderScreen());
}

/**
 * POST — envoie un e-mail de test RÉEL, par la chaîne réelle.
 *
 * Ne lève pas sur un refus fournisseur : le refus EST le résultat, et le
 * rapport le porte avec son code. Seule une entrée illisible — destinataire
 * absent — produit une erreur HTTP, parce qu'il n'y a alors rien à rapporter.
 */
export async function postEmailSenderTest(req, res) {
  return ok(res, await sendTestEmail({
    recipientEmail: req.body?.recipientEmail,
    actor: { userId: req.panelUser?.userId ?? null, userEmail: req.panelUser?.email ?? null },
  }));
}

/**
 * GET — RELIT un test sans rien renvoyer.
 *
 * C'est la route qui permet d'attendre le webhook. La confondre avec un second
 * POST écrirait une deuxième fois à une personne réelle pour la seule raison
 * qu'on voulait rafraîchir un écran.
 */
export async function getEmailSenderTest(req, res) {
  return ok(res, await describeTest(req.params.testId));
}

export default { getEmailSender, putEmailSender, postEmailSenderTest, getEmailSenderTest };
