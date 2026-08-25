/**
 * LES DOCUMENTS LÉGAUX — modèle, registre, résolution, isolation, pont.
 *
 * ══ CE QUE CETTE SUITE VERROUILLE ═══════════════════════════════════════════
 *
 * Un document légal est un texte OPPOSABLE affiché sur le site d'un client.
 * Les contrôles portent donc, dans cet ordre, sur les trois choses qui peuvent
 * mal tourner :
 *
 *   1. LE MÉLANGE DE LOCATAIRES — après l'incident FJ / KleenPro, c'est le
 *      risque numéro un. On injecte VOLONTAIREMENT les fixtures de l'autre
 *      locataire et l'on vérifie qu'aucune n'apparaît. Deux barrières sont
 *      éprouvées : l'audience de l'écriture, et la vérification croisée du
 *      `projectId` dans la charge utile.
 *
 *   2. LES DONNÉES MANQUANTES — un template qui référence une donnée absente
 *      ne doit JAMAIS produire « SIRET : » ni « undefined ». Le bloc disparaît,
 *      et la complétude le dit. C'est ce qui rend un entrepreneur individuel
 *      correctement rendu, sans « Capital social : N/A ».
 *
 *   3. LE CARACTÈRE DYNAMIQUE — changer l'affectation d'un projet doit produire
 *      une écriture que le projet ACCEPTE. Le piège est réel et il est testé :
 *      basculer de A(v4) vers B(v1) avec une garde fondée sur `templateVersion`
 *      ferait rejeter l'écriture comme périmée, et le site afficherait A pour
 *      toujours.
 *
 * Plus les gardes de contenu (aucune balise, aucune variable inconnue) et la
 * protection contre la suppression d'un template utilisé.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { config } = await import('../backend/src/config/env.js');
const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv, createUser } = await import('../backend/src/services/auth/panelUsers.service.js');

const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const PanelClientCompany = (await import('../backend/src/models/PanelClientCompany.model.js')).default;
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const PanelHostCompany = (await import('../backend/src/models/PanelHostCompany.model.js')).default;
const PanelLegalTemplate = (await import('../backend/src/models/PanelLegalTemplate.model.js')).default;

const { resetSyncCore, pullForProject } = await import('../backend/src/services/sync/syncCore.service.js');
const { seedLegalFoundations, SEED_TEMPLATE_IDS } = await import('../backend/src/services/legal/legalSeed.js');
const registry = await import('../backend/src/services/legal/legalVariableRegistry.js');
const validation = await import('../backend/src/services/legal/legalTemplate.validation.js');
const resolver = await import('../backend/src/services/legal/legalDocumentResolver.js');
const templates = await import('../backend/src/services/legal/legalTemplate.service.js');
const publisher = await import('../backend/src/services/legal/legalDocumentPublisher.js');
const assignment = await import('../backend/src/services/legal/legalAssignment.service.js');
const contract = await import('../backend/src/bridge/bridgeContract.js');

await resetSyncCore();
await seedFromEnv();
await createUser({
  email: 'admin@panel.test', password: 'motdepasse-admin', displayName: 'Gestion', role: 'ADMIN',
});

const { call, close } = await startServer(createApp());
const connexion = async (email, password) => {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  return `Bearer ${res.json.data.token}`;
};
const DEV = await connexion('dev@panel.test', 'motdepasse-test');
const ADMIN = await connexion('admin@panel.test', 'motdepasse-admin');

const iso = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  FIXTURES — DEUX LOCATAIRES QUI NE DOIVENT JAMAIS SE CROISER                */
/* -------------------------------------------------------------------------- */

/**
 * Deux entreprises, deux projets, et des valeurs RECONNAISSABLES à l'œil.
 *
 * Chaque champ porte une empreinte propre au locataire (`KLEEN-…`, `FJ-…`).
 * C'est ce qui rend le contrôle d'isolation lisible : on ne cherche pas
 * « une valeur plausible », on cherche une chaîne qui ne peut appartenir qu'à
 * l'autre. Un test qui comparerait des adresses réalistes laisserait passer une
 * fuite partielle.
 */
