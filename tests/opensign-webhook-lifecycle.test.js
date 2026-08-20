// OPENSIGN — LE CHEMIN RETOUR : réception, normalisation, cycle de vie.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md (lot 3).
//
// ══ CE QUE CETTE SUITE PROUVE ═══════════════════════════════════════════════
//
// Qu'un événement OpenSign traverse toute la chaîne de réception — signature,
// idempotence, appartenance, traduction, projection — et arrive au projet dans
// le vocabulaire qu'il connaît déjà.
//
// ══ ET CE QU'ELLE PROUVE SURTOUT ════════════════════════════════════════════
//
// Ce qui n'arrive PAS : un appel non signé, un corps modifié, un rejeu, un
// événement d'un fournisseur sur la demande d'un autre, une demande inconnue.
// Chacun de ces cas est un chemin par lequel un contrat pourrait changer d'état
// sans raison — et aucun ne produit d'erreur visible s'il n'est pas gardé.
import { createHmac, randomUUID } from 'node:crypto';

import {
  check, finish, section, setTestEnv,
  startMemoryMongo, connectTestDatabase, stopMemoryMongo,
} from './helpers/harness.js';
import { forme } from './helpers/secretShapes.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const ingest = await import('../backend/src/services/webhooks/webhookIngest.js');
const { ingestProviderEvent, INGEST_OUTCOME } = ingest;
const dispatch = await import('../backend/src/services/webhooks/signatureEventDispatch.js');
const adaptateur = await import('../backend/src/services/integratedApi/opensign/openSignAdapters.js');
const { saveCredentialSet } = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { default: WebhookBinding, WEBHOOK_DESTINATION } = await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js');
const { default: WebhookEvent } = await import('../backend/src/models/PanelProviderWebhookEvent.model.js');
const { default: SignatureBinding } = await import('../backend/src/models/PanelSignatureBinding.model.js');
const { PanelSyncJournalEntry: JournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');

const CLE = forme.openSignWebhookKey('LOT3');
const DOC = 'kpeg6Q2rO7';
const CONTRAT = '68b0000000000000000000aa';
const PROJET = 'projet-signature-a';
const DEV = 'dev.recette@example.com';
const CLIENT = 'client.recette@example.com';

/* -------------------------------------------------------------------------- */
/*  MISE EN PLACE                                                             */
/* -------------------------------------------------------------------------- */

await seedIntegratedApiCredentialSets();
await saveCredentialSet('OPENSIGN', 'TEST', {
  values: { apiToken: forme.openSignApiToken('LOT3'), webhookSecret: CLE },
  actor: { email: 'recette@local' },
});

/**
 * LE BINDING DE RÉCEPTION — sans lui, tout est refusé, et c'est voulu.
 *
 * « Le Panel n'a jamais enregistré d'endpoint pour ce couple » est un refus de
 * plein droit : accepter quand même reviendrait à traiter des événements dont
 * on ne peut pas dire d'où ils viennent.
 */
await WebhookBinding.create({
  bindingId: randomUUID(),
  provider: 'OPENSIGN',
  environment: 'TEST',
  destination: WEBHOOK_DESTINATION.PANEL,
  projectId: null,
  ownershipToken: randomUUID(),
  status: 'READY',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/**
 * ON LIT LE JOURNAL DURABLE, ON NE REMPLACE PAS `emitChange`.
 *
 * Remplacer la fonction d'émission prouverait qu'elle a été APPELÉE. Lire le
 * journal prouve que le fait est ÉCRIT — donc qu'un projet éteint le
 * retrouvera à sa reconnexion, ce qui est exactement la garantie que ce chemin
 * de retour existe pour tenir.
 *
 * En prime, cela fait traverser les gardes du pont : `emitChange` refuse une
 * charge utile portant un secret de fournisseur, et une projection qui les
 * contournerait passerait ce test sans les avoir subies.
 */
const projections = async () => JournalEntry.find({ 'change.entityType': 'SIGNATURE_EVENT' })
  .sort({ seq: 1 }).lean();
const derniereProjection = async () => (await projections()).at(-1)?.change?.payload ?? null;
const derniereAudience = async () => (await projections()).at(-1)?.audience ?? null;
const compterProjections = async () => (await projections()).length;

const signer = (corps, cle = CLE) => createHmac('sha256', cle).update(corps).digest('hex');
const envoyer = (charge, { cle = CLE, entete = 'x-webhook-signature' } = {}) => {
  const corps = Buffer.from(JSON.stringify(charge), 'utf8');
  return ingestProviderEvent({
    slug: 'opensign', rawBody: corps, headers: { [entete]: signer(corps, cle) },
  });
};

const charge = (evenement, extra = {}) => ({
  event: evenement,
  type: 'request-sign',
  objectId: DOC,
  file: 'https://stockage.test/doc.pdf',
  name: 'Contrat de recette',
  note: '',
  description: '',
  createdAt: 'Fri, 16 May 2025 15:02:28 GMT+5:30',
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('1 · La traduction — cinq mots du fournisseur, trois faits métier');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const { toBusinessEvent, SIGNATURE_EVENTS } = dispatch;

  check('« signed » → SIGNATURE_SIGNER_SIGNED',
    toBusinessEvent('signed', 'OPENSIGN') === SIGNATURE_EVENTS.SIGNER_SIGNED);
  check('« completed » → SIGNATURE_COMPLETED',
    toBusinessEvent('completed', 'OPENSIGN') === SIGNATURE_EVENTS.COMPLETED);
  check('« declined » → SIGNATURE_FAILED',
    toBusinessEvent('declined', 'OPENSIGN') === SIGNATURE_EVENTS.FAILED);

  /**
   * `revoked` N'EST PAS DOCUMENTÉ, ET IL EST QUAND MÊME TRAITÉ.
   *
   * La mesure montre qu'une révocation place le document en `declined` : il est
   * probable qu'aucun `revoked` n'arrive jamais. Le coût d'une ligne est nul ;
   * celui de son absence serait un contrat révoqué qui resterait « en cours »
   * pour toujours, sans que rien ne le signale.
   */
  check('« revoked » → SIGNATURE_FAILED, par précaution assumée',
    toBusinessEvent('revoked', 'OPENSIGN') === SIGNATURE_EVENTS.FAILED);

  /**
   * `created` ET `viewed` SONT ACQUITTÉS SANS ÊTRE PROJETÉS.
   *
   * Les faire remonter obligerait chaque projet à filtrer un flux qu'il n'a pas
   * demandé, et remplirait le journal durable de faits que personne ne lit.
   */
  check('« created » n’est PAS projeté', toBusinessEvent('created', 'OPENSIGN') === null);
  check('« viewed » n’est PAS projeté', toBusinessEvent('viewed', 'OPENSIGN') === null);

  /**
   * LE MÊME MOT NE VEUT PAS DIRE LA MÊME CHOSE PARTOUT. Traduire sans savoir
   * qui parle reviendrait à prêter aux fournisseurs un vocabulaire commun
   * qu'ils n'ont pas.
   */
  check('« completed » ne veut rien dire chez Yousign',
    toBusinessEvent('completed', 'YOUSIGN') === null);
  check('« signature_request.done » ne veut rien dire chez OpenSign',
    toBusinessEvent('signature_request.done', 'OPENSIGN') === null);
  check('un fournisseur inconnu ne traduit rien', toBusinessEvent('signed', 'MAILCHIMP') === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2 · La signature — le corps brut, et rien d’autre');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const corps = Buffer.from(JSON.stringify(charge('created')), 'utf8');

  const sans = await ingestProviderEvent({ slug: 'opensign', rawBody: corps, headers: {} });
  check('sans en-tête de signature → REFUSÉ', sans.outcome === INGEST_OUTCOME.REJECTED);

  const fausse = await ingestProviderEvent({
    slug: 'opensign', rawBody: corps, headers: { 'x-webhook-signature': 'a'.repeat(64) },
  });
  check('signature invalide → REFUSÉ', fausse.outcome === INGEST_OUTCOME.REJECTED);

  const autreCle = await ingestProviderEvent({
    slug: 'opensign', rawBody: corps,
    headers: { 'x-webhook-signature': signer(corps, forme.openSignWebhookKey('AUTRE')) },
  });
  check('signature d’une AUTRE clé → REFUSÉ', autreCle.outcome === INGEST_OUTCOME.REJECTED);

  /**
   * LE CORPS MODIFIÉ EST LE CAS QUI COMPTE. Une signature valide sur un corps
   * différent, c'est un intermédiaire qui a réécrit l'événement — et un contrat
   * qui changerait d'état sur la foi d'un tiers.
   */
  const altere = await ingestProviderEvent({
    slug: 'opensign',
    rawBody: Buffer.from(JSON.stringify(charge('completed')), 'utf8'),
    headers: { 'x-webhook-signature': signer(corps) },
  });
  check('corps modifié, signature d’origine → REFUSÉ', altere.outcome === INGEST_OUTCOME.REJECTED);

  const bon = await envoyer(charge('created'));
  check('signature correcte → ACCEPTÉ', bon.outcome === INGEST_OUTCOME.ACCEPTED);
  check('…et la preuve porte sur le CORPS',
    (await WebhookEvent.findOne({ provider: 'OPENSIGN' }).lean()).signatureVerified === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3 · L’idempotence — OpenSign ne fournit AUCUN identifiant d’événement');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  await WebhookEvent.deleteMany({});
  const vu = charge('viewed', { viewedBy: DEV, viewedAt: 'Fri, 16 May 2025 16:18:16 IST' });

  const premier = await envoyer(vu);
  check('première livraison acceptée', premier.outcome === INGEST_OUTCOME.ACCEPTED);
  const rejeu = await envoyer(vu);
  check('la MÊME livraison est un doublon', rejeu.duplicate === true);
  check('…et un seul événement est en base',
    (await WebhookEvent.countDocuments({ provider: 'OPENSIGN' })) === 1);

  /**
   * DEUX SIGNATAIRES DANS LA MÊME SECONDE — le cas que l'empreinte du corps
   * seule ne saurait pas distinguer si les charges étaient identiques, et que
   * la clé composite distingue parce que l'ACTEUR y entre.
   */
  const client = charge('viewed', { viewedBy: CLIENT, viewedAt: 'Fri, 16 May 2025 16:18:16 IST' });
  const second = await envoyer(client);
  check('un AUTRE signataire au même instant n’est pas un doublon', second.duplicate === false);
  check('…et les deux coexistent',
    (await WebhookEvent.countDocuments({ provider: 'OPENSIGN' })) === 2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4 · L’appartenance — la charge utile ne désigne JAMAIS le projet');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  await WebhookEvent.deleteMany({});
  await SignatureBinding.deleteMany({});

  /**
   * AUCUN LIEN : l'événement est acquitté, jamais acheminé. C'est le cas normal
   * pendant une coexistence — et le cas d'un document créé à la main dans la
   * console du fournisseur.
   */
  const orphelin = await envoyer(charge('signed', { signer: { email: DEV }, signedAt: 'x' }));
  check('sans lien d’appartenance, rien n’est acheminé', orphelin.dispatched === false);
  check('…et le motif le dit', orphelin.dispatchReason === 'NO_MATCHING_BINDING');
  check('…mais l’événement est CONSIGNÉ, jamais perdu',
    (await WebhookEvent.countDocuments({ provider: 'OPENSIGN' })) === 1);

  await SignatureBinding.create({
    projectId: PROJET, environment: 'TEST', resourceType: 'REQUEST',
    provider: 'OPENSIGN', resourceId: DOC, documentId: DOC,
    contractRef: CONTRAT, source: 'CREATED', createdAt: new Date().toISOString(),
  });

  /**
   * UN `projectId` GLISSÉ DANS LA CHARGE UTILE NE DÉSIGNE PERSONNE.
   *
   * C'est le chemin par lequel un tiers ferait router ses événements vers le
   * projet de son choix. Le destinataire vient du LIEN que le Panel a écrit
   * lui-même avant d'appeler le fournisseur.
   */
  await WebhookEvent.deleteMany({});
  await JournalEntry.deleteMany({});
  const menteur = await envoyer(charge('signed', {
    signer: { email: DEV }, signedAt: 'a', projectId: 'projet-de-lattaquant',
  }));
  check('l’événement est acheminé…', menteur.dispatched === true);
  check('…vers le projet du LIEN, pas celui de la charge utile',
    await derniereAudience() === PROJET);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5 · L’identité du signataire — la poignée, jamais l’adresse');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  await WebhookEvent.deleteMany({});
  await JournalEntry.deleteMany({});

  await envoyer(charge('signed', { signer: { email: DEV }, signedAt: 'b' }));
  const projete = await derniereProjection() ?? {};

  /**
   * ══ LE POINT LE PLUS IMPORTANT DE CE LOT ═══════════════════════════════════
   *
   * Le projet a reçu, à l'ouverture, une poignée opaque pour chaque signataire.
   * Le webhook, lui, ne porte qu'une ADRESSE. Si le Panel la faisait traverser,
   * deux choses casseraient d'un coup : une donnée personnelle entrerait dans
   * le journal durable, et le projet ne reconnaîtrait pas son propre signataire
   * — il saurait « quelqu'un a signé » sans savoir lequel, donc sans pouvoir
   * ouvrir le contrat à la contresignature.
   */
  check('la poignée projetée est celle de l’ouverture',
    projete.signerId === adaptateur.signerHandle(DOC, DEV));
  check('aucune adresse ne traverse',
    !JSON.stringify(projete).includes(DEV) && !JSON.stringify(projete).includes('@'));
  check('le fait est nommé dans le vocabulaire du parc',
    projete.event === dispatch.SIGNATURE_EVENTS.SIGNER_SIGNED);
  check('la référence de contrat vient du lien', projete.contractRef === CONTRAT);
  check('le fournisseur est nommé, pour le forensic', projete.provider === 'OPENSIGN');
  check('…et son libellé d’origine aussi', projete.providerEvent === 'signed');

  /** Un `declined` nomme son auteur par le même mécanisme. */
  await JournalEntry.deleteMany({});
  await envoyer(charge('declined', { declinedBy: CLIENT, declinedAt: 'c', declinedReason: 'non' }));
  const refus = await derniereProjection() ?? {};
  check('un refus nomme lui aussi son auteur par sa poignée',
    refus.signerId === adaptateur.signerHandle(DOC, CLIENT));
  check('…et vaut SIGNATURE_FAILED', refus.event === dispatch.SIGNATURE_EVENTS.FAILED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6 · Le désordre et le rejeu ne font pas reculer un contrat');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  await WebhookEvent.deleteMany({});
  await SignatureBinding.deleteMany({});
  await SignatureBinding.create({
    projectId: PROJET, environment: 'TEST', resourceType: 'REQUEST',
    provider: 'OPENSIGN', resourceId: DOC, documentId: DOC,
    contractRef: CONTRAT, source: 'CREATED', createdAt: new Date().toISOString(),
  });
  await JournalEntry.deleteMany({});

  await envoyer(charge('completed', { completedAt: 'd', certificate: 'https://x/c.pdf' }));
  const apresCompletion = await SignatureBinding.findOne({ resourceId: DOC }).lean();

  /**
   * UN FAIT TERMINAL FERME LE LIEN.
   *
   * C'est ce qui libère le contrat pour une relance éventuelle — l'index
   * n'autorise qu'une demande VIVANTE par contrat. Sans cette fermeture, un
   * contrat refusé resterait bloqué à jamais.
   */
  check('« completed » ferme le lien d’appartenance', Boolean(apresCompletion.closedAt));

  /**
   * UN `signed` RETARDÉ, ARRIVÉ APRÈS LE `completed`.
   *
   * ══ IL EST ACHEMINÉ, ET C'EST VOULU ═══════════════════════════════════════
   *
   * La tentation serait de le jeter : le lien est clos, le parcours est
   * tranché. Ce serait perdre un fait. Le Panel n'est pas juge de la pertinence
   * d'un événement authentique — il l'a vérifié, daté et attribué ; le taire
   * priverait le projet d'une information qu'il est seul à savoir interpréter.
   *
   * La convergence est garantie AILLEURS, et à deux endroits, ce qui est plus
   * robuste qu'un filtre unique :
   *
   *   · l'état du contrat porte la mémoire — un rang inférieur n'écrase rien,
   *     donc un `signed` retardé ne rouvre pas un contrat déjà signé ;
   *   · si le contrat a été relancé entre-temps, sa demande courante n'est plus
   *     celle-ci, et l'applicateur refuse un fait qui ne la concerne pas.
   *
   * Ce qu'on vérifie ici est donc que le fait ARRIVE, correctement attribué, et
   * que rien dans la chaîne de réception ne le déforme.
   */
  const retard = await envoyer(charge('signed', { signer: { email: DEV }, signedAt: 'e' }));
  check('un « signed » retardé reste acheminé — le Panel ne juge pas de sa pertinence',
    retard.dispatched === true);
  const faitRetarde = await derniereProjection();
  check('…il porte bien la demande close, pas une autre',
    faitRetarde.signatureRequestId === DOC);
  check('…et il reste attribué au bon signataire',
    faitRetarde.signerId === adaptateur.signerHandle(DOC, DEV));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7 · Un événement ne peut pas faire avancer la demande d’un AUTRE fournisseur');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  await WebhookEvent.deleteMany({});
  await SignatureBinding.deleteMany({});
  /** La MÊME référence, mais détenue par Yousign. */
  await SignatureBinding.create({
    projectId: PROJET, environment: 'TEST', resourceType: 'REQUEST',
    provider: 'YOUSIGN', resourceId: DOC, documentId: DOC,
    contractRef: CONTRAT, source: 'CREATED', createdAt: new Date().toISOString(),
  });
  await JournalEntry.deleteMany({});

  const croise = await envoyer(charge('signed', { signer: { email: DEV }, signedAt: 'f' }));
  /**
   * SANS CE CONTRÔLE, la conséquence ne serait pas une erreur : ce serait un
   * contrat marqué signé par un événement qui ne le concerne pas. Rien ne le
   * signalerait, et la date de signature serait fausse sur un objet juridique.
   */
  check('un événement OpenSign sur une demande Yousign est REFUSÉ',
    croise.dispatched === false && croise.dispatchReason === 'PROVIDER_MISMATCH');
  check('…et rien n’a été projeté', await compterProjections() === 0);
}

await stopMemoryMongo();
finish();
