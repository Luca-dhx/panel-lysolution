/**
 * LA PROSPECTION — le carnet des affaires qui ne sont pas encore des clients.
 *
 * ══ CE QUE CETTE SUITE VERROUILLE ═══════════════════════════════════════════
 *
 *   1. LA FICHE        un prospect existe, se corrige champ par champ, et une
 *                      correction partielle n'efface jamais ce qu'elle ne
 *                      mentionne pas ;
 *   2. LE STATUT       il ne bouge que par une décision humaine, toutes les
 *                      transitions sont permises, et chacune laisse sa TRACE ;
 *   2 bis. LE TYPE     conception ou refonte — un SECOND axe, qui n'entre pas
 *                      dans l'historique du statut, et dont l'absence sur les
 *                      fiches antérieures ne les rend pas introuvables ;
 *   3. LE SUIVI        les réunions et les événements du Panel se rattachent à
 *                      un prospect sans qu'un second agenda existe ;
 *   4. L'ÉTANCHÉITÉ    ajouter `subjectType` ne fait disparaître aucun
 *                      rendez-vous écrit AVANT ce lot, et un rendez-vous de
 *                      prospection ne se glisse pas dans l'agenda d'un client ;
 *   5. L'ACCÈS         un compte de gestion (ADMIN) peut prospecter. C'est la
 *                      différence assumée avec les entreprises clientes, dont
 *                      l'écriture reste réservée aux comptes DEV.
 *
 * Le point 4 est le vrai risque de ce chantier. Les documents antérieurs ne
 * portent pas le champ du tout : une lecture qui demanderait
 * `{ subjectType: 'PROJECT' }` viderait l'agenda de tous les clients le jour du
 * déploiement, sans erreur, sans trace. C'est pour cela que les lectures
 * demandent l'ABSENCE de prospect.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  check, connectTestDatabase, finish, guardUploads, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

/** Inventaire du dossier d'imports AVANT la recette — voir `guardUploads`. */
const gardeUploads = guardUploads();

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv, createUser } = await import('../backend/src/services/auth/panelUsers.service.js');
const { PanelProspect } = await import('../backend/src/models/PanelProspect.model.js');
const { PanelMeeting } = await import('../backend/src/models/PanelMeeting.model.js');
const { PanelProjectEvent } = await import('../backend/src/models/PanelProjectEvent.model.js');

// Les tests vivent hors de `backend/` : la dépendance se résout depuis
// `backend/node_modules`, explicitement — comme pour `mongodb-memory-server`.
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = (await import(pathToFileURL(requireBackend.resolve('sharp')).href)).default;