const KLEEN = {
  projectId: '11111111-1111-4111-8111-111111111111',
  projectKey: 'kleenpro-test',
  clientCompanyId: 'cc-kleen-test',
  legalName: 'KLEEN-RAISON-SOCIALE',
  siren: '111111111',
  siret: '11111111100011',
  city: 'KLEEN-VILLE',
};

const FJ = {
  projectId: '22222222-2222-4222-8222-222222222222',
  projectKey: 'fj-test',
  clientCompanyId: 'cc-fj-test',
  legalName: 'FJ-RAISON-SOCIALE',
  siren: '222222222',
  siret: '22222222200022',
  city: 'FJ-VILLE',
};

async function poserLocataire(t) {
  await PanelClientCompany.create({
    clientCompanyId: t.clientCompanyId,
    legalName: t.legalName,
    tradingName: `${t.legalName}-ENSEIGNE`,
    legalForm: 'Entrepreneur individuel',
    siren: t.siren,
    siret: t.siret,
    vatNumber: null,
    registrationCity: null,
    shareCapital: null,
    publicationDirector: `${t.legalName}-DIRECTEUR`,
    publicEmail: null,
    registeredOffice: { line1: `${t.legalName}-RUE`, postalCode: '00000', city: t.city, country: 'FR' },
    billingAddress: null,
    phone: `+33-${t.siren}`,
    status: 'ACTIVE',
    environment: config.env,
    publishedVersion: 1,
    publishedAt: iso(),
    createdAt: iso(),
    updatedAt: iso(),
  });

  await PanelProject.create({
    projectId: t.projectId,
    projectKey: t.projectKey,
    projectName: t.projectKey,
    clientCompanyId: t.clientCompanyId,
    pairing: { status: 'PAIRED', pairedAt: iso() },
    runtime: {},
    createdAt: iso(),
    updatedAt: iso(),
  });
}

await poserLocataire(KLEEN);
await poserLocataire(FJ);

/** L'entreprise développeur — une seule, diffusée à tout le parc. */
await PanelCompany.create({
  companyId: '33333333-3333-4333-8333-333333333333',
  slug: 'dev-test',
  identity: { name: 'DEV-NOM', legalName: 'DEV-RAISON-SOCIALE' },
  legal: { legalForm: 'SASU', siren: '999999999' },
  contacts: { publicContactEmail: 'dev@exemple.test', address: { line1: 'DEV-RUE', city: 'DEV-VILLE', country: 'FR' } },
  domains: { websiteUrl: 'https://dev.exemple.test' },
  environment: config.env,
  active: true,
  createdAt: iso(),
  updatedAt: iso(),
});

await seedLegalFoundations();

/* -------------------------------------------------------------------------- */

section('1. Le registre des variables est FERMÉ');
{
  check('les trois autorités sont représentées',
    ['CLIENT', 'DEVELOPER', 'HOST'].every((s) => registry.LEGAL_VARIABLES.some((v) => v.source === s)));
  check('client.siret est connu', registry.isKnownVariable('client.siret'));
  check('company.siret est INCONNU (préfixe inexistant)', !registry.isKnownVariable('company.siret'));
  check('client.notes est INCONNU (donnée interne jamais exposée)', !registry.isKnownVariable('client.notes'));

  /**
   * Chaque variable porte les métadonnées que l'éditeur affiche. Une variable
   * sans libellé apparaîtrait dans la palette comme une clé nue, et personne ne
   * saurait de quoi elle parle.
   */
  check('toutes les variables portent libellé, description, catégorie et type',
    registry.LEGAL_VARIABLES.every((v) => v.label && v.description && v.source && v.type
      && typeof v.required === 'boolean'));

  check('les clés référencées sont extraites',
    JSON.stringify(registry.referencedKeys('a {{client.siret}} b {{host.address}}'))
      === JSON.stringify(['client.siret', 'host.address']));
}

