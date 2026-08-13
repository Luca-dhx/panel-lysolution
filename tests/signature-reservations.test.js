// LE VERROU DE SIGNATURE — ce qu'il protège, et comment on en sort (R10.5C).
//
// ══ CE QUE CE FICHIER PROUVE ════════════════════════════════════════════════
//
// Ouvrir une signature RÉSERVE le contrat avant d'appeler Yousign. Sur une
// issue indéterminée, la réservation n'est PAS libérée : la demande a peut-être
// été créée, et libérer autoriserait une seconde sollicitation d'un signataire
// réel.
//
// C'est le bon arbitrage, et il coûte : le contrat reste verrouillé jusqu'à ce
// qu'un humain tranche. On éprouve donc les deux moitiés — que le verrou tient,
// et qu'il existe une sortie tracée.
//
// ══ ET LA LIMITE DE TAILLE ══════════════════════════════════════════════════
//
// Le PDF transite en base64 sur la passerelle JSON. La borne doit refuser TÔT
// (avant décodage) et parler la langue de l'exploitant (des Mio de PDF, pas des
// caractères de base64).
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const limits = await import('../backend/src/services/integratedApi/yousign/signatureDocumentLimits.js');
const ownership = await import('../backend/src/services/integratedApi/yousign/signatureOwnership.js');
const reservations = await import('../backend/src/services/integratedApi/yousign/signatureReservations.service.js');
const { default: PanelSignatureBinding } = await import('../backend/src/models/PanelSignatureBinding.model.js');
const { PanelEvent } = await import('../backend/src/models/PanelSupervision.model.js');

await PanelSignatureBinding.syncIndexes();

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };

