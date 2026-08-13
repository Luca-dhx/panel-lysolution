/**
 * L10.6B-2 — CE QU'ON ANNONCE, ET QUAND ON A LE DROIT DE L'ANNONCER.
 *
 * ══ LA PHRASE QUE CETTE SUITE DOIT RENDRE DÉMONTRABLE ══════════════════════
 *
 * Le prélèvement échoue. Stripe gère ses tentatives. La grâce expire. Le Panel
 * DEMANDE la suspension. SB Auto applique la cause et calcule l'accessibilité
 * réelle. SB Auto renvoie son état. SEULEMENT ALORS le Panel écrit l'activité
 * et prévient les deux publics.
 *
 * Si Brevo tombe, la suspension reste vraie.
 * Si le projet est hors ligne, aucune annonce mensongère ne part.
 * Si une maintenance coexiste, la cause dominante peut rester TECHNICAL — et
 * le défaut de paiement est confirmé quand même.
 *
 * ══ CE QUE CETTE SUITE NE PROUVE PAS ═══════════════════════════════════════
 *
 * La traduction d'une panne fournisseur en FAILED (rejouable) ou UNKNOWN
 * (jamais rejoué) appartient à la passerelle de capacités et à ses propres
 * suites. Ici on prouve ce qui relève de CE lot : que ce verdict est RELAYÉ
 * sans être recalculé, et qu'aucune des deux issues ne touche à l'état métier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const PanelPaymentDefault = (await import('../backend/src/models/PanelPaymentDefault.model.js')).default;
const { PAYMENT_DEFAULT_STATUS } = await import('../backend/src/models/PanelPaymentDefault.model.js');
const { EVENT_TYPES, PanelEvent } = await import('../backend/src/models/PanelSupervision.model.js');
const PanelUser = (await import('../backend/src/models/PanelUser.model.js')).default;
const {
  PanelProjectMember, PanelProjectPresentation,
} = await import('../backend/src/models/PanelProjectProjection.model.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const PanelCapabilityOperation = (await import('../backend/src/models/PanelCapabilityOperation.model.js')).default;

const defauts = await import('../backend/src/services/finance/paymentDefaults/paymentDefaults.service.js');
const annonces = await import('../backend/src/services/finance/paymentDefaults/paymentDefaultAnnouncements.js');

await PanelPaymentDefault.init();
await PanelCapabilityOperation.init();

const PROJET = 'atelier-nord';
{
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId: PROJET, projectKey: PROJET, projectName: 'Atelier du Nord',
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED' }, runtime: { environment: 'TEST' },
  });
}

let sequence = 0;

/** Un incident arrivé à expiration, dont la fermeture a été DEMANDÉE. */
async function incidentExpire() {
  sequence += 1;
  const id = `pd-n-${sequence}`;
  await PanelPaymentDefault.create({
    paymentDefaultId: id,
    projectId: PROJET,
    environment: 'TEST',
    invoiceId: `in_n_${sequence}`,
    subscriptionId: 'sub_n',
    amountDueCents: 24_900,
    currency: 'EUR',
    graceDaysSnapshot: 7,
    graceDeadlineAt: new Date('2026-08-08T10:00:00Z'),
    firstFailedAt: new Date('2026-08-01T10:00:00Z'),
    status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
    suspensionRequestedAt: new Date('2026-08-08T10:00:00Z'),
  });
  return id;
}

const snapshot = ({
  accessible, source, technical = false, contract = false,
  paymentDefault = false, at = '2026-08-08T10:05:00Z',
}) => ({
  accessible,
  status: accessible ? 'ACTIVE' : 'SUSPENDED',
  suspensionSource: source,
  contractProtectionEnabled: true,
  technicalSuspension: technical,
  causes: { technical, contract, paymentDefault },
  sourceModifiedAt: at,
});

const activites = (type = EVENT_TYPES.PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT) =>
  PanelEvent.countDocuments({ projectId: PROJET, type });