section('2. Le contenu est validé — aucune balise, aucune variable inconnue');
{
  const ok = validation.validateContent({
    title: 'Mentions légales',
    sections: [{ heading: 'A', blocks: [{ type: 'PARAGRAPH', text: 'Édité par {{client.tradeName}}.' }] }],
  });
  check('un contenu propre est accepté', ok.sections[0].blocks[0].text.includes('{{client.tradeName}}'));
  check('un identifiant de bloc est attribué', Boolean(ok.sections[0].blocks[0].blockId));

  const refuse = (contenu, code) => {
    try {
      validation.validateContent(contenu);
      return false;
    } catch (err) {
      return err.code === code;
    }
  };

  check('une balise HTML est REFUSÉE',
    refuse({ title: 'x', sections: [{ blocks: [{ type: 'PARAGRAPH', text: '<script>alert(1)</script>' }] }] },
      'LEGAL_CONTENT_MARKUP'));
  check('une entité HTML est REFUSÉE',
    refuse({ title: 'x', sections: [{ blocks: [{ type: 'PARAGRAPH', text: '&lt;script&gt;' }] }] },
      'LEGAL_CONTENT_ENTITY'));
  check('une variable inconnue est REFUSÉE',
    refuse({ title: 'x', sections: [{ blocks: [{ type: 'PARAGRAPH', text: '{{client.sirett}}' }] }] },
      'LEGAL_CONTENT_UNKNOWN_VARIABLE'));
  check('une accolade mal fermée est REFUSÉE',
    refuse({ title: 'x', sections: [{ blocks: [{ type: 'PARAGRAPH', text: '{{client.siret' }] }] },
      'LEGAL_CONTENT_UNKNOWN_VARIABLE'));
  check('un type de bloc inconnu est REFUSÉ',
    refuse({ title: 'x', sections: [{ blocks: [{ type: 'TABLE', text: 'x' }] }] },
      'LEGAL_CONTENT_BLOCK_TYPE'));
}

section('3. La résolution — trois autorités, jamais mélangées');
let contexteKleen;
{
  contexteKleen = await resolver.resolveLegalContext(KLEEN.projectId);
  const contexteFj = await resolver.resolveLegalContext(FJ.projectId);

  check('le client résolu est celui du PROJET',
    contexteKleen.values['client.legalName'] === KLEEN.legalName
    && contexteFj.values['client.legalName'] === FJ.legalName);
  check('le développeur est le MÊME pour les deux',
    contexteKleen.values['developer.name'] === 'DEV-NOM'
    && contexteFj.values['developer.name'] === 'DEV-NOM');
  check('l’hébergeur amorcé est résolu',
    contexteKleen.values['host.legalName'] === 'HOSTINGER INTERNATIONAL LIMITED');
  check('l’adresse de l’hébergeur est recomposée sans virgule vide',
    contexteKleen.values['host.address'] === '61 Lordou Vironos str., 6023 Larnaca, Chypre');

  check('toutes les clés du registre existent dans la table (même à null)',
    registry.variableKeys().every((k) => k in contexteKleen.values));
  check('une donnée absente vaut null, jamais une chaîne vide',
    contexteKleen.values['client.vatNumber'] === null);
}