await seedFromEnv();
const { base, call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const demain = () => new Date(Date.now() + 86_400_000).toISOString();
const hier = () => new Date(Date.now() - 86_400_000).toISOString();

/* ────────────────────────────────────────────────────────────────────────── */
section('1. La fiche — création, lecture, correction');

let prospectId = null;
{
  const sansNom = await call('POST', '/api/prospects', { headers: AUTH, body: { email: 'a@b.fr' } });
  check('un prospect sans nom est REFUSÉ', sansNom.status === 400);
  check('…avec un code explicite', sansNom.json.code === 'PANEL_PROSPECT_NAME_REQUIRED');

  const cree = await call('POST', '/api/prospects', {
    headers: AUTH,
    body: {
      name: 'Garage Dupont',
      email: 'contact@garage-dupont.fr',
      phone: '06 12 34 56 78',
      notes: 'Rencontré au salon. Intéressé par un site vitrine.',
      links: [{ label: 'Site', url: 'garage-dupont.fr' }],
    },
  });
  check('un prospect nommé est créé', cree.status === 201);
  prospectId = cree.json.data.prospect._id;

  check('…en « en attente » par défaut', cree.json.data.prospect.status === 'WAITING');
  check('…et la création est datée dans l’historique',
    cree.json.data.prospect.statusHistory.length === 1
    && cree.json.data.prospect.statusHistory[0].from === null
    && cree.json.data.prospect.statusHistory[0].to === 'WAITING');

  // Un lien saisi sans protocole est la saisie la PLUS courante : le refuser
  // aurait transformé le cas nominal en erreur.
  check('un lien sans protocole est complété, pas refusé',
    cree.json.data.prospect.links[0].url === 'https://garage-dupont.fr/');
  check('…et il porte un identifiant propre',
    typeof cree.json.data.prospect.links[0].id === 'string'
    && cree.json.data.prospect.links[0].id.length > 0);

  const hostile = await call('POST', '/api/prospects', {
    headers: AUTH,
    body: { name: 'Piège', links: [{ url: 'javascript:alert(1)' }] },
  });
  check('un schéma non http est REFUSÉ', hostile.status === 400);
  check('…avec un code explicite', hostile.json.code === 'PANEL_PROSPECT_LINK_SCHEME');

  const imageExterne = await call('POST', '/api/prospects', {
    headers: AUTH,
    body: { name: 'Image ailleurs', images: [{ url: 'https://ailleurs.example/logo.png' }] },
  });
  check('une image qui n’a pas été importée dans le Panel est REFUSÉE',
    imageExterne.status === 400 && imageExterne.json.code === 'PANEL_PROSPECT_IMAGE_INVALID');
}

{
  // LE CŒUR DE LA CORRECTION PARTIELLE : un `PATCH` qui ne parle que du
  // téléphone ne doit pas effacer les notes parce qu'il ne les mentionne pas.
  const patch = await call('PATCH', `/api/prospects/${prospectId}`, {
    headers: AUTH, body: { phone: '07 00 00 00 00' },
  });
  check('une correction partielle aboutit', patch.status === 200);
  check('…le champ visé change', patch.json.data.prospect.phone === '07 00 00 00 00');
  check('…et les champs NON mentionnés survivent',
    patch.json.data.prospect.notes.startsWith('Rencontré au salon')
    && patch.json.data.prospect.name === 'Garage Dupont'
    && patch.json.data.prospect.links.length === 1);

  const vide = await call('PATCH', `/api/prospects/${prospectId}`, {
    headers: AUTH, body: { name: '   ' },
  });
  check('un nom vidé est refusé', vide.status === 400);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Le statut — manuel, réversible, tracé');
{
  const inconnu = await call('POST', `/api/prospects/${prospectId}/status`, {
    headers: AUTH, body: { status: 'PEUT_ETRE' },
  });
  check('un statut hors liste est REFUSÉ', inconnu.status === 400);
  check('…avec un code explicite', inconnu.json.code === 'PANEL_PROSPECT_STATUS_UNKNOWN');

  const enCours = await call('POST', `/api/prospects/${prospectId}/status`, {
    headers: AUTH, body: { status: 'IN_PROGRESS' },
  });
  check('le statut change', enCours.status === 200 && enCours.json.data.prospect.status === 'IN_PROGRESS');
  check('…et la trace porte l’avant, l’après et l’auteur', (() => {
    const dernier = enCours.json.data.prospect.statusHistory.at(-1);
    return dernier.from === 'WAITING' && dernier.to === 'IN_PROGRESS'
      && dernier.actorEmail === 'dev@panel.test';
  })());

  const idem = await call('POST', `/api/prospects/${prospectId}/status`, {
    headers: AUTH, body: { status: 'IN_PROGRESS' },
  });
  check('reposer le MÊME statut ne consigne rien',
    idem.json.data.prospect.statusHistory.length
      === enCours.json.data.prospect.statusHistory.length);

  await call('POST', `/api/prospects/${prospectId}/status`, { headers: AUTH, body: { status: 'LOST' } });
  const rouvert = await call('POST', `/api/prospects/${prospectId}/status`, {
    headers: AUTH, body: { status: 'SIGNED', note: 'Rappelé six mois plus tard.' },
  });
  // Une affaire perdue se rouvre : une machine à états qui l'interdirait ne
  // rendrait pas le pipeline plus vrai, elle pousserait à créer un doublon.
  check('une affaire PERDUE peut redevenir SIGNÉE', rouvert.status === 200);
  check('…et le motif est conservé',
    rouvert.json.data.prospect.statusHistory.at(-1).note === 'Rappelé six mois plus tard.');

  const liste = await call('GET', '/api/prospects', { headers: AUTH });
  check('le résumé compte TOUS les états, y compris à zéro',
    Object.keys(liste.json.data.summary.byStatus).length === 5
    && liste.json.data.summary.byStatus.WAITING === 0
    && liste.json.data.summary.byStatus.SIGNED === 1);

  const filtree = await call('GET', '/api/prospects?status=SIGNED', { headers: AUTH });
  check('la liste se filtre par statut',
    filtree.json.data.prospects.length === 1
    && filtree.json.data.prospects[0]._id === prospectId);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2 bis. La nature de l’affaire — conception ou refonte');
{
  // Le TYPE est un SECOND axe : il n'entre pas dans `statusHistory`, parce que
  // ce n'est pas une étape du pipeline mais une caractéristique de l'affaire.
  const parDefaut = await call('POST', '/api/prospects', {
    headers: AUTH, body: { name: 'Sans site connu' },
  });
  check('un prospect est une CONCEPTION par défaut',
    parDefaut.json.data.prospect.type === 'CREATION');

  const refonte = await call('POST', '/api/prospects', {
    headers: AUTH, body: { name: 'Site à refaire', type: 'REDESIGN' },
  });
  check('…et la refonte se déclare à la création',
    refonte.status === 201 && refonte.json.data.prospect.type === 'REDESIGN');

  const inconnu = await call('POST', '/api/prospects', {
    headers: AUTH, body: { name: 'Ni l’un ni l’autre', type: 'MAINTENANCE' },
  });
  // Retomber silencieusement sur « conception » ferait apparaître une refonte
  // comme un site à créer — la confusion exacte que ce champ existe pour lever.
  check('un type hors liste est REFUSÉ, jamais ramené au défaut',
    inconnu.status === 400 && inconnu.json.code === 'PANEL_PROSPECT_TYPE_UNKNOWN');

  const corrige = await call('PATCH', `/api/prospects/${parDefaut.json.data.prospect._id}`, {
    headers: AUTH, body: { type: 'REDESIGN' },
  });
  check('le type se corrige par la correction partielle', corrige.json.data.prospect.type === 'REDESIGN');
  check('…sans rien écrire dans l’historique du statut',
    corrige.json.data.prospect.statusHistory.length === 1);

  /**
   * UNE FICHE ÉCRITE AVANT CE CHAMP — le champ retiré à la main, comme en base.
   *
   * Le schéma pose le défaut à l'écriture : un document « à l'ancienne » ne
   * peut pas naître par la voie normale. C'est pourtant l'état qu'on trouve en
   * production, et le filtre « conception » doit continuer de le voir.
   */
  const ancien = await call('POST', '/api/prospects', {
    headers: AUTH, body: { name: 'Fiche d’avant' },
  });
  await PanelProspect.updateOne(
    { _id: ancien.json.data.prospect._id }, { $unset: { type: '' } },
  );
  const brut = await PanelProspect.findById(ancien.json.data.prospect._id).lean();
  check('…et le champ est bien ABSENT du document', brut.type === undefined);

  const conceptions = await call('GET', '/api/prospects?type=CREATION', { headers: AUTH });
  const idsConception = conceptions.json.data.prospects.map((p) => p._id);
  check('le filtre « conception » retrouve la fiche antérieure',
    idsConception.includes(String(brut._id)));
  check('…et n’y mêle aucune refonte',
    !idsConception.includes(refonte.json.data.prospect._id));

  const refontes = await call('GET', '/api/prospects?type=REDESIGN', { headers: AUTH });
  check('le filtre « refonte » ne rend que des refontes',
    refontes.json.data.prospects.every((p) => p.type === 'REDESIGN'));

  const resume = (await call('GET', '/api/prospects', { headers: AUTH })).json.data.summary;
  check('le résumé compte les deux natures',
    resume.byType.CREATION + resume.byType.REDESIGN === resume.total);
  check('…et la fiche sans champ compte pour une conception',
    resume.byType.CREATION >= 1);

  // On nettoie : les sections suivantes comptent les fiches et les réunions.
  for (const p of [parDefaut, refonte, inconnu, ancien]) {
    const id = p.json?.data?.prospect?._id;
    // eslint-disable-next-line no-await-in-loop
    if (id) await call('DELETE', `/api/prospects/${id}`, { headers: AUTH });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Le suivi — l’agenda du Panel, branché sur un prospect');

let reunionProspect = null;
{
  const reunion = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: prospectId,
      projectName: 'Garage Dupont',
      subjectType: 'PROSPECT',
      title: 'Visite de l’atelier',
      scheduledAt: demain(),
      mode: 'ONSITE',
      address: '12 rue des Lilas, 06000 Nice',
    },
  });
  check('une réunion peut porter sur un PROSPECT', reunion.status === 201);
  check('…et le sujet est consigné', reunion.json.data.meeting.subjectType === 'PROSPECT');
  reunionProspect = reunion.json.data.meeting._id;

  const evenement = await call('POST', '/api/events', {
    headers: AUTH,
    body: {
      projectId: prospectId,
      projectName: 'Garage Dupont',
      subjectType: 'PROSPECT',
      type: 'CALL',
      title: 'Premier appel',
      occurredAt: hier(),
      notes: 'Il rappellera.',
    },
  });
  check('un événement passé peut porter sur un PROSPECT', evenement.status === 201);
  check('…et le sujet est consigné', evenement.json.data.event.subjectType === 'PROSPECT');

  const inconnu = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: prospectId, subjectType: 'CHOSE', title: 'X',
      scheduledAt: demain(), mode: 'REMOTE', remoteKind: 'CALL', phone: '0600000000',
    },
  });
  // Un `subjectType` fantaisiste ne doit PAS retomber sur « projet » : le
  // rendez-vous serait rangé sous un client qui n'existe pas.
  check('un sujet d’espèce inconnue est REFUSÉ, jamais requalifié',
    inconnu.status === 400 && inconnu.json.code === 'PANEL_SUBJECT_TYPE_UNKNOWN');

  const fiche = await call('GET', `/api/prospects/${prospectId}`, { headers: AUTH });
  check('la fiche rend le prospect, son agenda et son histoire EN UNE lecture',
    fiche.status === 200
    && fiche.json.data.prospect._id === prospectId
    && fiche.json.data.meetings.length === 1
    && fiche.json.data.events.length === 1);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Étanchéité — et la compatibilité des documents antérieurs');
{
  /**
   * UN RENDEZ-VOUS ÉCRIT AVANT CE LOT — sans le champ, comme en base.
   *
   * `updateOne` avec `$unset` plutôt qu'une création sans le champ : le schéma
   * pose la valeur par défaut à l'écriture, et un document « à l'ancienne » ne
   * peut donc pas naître par la voie normale. C'est exactement l'état qu'on
   * trouvera en production le jour du déploiement.
   */
  const ancienne = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: 'projet-historique',
      projectName: 'Client d’avant',
      title: 'Point mensuel',
      scheduledAt: demain(),
      mode: 'REMOTE',
      remoteKind: 'CALL',
      phone: '06 11 22 33 44',
    },
  });
  check('une réunion sans `subjectType` reste créable', ancienne.status === 201);
  await PanelMeeting.updateOne(
    { _id: ancienne.json.data.meeting._id },
    { $unset: { subjectType: '' } },
  );
  const brute = await PanelMeeting.findById(ancienne.json.data.meeting._id).lean();
  check('…et le champ est bien ABSENT du document', brute.subjectType === undefined);

  const cotesProjets = await call('GET', '/api/meetings?scope=upcoming&subjectType=PROJECT', {
    headers: AUTH,
  });
  const idsProjets = cotesProjets.json.data.meetings.map((m) => m._id);
  check('l’agenda des PROJETS retrouve le document antérieur',
    idsProjets.includes(String(brute._id)));
  check('…et n’y mêle AUCUN rendez-vous de prospection',
    !idsProjets.includes(reunionProspect));

  const cotesProspects = await call('GET', '/api/meetings?scope=upcoming&subjectType=PROSPECT', {
    headers: AUTH,
  });
  const idsProspects = cotesProspects.json.data.meetings.map((m) => m._id);
  check('l’agenda de PROSPECTION ne rend que la prospection',
    idsProspects.length === 1 && idsProspects[0] === reunionProspect);

  const global = await call('GET', '/api/meetings?scope=upcoming', { headers: AUTH });
  // L'équipe n'a qu'UN agenda : un rendez-vous de prospection absent de
  // « Réunions à venir » serait un rendez-vous manqué.
  check('sans précision, l’agenda global rend LES DEUX',
    global.json.data.meetings.length === 2);

  const evenementsProjets = await call('GET', '/api/events?scope=all&subjectType=PROJECT', {
    headers: AUTH,
  });
  check('la vue globale des événements se borne elle aussi',
    evenementsProjets.json.data.events.every((e) => e.subjectType !== 'PROSPECT'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. L’accès — la prospection est ouverte à toute l’équipe');
{
  await createUser(
    { email: 'gestion@panel.test', password: 'motdepasse-test', role: 'ADMIN', name: 'Gestion' },
    { email: 'dev@panel.test', role: 'DEV' },
  );
  const connexion = await call('POST', '/api/auth/login', {
    body: { email: 'gestion@panel.test', password: 'motdepasse-test' },
  });
  check('le compte de gestion existe', connexion.status === 200);
  const GESTION = { authorization: `Bearer ${connexion.json.data.token}` };

  const lecture = await call('GET', '/api/prospects', { headers: GESTION });
  check('un ADMIN peut LIRE la prospection', lecture.status === 200);

  // La différence assumée avec les entreprises clientes : un prospect
  // n'engage rien — il ne facture pas, ne signe pas, ne s'affiche nulle part.
  const ecriture = await call('POST', '/api/prospects', {
    headers: GESTION, body: { name: 'Boulangerie Martin' },
  });
  check('…et il peut ÉCRIRE', ecriture.status === 201);

  const anonyme = await call('GET', '/api/prospects');
  check('sans authentification, la prospection est inaccessible', anonyme.status === 401);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. La suppression emporte l’agenda du prospect');
{
  const avant = await PanelMeeting.countDocuments({ projectId: prospectId });
  check('le prospect a bien un rendez-vous avant suppression', avant === 1);

  const supprime = await call('DELETE', `/api/prospects/${prospectId}`, { headers: AUTH });
  check('la suppression aboutit', supprime.status === 200 && supprime.json.data.deleted === true);

  check('la fiche a disparu', (await PanelProspect.findById(prospectId)) === null);
  // Sans cela, l'agenda garderait des rendez-vous intitulés « Visite » sans
  // plus personne au bout, et un lien qui mène à une page introuvable.
  check('…ses réunions aussi',
    (await PanelMeeting.countDocuments({ projectId: prospectId })) === 0);
  check('…et ses événements aussi',
    (await PanelProjectEvent.countDocuments({ projectId: prospectId })) === 0);

  // La réunion du client d'avant, elle, n'a pas bougé : la suppression est
  // BORNÉE au prospect, elle ne balaie pas la collection.
  check('l’agenda des projets est intact',
    (await PanelMeeting.countDocuments({ projectId: 'projet-historique' })) === 1);

  const introuvable = await call('GET', `/api/prospects/${prospectId}`, { headers: AUTH });
  check('la fiche supprimée répond 404', introuvable.status === 404);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Les images — la même chaîne que les médias de marque, une autre garde');
{
  /**
   * UN VRAI PNG, ENVOYÉ EN VRAI MULTIPART, PAR LA VRAIE ROUTE.
   *
   * Le doubler aurait prouvé que le doublon fonctionne. Ce qui est éprouvé
   * ici, c'est que `/api/prospects/images` traverse RÉELLEMENT la chaîne des
   * médias — validation sur les octets, réencodage, descripteur — parce
   * qu'elle monte le même module que l'adresse historique.
   */
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 2654435761) % 256;
  const png = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();

  const envoyer = async (buffer, { nom = 'devanture.png', type = 'image/png' } = {}) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), nom);
    const res = await fetch(`${base}/api/prospects/images?prefix=prospect&role=prospect`, {
      method: 'POST', headers: AUTH, body: form,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };

  const importee = await envoyer(png);
  check('une image de prospect est acceptée', importee.status === 201);
  check('…et le chemin rendu est RELATIF, jamais une adresse absolue',
    typeof importee.json?.url === 'string' && importee.json.url.startsWith('/uploads/'));
  check('…et le fichier est réécrit en WebP, jamais servi tel quel',
    importee.json.url.endsWith('.webp'));

  // Le contrôle réel lit les OCTETS : un type déclaré par le navigateur ne
  // protège rien, et c'est le même garde que pour les médias de marque.
  const faussaire = await envoyer(Buffer.from('MZ ce fichier est un exécutable, pas une image'), {
    nom: 'piege.png',
  });
  check('un fichier qui n’est pas une image est REFUSÉ malgré son extension',
    faussaire.status >= 400);

  const citee = await call('POST', '/api/prospects', {
    headers: AUTH,
    body: { name: 'Avec devanture', images: [{ url: importee.json.url, caption: 'Devanture' }] },
  });
  check('la fiche peut CITER le média importé', citee.status === 201);
  check('…et l’image porte un identifiant propre et sa légende',
    citee.json.data.prospect.images.length === 1
    && citee.json.data.prospect.images[0].caption === 'Devanture'
    && typeof citee.json.data.prospect.images[0].id === 'string');

  const anonyme = await fetch(`${base}/api/prospects/images`, { method: 'POST' });
  check('l’import exige une session', anonyme.status === 401);
}

await close();
await stopMemoryMongo();
gardeUploads.cleanup();
finish();