/**
 * Les activités D'UN incident précis.
 *
 * Compter globalement serait trompeur : une seule livraison peut confirmer
 * PLUSIEURS incidents en attente d'un coup — c'est même le comportement
 * attendu quand un projet revient après une absence. La question « une seule
 * fois » se pose par incident, pas par projet.
 */
const activitesDe = (paymentDefaultId) => PanelEvent.countDocuments({
  projectId: PROJET,
  type: EVENT_TYPES.PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT,
  'data.paymentDefaultId': paymentDefaultId,
});

const actes = (prefixe) =>
  PanelCapabilityOperation.countDocuments({ projectId: PROJET, operationId: new RegExp(`^${prefixe}`) });

/* ══════════════════════════════════════════════════════════════════════════
   A. LA DEMANDE NE SUFFIT PAS
   ══════════════════════════════════════════════════════════════════════════ */
section('A. GRACE_EXPIRED et suspension DEMANDÉE — on n’annonce RIEN');
{
  const id = await incidentExpire();
  const avant = await activites();

  /**
   * L'incident a une échéance dépassée et une fermeture demandée. C'est
   * exactement l'état où il serait tentant d'annoncer — et où l'annonce serait
   * un mensonge : personne n'a encore prouvé que le site est fermé.
   */
  const incident = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('la fermeture est DEMANDÉE', incident.suspensionRequestedAt !== null);
  check('…mais rien ne la CONFIRME', incident.suspensionConfirmedAt === null);
  check('AUCUNE activité de suspension', (await activites()) === avant);
  check('…et aucun acte d’envoi', (await actes('pd-susp')) === 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   B + C. LA CONFIRMATION RÉELLE, MÊME SOUS MAINTENANCE
   ══════════════════════════════════════════════════════════════════════════ */
section('B+C. Le retour du projet confirme — même quand TECHNICAL domine');
{
  const id = await incidentExpire();
  const avant = await activites();

  /**
   * LE CAS QUI JUSTIFIE TOUT : une maintenance est en cours, donc la cause
   * DOMINANTE affichée est TECHNICAL. Notre cause financière est pourtant
   * appliquée, et l'annonce financière doit partir quand même.
   */
  const res = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({
      accessible: false, source: 'TECHNICAL', technical: true, paymentDefault: true,
    }),
  });

  check('la source dominante n’est PAS la nôtre — et pourtant', res.confirmed >= 1);
  check('la transition est IDENTIFIABLE, pas seulement comptée',
    Array.isArray(res.confirmedIncidents)
    && res.confirmedIncidents.some((i) => i.paymentDefaultId === id));

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('la fermeture est confirmée', apres.suspensionConfirmedAt !== null);
  check('UNE activité est écrite pour CET incident', (await activitesDe(id)) === 1);

  const evenement = await PanelEvent.findOne({
    projectId: PROJET,
    type: EVENT_TYPES.PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT,
    'data.paymentDefaultId': id,
  }).lean();
  check('…avec le motif canonique', evenement.data.reasonLabel === 'Défaut de paiement');
  check('…et son code stable', evenement.data.reason === 'PAYMENT_DEFAULT');
  check('…l’incident y est référencé', evenement.data.paymentDefaultId === apres.paymentDefaultId);
  check('…le premier échec y est', evenement.data.firstFailedAt !== null);
  check('…l’échéance de grâce aussi', evenement.data.graceDeadlineAt !== null);
  check('…et la date de confirmation', evenement.data.suspensionConfirmedAt !== null);
  check('l’activité est un CONSTAT, pas un acte d’opérateur',
    evenement.source === 'PANEL_OBSERVATION');
}

/* ══════════════════════════════════════════════════════════════════════════
   D. HUIT FOIS LE MÊME INSTANTANÉ
   ══════════════════════════════════════════════════════════════════════════ */