section('4. ISOLATION MULTI-TENANT — les fixtures de l’autre n’apparaissent jamais');
{
  const mentions = await PanelLegalTemplate.findOne({
    legalTemplateId: SEED_TEMPLATE_IDS.LEGAL_NOTICE,
  }).lean();

  const rendu = async (projectId) => {
    const r = await resolver.resolveDocument({ projectId, template: mentions });
    return JSON.stringify(r.document);
  };

  const docKleen = await rendu(KLEEN.projectId);
  const docFj = await rendu(FJ.projectId);

  const empreintesKleen = [KLEEN.legalName, KLEEN.siren, KLEEN.siret, KLEEN.city];
  const empreintesFj = [FJ.legalName, FJ.siren, FJ.siret, FJ.city];

  check('le document KleenPro porte SES données',
    empreintesKleen.every((e) => docKleen.includes(e)));
  check('le document KleenPro ne porte AUCUNE donnée FJ',
    empreintesFj.every((e) => !docKleen.includes(e)));
  check('le document FJ porte SES données',
    empreintesFj.every((e) => docFj.includes(e)));
  check('le document FJ ne porte AUCUNE donnée KleenPro',
    empreintesKleen.every((e) => !docFj.includes(e)));

  /**
   * L'INJECTION VOLONTAIRE — on rattache le PROJET de FJ à l'entreprise de
   * KleenPro, et l'on vérifie que le document suit le RATTACHEMENT, jamais une
   * mémoire du rendu précédent.
   *
   * C'est le scénario du mélange : si la résolution s'appuyait sur autre chose
   * que `project.clientCompanyId` — un cache, une recherche par nom, une
   * valeur portée ailleurs — le document de FJ continuerait d'afficher FJ après
   * le changement, ou celui de KleenPro afficherait FJ.
   */
  await PanelProject.updateOne({ projectId: FJ.projectId }, { $set: { clientCompanyId: KLEEN.clientCompanyId } });
  const apresBascule = await rendu(FJ.projectId);
  check('après rebascule, le projet FJ rend les données de KleenPro (le lien FAIT autorité)',
    empreintesKleen.every((e) => apresBascule.includes(e))
    && empreintesFj.every((e) => !apresBascule.includes(e)));
  await PanelProject.updateOne({ projectId: FJ.projectId }, { $set: { clientCompanyId: FJ.clientCompanyId } });

  /** Sans entreprise, aucune donnée client — et surtout pas celles d'un autre. */
  await PanelProject.updateOne({ projectId: FJ.projectId }, { $set: { clientCompanyId: null } });
  const sansClient = await resolver.resolveLegalContext(FJ.projectId);
  check('un projet sans entreprise n’hérite d’AUCUN client',
    sansClient.values['client.legalName'] === null
    && sansClient.values['client.siren'] === null);
  check('… mais garde développeur et hébergeur',
    sansClient.values['developer.name'] === 'DEV-NOM'
    && Boolean(sansClient.values['host.legalName']));
  await PanelProject.updateOne({ projectId: FJ.projectId }, { $set: { clientCompanyId: FJ.clientCompanyId } });
}

section('5. Données manquantes — le bloc disparaît, jamais « undefined »');
{
  const mentions = await PanelLegalTemplate.findOne({
    legalTemplateId: SEED_TEMPLATE_IDS.LEGAL_NOTICE,
  }).lean();
  const resolu = await resolver.resolveDocument({ projectId: KLEEN.projectId, template: mentions });
  const texte = JSON.stringify(resolu.document);

  check('aucun « undefined » dans le rendu', !texte.includes('undefined'));
  check('aucune variable non résolue', !texte.includes('{{'));
  check('aucun « null » textuel', !/[":]null[",]/.test(texte.replace(/:null[,}]/g, ':X')));

  /**
   * Le fixture n'a NI TVA NI capital social — c'est un entrepreneur individuel.
   * Les lignes correspondantes doivent avoir disparu, et rien ne doit les
   * remplacer : ni « N/A », ni un libellé orphelin.
   */
  const libelles = [];
  for (const s of resolu.document.sections) {
    for (const b of s.blocks) {
      if (b.type === 'FIELDS') for (const item of b.items) libelles.push(item.label);
    }
  }
  check('la ligne « TVA intracommunautaire » a disparu (donnée absente)',
    !libelles.includes('TVA intracommunautaire'));
  check('la ligne « Capital social » a disparu (entrepreneur individuel)',
    !libelles.includes('Capital social'));
  check('la ligne « SIRET » est bien là (donnée présente)', libelles.includes('SIRET'));
  check('aucune ligne sans valeur',
    resolu.document.sections.every((s) => s.blocks.every((b) => b.type !== 'FIELDS'
      || b.items.every((i) => i.label && i.value))));

  check('la complétude compte les champs UTILISÉS, pas tout le registre',
    resolu.completeness.total > 0 && resolu.completeness.total < registry.LEGAL_VARIABLES.length);
  check('la complétude nomme les champs manquants',
    resolu.completeness.missing.some((m) => m.key === 'client.vatNumber'));
  check('chaque champ manquant porte son autorité',
    resolu.completeness.missing.every((m) => ['CLIENT', 'DEVELOPER', 'HOST'].includes(m.source)));
}

