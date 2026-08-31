/**
 * L'IMPORT JSON D'UN PROSPECT — du rapport de qualification à la fiche.
 *
 * ══ CE QUE CETTE SUITE VERROUILLE ═══════════════════════════════════════════
 *
 *   1. LA LECTURE      un document écrit à la main, avec les mots de l'équipe
 *                      (« nom », « en cours », « refonte », `googleUrl`), donne
 *                      la même fiche qu'un document écrit avec les constantes ;
 *   2. L'APERÇU        il n'écrit RIEN — ni fiche, ni dossier, ni tâche — et il
 *                      dit ce qui va changer, section par section ;
 *   3. TROIS COLLECTIONS  un seul fichier pose la fiche, ses messages, ses
 *                      tâches planifiées et ses rendez-vous ;
 *   4. L'IDEMPOTENCE   réimporter le même fichier ne duplique rien. C'est le
 *                      vrai risque du lot : un rapport corrigé est réimporté,
 *                      et sans rapprochement par clef naturelle la fiche
 *                      finirait avec deux « Fiche Google » et deux accroches ;
 *   5. CE QUI N'EST PAS DÉTRUIT  le mode REMPLACER vide les listes de la fiche,
 *                      jamais l'échéancier ni l'agenda ;
 *   6. CE QUI N'EST PAS DEVINÉ   une clef inconnue n'entre pas « au cas où » ;
 *                      elle est consignée avec sa raison.
 *
 * Le point 4 est celui qui ne se voit pas à l'œil : un doublon d'accroche ne
 * casse rien, il fait juste renvoyer deux fois le même e-mail au prospect.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const { PanelProspect } = await import('../backend/src/models/PanelProspect.model.js');
const { PanelProspectFolder } = await import('../backend/src/models/PanelProspectFolder.model.js');
const { PanelTask } = await import('../backend/src/models/PanelTask.model.js');
const { PanelMeeting } = await import('../backend/src/models/PanelMeeting.model.js');
const { lireDocumentProspect, extraireFiches } = await import(
  '../backend/src/services/prospection/prospectImport.contract.js'
);

await seedFromEnv();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

/* ────────────────────────────────────────────────────────────────────────── */
section('1. La lecture — les mots de l’équipe, pas ceux du modèle');