section('D. Le même instantané ×8 — une transition, une activité');
{
  const id = await incidentExpire();
  const avant = await activites();

  const livraison = () => defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({ accessible: false, source: 'PAYMENT_DEFAULT', paymentDefault: true }),
  });

  const premiers = await livraison();
  const gagnants = premiers.confirmedIncidents.filter((i) => i.paymentDefaultId === id).length;

  let suivantes = 0;
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await livraison();
    suivantes += (r.confirmedIncidents ?? []).length;
  }

  check('la PREMIÈRE livraison fait la transition', gagnants === 1);
  check('LES SEPT SUIVANTES n’en font AUCUNE', suivantes === 0);
  check('UNE SEULE activité pour huit livraisons', (await activitesDe(id)) === 1);

  const fige = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('…et la date de confirmation ne rajeunit pas',
    fige.suspensionConfirmedAt.toISOString() === '2026-08-08T10:05:00.000Z');
}

/* ══════════════════════════════════════════════════════════════════════════
   E. LE RETOUR APRÈS ABSENCE
   ══════════════════════════════════════════════════════════════════════════ */
section('E. Projet hors ligne puis retour — convergence exactement-une-fois');
{
  const { applyIncoming } = await import('../backend/src/services/sync/syncCore.service.js');
  const id = await incidentExpire();
  const avant = await activites();

  /* Pendant l'absence : rien n'est inventé. */
  const pendant = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('hors ligne, AUCUNE confirmation n’est fabriquée', pendant.suspensionConfirmedAt === null);
  check('…et AUCUNE activité', (await activites()) === avant);

  /* Le projet revient et livre son état, par la voie réelle du pont. */
  const ecriture = (at) => ([{
    writeId: `wn-${at}`,
    entityType: 'PROJECT_SITE_STATUS',
    entityId: `site-${PROJET}`,
    deleted: false,
    payload: {
      accessible: false, status: 'SUSPENDED', suspensionSource: 'TECHNICAL',
      contractProtectionEnabled: true, technicalSuspension: true,
      causes: { technical: true, contract: false, paymentDefault: true },
    },
    modifiedAt: at,
    emitter: 'PROJECT',
  }]);

  const { results } = await applyIncoming(PROJET, ecriture('2026-08-09T08:00:00Z'));
  check('l’écriture est APPLIQUÉE par le cœur', results[0]?.status === 'APPLIED');

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('LA CONFIRMATION A CONVERGÉ', apres.suspensionConfirmedAt !== null);
  check('…et l’activité est écrite', (await activitesDe(id)) === 1);

  /* Rejeu du même snapshot : aucun doublon. */
  await applyIncoming(PROJET, ecriture('2026-08-09T08:00:00Z'));
  await applyIncoming(PROJET, ecriture('2026-08-10T09:00:00Z'));
  check('LE REJEU NE PRODUIT AUCUN DOUBLON', (await activitesDe(id)) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   F + G. QUAND L'ENVOI ÉCHOUE
   ══════════════════════════════════════════════════════════════════════════ */
section('F+G. Une panne d’envoi ne défait JAMAIS une suspension');
{
  /**
   * Aucune clé Brevo n'est configurée dans ce monde de recette : la passerelle
   * refuse donc l'envoi. C'est une panne fournisseur RÉELLE, pas simulée — et
   * c'est exactement ce qu'on veut éprouver.
   */
  const id = await incidentExpire();
  const avant = await activites();

  const res = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({ accessible: false, source: 'PAYMENT_DEFAULT', paymentDefault: true, at: '2026-08-11T10:00:00Z' }),
  });
  check('la confirmation a bien eu lieu', res.confirmed >= 1);

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('LE SITE RESTE SUSPENDU — statut inchangé',
    apres.status === PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED);
  check('…la confirmation est CONSERVÉE', apres.suspensionConfirmedAt !== null);
  check('…aucun retour en arrière vers une simple demande',
    apres.suspensionRequestedAt !== null);
  check('L’ACTIVITÉ EST CONSERVÉE malgré l’échec d’envoi',
    (await activitesDe(id)) === 1);

  /**
   * LE RELAIS DU VERDICT, SANS LE RECALCULER.
   *
   * La passerelle dérive `replaySafe` de l'issue : vrai pour un refus franc
   * (rien n'est parti, on peut rejouer), faux pour un timeout (l'envoi a
   * peut-être abouti, on ne rejoue JAMAIS aveuglément). Notre code doit
   * transporter ce verdict tel quel.
   */
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(
    path.join(racine, 'backend/src/services/finance/paymentDefaults/paymentDefaultAnnouncements.js'),
    'utf8',
  );
  check('le verdict de rejouabilité est RELAYÉ', /replaySafe:\s*err\?\.replaySafe/.test(source));
  check('…et jamais recalculé localement',
    !/replaySafe\s*=\s*(true|false)\b/.test(source));
}

