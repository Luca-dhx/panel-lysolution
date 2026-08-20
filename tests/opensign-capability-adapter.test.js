// OPENSIGN — L'ADAPTATEUR DE CAPACITÉS, ET L'AIGUILLAGE ENTRE DEUX FOURNISSEURS.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md.
//
// ══ CE QUE CETTE SUITE PROUVE ═══════════════════════════════════════════════
//
// Que les cinq capacités `signature.*` tiennent le MÊME contrat qu'avant, en
// étant servies par un autre fournisseur — et que les demandes ouvertes chez
// l'ancien restent servies par l'ancien.
//
// Aucun appel réseau : le transport est injecté. Ce qui est éprouvé ici est la
// TRADUCTION — la charge utile envoyée, l'identité des signataires, le
// vocabulaire rendu, et le choix de l'exécutant. La conformité du fournisseur,
// elle, se prouve en bac à sable réel (`tools/opensign/`).
import { check, finish, section, setTestEnv } from './helpers/harness.js';
import { startMemoryMongo, connectTestDatabase, stopMemoryMongo } from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const adaptateur = await import('../backend/src/services/integratedApi/opensign/openSignAdapters.js');
const routing = await import('../backend/src/services/integratedApi/signature/signatureProviderRouting.js');
const vocabulaire = await import('../backend/src/services/integratedApi/signature/signatureVocabulary.js');
const limites = await import('../backend/src/services/integratedApi/signature/signatureDocumentLimits.js');
const ownership = await import('../backend/src/services/integratedApi/signature/signatureOwnership.js');
const registre = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const { default: Binding } = await import('../backend/src/models/PanelSignatureBinding.model.js');

const { buildCreateDocumentPayload, signerHandle, OPENSIGN_ADAPTERS } = adaptateur;

const SIGNATAIRES = [
  {
    role: 'DEVELOPER', firstName: 'Ada', lastName: 'Lovelace', email: 'Ada@Example.com',
    redirectUrls: { success: 'https://x.test/dev', error: 'https://x.test/dev', decline: 'https://x.test/dev' },
  },
  {
    role: 'CLIENT', firstName: 'Alan', lastName: 'Turing', email: 'alan@example.com',
    redirectUrls: { success: 'https://x.test/client-ok', error: 'https://x.test/ko', decline: 'https://x.test/non' },
  },
];
const ZONES = [
  { signerRole: 'DEVELOPER', page: 1, x: 45, y: 90, width: 150, height: 45 },
  { signerRole: 'CLIENT', page: 2, x: 380, y: 400, width: 150, height: 45 },
];
const ENTREE = {
  contractRef: '68a1b2c3d4e5f60718293a4b',
  name: 'Contrat REC-2026-001',
  documentBase64: Buffer.from('%PDF-1.4 fixture').toString('base64'),
  documentFilename: 'contrat.pdf',
  signers: SIGNATAIRES,
  fields: ZONES,
  operationId: 'sig-open-68a1b2c3d4e5f60718293a4b',
};