{
  const { ok, entree, ignores } = lireDocumentProspect({
    nom: 'Boulangerie Martin',
    mail: 'contact@martin.fr',
    telephone: '06 12 34 56 78',
    statut: 'en cours',
    nature: 'refonte',
    googleUrl: 'https://g.page/martin',
    siteActuel: 'martin.fr',
    infos: { 'Budget annoncé': '3 000 €' },
    concurrents: [{ name: 'Pain & Co', url: 'painco.fr', note: 'Refait en 2024' }],
    rowId: 42,
  });

  check('le document est lisible', ok === true);
  check('« nom » vaut `name`', entree.name === 'Boulangerie Martin');
  check('« mail » vaut `email`', entree.email === 'contact@martin.fr');
  check('« en cours » vaut IN_PROGRESS', entree.status === 'IN_PROGRESS');
  check('« refonte » vaut REDESIGN', entree.type === 'REDESIGN');
  check('une colonne `googleUrl` devient un lien nommé',
    entree.links.some((l) => l.label === 'Fiche Google' && l.url === 'https://g.page/martin'));
  check('une adresse sans schéma est rendue cliquable',
    entree.links.some((l) => l.url.startsWith('https://martin.fr')));
  check('un dictionnaire d’informations devient une liste',
    entree.infoFields.some((f) => f.label === 'Budget annoncé' && f.value === '3 000 €'));
  check('un concurrent devient un lien étiqueté',
    entree.links.some((l) => l.label === 'Concurrent — Pain & Co'));
  check('…et sa note devient une information du même nom',
    entree.infoFields.some((f) => f.label === 'Concurrent — Pain & Co' && f.value === 'Refait en 2024'));

  check('une clef inconnue n’est PAS devinée',
    entree.infoFields.every((f) => f.label !== 'rowId'));
  check('…elle est consignée avec sa raison',
    ignores.some((i) => i.path === 'rowId' && /inconnu/i.test(i.reason)));

  /* La différence qui décide de tout en mode REMPLACER : une section absente
     du document ne doit pas être confondue avec une section vide. */
  check('une section absente vaut `null`, pas une liste vide', entree.images === null);
  check('…et une section vide reste une liste',
    Array.isArray(lireDocumentProspect({ name: 'X', links: [] }).entree.links));

  const platOuNon = lireDocumentProspect({ prospect: { name: 'Emboîté' }, messages: [] });
  check('la forme emboîtée est lue comme la forme plate',
    platOuNon.entree.name === 'Emboîté' && Array.isArray(platOuNon.entree.messages));

  check('un fichier de tournée rend toutes ses fiches',
    extraireFiches({ prospects: [{ name: 'a' }, { name: 'b' }] }).length === 2
    && extraireFiches([{ name: 'a' }, { name: 'b' }, 3]).length === 2);

  const casse = lireDocumentProspect('pas un objet');
  check('un document qui n’est pas un objet est REFUSÉ', casse.ok === false);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. L’aperçu n’écrit rien');

const DOCUMENT = {
  name: 'Garage Leblanc',
  email: 'contact@leblanc.fr',
  phone: '04 91 00 00 00',
  status: 'en cours',
  type: 'creation',
  folderPath: 'Garages / Marseille',
  notes: 'Vu sur la route. Devanture refaite.',
  websiteUrl: 'garage-leblanc.fr',
  infoFields: [{ label: 'Qui décide', value: 'M. Leblanc' }],
  messages: [
    { title: 'Accroche', channel: 'E-mail', body: 'Bonjour…', sentAt: '2026-08-20T09:00:00Z' },
    { title: 'Relance 1', channel: 'E-mail', body: 'Je reviens vers vous.' },
  ],
  tasks: [
    { name: 'Rappeler le gérant', dueInDays: 3, subtasks: [{ name: 'Préparer le devis' }] },
  ],
  meetings: [
    { title: 'Visite', scheduledAt: '2026-12-10T10:00:00Z', mode: 'onsite', address: '1 rue du Port' },
  ],
};

{
  const avant = await PanelProspect.countDocuments({});
  const dossiersAvant = await PanelProspectFolder.countDocuments({});

  const apercu = await call('POST', '/api/prospects/import/preview', {
    headers: AUTH, body: { document: DOCUMENT },
  });
  check('l’aperçu répond 200', apercu.status === 200);
  const plan = apercu.json.data.plan;
  check('il annonce une CRÉATION', plan.target.action === 'CREATE' && plan.target.prospectId === null);
  check('…et nomme la fiche', plan.target.name === 'Garage Leblanc');

  const parCle = Object.fromEntries(plan.sections.map((s) => [s.key, s]));
  check('les coordonnées sont annoncées', parCle.identity.added.length >= 3);
  check('les deux messages sont annoncés', parCle.messages.added.length === 2);
  check('la tâche est annoncée', parCle.tasks.added.length === 1);
  check('le rendez-vous est annoncé', parCle.meetings.added.length === 1);
  check('le dossier à créer est annoncé AVANT de l’être',
    parCle.classement.added.some((i) => i.detail === 'Garages / Marseille'));

  check('AUCUNE fiche n’a été écrite', await PanelProspect.countDocuments({}) === avant);
  check('AUCUN dossier n’a été créé',
    await PanelProspectFolder.countDocuments({}) === dossiersAvant);
  check('AUCUNE tâche n’a été créée', await PanelTask.countDocuments({}) === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Un fichier, trois collections');

let prospectId = null;
{
  const applique = await call('POST', '/api/prospects/import', {
    headers: AUTH, body: { document: DOCUMENT },
  });
  check('l’import répond 200', applique.status === 200);
  const fiche = applique.json.data.prospect;
  prospectId = fiche._id;

  check('la fiche porte les coordonnées', fiche.email === 'contact@leblanc.fr');
  check('…le statut lu en français', fiche.status === 'IN_PROGRESS');
  check('…le lien du site', fiche.links.some((l) => l.label === 'Site officiel'));
  check('…l’information libre', fiche.infoFields.some((f) => f.label === 'Qui décide'));
  check('…les deux messages', fiche.messages.length === 2);
  check('…dont un envoyé et un à envoyer',
    fiche.messages.filter((m) => m.sentAt).length === 1
    && fiche.messages.filter((m) => !m.sentAt).length === 1);

  /* LE STATUT NE SE POSE JAMAIS SANS AUTEUR — même par import. */
  check('la création est datée dans l’historique',
    fiche.statusHistory.length === 1 && /import/i.test(fiche.statusHistory[0].note ?? ''));

  const dossier = await PanelProspectFolder.findById(fiche.folderId).lean();
  check('le dossier du chemin existe et porte le dernier segment',
    dossier !== null && dossier.name === 'Marseille');
  const parent = await PanelProspectFolder.findById(dossier.parentId).lean();
  check('…sous son parent', parent !== null && parent.name === 'Garages');

  const taches = await PanelTask.find({ 'links.prospectIds': prospectId }).lean();
  check('la tâche est créée ET rattachée au prospect', taches.length === 1);
  check('…avec son échéance relative calculée', taches[0].dueAt instanceof Date);
  check('…et sa sous-tâche', taches[0].subtasks.length === 1);

  const rdv = await PanelMeeting.find({ projectId: prospectId, subjectType: 'PROSPECT' }).lean();
  check('le rendez-vous entre dans l’agenda du Panel', rdv.length === 1);
  check('…comme rendez-vous de PROSPECT, pas de projet', rdv[0].subjectType === 'PROSPECT');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Réimporter ne duplique rien');

{
  const encore = await call('POST', '/api/prospects/import', {
    headers: AUTH, body: { document: DOCUMENT, prospectId },
  });
  const fiche = encore.json.data.prospect;

  check('les liens ne doublent pas', fiche.links.length === 1);
  check('les informations ne doublent pas', fiche.infoFields.length === 1);
  check('les messages ne doublent pas', fiche.messages.length === 2);
  check('les tâches ne doublent pas',
    await PanelTask.countDocuments({ 'links.prospectIds': prospectId }) === 1);
  check('les rendez-vous ne doublent pas',
    await PanelMeeting.countDocuments({ projectId: prospectId, subjectType: 'PROSPECT' }) === 1);
  check('aucun dossier n’est recréé',
    await PanelProspectFolder.countDocuments({ name: 'Marseille' }) === 1);
  check('les notes ne se recopient pas à la suite d’elles-mêmes',
    (fiche.notes.match(/Devanture refaite/g) ?? []).length === 1);

  /* Rapproché ≠ recréé : l'identifiant tient, sans quoi l'écran perdrait la
     ligne qu'on était en train de modifier à chaque import. */
  const memeId = fiche.links[0].id;
  const troisieme = await call('POST', '/api/prospects/import', {
    headers: AUTH, body: { document: DOCUMENT, prospectId },
  });
  check('un élément rapproché GARDE son identifiant',
    troisieme.json.data.prospect.links[0].id === memeId);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Compléter, remplacer — et ce qu’un import ne détruit jamais');

{
  /* Une main humaine ajoute un lien et une tâche que le fichier ne connaît pas. */
  await call('PATCH', `/api/prospects/${prospectId}`, {
    headers: AUTH,
    body: {
      links: [
        ...(await PanelProspect.findById(prospectId).lean()).links,
        { label: 'Noté à la main', url: 'https://exemple.fr' },
      ],
    },
  });
  await PanelTask.create({
    name: 'Relance notée à la main',
    links: { projectIds: [], prospectIds: [prospectId], transactionIds: [], clientCompanyIds: [] },
  });

  const complete = await call('POST', '/api/prospects/import', {
    headers: AUTH, body: { document: DOCUMENT, prospectId, mode: 'MERGE' },
  });
  check('COMPLÉTER garde ce que le document ignore',
    complete.json.data.prospect.links.some((l) => l.label === 'Noté à la main'));

  const remplace = await call('POST', '/api/prospects/import', {
    headers: AUTH, body: { document: DOCUMENT, prospectId, mode: 'REPLACE' },
  });
  const fiche = remplace.json.data.prospect;
  check('REMPLACER retire ce que le document ne reprend pas',
    fiche.links.every((l) => l.label !== 'Noté à la main'));
  check('…et le retrait était annoncé dans le plan',
    remplace.json.data.plan.sections
      .find((s) => s.key === 'links').removed
      .some((i) => i.label === 'Noté à la main'));

  /* L'INVARIANT DU LOT : un échéancier ne se vide pas par import. */
  check('REMPLACER ne supprime AUCUNE tâche',
    await PanelTask.countDocuments({ 'links.prospectIds': prospectId }) === 2);
  check('…et le dit plutôt que de le taire',
    remplace.json.data.plan.ignored.some((i) => i.path === 'tasks'));
  check('REMPLACER ne supprime AUCUN rendez-vous',
    await PanelMeeting.countDocuments({ projectId: prospectId, subjectType: 'PROSPECT' }) === 1);

  /* Une section ABSENTE du document n'est jamais touchée, même en REMPLACER —
     sans quoi un fichier qui ne parle que des messages viderait les liens. */
  const partiel = await call('POST', '/api/prospects/import', {
    headers: AUTH,
    body: {
      document: { name: 'Garage Leblanc', messages: [] },
      prospectId,
      mode: 'REPLACE',
    },
  });
  check('une section absente survit au mode REMPLACER',
    partiel.json.data.prospect.links.length > 0
    && partiel.json.data.prospect.infoFields.length > 0);
  check('…et une section vide PRÉSENTE, elle, vide bien la liste',
    partiel.json.data.prospect.messages.length === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Ce qui ne passe pas, et ce qui le dit');

{
  const refuse = await call('POST', '/api/prospects/import/preview', {
    headers: AUTH, body: { document: { email: 'x@y.fr' } },
  });
  check('un document sans nom, sans fiche à compléter, est REFUSÉ',
    refuse.status === 400 && refuse.json.code === 'PANEL_PROSPECT_IMPORT_NAME_REQUIRED');

  const mode = await call('POST', '/api/prospects/import/preview', {
    headers: AUTH, body: { document: { name: 'X' }, mode: 'ECRASER' },
  });
  check('un mode inconnu est REFUSÉ plutôt que ramené au défaut',
    mode.status === 400 && mode.json.code === 'PANEL_PROSPECT_IMPORT_MODE_UNKNOWN');

  const boiteux = await call('POST', '/api/prospects/import/preview', {
    headers: AUTH,
    body: {
      document: {
        name: 'Tolérance',
        links: [{ label: 'Piégé', url: 'javascript:alert(1)' }],
        images: [{ url: 'https://ailleurs.example/photo.jpg' }],
        messages: [{ channel: 'E-mail' }, { title: 'Daté', body: 'x', sentAt: 'hier' }],
        tasks: [{ description: 'sans nom' }],
        meetings: [{ title: 'Sur place', scheduledAt: '2026-12-01T10:00:00Z', mode: 'onsite' }],
      },
    },
  });
  check('un document partiellement fautif est LU, pas refusé', boiteux.status === 200);
  const raisons = boiteux.json.data.plan.ignored.map((i) => i.path);
  check('un lien à schéma exotique est écarté', raisons.some((p) => p.startsWith('links')));
  check('une image externe est écartée', raisons.some((p) => p.startsWith('images')));
  check('un message sans titre ni contenu est écarté', raisons.some((p) => p === 'messages[0]'));
  check('une date d’envoi illisible n’emporte pas le message',
    raisons.some((p) => p === 'messages[1].sentAt')
    && boiteux.json.data.plan.sections.find((s) => s.key === 'messages').added.length === 1);
  check('une tâche sans intitulé est écartée', raisons.some((p) => p.startsWith('tasks')));
  check('un présentiel sans adresse est écarté par les règles de l’agenda',
    raisons.some((p) => p.startsWith('meetings')));

  /* Un compte de gestion prospecte : c'est la différence assumée avec les
     entreprises clientes, et l'import ne la referme pas. */
  const sansJeton = await call('POST', '/api/prospects/import', { body: { document: { name: 'X' } } });
  check('l’import exige un compte du Panel', sansJeton.status === 401);
}

await close();
await stopMemoryMongo();
finish();