/* ══════════════════════════════════════════════════════════════════════════
   H. PERSONNE À PRÉVENIR
   ══════════════════════════════════════════════════════════════════════════ */
section('H. Aucun administrateur joignable — la suspension reste vraie');
{
  const id = await incidentExpire();
  const avant = await activites();

  check('le projet n’a aucun membre ADMIN',
    (await PanelProjectMember.countDocuments({ projectId: PROJET, role: 'ADMIN' })) === 0);
  check('…ni contact de repli',
    (await annonces.resolveProjectAdmins(PROJET)).length === 0);

  await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({ accessible: false, source: 'PAYMENT_DEFAULT', paymentDefault: true, at: '2026-08-12T10:00:00Z' }),
  });

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('LA CONFIRMATION RESTE VALIDE', apres.suspensionConfirmedAt !== null);
  check('…et l’activité est écrite', (await activitesDe(id)) === 1);

  const rapport = await annonces.announceConfirmedSuspensions({
    projectId: PROJET, incidents: [apres],
  });
  check('l’absence de destinataire est un ÉTAT, pas une erreur',
    rapport.rapports[0].client.reason === 'NO_RECIPIENT');
}

/* ══════════════════════════════════════════════════════════════════════════
   I. LA POPULATION DES DESTINATAIRES
   ══════════════════════════════════════════════════════════════════════════ */
section('I. Plusieurs admins, adresses en double, adresses invalides');
{
  // La projection porte ses métadonnées de source : ce sont des faits publiés
  // par le projet, pas des lignes fabriquées ici.
  const projete = (entityId, role, email, name) => ({
    projectId: PROJET, entityId, role, email, name,
    sourceUserId: entityId,
    sourceModifiedAt: '2026-08-01T10:00:00.000Z',
    receivedAt: '2026-08-01T10:00:01.000Z',
  });
  await PanelProjectMember.create([
    projete('m1', 'ADMIN', 'Gerant@Atelier.fr', 'Gérant'),
    projete('m2', 'ADMIN', 'gerant@atelier.fr', 'Doublon'),
    projete('m3', 'ADMIN', 'pas-une-adresse', 'Cassé'),
    projete('m5', 'ADMIN', 'second@atelier.fr', 'Second'),
    projete('m6', 'DEV', 'dev@lysolution.fr', 'Technicien'),
  ]);

  const admins = await annonces.resolveProjectAdmins(PROJET);
  const adresses = admins.map((a) => a.email);

  check('LE DOUBLON D’ADRESSE EST FUSIONNÉ (casse comprise)',
    adresses.filter((e) => e === 'gerant@atelier.fr').length === 1);
  check('une adresse invalide est un NON-DESTINATAIRE, pas une erreur',
    !adresses.includes('pas-une-adresse'));
  /**
   * « Sans adresse » ne se teste pas : la projection le REFUSE à l'écriture.
   * C'est une garantie plus forte qu'un filtre — un membre sans adresse ne
   * peut pas exister, donc aucun code n'a à s'en défendre.
   */
  let sansAdresse = null;
  try {
    await PanelProjectMember.create(projete('m7', 'ADMIN', '', 'Sans adresse'));
  } catch (err) { sansAdresse = err; }
  check('un membre SANS adresse ne peut pas exister', sansAdresse !== null);
  check('…et aucune adresse vide ne circule', adresses.every((e) => e.length > 0));
  check('les deux administrateurs réels sont là', adresses.length === 2);
  check('LE COMPTE TECHNIQUE N’EST JAMAIS DESTINATAIRE',
    !adresses.includes('dev@lysolution.fr'));

  /* Le repli de présentation ne sert QUE si personne n'est joignable. */
  await PanelProjectPresentation.create({
    projectId: PROJET,
    contacts: { email: 'contact@atelier.fr' },
    sourceModifiedAt: '2026-08-01T10:00:00.000Z',
    receivedAt: '2026-08-01T10:00:01.000Z',
  });
  check('…et il ne s’ajoute pas aux administrateurs existants',
    (await annonces.resolveProjectAdmins(PROJET)).length === 2);

  /* L'équipe Panel : des comptes réels, jamais une adresse en dur. */
  const compte = (userId, email, displayName, role) => ({
    userId, email, displayName, role,
    passwordHash: 'scrypt$stub', createdAt: '2026-01-01T00:00:00.000Z',
  });
  await PanelUser.create([
    compte('u1', 'Luca@lysolution.fr', 'Luca', 'ADMIN'),
    compte('u2', 'ops@lysolution.fr', 'Ops', 'DEV'),
  ]);
  const equipe = await annonces.resolvePanelTeam();
  const adressesEquipe = equipe.map((u) => u.email);
  check('L’ÉQUIPE VIENT DES COMPTES DU PANEL', adressesEquipe.includes('luca@lysolution.fr'));
  check('…les deux rôles sont prévenus', adressesEquipe.includes('ops@lysolution.fr'));
  check('…et le nom est celui du compte, pas un vide',
    equipe.find((u) => u.email === 'luca@lysolution.fr')?.name === 'Luca');
}