/* ══════════════════════════════════════════════════════════════════════════ */
section('1 · La charge utile envoyée à OpenSign');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const p = buildCreateDocumentPayload(ENTREE);

  check('le PDF part en base64, sous « file »', p.file === ENTREE.documentBase64);
  check('le titre est celui de la demande', p.title === ENTREE.name);
  check('deux signataires', p.signers.length === 2);

  /**
   * LE RÔLE MÉTIER TRAVERSE TEL QUEL.
   *
   * `role` est un libellé LIBRE chez OpenSign. Y écrire nos rôles évite une
   * table de correspondance — et surtout, c'est ce que la piste d'audit et les
   * écrans du fournisseur afficheront à un humain qui viendrait regarder.
   */
  check('DEVELOPER et CLIENT passent en clair', p.signers.map((s) => s.role).join() === 'DEVELOPER,CLIENT');
  check('le nom est composé prénom + nom', p.signers[0].name === 'Ada Lovelace');
  check('tous sont des signataires (ni relecteur, ni approbateur)',
    p.signers.every((s) => s.signer_role === 'signer'));

  /**
   * LES ZONES SUIVENT LEUR SIGNATAIRE.
   *
   * Chez Yousign, un champ était posé PUIS lié par `signer_id`. Chez OpenSign
   * il est IMBRIQUÉ. Une erreur de regroupement donnerait un document où le
   * client signerait à la place du développeur — accepté par le fournisseur,
   * faux pour le contrat, et invisible avant la signature.
   */
  check('la zone du DEVELOPER est chez le DEVELOPER',
    p.signers[0].widgets.length === 1 && p.signers[0].widgets[0].page === 1);
  check('la zone du CLIENT est chez le CLIENT',
    p.signers[1].widgets.length === 1 && p.signers[1].widgets[0].page === 2);

  /**
   * LES COORDONNÉES NE SUBISSENT AUCUNE CONVERSION.
   *
   * Prouvé en bac à sable : les x/y de l'API sont des POINTS PDF depuis le coin
   * supérieur gauche. Ajouter une échelle « au cas où » déplacerait chaque
   * signature proportionnellement à sa distance à l'origine — le décalage
   * passerait inaperçu en haut de page et manquerait la ligne en bas.
   */
  const zone = p.signers[0].widgets[0];
  check('x, y, w, h passent inchangés',
    zone.x === 45 && zone.y === 90 && zone.w === 150 && zone.h === 45);
  check('le type est « signature »', zone.type === 'signature');

  /**
   * AUCUN E-MAIL. Le parcours actuel présente les liens lui-même (Yousign était
   * appelé en `delivery_mode: 'none'`). Laisser le fournisseur écrire aux
   * signataires changerait le parcours sous prétexte de changer de fournisseur.
   */
  check('le fournisseur n’écrit à personne', p.send_email === false);

  /** L'ordre DEV → CLIENT est une règle métier, et `strict` la fait tenir. */
  check('ordre imposé', p.sendInOrder === true && p.send_in_order_strict === true);
  check('aucun code à usage unique — le lien fait foi', p.enableOTP === false);
  check('le certificat reste un document SÉPARÉ', p.merge_certificate === false);

  /**
   * UNE SEULE URL DE RETOUR, et c'est celle du CLIENT quand l'appelant n'en
   * fournit pas une explicitement : c'est le signataire externe, celui pour qui
   * atterrir quelque part de sensé compte vraiment.
   */
  check('à défaut, l’URL de succès du CLIENT sert de retour',
    p.redirect_url === 'https://x.test/client-ok');
  check('« returnUrl » l’emporte quand elle est fournie',
    buildCreateDocumentPayload({ ...ENTREE, returnUrl: 'https://x.test/retour' })
      .redirect_url === 'https://x.test/retour');
  check('aucune URL de retour ⇒ le champ est ABSENT, pas vide',
    !('redirect_url' in buildCreateDocumentPayload({
      ...ENTREE,
      signers: SIGNATAIRES.map(({ redirectUrls, ...reste }) => reste),
    })));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2 · L’identité d’un signataire — opaque, stable, sans donnée personnelle');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const a = signerHandle('doc123', 'ada@example.com');

  check('la poignée fait 32 caractères hexadécimaux', /^[0-9a-f]{32}$/.test(a));
  check('elle satisfait la borne du contrat (8..64)', a.length >= 8 && a.length <= 64);
  check('elle est STABLE', a === signerHandle('doc123', 'ada@example.com'));

  /**
   * LA CASSE ET LES ESPACES NE CHANGENT RIEN.
   *
   * `Ada@Example.com` et `ada@example.com` désignent la même personne. Sans
   * normalisation, la poignée calculée à l'ouverture ne correspondrait pas à
   * celle recalculée à la lecture — et le signataire deviendrait introuvable
   * dans sa propre demande.
   */
  check('elle normalise casse et espaces',
    a === signerHandle('doc123', '  Ada@Example.COM '));

  /** Aucune adresse ne doit pouvoir se lire dans la poignée. */
  check('elle ne contient aucune trace de l’adresse',
    !a.includes('ada') && !a.includes('example'));

  /**
   * LE DOCUMENT ENTRE DANS LE CALCUL.
   *
   * Sans lui, la poignée d'un signataire serait la même sur tous ses contrats :
   * un identifiant appris sur l'un désignerait quelqu'un sur l'autre.
   */
  check('la même adresse sur un autre document donne une AUTRE poignée',
    a !== signerHandle('doc456', 'ada@example.com'));
  check('deux adresses sur le même document diffèrent',
    a !== signerHandle('doc123', 'alan@example.com'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3 · Le vocabulaire rendu au projet');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const { SIGNATURE_REQUEST_STATE: E, SIGNER_STATE: S, toRequestState, signerStateFromAuditTrace } = vocabulaire;

  check('OpenSign « in-progress » → ONGOING', toRequestState('OPENSIGN', 'in-progress') === E.ONGOING);
  check('OpenSign « completed » → DONE', toRequestState('OPENSIGN', 'completed') === E.DONE);
  check('OpenSign « expired » → EXPIRED', toRequestState('OPENSIGN', 'expired') === E.EXPIRED);
  /**
   * MESURÉ : une RÉVOCATION place le document en `declined`. On ne corrige pas
   * cette confusion du fournisseur — du point de vue du contrat, refus et
   * révocation ont la même conséquence, et inventer une distinction qu'il ne
   * tient pas ferait promettre une information qu'on n'a pas.
   */
  check('OpenSign « declined » → DECLINED', toRequestState('OPENSIGN', 'declined') === E.DECLINED);

  check('Yousign « ongoing » → ONGOING', toRequestState('YOUSIGN', 'ongoing') === E.ONGOING);
  check('Yousign « done » → DONE', toRequestState('YOUSIGN', 'done') === E.DONE);
  check('Yousign « canceled » → CANCELED', toRequestState('YOUSIGN', 'canceled') === E.CANCELED);

  /**
   * UN ÉTAT INCONNU RESTE INCONNU.
   *
   * Le rabattre sur « le mot le plus proche » produirait la même chose sans le
   * dire — et un contrat piloté par une supposition ne se rattrape qu'en le
   * découvrant chez le client.
   */
  check('un état inconnu ne se devine pas', toRequestState('OPENSIGN', 'wibble') === E.UNKNOWN);
  check('un fournisseur inconnu non plus', toRequestState('MAILCHIMP', 'completed') === E.UNKNOWN);

  /** OpenSign ne publie pas d'état de signataire : il publie des DATES. */
  check('ni vu ni signé → PENDING', signerStateFromAuditTrace({ viewed: '', signed: '' }) === S.PENDING);
  check('vu, pas signé → VIEWED', signerStateFromAuditTrace({ viewed: '2026-01-01', signed: '' }) === S.VIEWED);
  check('signé → SIGNED', signerStateFromAuditTrace({ viewed: '2026-01-01', signed: '2026-01-02' }) === S.SIGNED);
  check('aucune trace → UNKNOWN', signerStateFromAuditTrace(null) === S.UNKNOWN);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4 · La taille d’un document — la limite du fournisseur RETENU');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const base64De = (octets) => Buffer.alloc(octets, 0x41).toString('base64');

  check('OpenSign accepte 9 Mo', limites.checkDocumentSize(base64De(9 * 1024 * 1024), { provider: 'OPENSIGN' }).ok);
  /**
   * LE DÉFAUT QUE CETTE BORNE FERME.
   *
   * Sans elle, le Panel acceptait 11 Mo, réservait le contrat, débitait un
   * crédit, et n'apprenait le refus qu'après — avec un message parlant du
   * fournisseur pour un problème qui est celui du PDF.
   */
  const trop = limites.checkDocumentSize(base64De(11 * 1024 * 1024), { provider: 'OPENSIGN' });
  check('…et refuse 11 Mo (limite mesurée : 10 Mo)', trop.ok === false);
  check('…en nommant la limite en Mio, pas en caractères', /10 Mio/.test(trop.message));
  check('…avec un code stable', trop.code === 'SIGNATURE_DOCUMENT_TOO_LARGE');

  /** Chez Yousign, c'est NOTRE transport qui borne, plus haut. */
  check('Yousign accepte 11 Mo — sa limite à lui est plus haute',
    limites.checkDocumentSize(base64De(11 * 1024 * 1024), { provider: 'YOUSIGN' }).ok);
  check('la limite effective est la PLUS BASSE des deux',
    limites.maxDocumentBytesFor('OPENSIGN') === 10 * 1024 * 1024
    && limites.maxDocumentBytesFor('YOUSIGN') === limites.MAX_DOCUMENT_BYTES);
  check('sans fournisseur, seule la limite de transport s’applique',
    limites.maxDocumentBytesFor(null) === limites.MAX_DOCUMENT_BYTES);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5 · L’aiguillage — la demande désigne son exécutant');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  await Binding.deleteMany({});
  const nowIso = new Date().toISOString();
  await Binding.create({
    projectId: 'projet-a', environment: 'TEST', resourceType: 'REQUEST',
    provider: 'YOUSIGN', resourceId: 'ancienne-demande-yousign-0001',
    contractRef: 'contrat-ancien', source: 'CREATED', createdAt: nowIso,
  });
  await Binding.create({
    projectId: 'projet-a', environment: 'TEST', resourceType: 'REQUEST',
    provider: 'OPENSIGN', resourceId: 'nouvelleDem',
    contractRef: 'contrat-recent', source: 'CREATED', createdAt: nowIso,
  });
  /** Un lien écrit AVANT le champ : il n'a pas de fournisseur inscrit. */
  await Binding.collection.insertOne({
    projectId: 'projet-a', environment: 'TEST', resourceType: 'REQUEST',
    resourceId: 'lien-sans-fournisseur-0001',
    contractRef: 'contrat-tres-ancien', source: 'CREATED', createdAt: nowIso, closedAt: null,
  });

  const ctx = { environment: 'TEST' };
  check('une demande OpenSign est servie par OPENSIGN',
    await routing.resolveSignatureProvider(ctx, { signatureRequestId: 'nouvelleDem' }) === 'OPENSIGN');
  check('une demande Yousign reste servie par YOUSIGN',
    await routing.resolveSignatureProvider(ctx, { signatureRequestId: 'ancienne-demande-yousign-0001' }) === 'YOUSIGN');

  /**
   * LE LIEN SANS FOURNISSEUR EST HISTORIQUE, DONC YOUSIGN.
   *
   * Ce n'est pas une supposition : aucun autre code n'a jamais écrit dans cette
   * collection. La migration l'inscrit une fois ; ce repli couvre ceux qu'elle
   * n'aurait pas atteints.
   */
  check('un lien antérieur au champ est traité comme YOUSIGN',
    await routing.resolveSignatureProvider(ctx, { signatureRequestId: 'lien-sans-fournisseur-0001' }) === 'YOUSIGN');

  /**
   * UNE DEMANDE INCONNUE NE DÉCLENCHE AUCUN REPLI.
   *
   * L'aiguilleur rend l'actif, et c'est l'APPARTENANCE qui refuse juste après.
   * Rendre « le plus probable » enverrait un identifiant étranger chez un
   * fournisseur réel, avec les identifiants du Panel.
   */
  check('une demande inconnue tombe sur l’ACTIF, et l’appartenance tranchera',
    await routing.resolveSignatureProvider(ctx, { signatureRequestId: 'jamais-vue-000001' }) === 'OPENSIGN');

  check('un autre monde ne voit pas la demande',
    await routing.providerOfSignatureRequest({ environment: 'PROD', signatureRequestId: 'nouvelleDem' }) === null);

  await Binding.deleteMany({});
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6 · L’appartenance porte le fournisseur dès la réservation');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  await Binding.deleteMany({});
  const claim = await ownership.claimSignatureRequest({
    projectId: 'projet-b', environment: 'TEST',
    contractRef: 'contrat-b', operationId: 'op-reservation-0001', provider: 'OPENSIGN',
  });
  check('la réservation est prise', claim.claimed === true);
  check('…et elle porte déjà le fournisseur, AVANT tout appel',
    claim.binding.provider === 'OPENSIGN');
  check('…avec un identifiant de réservation, pas un identifiant réel',
    String(claim.binding.resourceId).startsWith('pending:'));

  const second = await ownership.claimSignatureRequest({
    projectId: 'projet-b', environment: 'TEST',
    contractRef: 'contrat-b', operationId: 'op-reservation-0002', provider: 'OPENSIGN',
  });
  check('un second clic ne prend PAS une seconde réservation', second.claimed === false);
  check('…et rend celle qui existe', second.binding.contractRef === 'contrat-b');

  await ownership.attachResource({ operationId: 'op-reservation-0001', resourceId: 'docReel123', documentId: 'docReel123' });
  const apres = await Binding.findOne({ createdByOperationId: 'op-reservation-0001' }).lean();
  check('l’identifiant réel remplace la réservation', apres.resourceId === 'docReel123');
  check('…et le fournisseur n’a pas bougé', apres.provider === 'OPENSIGN');
  await Binding.deleteMany({});
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7 · Le contrat de capacité — cinq codes, un exécutant actif');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const codes = ['signature.request.open', 'signature.request.retrieve',
    'signature.signer.retrieve', 'signature.document.download', 'signature.request.cancel'];
  check('l’adaptateur OpenSign sert les cinq',
    codes.every((c) => typeof OPENSIGN_ADAPTERS[c] === 'function'));
  check('…et rien de plus', Object.keys(OPENSIGN_ADAPTERS).length === 5);

  /**
   * AUCUNE CAPACITÉ NE PORTE LE NOM D'UN FOURNISSEUR. C'est l'invariant qui a
   * rendu la bascule invisible depuis les projets — et le seul qui rendrait la
   * prochaine possible.
   */
  check('aucun code ne nomme un fournisseur',
    codes.every((c) => !/opensign|yousign/i.test(c)));

  const ouverture = registre.getCapabilityDefinition('signature.request.open');
  check('l’ouverture accepte une URL de retour de niveau DEMANDE',
    ouverture.inputSchema.safeParse({ ...ENTREE, returnUrl: 'https://x.test/r' }).success);
  check('…et refuse toujours une clé inconnue',
    !ouverture.inputSchema.safeParse({ ...ENTREE, provider: 'OPENSIGN' }).success);
}

await stopMemoryMongo();
finish();