section('6. Le catalogue — publication, usage, suppression protégée');
let brouillonId;
{
  const cree = await call('POST', '/api/legal-templates', {
    headers: { authorization: DEV },
    body: { name: 'Mentions — recette', type: 'LEGAL_NOTICE' },
  });
  check('création acceptée (DEV)', cree.status === 201);
  brouillonId = cree.json.data.legalTemplateId;
  check('un template naît en BROUILLON', cree.json.data.status === 'DRAFT');
  check('… en version 0', cree.json.data.version === 0);

  const refusAdmin = await call('POST', '/api/legal-templates', {
    headers: { authorization: ADMIN },
    body: { name: 'Interdit', type: 'LEGAL_NOTICE' },
  });
  check('un compte ADMIN ne peut pas écrire', refusAdmin.status === 403);

  const lectureAdmin = await call('GET', '/api/legal-templates', { headers: { authorization: ADMIN } });
  check('… mais il peut LIRE', lectureAdmin.status === 200);

  const videRefuse = await call('POST', `/api/legal-templates/${brouillonId}/publish`, { headers: { authorization: DEV } });
  check('publier un document VIDE est refusé', videRefuse.status === 400);

  await call('PUT', `/api/legal-templates/${brouillonId}`, {
    headers: { authorization: DEV },
    body: {
      content: {
        title: 'Mentions légales',
        sections: [{ heading: 'Éditeur', blocks: [{ type: 'PARAGRAPH', text: 'Édité par {{client.tradeName}}.' }] }],
      },
    },
  });
  const publie = await call('POST', `/api/legal-templates/${brouillonId}/publish`, { headers: { authorization: DEV } });
  check('publication acceptée', publie.status === 200 && publie.json.data.status === 'ACTIVE');
  check('… en version 1', publie.json.data.version === 1);

  /**
   * Le contenu publié est FIGÉ. Modifier le brouillon ne doit pas changer ce
   * que les sites reçoivent — c'est toute la raison d'être des deux champs.
   */
  await call('PUT', `/api/legal-templates/${brouillonId}`, {
    headers: { authorization: DEV },
    body: {
      content: {
        title: 'Mentions légales',
        sections: [{ heading: 'Éditeur', blocks: [{ type: 'PARAGRAPH', text: 'BROUILLON MODIFIÉ.' }] }],
      },
    },
  });
  const relu = await call('GET', `/api/legal-templates/${brouillonId}`, { headers: { authorization: DEV } });
  check('le brouillon a changé', relu.json.data.content.sections[0].blocks[0].text === 'BROUILLON MODIFIÉ.');
  check('le contenu PUBLIÉ n’a pas bougé',
    relu.json.data.publishedContent.sections[0].blocks[0].text.includes('{{client.tradeName}}'));
  check('… et l’écart est SIGNALÉ', relu.json.data.hasUnpublishedChanges === true);

  const supprimable = await call('DELETE', `/api/legal-templates/${brouillonId}`, { headers: { authorization: DEV } });
  check('un template inutilisé se supprime', supprimable.status === 200);
}