/* ══════════════════════════════════════════════════════════════════════════ */
section('TAILLE — une borne nommée, qui refuse tôt et parle clair');
{
  const petit = Buffer.from('%PDF-1.4 contenu court').toString('base64');
  const ok = limits.checkDocumentSize(petit);
  check('un PDF normal passe', ok.ok === true);
  check('…et sa taille décodée est rendue', ok.byteLength > 0);

  /**
   * REFUS AVANT DÉCODAGE : on mesure la CHAÎNE d'abord. Décoder pour découvrir
   * que c'est trop reviendrait à payer le coût de l'attaque avant de la
   * refuser.
   */
  const enorme = 'A'.repeat(limits.MAX_DOCUMENT_BASE64_LENGTH + 10);
  const refus = limits.checkDocumentSize(enorme);
  check('une chaîne hors gabarit est refusée', refus.ok === false);
  check('…avec un code STABLE', refus.code === limits.DOCUMENT_TOO_LARGE);
  check('…et un message qui donne la limite en Mio',
    /Mio/.test(refus.message) && /limite/.test(refus.message));
  check('…et qui dit QUOI FAIRE', /Allégez le PDF/.test(refus.message));

  check('la borne base64 est cohérente avec la borne en octets',
    limits.MAX_DOCUMENT_BASE64_LENGTH > limits.MAX_DOCUMENT_BYTES);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('VERROU — une réservation bloquée reste visible');
{
  await PanelSignatureBinding.deleteMany({});

  const claim = await ownership.claimSignatureRequest({
    projectId: 'p-alpha', environment: 'TEST', contractRef: 'CTR-1', operationId: 'op-bloquee-1',
  });
  check('la réservation est posée', claim.claimed === true);
  check('…avec un identifiant PROVISOIRE',
    claim.binding.resourceId === 'pending:op-bloquee-1');

  /**
   * LE DEUXIÈME CLIC — même contrat, clé d'idempotence DIFFÉRENTE.
   *
   * C'est le cas que le registre d'opérations ne couvre PAS : deux intentions
   * distinctes pour un même contrat. L'index partiel les départage en base.
   */
  const second = await ownership.claimSignatureRequest({
    projectId: 'p-alpha', environment: 'TEST', contractRef: 'CTR-1', operationId: 'op-bloquee-2',
  });
  check('NO_SECOND_REQUEST — une seconde ouverture ne réserve rien',
    second.claimed === false);
  check('…et rend la réservation existante',
    second.binding.createdByOperationId === 'op-bloquee-1');

  const liste = await reservations.listPendingReservations({});
  check('la réservation apparaît dans l’écran d’exploitation', liste.length === 1);
  check('…avec le contrat concerné', liste[0].contractRef === 'CTR-1');
  check('…et son ancienneté', typeof liste[0].ageMs === 'number');
  check('…fraîche, elle n’est pas signalée comme abandonnée', liste[0].stale === false);

  const parProjet = await reservations.listPendingReservations({ projectId: 'p-autre' });
  check('le filtre par projet isole bien', parProjet.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LIBÉRATION — tracée, motivée, et impossible sur une demande réelle');
{
  let sansMotif = null;
  try {
    await reservations.releaseReservation({ operationId: 'op-bloquee-1', actor: ACTEUR, reason: '  ' });
  } catch (err) { sansMotif = err; }
  check('AUDIT_REQUIRED — libérer sans motif est refusé',
    sansMotif?.code === 'PANEL_SIGNATURE_RELEASE_REASON_REQUIRED');

  let inconnue = null;
  try {
    await reservations.releaseReservation({ operationId: 'op-inexistante', actor: ACTEUR, reason: 'x' });
  } catch (err) { inconnue = err; }
  check('une opération inconnue est refusée',
    inconnue?.code === 'PANEL_SIGNATURE_RESERVATION_UNKNOWN');

  const avant = await PanelEvent.countDocuments({ projectId: 'p-alpha' });
  const out = await reservations.releaseReservation({
    operationId: 'op-bloquee-1', actor: ACTEUR,
    reason: 'Vérifié dans la console Yousign : aucune demande créée.',
  });
  check('la libération aboutit', out.released === true);
  check('…et nomme le contrat libéré', out.contractRef === 'CTR-1');
  check('la réservation a disparu',
    (await reservations.listPendingReservations({})).length === 0);

  const apres = await PanelEvent.find({ projectId: 'p-alpha' }).sort({ occurredAt: -1 }).lean();
  check('AUDIT — un événement est écrit', apres.length === avant + 1);
  check('…en WARNING, parce que le geste autorise une seconde sollicitation',
    apres[0].severity === 'WARNING');
  check('…avec le motif conservé',
    /console Yousign/.test(apres[0].data?.reason ?? ''));
  check('…et l’acteur', apres[0].data?.actor === 'u-dev');

  // Le contrat est de nouveau ouvrable — c'est tout l'objet du déblocage.
  const rouvert = await ownership.claimSignatureRequest({
    projectId: 'p-alpha', environment: 'TEST', contractRef: 'CTR-1', operationId: 'op-apres-1',
  });
  check('le contrat peut être rouvert après libération', rouvert.claimed === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE DEMANDE RÉELLE NE SE LIBÈRE PAS');
{
  await ownership.attachResource({
    operationId: 'op-apres-1', resourceId: 'ys-req-reelle-0001', documentId: 'ys-doc-1',
  });

  let refus = null;
  try {
    await reservations.releaseReservation({
      operationId: 'op-apres-1', actor: ACTEUR, reason: 'tentative',
    });
  } catch (err) { refus = err; }
  /**
   * Supprimer ce lien effacerait l'appartenance d'une demande VIVANTE : son
   * webhook ne retrouverait plus son projet, et le contrat resterait
   * éternellement « en cours » alors qu'il avance.
   */
  check('NO_RELEASE_ON_LIVE — une demande aboutie ne se libère pas',
    refus?.code === 'PANEL_SIGNATURE_RESERVATION_NOT_PENDING');
  check('…et le message oriente vers l’annulation',
    /annulation/i.test(refus?.message ?? ''));

  check('elle n’apparaît plus comme réservation bloquée',
    (await reservations.listPendingReservations({})).length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('APPARTENANCE — un identifiant inventé n’ouvre rien');
{
  const etranger = await ownership.describeOwnership({
    projectId: 'p-beta', environment: 'TEST', resourceId: 'ys-req-reelle-0001',
  });
  check('CROSS_TENANT — le projet B ne possède pas la demande de A',
    etranger.owned === false);

  const invente = await ownership.describeOwnership({
    projectId: 'p-alpha', environment: 'TEST', resourceId: 'ys-req-inventee-9999',
  });
  check('FORGED_ID — un identifiant inventé n’appartient à personne',
    invente.owned === false);

  const autreMonde = await ownership.describeOwnership({
    projectId: 'p-alpha', environment: 'PROD', resourceId: 'ys-req-reelle-0001',
  });
  check('TEST_PROD_ISOLATION — le même identifiant n’existe pas dans l’autre monde',
    autreMonde.owned === false);

  const legitime = await ownership.describeOwnership({
    projectId: 'p-alpha', environment: 'TEST', resourceId: 'ys-req-reelle-0001',
  });
  check('le propriétaire, lui, est reconnu', legitime.owned === true);
  check('…et son lien porte la référence métier', legitime.binding.contractRef === 'CTR-1');
}

await stopMemoryMongo();
finish();