/* ══════════════════════════════════════════════════════════════════════════
   J. RÉGULARISATION SOUS MAINTENANCE
   ══════════════════════════════════════════════════════════════════════════ */
section('J. Le paiement est régularisé, la maintenance continue');
{
  const id = await incidentExpire();
  await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({ accessible: false, source: 'TECHNICAL', technical: true, paymentDefault: true, at: '2026-08-13T10:00:00Z' }),
  });
  await PanelPaymentDefault.updateOne(
    { paymentDefaultId: id },
    { $set: { status: PAYMENT_DEFAULT_STATUS.RESOLVED } },
  );

  const avantReactivation = await PanelEvent.countDocuments({
    projectId: PROJET, type: { $regex: 'REACTIV|RESTORED|ACTIVATED' },
  });

  /* La cause financière disparaît, mais le site reste fermé pour maintenance. */
  const res = await defauts.confirmFromSiteStatus({
    projectId: PROJET,
    snapshot: snapshot({ accessible: false, source: 'TECHNICAL', technical: true, paymentDefault: false, at: '2026-08-14T10:00:00Z' }),
  });

  const apres = await PanelPaymentDefault.findOne({ paymentDefaultId: id }).lean();
  check('la cause financière est constatée retirée', apres.causeRemovalConfirmedAt !== null);
  check('…mais le site n’est PAS déclaré rouvert', res.confirmed === 0);
  check('AUCUN message de réactivation n’existe',
    (await PanelEvent.countDocuments({
      projectId: PROJET, type: { $regex: 'REACTIV|RESTORED|ACTIVATED' },
    })) === avantReactivation);
}

/* ══════════════════════════════════════════════════════════════════════════
   K + L. CE QUI NE DOIT RIEN DÉCLENCHER
   ══════════════════════════════════════════════════════════════════════════ */