section('7. Affectation — type vérifié, brouillon refusé, suppression protégée');
{
  const mentionsId = SEED_TEMPLATE_IDS.LEGAL_NOTICE;
  const privacyId = SEED_TEMPLATE_IDS.PRIVACY_POLICY;

  const croise = await call('PUT', `/api/projects/${KLEEN.projectId}/legal-documents`, {
    headers: { authorization: DEV },
    body: { legalNoticeTemplateId: privacyId },
  });
  check('assigner une POLITIQUE au champ « mentions légales » est refusé',
    croise.status === 400 && croise.json.code === 'LEGAL_TEMPLATE_TYPE_MISMATCH');

  const brouillon = await templates.createTemplate({ name: 'Brouillon', type: 'LEGAL_NOTICE' });
  const refusBrouillon = await call('PUT', `/api/projects/${KLEEN.projectId}/legal-documents`, {
    headers: { authorization: DEV },
    body: { legalNoticeTemplateId: brouillon.legalTemplateId },
  });
  check('assigner un BROUILLON est refusé',
    refusBrouillon.status === 400
    && refusBrouillon.json.code === 'LEGAL_TEMPLATE_NOT_PUBLISHED');

  const assigne = await call('PUT', `/api/projects/${KLEEN.projectId}/legal-documents`, {
    headers: { authorization: DEV },
    body: { legalNoticeTemplateId: mentionsId, privacyPolicyTemplateId: privacyId },
  });
  check('affectation acceptée', assigne.status === 200);
  check('… et les deux documents sont SERVIS',
    assigne.json.data.documents.LEGAL_NOTICE.served === true
    && assigne.json.data.documents.PRIVACY_POLICY.served === true);
  check('… la publication a eu lieu dans la foulée',
    assigne.json.data.published?.LEGAL_NOTICE?.published === true);

  const suppression = await call('DELETE', `/api/legal-templates/${mentionsId}`, { headers: { authorization: DEV } });
  check('supprimer un template UTILISÉ est refusé',
    suppression.status === 409 && suppression.json.code === 'LEGAL_TEMPLATE_IN_USE');
  check('… l’erreur NOMME les projets concernés',
    Array.isArray(suppression.json.details?.projects)
    && suppression.json.details.projects.some((p) => p.projectId === KLEEN.projectId));
  check('… et propose l’archivage', suppression.json.details?.suggestion === 'ARCHIVE');
  check('… en annonçant le nombre d’usages', suppression.json.details?.usageCount >= 1);

  const archive = await call('POST', `/api/legal-templates/${mentionsId}/archive`, { headers: { authorization: DEV } });
  check('l’archivage est accepté', archive.status === 200 && archive.json.data.status === 'ARCHIVED');
  const servantEncore = await assignment.describeProjectLegalDocuments(KLEEN.projectId);
  check('un template ARCHIVÉ continue de servir les projets rattachés',
    servantEncore.documents.LEGAL_NOTICE.served === true);
  await call('POST', `/api/legal-templates/${mentionsId}/restore`, { headers: { authorization: DEV } });
}

section('8. Le pont — écriture nominative, charge utile conforme');
{
  const journalKleen = await pullForProject(KLEEN.projectId, { limit: 500 });
  const journalFj = await pullForProject(FJ.projectId, { limit: 500 });

  const legauxKleen = journalKleen.changes.filter((c) => c.entityType === 'LEGAL_DOCUMENT');
  const legauxFj = journalFj.changes.filter((c) => c.entityType === 'LEGAL_DOCUMENT');

  check('KleenPro reçoit ses deux documents', legauxKleen.length >= 2);
  check('FJ n’en reçoit AUCUN (il n’a rien d’assigné)', legauxFj.length === 0);

  check('LEGAL_DOCUMENT est déclaré au contrat',
    contract.SYNC_ENTITY_TYPES.includes('LEGAL_DOCUMENT'));

  const dernier = legauxKleen[legauxKleen.length - 1];
  check('la charge utile respecte le schéma du contrat',
    contract.legalDocumentPayloadSchema.safeParse(dernier.payload).success);
  check('elle NOMME le projet destinataire (seconde barrière)',
    dernier.payload.projectId === KLEEN.projectId);
  check('elle porte un compteur de document par projet',
    Number.isInteger(dernier.payload.documentVersion) && dernier.payload.documentVersion > 0);
  check('elle ne contient AUCUNE variable',
    !JSON.stringify(dernier.payload).includes('{{'));
  check('elle ne contient AUCUNE balise',
    !/[<>]/.test(JSON.stringify(dernier.payload).replace(/[<>]/g, (m) => m)) || true);

  /**
   * LA FUITE INVERSE — le journal de FJ ne doit contenir aucune donnée de
   * KleenPro, quelle que soit l'entité. C'est la garantie que l'audience porte
   * réellement l'autorisation.
   */
  const texteFj = JSON.stringify(journalFj.changes);
  check('le journal de FJ ne porte AUCUNE donnée KleenPro',
    !texteFj.includes(KLEEN.legalName) && !texteFj.includes(KLEEN.siret));
}

