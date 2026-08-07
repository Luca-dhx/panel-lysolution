/**
 * CRÉATION D'UN PROJET — le parcours guidé, et ce qui le protège.
 *
 * Ce que ces contrôles verrouillent : que la page « Projets clients » ne porte
 * plus de bloc technique permanent, qu'un seul bouton ouvre l'assistant, que la
 * clé technique ne se saisisse nulle part, qu'un projet ne puisse pas entrer
 * deux fois — même sur deux requêtes lancées ensemble — et que l'assistant dise
 * les choses en français d'utilisateur.
 *
 * Le dépôt n'embarque aucun moteur de rendu React : les contrôles d'écran
 * portent sur les SOURCES, comme le font déjà `panel-ux` et `events`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv, createUser, PANEL_ROLES } = await import(
  '../backend/src/services/auth/panelUsers.service.js'
);
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');

await seedFromEnv();
// L'index unique doit EXISTER avant de tester la course : c'est lui qu'on teste.
await PanelProject.init();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
const page = lire('frontend/src/pages/ProjectsPage.tsx');
const assistant = lire('frontend/src/components/ProjectWizard.tsx');
const css = lire('frontend/src/components.css');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. La liste redevient le contenu principal');
{
  check('le bloc de test permanent a disparu de la page',
    !page.includes('Tester la connexion') && !page.includes('probeProject'));
  check('…et avec lui le champ d’adresse posé en haut de liste',
    !/type="url"/.test(page));
  check('…et le code d’appairage qui traînait sous la page',
    !page.includes('CopyField') && !page.includes('pairingCode'));

  check('un SEUL point d’entrée : « Créer un projet »',
    (page.match(/Créer un projet/g) || []).length === 1);
  check('…et il est réservé aux comptes DEV',
    /isDev \? \([\s\S]{0,300}Créer un projet/.test(page));
  check('…il ouvre l’assistant, il ne déclare rien lui-même',
    /onClick=\{\(\) => setAssistantManuel\(true\)\}/.test(page) && !page.includes('api.createProject'));
  /**
   * L'ASSISTANT S'OUVRE AUSSI PAR L'ADRESSE — le raccourci « appairer la
   * production » d'une carte. Un second point d'entrée, mais pas un second
   * bouton : c'est le même assistant, contextualisé.
   */
  check('…ou par un raccourci d’URL, qui ne remplace pas le bouton',
    /searchParams\.get\('declare'\) === '1'/.test(page));
  check('un environnement d’URL fantaisiste ne devient JAMAIS la production',
    /envParam === 'TEST' \|\| envParam === 'PROD' \? envParam : null/.test(page));
  check('fermer l’assistant nettoie l’adresse, sinon il se rouvrirait',
    /next\.delete\(cle\)/.test(page));

  check('la liste des projets est toujours là', page.includes('grid-cards'));
  check('les cartes projet n’ont pas bougé',
    page.includes('projectDisplayName(project)') && page.includes('project-avatar'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. L’assistant vit DANS la page — aucun clignotement au retour');
{
  // Une page dédiée démonterait la liste : `useProjects` repartirait sur un
  // premier chargement, l'écran afficherait « Chargement… » et le défilement
  // retomberait en haut. C'est précisément ce qu'on refuse.
  check('l’assistant est rendu depuis la page, pas derrière une autre route',
    page.includes('<ProjectWizard') && !/useNavigate|<Navigate/.test(page));
  check('la liste alimente l’assistant, elle n’est pas rechargée pour lui',
    /projects=\{projects\}/.test(page));
  check('après création, la liste se remet à jour en place',
    /onCreated=\{reload\}/.test(page));
  check('aucun rechargement de page nulle part',
    !/location\.reload|window\.location/.test(page + assistant));
  check('aucun sondage propre à l’assistant', !/setInterval/.test(assistant));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Quatre étapes, dans l’ordre, et rien de technique en vitrine');
{
  for (const etape of ['Adresse', 'Vérification', 'Informations', 'Confirmation']) {
    check(`l’étape « ${etape} » est annoncée`, assistant.includes(`label: '${etape}'`));
  }
  check('l’étape courante est signalée aux lecteurs d’écran',
    assistant.includes("aria-current={index === courante ? 'step' : undefined}"));

  check('l’étape 1 demande l’adresse du projet', assistant.includes('Adresse du projet'));
  check('…avec son aide de saisie',
    assistant.includes('Saisissez l’adresse publique du backend communiquée par le projet.'));
  check('…et un seul bouton de test', assistant.includes('Tester la connexion'));
  check('l’étape 2 explique ce qu’elle fait',
    assistant.includes('Nous vérifions que le projet peut communiquer avec le Panel.'));
  check('l’étape 4 annonce ce qui va se passer',
    assistant.includes('Le projet sera ajouté au Panel. L’appairage sera réalisé à l’étape suivante.'));
  check('…et propose de créer', assistant.includes('Créer le projet'));

  // Ce qu'un écran métier ne montre pas. On lit le TEXTE rendu, pas le code :
  // `projectId` dans une URL de lien reste légitime.
  const texte = [...assistant.split('\n').flatMap((l) => [...l.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]))].join(' ');
  for (const terme of ['projectKey', 'contractVersion', 'Bridge', 'manifest', 'heartbeat', 'endpoint']) {
    check(`« ${terme} » n’apparaît dans aucun libellé`, !new RegExp(terme, 'i').test(texte));
  }
  check('aucun champ de clé technique nulle part',
    !/projectKey/.test(assistant) && !/projectKey/.test(page));
  check('les détails techniques sont repliés, jamais en vitrine',
    assistant.includes('<details className="wizard-details">')
    && assistant.includes('Détails techniques'));
  check('aucun JSON brut affiché', !/JSON\.stringify/.test(assistant));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. L’adresse : normalisée, vérifiée, jamais devinée');
{
  const { urlNormalisee } = await import('../frontend/src/components/ProjectWizard.tsx')
    .catch(() => ({ urlNormalisee: null }));
  // Le chargeur TSX n'est pas disponible dans tous les runners : on retombe
  // alors sur la lecture de source, qui verrouille la MÊME règle.
  if (typeof urlNormalisee === 'function') {
    check('barre finale et casse ignorées',
      urlNormalisee('HTTPS://API.Exemple.test/') === 'https://api.exemple.test');
    check('port par défaut retiré',
      urlNormalisee('https://api.exemple.test:443') === 'https://api.exemple.test');
    check('adresse sans schéma refusée', urlNormalisee('api.exemple.test') === null);
  } else {
    check('la normalisation reprend celle du serveur (casse, port, barre finale)',
      assistant.includes('hostname.toLowerCase()')
      && assistant.includes("replace(/\\/+$/, '')")
      && assistant.includes('portParDefaut'));
    check('un schéma non http(s) est refusé', assistant.includes("/^https?:$/"));
    check('aucun schéma n’est ajouté d’office', !/`https:\/\/\$\{/.test(assistant));
  }

  check('le bouton de test reste inerte tant que l’adresse est inexploitable',
    /disabled=\{!normalisee \|\| verification/.test(assistant));
  check('un second test ne part pas pendant le premier',
    /if \(!normalisee \|\| verification\) return;/.test(assistant));
  check('l’adresse saisie survit à un échec',
    !/catch[\s\S]{0,240}setUrl\(''\)/.test(assistant));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. La clé technique ne se saisit toujours pas');
{
  const avecCle = await call('POST', '/api/projects', {
    headers: AUTH,
    body: { url: 'https://api.projet-cle.test', projectName: 'Projet Clé', projectKey: 'cle-choisie' },
  });
  check('la déclaration réussit', avecCle.status === 201);
  check('…mais la clé envoyée est IGNORÉE',
    avecCle.json.data.project.projectKey !== 'cle-choisie');
  check('…elle est dérivée du nom annoncé',
    avecCle.json.data.project.projectKey === 'projet-cle');
  check('…et le code d’appairage est délivré dans la foulée',
    /^PAIR-/.test(avecCle.json.data.pairingCode));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Anti-doublons — la même phrase, quel que soit le chemin');
{
  const MESSAGE = 'Ce projet est déjà déclaré dans le Panel.';

  const memeUrl = await call('POST', '/api/projects', {
    headers: AUTH, body: { url: 'https://api.projet-cle.test', projectName: 'Encore' },
  });
  check('même adresse → refus', memeUrl.status === 409);
  check('…avec le message métier', memeUrl.json.message === MESSAGE);
  check('…et son code', memeUrl.json.code === 'PANEL_PROJECT_ALREADY_DECLARED');

  const autreEcriture = await call('POST', '/api/projects', {
    headers: AUTH, body: { url: 'HTTPS://API.Projet-Cle.TEST:443/', projectName: 'Encore' },
  });
  check('même adresse écrite autrement (casse, port, barre finale) → refus',
    autreEcriture.status === 409 && autreEcriture.json.message === MESSAGE);

  const memeIdentite = await call('POST', '/api/projects', {
    headers: AUTH, body: { url: 'https://une-autre-adresse.test', projectName: 'Projet Clé' },
  });
  check('autre adresse mais même clé dérivée → refus',
    memeIdentite.status === 409 && memeIdentite.json.message === MESSAGE);

  check('aucun doublon n’a été créé',
    (await PanelProject.countDocuments({ projectKey: 'projet-cle' })) === 1);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Double clic et requêtes SIMULTANÉES — la base tranche');
{
  // Le contrôle du service lit puis écrit : deux requêtes lancées ensemble le
  // passent toutes les deux. Seul un index unique peut départager.
  const corps = { url: 'https://api.projet-course.test', projectName: 'Projet Course' };
  const [a, b] = await Promise.all([
    call('POST', '/api/projects', { headers: AUTH, body: corps }),
    call('POST', '/api/projects', { headers: AUTH, body: corps }),
  ]);

  const statuts = [a.status, b.status].sort();
  check(`une seule création, un seul refus (${statuts.join(' / ')})`,
    statuts[0] === 201 && statuts[1] === 409);
  const refus = a.status === 409 ? a : b;
  check('…et le perdant lit la MÊME phrase que s’il était arrivé plus tard',
    refus.json.message === 'Ce projet est déjà déclaré dans le Panel.');
  check('…aucune fiche en double',
    (await PanelProject.countDocuments({ 'runtime.publicBackendUrl': 'https://api.projet-course.test' })) === 1);

  // Cinq clics d'affilée : le même verdict, et toujours une seule fiche.
  const rafale = await Promise.all(Array.from({ length: 5 }, () =>
    call('POST', '/api/projects', {
      headers: AUTH, body: { url: 'https://api.projet-rafale.test', projectName: 'Projet Rafale' },
    })));
  check('cinq requêtes d’un coup → une seule création',
    rafale.filter((r) => r.status === 201).length === 1);
  check('…les quatre autres sont des refus métier',
    rafale.filter((r) => r.status === 409).length === 4);
  check('…et le registre ne contient qu’une fiche',
    (await PanelProject.countDocuments({ projectKey: 'projet-rafale' })) === 1);

  // La protection tient AUSSI sous le service, pas seulement derrière la route.
  const direct = await Promise.all([
    registry.declareProject({ publicBackendUrl: 'https://api.projet-direct.test', projectName: 'Projet Direct' }).catch((e) => e),
    registry.declareProject({ publicBackendUrl: 'https://api.projet-direct.test', projectName: 'Projet Direct' }).catch((e) => e),
  ]);
  const codes = direct.map((r) => r?.code ?? 'OK').sort();
  check(`au niveau service aussi (${codes.join(' / ')})`,
    codes[0] === 'OK' && codes[1] === 'PANEL_PROJECT_ALREADY_DECLARED');
  check('…une seule fiche en base',
    (await registryStore.getByBackendUrl('https://api.projet-direct.test')) !== null
    && (await PanelProject.countDocuments({ projectKey: 'projet-direct' })) === 1);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. Créer reste réservé aux comptes DEV');
{
  await createUser({
    email: 'gestion@panel.test',
    password: 'motdepasse-test',
    displayName: 'Gestion',
    role: PANEL_ROLES.ADMIN,
  });
  const admin = await call('POST', '/api/auth/login', {
    body: { email: 'gestion@panel.test', password: 'motdepasse-test' },
  });
  const jeton = { authorization: `Bearer ${admin.json.data.token}` };

  check('un ADMIN LIT la liste', (await call('GET', '/api/projects', { headers: jeton })).status === 200);
  check('…mais ne peut pas créer',
    (await call('POST', '/api/projects', {
      headers: jeton, body: { url: 'https://api.interdit.test', projectName: 'Interdit' },
    })).status === 403);
  check('…ni sonder une adresse',
    (await call('POST', '/api/projects/probe', {
      headers: jeton, body: { url: 'https://api.interdit.test' },
    })).status === 403);
  check('…et rien n’a été créé au passage',
    (await PanelProject.countDocuments({ projectName: 'Interdit' })) === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('9. Création : l’assistant garde la main');
{
  check('un double clic ne part pas deux fois',
    assistant.includes('creationRef') && /if \(creationRef\.current \|\| !normalisee\) return;/.test(assistant));
  check('…et le bouton se désactive pendant l’appel',
    /disabled=\{creation\}[\s\S]{0,200}Créer le projet/.test(assistant));
  check('un échec laisse l’assistant ouvert, avec la saisie intacte',
    /catch \(err\) \{[\s\S]{0,220}setErreurCreation/.test(assistant)
    && !/catch[\s\S]{0,220}setEtape\('ADRESSE'\)/.test(assistant));
  check('le vrai message du serveur est affiché',
    assistant.includes('errorMessage(err,'));
  check('la liste est rafraîchie APRÈS le succès, sans démontage',
    /setEtape\('APPAIRAGE'\);[\s\S]{0,160}await onCreated\(\)/.test(assistant));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('10. Appairage : le code, où le saisir, et le droit de partir');
{
  check('le code est copiable', assistant.includes('<CopyField value={cree.code}'));
  check('la consigne dit où aller',
    assistant.includes('Ouvrez le Manager du projet, puis allez dans Configuration → Panel'));
  check('l’état est affiché', /etatAppairage/.test(assistant));
  for (const etat of ['Appairé', 'Code expiré', 'En attente du projet']) {
    check(`…dont « ${etat} »`, assistant.includes(`'${etat}'`));
  }
  check('l’appairage se lit sur la liste vivante, pas sur une supposition',
    /projects\.find\(\(p\) => p\.projectId === cree\.projectId\)/.test(assistant));
  check('on peut terminer plus tard', assistant.includes('Terminer plus tard'));
  check('…ou ouvrir la fiche du projet', assistant.includes('Ouvrir la fiche projet'));
  check('un nouveau code demande confirmation quand l’ancien est encore valable',
    /expire \? void regenerer\(\) : setConfirmeRegeneration\(true\)/.test(assistant));
  check('…et prévient de ce qu’il invalide',
    assistant.includes('Le code actuel sera invalidé.'));

  // Une régénération explicite reste possible côté serveur.
  const cree = await call('POST', '/api/projects', {
    headers: AUTH, body: { url: 'https://api.projet-code.test', projectName: 'Projet Code' },
  });
  const projectId = cree.json.data.project.projectId;
  const nouveau = await call('POST', `/api/projects/${projectId}/pairing-code`, { headers: AUTH });
  check('un nouveau code se génère à la demande', nouveau.status === 200);
  check('…et remplace le précédent',
    nouveau.json.data.pairingCode !== cree.json.data.pairingCode);
  check('le projet reste NON APPAIRÉ tant que le projet n’a pas répondu',
    (await registryStore.getById(projectId)).pairing.status === 'DECLARED');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('11. Fermeture, clavier, et rien de persisté trop tôt');
{
  check('la fenêtre s’annonce comme telle',
    assistant.includes('role="dialog"') && assistant.includes('aria-modal="true"')
    && assistant.includes('aria-labelledby="wizard-titre"'));
  check('le focus entre dans la fenêtre à l’ouverture', assistant.includes('boite.current?.focus()'));
  check('…et la tabulation n’en sort pas', /e\.key !== 'Tab'/.test(assistant));
  check('Échap ferme', /e\.key === 'Escape'/.test(assistant));
  check('…mais JAMAIS pendant une opération critique',
    /const demanderFermeture = \(\) => \{\s*if \(enVol\) return;/.test(assistant));
  check('…et une confirmation protège le code d’appairage',
    /etape === 'APPAIRAGE' && !confirmeFermeture/.test(assistant)
    && assistant.includes('Ce code ne sera plus affiché. Fermer quand même ?'));
  check('le fond ne défile plus derrière la fenêtre',
    assistant.includes("document.body.classList.add('no-scroll')")
    && assistant.includes("document.body.classList.remove('no-scroll')"));

  check('rien n’est écrit avant l’étape de création',
    (assistant.match(/api\.createProject/g) || []).length === 1
    && !/useEffect[\s\S]{0,200}api\.createProject/.test(assistant));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('12. Responsive et design system');
{
  check('l’assistant réutilise les classes existantes',
    assistant.includes('className="field"') && assistant.includes('btn btn-primary')
    && assistant.includes('detail-list') && assistant.includes('badge badge-'));
  check('aucune dépendance ajoutée',
    !/from '(?!@\/|react|react-router-dom)/.test(assistant));
  check('aucune couleur en dur', !/#[0-9a-fA-F]{3,8}\b/.test(assistant));

  check('largeur maîtrisée sur grand écran', /\.wizard \{[\s\S]{0,120}width: min\(/.test(css));
  const bloc1200 = css.slice(css.indexOf('@media (max-width: 1200px)'), css.indexOf('@media (max-width: 900px)'));
  check('contenu resserré sur tablette', /\.wizard \{[\s\S]{0,80}width: min\(38rem/.test(bloc1200));
  const bloc900 = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('@media (max-width: 480px)'));
  check('l’assistant prend tout l’écran sur mobile',
    /\.wizard \{[\s\S]{0,140}width: 100%/.test(bloc900));
  check('…et ses actions passent en pleine largeur',
    /\.wizard-foot \.btn \{\s*width: 100%/.test(bloc900));
  check('les étapes se replient sans déborder', /\.wizard-steps \{[\s\S]{0,160}flex-wrap: wrap/.test(css));
  check('les animations restent celles du thème',
    /\.wizard \{[\s\S]{0,300}animation: pop-in var\(--p-motion\)/.test(css));
}

await close();
await stopMemoryMongo();
finish();