section('K+L. Prestation impayée et absence de politique');
{
  const avant = await activites();

  /* K — une prestation ponctuelle n'ouvre pas d'incident, donc n'annonce rien. */
  const { normalizeInvoiceFailure } = await import(
    '../backend/src/services/finance/paymentDefaults/stripeInvoiceFailureNormalizer.js'
  );
  const presta = normalizeInvoiceFailure({
    eventType: 'invoice.payment_failed',
    environment: 'TEST',
    payload: { data: { object: { id: 'in_presta_b2', subscription: null, amount_due: 12_000 } } },
  });
  check('une prestation reste exclue', presta.reason === 'NOT_A_SUBSCRIPTION');

  /* L — sans politique de grâce, aucune échéance, donc aucune suspension. */
  sequence += 1;
  await PanelPaymentDefault.create({
    paymentDefaultId: `pd-sans-${sequence}`,
    projectId: PROJET, environment: 'TEST', invoiceId: `in_sans_${sequence}`,
    subscriptionId: 'sub_n', amountDueCents: 24_900, currency: 'EUR',
    graceDaysSnapshot: null, graceDeadlineAt: null,
    firstFailedAt: new Date('2026-08-01T10:00:00Z'),
    status: PAYMENT_DEFAULT_STATUS.OPEN,
  });

  await defauts.expireDueGracePeriods({ now: new Date('2027-06-01T00:00:00Z') });
  const sansPolitique = await PanelPaymentDefault.findOne({ paymentDefaultId: `pd-sans-${sequence}` }).lean();

  check('un incident sans politique n’expire jamais',
    sansPolitique.status === PAYMENT_DEFAULT_STATUS.OPEN);
  check('…aucune fermeture n’est demandée', sansPolitique.suspensionRequestedAt === null);
  check('DONC AUCUNE ANNONCE AUTOMATIQUE', (await activites()) === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   M. LE RENDU
   ══════════════════════════════════════════════════════════════════════════ */
section('M. Accents, caractères HTML, champs facultatifs');
{
  const { renderTemplate } = await import('../backend/src/services/email/panelEmailTemplateRenderer.js');
  const registre = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');

  const rendre = (templateId, variables) => {
    const def = registre.getTemplateDefinition(templateId);
    return renderTemplate({
      templateId,
      template: { subject: def.defaultSubject, html: def.defaultHtml },
      variables,
    });
  };

  const client = rendre('SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT', {
    'company.name': 'Café & Cie <Élise>',
    'suspension.reasonLabel': 'Défaut de paiement',
    'suspension.confirmedOn': '13 août 2026',
    'billing.url': 'https://manager.exemple.fr/factures',
    'developer.companyName': 'L.Y Solution',
  });

  check('les accents traversent intacts', client.html.includes('Défaut de paiement'));
  check('LE HTML HOSTILE EST ÉCHAPPÉ',
    client.html.includes('Caf&eacute; &amp; Cie'.replace('&eacute;', 'é'))
    || client.html.includes('&amp;') && client.html.includes('&lt;Élise&gt;'));
  check('…aucune balise injectée ne survit', !client.html.includes('<Élise>'));
  check('le motif est dans le sujet', client.subject.includes('Défaut de paiement'));

  /* Le champ facultatif absent ne laisse AUCUN placeholder visible. */
  const sansLien = rendre('SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT', {
    'company.name': 'Atelier du Nord',
    'suspension.reasonLabel': 'Défaut de paiement',
    'suspension.confirmedOn': '13 août 2026',
    'developer.companyName': 'L.Y Solution',
  });
  check('UN CHAMP FACULTATIF ABSENT NE LAISSE PAS « {{billing.url}} »',
    !sansLien.html.includes('{{billing.url}}'));

  const equipe = rendre('SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM', {
    'project.name': 'Atelier du Nord',
    'project.id': PROJET,
    'suspension.reasonLabel': 'Défaut de paiement',
    'incident.firstFailedOn': '1 août 2026',
    'suspension.confirmedOn': '13 août 2026',
    'incident.reference': 'pd-1',
  });
  check('le dossier équipe se rend sans ses champs facultatifs',
    !equipe.html.includes('{{incident.amountDue}}')
    && !equipe.html.includes('{{incident.graceDeadlineOn}}'));
  check('…et porte l’identifiant stable du projet', equipe.html.includes(PROJET));
}

/* ══════════════════════════════════════════════════════════════════════════
   N. UNE SEULE SÉMANTIQUE
   ══════════════════════════════════════════════════════════════════════════ */
section('N. Livraison immédiate et rattrapage empruntent la même voie');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const projecteurs = fs.readFileSync(path.join(racine, 'backend/src/services/sync/projectors.js'), 'utf8');

  check('un seul point confirme, pour le push comme pour le pull',
    (projecteurs.match(/confirmerDefautsDePaiement/g) || []).length >= 1);
  check('aucune branche « si hors ligne »',
    !/offline|horsLigne|isOffline/i.test(projecteurs));
}

/* ══════════════════════════════════════════════════════════════════════════
   GARDE-FOUS STATIQUES
   ══════════════════════════════════════════════════════════════════════════ */
section('Garde-fous — les onze interdits du lot');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const nu = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

  const annonce = nu(lire('backend/src/services/finance/paymentDefaults/paymentDefaultAnnouncements.js'));
  const service = nu(lire('backend/src/services/finance/paymentDefaults/paymentDefaults.service.js'));

  // 1 — jamais déclenché par la seule demande de suspension
  check('1 · rien ne se déclenche sur suspensionRequestedAt seul',
    !/suspensionRequestedAt[^;]*announce|announce[^;]*suspensionRequestedAt/.test(service));
  // 2 — jamais la source dominante comme preuve
  check('2 · aucune dépendance à suspensionSource',
    !/suspensionSource/.test(annonce));
  // 3 + 4 — aucun appel ni driver Brevo dans ce chemin
  check('3 · aucun appel Brevo direct',
    !/api\.brevo|v3\/smtp|sendinblue/i.test(annonce));
  check('4 · aucun driver de transport importé',
    !/brevoTransport|brevoSendAdapter/.test(annonce));
  // 5 — aucun credential projet
  check('5 · aucun credential dans ce chemin',
    !/apiKey|api_key|BREVO_[A-Z_]*KEY/i.test(annonce));
  // 6 — aucun retour arrière métier sur erreur d'envoi
  check('6 · l’annonce n’écrit JAMAIS sur l’incident',
    !/PanelPaymentDefault/.test(annonce));
  check('6b · …ni ne remet un incident en arrière',
    !/GRACE_EXPIRED|updateOne|updateMany|findOneAndUpdate/.test(annonce));
  // 7 — pas d'activité avant confirmation
  check('7 · l’activité n’est écrite que depuis la confirmation',
    /announceConfirmedSuspensions/.test(service)
    && /confirmes\.length\s*>\s*0/.test(service));
  // 8 — aucun renderer parallèle
  check('8 · aucun HTML fabriqué ici',
    !/<html|<table|<p\s|innerHTML/.test(annonce));
  // 10 — aucun contournement par l'environnement
  check('10 · aucun contournement NODE_ENV',
    !/NODE_ENV/.test(annonce));
  // 11 — aucune adresse en dur
  check('11 · AUCUNE ADRESSE E-MAIL EN DUR',
    !/[\w.-]+@[\w.-]+\.[a-z]{2,}/i.test(annonce));

  // La clé d'acte ne doit dépendre d'aucune horloge.
  check('l’identité d’acte ne contient aucune horloge',
    !/Date\.now\(\)|new Date\(\)/.test(
      annonce.slice(annonce.indexOf('export function suspensionOperationId'),
        annonce.indexOf('export function suspensionOperationId') + 300),
    ));
  check('…et elle est dérivée de l’incident, de la transition et du destinataire',
    /pd-susp-\$\{paymentDefaultId\}-\$\{audience\}-\$\{index\}/.test(annonce));

  // 9 — les nouveaux modèles sont soumis aux invariants du registre
  const fondation = lire('tests/brevo-send-template-foundation.test.js');
  check('9 · les deux modèles sont DÉCLARÉS dans l’invariant nominatif',
    fondation.includes('SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT')
    && fondation.includes('SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM'));
}

await stopMemoryMongo();
finish();