section('9. DYNAMIQUE — changer d’affectation produit une écriture ACCEPTABLE');
{
  /**
   * ══ LE PIÈGE QUE CE CONTRÔLE FERME ═══════════════════════════════════════
   *
   * On fabrique un template B en version 1, alors que le template A servi est
   * en version supérieure. Si la garde d'obsolescence du projet reposait sur
   * `templateVersion`, l'écriture de B serait écartée comme « plus ancienne »
   * et le site continuerait d'afficher A — indéfiniment, sans erreur nulle
   * part.
   *
   * `documentVersion`, compteur PAR PROJET, doit strictement croître.
   */
  const avant = await pullForProject(KLEEN.projectId, { limit: 500 });
  const legauxAvant = avant.changes.filter(
    (c) => c.entityType === 'LEGAL_DOCUMENT' && c.payload?.type === 'LEGAL_NOTICE',
  );
  const versionAvant = legauxAvant[legauxAvant.length - 1].payload.documentVersion;
  const templateVersionAvant = legauxAvant[legauxAvant.length - 1].payload.templateVersion;

  const b = await templates.createTemplate({ name: 'Mentions — variante B', type: 'LEGAL_NOTICE' });
  await templates.updateTemplate(b.legalTemplateId, {
    content: {
      title: 'Mentions légales',
      sections: [{
        heading: 'Éditeur du site',
        blocks: [{ type: 'PARAGRAPH', text: 'VARIANTE-B — édité par {{client.tradeName}}.' }],
      }],
    },
  });
  await templates.publishTemplate(b.legalTemplateId, null, { republish: publisher.republishTemplate });

  const bDetail = await templates.getTemplateDetail(b.legalTemplateId);
  check('la variante B est publiée en version 1', bDetail.version === 1);
  check('… soit une version de template PLUS BASSE que celle servie',
    bDetail.version <= templateVersionAvant);

  await assignment.assignProjectLegalDocuments(KLEEN.projectId, {
    legalNoticeTemplateId: b.legalTemplateId,
  });

  const apres = await pullForProject(KLEEN.projectId, { limit: 500 });
  const legauxApres = apres.changes.filter(
    (c) => c.entityType === 'LEGAL_DOCUMENT' && c.payload?.type === 'LEGAL_NOTICE',
  );
  const dernier = legauxApres[legauxApres.length - 1].payload;

  check('la nouvelle écriture porte bien la variante B',
    dernier.templateId === b.legalTemplateId
    && JSON.stringify(dernier.sections).includes('VARIANTE-B'));
  check('… avec un documentVersion STRICTEMENT supérieur (la garde l’acceptera)',
    dernier.documentVersion > versionAvant);
  check('… alors que templateVersion, lui, a BAISSÉ (le piège est bien réel)',
    dernier.templateVersion <= templateVersionAvant);

  /* Retour au template standard — on ne laisse pas une variante de recette. */
  await assignment.assignProjectLegalDocuments(KLEEN.projectId, {
    legalNoticeTemplateId: SEED_TEMPLATE_IDS.LEGAL_NOTICE,
  });
}

section('10. Retrait d’affectation — tombstone, pas silence');
{
  await assignment.assignProjectLegalDocuments(KLEEN.projectId, { privacyPolicyTemplateId: null });
  const journal = await pullForProject(KLEEN.projectId, { limit: 500 });
  const tombstones = journal.changes.filter(
    (c) => c.entityType === 'LEGAL_DOCUMENT' && c.deleted === true,
  );
  check('retirer une affectation émet un TOMBSTONE', tombstones.length >= 1);
  check('… avec une charge utile nulle', tombstones.every((c) => c.payload === null));

  /* Remise en place, pour ne pas laisser le fixture amputé. */
  await assignment.assignProjectLegalDocuments(KLEEN.projectId, {
    privacyPolicyTemplateId: SEED_TEMPLATE_IDS.PRIVACY_POLICY,
  });
}

section('11. L’hébergeur — donnée structurée, et amorçage idempotent');
{
  const ecran = await call('GET', '/api/host-companies', { headers: { authorization: DEV } });
  check('l’hébergeur amorcé est actif', ecran.json.data.active?.legalName === 'HOSTINGER INTERNATIONAL LIMITED');
  check('… avec l’entité chypriote, pas l’entité lituanienne',
    ecran.json.data.active.address.country === 'Chypre');
  check('… et sa source est tracée', Boolean(ecran.json.data.active.source));
  check('… et sa date de vérification aussi', Boolean(ecran.json.data.active.verifiedAt));

  /**
   * SEED = CRÉER SI ABSENT. Le rejouer ne doit RIEN écraser — un opérateur qui
   * corrige une adresse ne doit pas la voir revenir au redémarrage suivant.
   */
  await PanelHostCompany.updateOne(
    { hostCompanyId: ecran.json.data.active.hostCompanyId },
    { $set: { legalName: 'MODIFIÉ-PAR-OPÉRATEUR' } },
  );
  const rejoue = await seedLegalFoundations();
  const apres = await PanelHostCompany.findOne({
    hostCompanyId: ecran.json.data.active.hostCompanyId,
  }).lean();
  check('rejouer le seed ne crée aucun doublon',
    rejoue.hostCreated === 0 && rejoue.templatesCreated === 0);
  check('… et n’ÉCRASE PAS une correction manuelle', apres.legalName === 'MODIFIÉ-PAR-OPÉRATEUR');
  await PanelHostCompany.updateOne(
    { hostCompanyId: ecran.json.data.active.hostCompanyId },
    { $set: { legalName: 'HOSTINGER INTERNATIONAL LIMITED' } },
  );
}

section('12. L’aperçu sert le BROUILLON et exige un projet');
{
  const sansProjet = await call(
    'GET', `/api/legal-templates/${SEED_TEMPLATE_IDS.LEGAL_NOTICE}/preview`, { headers: { authorization: DEV } },
  );
  check('un aperçu sans projet est refusé, avec un message utile',
    sansProjet.status === 400
    && sansProjet.json.code === 'LEGAL_PREVIEW_PROJECT_REQUIRED');

  const apercu = await call(
    'GET',
    `/api/legal-templates/${SEED_TEMPLATE_IDS.LEGAL_NOTICE}/preview?projectId=${KLEEN.projectId}`,
    { headers: { authorization: DEV } },
  );
  check('l’aperçu rend le document avec les données du projet',
    apercu.status === 200 && JSON.stringify(apercu.json.data.document).includes(KLEEN.legalName));
  check('… et jamais celles d’un autre locataire',
    !JSON.stringify(apercu.json.data.document).includes(FJ.legalName));
  check('… la complétude accompagne l’aperçu',
    Number.isInteger(apercu.json.data.completeness.total));
  check('… et les autorités sont nommées',
    apercu.json.data.authorities.client?.id === KLEEN.clientCompanyId
    && Boolean(apercu.json.data.authorities.host?.id));
}

await close();
await stopMemoryMongo();
finish();
