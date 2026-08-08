/**
 * FINITIONS D'INTERFACE — cartes de réunion, liens, confirmation, filtres.
 *
 * Ce que ces contrôles verrouillent : qu'une visioconférence s'ouvre d'un
 * bouton et jamais d'un lien nu, qu'un lien externe ne laisse pas de prise à la
 * page ouverte, qu'une réunion se confirme SANS écrire de compte rendu, qu'une
 * chaîne vide ne soit jamais persistée, et qu'aucun filtre ne retombe sur le
 * menu déroulant du système d'exploitation — qui ignore le thème.
 *
 * Les contrôles d'écran portent sur les SOURCES : le dépôt n'embarque aucun
 * moteur de rendu React.
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
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const { PanelMeeting } = await import('../backend/src/models/PanelMeeting.model.js');
const { PanelProjectEvent } = await import('../backend/src/models/PanelProjectEvent.model.js');
const meetings = await import('../backend/src/services/events/meetings.service.js');

await seedFromEnv();
await PanelProjectEvent.init();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };
const dans = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
const listes = lire('frontend/src/components/EventLists.tsx');
const confirmation = lire('frontend/src/components/EventConfirmation.tsx');
const liens = lire('frontend/src/components/Links.tsx');
const icones = lire('frontend/src/components/Icon.tsx');
const tselect = lire('frontend/src/components/ThemedSelect.tsx');
const css = lire('frontend/src/components.css');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. La carte de réunion : une hiérarchie, pas une suite de fragments');
{
  check('la ligne d’agenda est devenue une CARTE', listes.includes('className="meeting-card"'));
  check('l’intitulé domine', listes.includes('meeting-card-name'));
  check('le projet est nommé, avec son icône',
    /meeting-card-project[\s\S]{0,120}name="building"/.test(listes));
  check('la date porte l’icône calendrier',
    /name="calendar-event"/.test(listes));
  check('l’heure et la durée portent l’icône horloge',
    /name="clock"[\s\S]{0,200}durationMinutes/.test(listes));
  check('les participants portent l’icône groupe',
    /name="people"[\s\S]{0,160}ParticipantsSummary/.test(listes));
  check('l’état reste une pastille', listes.includes('toneBadgeClass(etat.tone)'));

  // Une icône de mode, choisie par le mode : c'est ce qu'on voit avant de lire.
  check('présentiel → repère de lieu', /if \(m\.mode === 'ONSITE'\) return 'geo-alt';/.test(listes));
  check('appel → téléphone', /'CALL' \? 'telephone'/.test(listes));
  check('visioconférence → caméra', /'telephone' : 'camera-video'/.test(listes));
  check('les actions restent groupées, en bas', listes.includes('meeting-card-actions'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Visio, appel, présentiel — chacun son action');
{
  check('la visioconférence a un BOUTON, pas un lien nu',
    /className="btn btn-primary btn-small meeting-join"/.test(listes));
  check('…intitulé « Rejoindre la réunion »', listes.includes('Rejoindre la réunion'));
  check('…qui ouvre un nouvel onglet', /meeting-join[\s\S]{0,160}target="_blank"/.test(listes));
  check('…sans laisser de prise à la page ouverte',
    /meeting-join[\s\S]{0,200}rel="noopener noreferrer"/.test(listes));
  check('…avec l’icône caméra', /meeting-join[\s\S]{0,320}name="camera-video"/.test(listes));

  // Un lien invalide ne doit pas fabriquer un bouton qui ouvre une page blanche.
  check('le lien de visio est VÉRIFIÉ avant d’être proposé',
    listes.includes('function lienVisio') && /new URL\(m\.meetingUrl\)/.test(listes));
  check('…et seuls les schémas de visioconférence sont acceptés',
    /https\|msteams\|zoommtg\|webex/.test(listes));
  check('le bouton n’apparaît que si le lien tient',
    /\{visio \? \(/.test(listes));

  check('un appel affiche son numéro, avec l’icône téléphone',
    /remoteKind === 'CALL' && meeting\.phone[\s\S]{0,200}name="telephone"/.test(listes));
  check('…et le rend composable', /href=\{lienTelephone\(meeting\.phone\)\}/.test(listes));
  check('…sans les espaces de lecture, qui ne se composent pas',
    /replace\(\/\[\^\+0-9\]\/g, ''\)/.test(liens));

  check('le présentiel affiche son adresse, avec l’icône de lieu',
    /mode === 'ONSITE' && meeting\.address[\s\S]{0,160}name="geo-alt"/.test(listes));
  check('…complément compris', /addressComplement/.test(listes));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Icônes : le jeu Bootstrap, sans bibliothèque ni couleur propre');
{
  for (const nom of [
    'geo-alt', 'camera-video', 'telephone', 'calendar-event', 'clock',
    'people', 'building', 'globe', 'envelope', 'box-arrow-up-right',
    'download', 'file-earmark-text', 'chevron-down',
  ]) {
    check(`le jeu fournit « ${nom} »`, icones.includes(`'${nom}':`) || icones.includes(`${nom}: [`));
  }
  check('les tracés héritent de la couleur du texte', icones.includes('fill="currentColor"'));
  check('…et le CSS ne leur en impose aucune', !/\.icon \{[^}]*color:/.test(css));
  check('une icône décorative est masquée aux lecteurs d’écran',
    icones.includes("'aria-hidden': true"));
  check('…une icône seule porte un nom', /role: 'img', 'aria-label': label/.test(icones));
  check('le jeu maison n’importe aucune bibliothèque d’icônes',
    !/from 'bootstrap-icons'|from 'react-icons'/.test(icones));
  /**
   * ── LA LISTE DE DÉPENDANCES ÉTAIT PÉRIMÉE, ET C'EST ELLE QUI AVAIT TORT ──
   *
   * L'allow-list valait `react, react-dom, react-router-dom`. Elle datait
   * d'avant le sélecteur d'icônes de « Mon entreprise », qui repose sur la
   * POLICE Bootstrap Icons : `referenceIcons.ts` stocke des noms `bi-*` et le
   * rendu les résout en classes CSS. Ce n'est pas une bibliothèque de
   * composants qui se serait glissée dans le jeu maison — celui-ci reste
   * intact, le contrôle ci-dessus le vérifie — c'est une police, importée une
   * seule fois dans `main.tsx`.
   *
   * L'allow-list reste EXACTE : ajouter quoi que ce soit d'autre fera toujours
   * échouer ce contrôle.
   */
  const pkg = JSON.parse(lire('frontend/package.json'));
  check('…et les dépendances du frontend restent celles-là, exactement',
    Object.keys(pkg.dependencies).sort().join(',')
      === 'bootstrap-icons,react,react-dom,react-router-dom');
  check('…la police n’est importée qu’en un seul point',
    (lire('frontend/src/main.tsx').match(/^import 'bootstrap-icons/gm) ?? []).length === 1);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Liens et coordonnées : plus un seul bleu souligné');
{
  const detail = lire('frontend/src/pages/ProjectDetailPage.tsx');
  const projets = lire('frontend/src/pages/ProjectsPage.tsx');

  check('la fiche présente ses contacts en lignes icône + libellé + valeur',
    /LinkRow[\s\S]{0,120}icon="envelope"/.test(detail)
    && /icon="telephone"/.test(detail) && /icon="globe"/.test(detail));
  check('la liste des projets affiche le site en puce cliquable',
    /LinkChip icon="globe"/.test(projets));
  check('l’adresse s’affiche sans son protocole',
    liens.includes('export function sansProtocole'));

  // Plus aucun `<a>` nu sur les écrans projet : tout passe par une classe.
  for (const [nom, source] of [['la fiche projet', detail], ['la liste', projets]]) {
    const nus = [...source.matchAll(/<a\s+(?![^>]*className)/g)];
    check(`${nom} : aucun lien sans mise en forme (${nus.length})`, nus.length === 0);
  }
  check('les liens externes ne laissent aucune prise à la page ouverte',
    !/rel="noreferrer"(?!\s*")/.test(detail + projets + listes + liens)
    && liens.includes('rel: \'noopener noreferrer\''));

  check('un lien du thème n’est pas souligné au repos',
    /\.link-action,\s*\.link-chip \{[\s\S]{0,240}text-decoration: none/.test(css));
  check('…mais le devient au survol',
    /\.link-action:hover,\s*\.link-chip:hover \{[\s\S]{0,120}text-decoration: underline/.test(css));
  check('…et son focus reste visible',
    /\.link-action:focus-visible[\s\S]{0,160}outline: 2px solid var\(--p-primary\)/.test(css));
  check('une adresse longue est tronquée, jamais débordante',
    /\.link-action-value \{[\s\S]{0,160}text-overflow: ellipsis/.test(css));
  check('…et une adresse postale revient à la ligne proprement',
    /\.meeting-place-value \{[\s\S]{0,120}overflow-wrap: anywhere/.test(css));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Confirmer une réunion : un seul champ, et il est facultatif');
{
  check('le compte rendu reste', confirmation.includes('Compte rendu'));
  check('…et il est annoncé comme facultatif',
    /Compte rendu <span className="muted">\(facultatif\)<\/span>/.test(confirmation));
  check('…avec un exemple discret', /placeholder="Ce qui s’est dit/.test(confirmation));

  check('« Ce qui en ressort » a disparu du formulaire',
    !confirmation.includes('Ce qui en ressort'));
  check('« Prochaines actions » aussi', !confirmation.includes('Prochaines actions'));
  check('…et leurs états locaux avec',
    !/setOutcome|setActions/.test(confirmation));
  check('un compte rendu vide n’est même pas envoyé',
    /\.\.\.\(notes\.trim\(\) \? \{ notes: notes\.trim\(\) \} : \{\}\)/.test(confirmation));

  // Ce qui a été saisi AVANT reste lisible : on ne demande plus, on n'efface pas.
  check('l’historique affiche encore un résultat ancien',
    /event\.outcome \? <span className="muted">\{event\.outcome\}/.test(listes));
  check('…et signale les actions déjà consignées',
    /event\.nextActions\.length > 0/.test(listes));

  const service = lire('backend/src/services/events/events.service.js');
  check('le serveur n’écrit pas une chaîne vide par-dessus un compte rendu',
    /typeof data\.notes === 'string' && data\.notes\.trim\(\)/.test(service));
  check('…et continue d’accepter les anciens champs',
    /data\.outcome/.test(service) && /data\.nextActions/.test(service));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Confirmer sans rien écrire — le parcours réel');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});

  const reunion = await meetings.createMeeting({
    projectId: 'projet-ui', title: 'Point sans compte rendu', scheduledAt: dans(-20),
    mode: 'ONSITE', address: '3 place du Marché',
  }, { email: 'dev@panel.test' });
  await meetings.convertDueMeetings();
  const attente = await PanelProjectEvent.findOne({ sourceMeetingId: String(reunion._id) }).lean();

  const res = await call('POST', `/api/events/${attente._id}/confirm`, {
    headers: AUTH, body: { participants: [] },
  });
  check('une réunion se confirme SANS compte rendu', res.status === 200);
  check('…et elle est bien confirmée', res.json.data.event.status === 'CONFIRMED');
  check('…sans qu’aucune chaîne vide ne soit inventée',
    res.json.data.event.notes === '' && res.json.data.event.outcome === '');
  check('…et l’auteur est consigné', res.json.data.event.confirmedBy === 'dev@panel.test');

  // Un événement ANCIEN, porteur des champs qu'on ne demande plus.
  const ancien = await PanelProjectEvent.create({
    projectId: 'projet-ui', type: 'CALL', title: 'Appel d’avant',
    occurredAt: new Date(), status: 'PENDING_CONFIRMATION',
    notes: 'Compte rendu d’origine', outcome: 'Accord de principe',
    nextActions: ['Envoyer le devis'],
  });
  const apres = await call('POST', `/api/events/${ancien._id}/confirm`, {
    headers: AUTH, body: {},
  });
  check('confirmer sans champs ne DÉTRUIT rien',
    apres.json.data.event.notes === 'Compte rendu d’origine'
    && apres.json.data.event.outcome === 'Accord de principe');
  check('…ni les actions déjà notées', apres.json.data.event.nextActions.length === 1);

  const blanc = await call('PUT', `/api/events/${ancien._id}`, {
    headers: AUTH, body: { notes: '   ' },
  });
  check('une correction à blanc reste possible, mais explicite',
    blanc.status === 200);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Filtres : aucun menu déroulant du système');
{
  // On lit le CODE, pas les commentaires : ce fichier-ci comme celui du
  // sélecteur thémé parlent de `<select>` pour expliquer ce qu'ils remplacent.
  const sansCommentaires = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  const fichiers = fs.readdirSync(path.join(racine, 'frontend/src/pages'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => [`pages/${f}`, sansCommentaires(lire(`frontend/src/pages/${f}`))])
    .concat(
      fs.readdirSync(path.join(racine, 'frontend/src/components'))
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => [`components/${f}`, sansCommentaires(lire(`frontend/src/components/${f}`))]),
    );

  // Un `<select>` natif ne se style pas : son menu est dessiné par le système
  // et ignore le thème. Il n'en reste que dans les FORMULAIRES, où le widget
  // natif du mobile a de la valeur — jamais dans un filtre.
  const fautifs = [];
  const restants = [];
  for (const [nom, source] of fichiers) {
    for (const found of source.matchAll(/<select/g)) {
      const avant = source.slice(Math.max(0, found.index - 260), found.index);
      restants.push(nom);
      if (/className="filter"|className="filter-row"/.test(avant)) fautifs.push(nom);
    }
  }
  check(`aucun filtre ne repose sur un select natif${fautifs.length ? ` — ${[...new Set(fautifs)].join(', ')}` : ''}`,
    fautifs.length === 0);
  /**
   * `pages/CompanyPage.tsx` A QUITTÉ CETTE LISTE — et c'est un progrès.
   *
   * Son dernier `<select>` natif est parti avec la restructuration de « Mon
   * entreprise » (sélecteur d'icônes dédié). L'attendu n'avait pas suivi : il
   * réclamait un widget qui n'existe plus. La liste reste EXACTE — un
   * `<select>` de plus, où que ce soit, fera échouer ce contrôle.
   */
  check(`les selects restants sont tous des champs de formulaire (${[...new Set(restants)].join(', ')})`,
    [...new Set(restants)].sort().join('|')
      === 'components/EventConfirmation.tsx|components/EventForms.tsx'
      + '|pages/DeploymentPage.tsx|pages/IntegratedApisPage.tsx|pages/ProjectActionsPage.tsx'
      + '|pages/ThemePage.tsx');

  for (const page of ['ActionsPage', 'FleetPage', 'IntegratedApisPage', 'ProjectDetailPage']) {
    check(`${page} filtre avec le sélecteur thémé`,
      lire(`frontend/src/pages/${page}.tsx`).includes('<ThemedFilter'));
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. Le sélecteur thémé : ouverture, clavier, sortie');
{
  check('le déclencheur est un bouton thémé, pas un champ natif',
    tselect.includes('className={ouvert ? \'tselect-trigger tselect-open\' : \'tselect-trigger\'}'));
  check('il s’annonce comme une liste déroulante',
    tselect.includes('aria-haspopup="listbox"') && tselect.includes('aria-expanded={ouvert}'));
  check('…et ses options comme telles',
    tselect.includes('role="listbox"') && tselect.includes('role="option"')
    && tselect.includes('aria-selected={option.value === value}'));

  check('flèches, Début et Fin parcourent la liste',
    /'ArrowDown'/.test(tselect) && /'ArrowUp'/.test(tselect)
    && /'Home'/.test(tselect) && /'End'/.test(tselect));
  check('Entrée et Espace choisissent', /e\.key === 'Enter' \|\| e\.key === ' '/.test(tselect));
  check('Échap ferme et rend le focus', /e\.key === 'Escape'[\s\S]{0,120}fermer\(true\)/.test(tselect));
  check('un clic à côté ferme', /document\.addEventListener\('mousedown', dehors\)/.test(tselect));
  check('…et l’écouteur est retiré', /removeEventListener\('mousedown', dehors\)/.test(tselect));

  check('le menu s’efface VRAIMENT au lieu de disparaître',
    tselect.includes('tselect-menu-closing') && /setFerme\(true\)/.test(tselect));
  check('…sur une durée alignée sur le thème', /const SORTIE_MS = 120;/.test(tselect));
  check('…et sans attente pour qui a demandé moins d’animations',
    /if \(mouvementReduit\(\)\) return;/.test(tselect)
    && tselect.includes("matchMedia('(prefers-reduced-motion: reduce)')"));

  check('le menu se retourne s’il n’y a pas la place dessous',
    /setVersLeHaut\(window\.innerHeight - cadre\.bottom < 240/.test(tselect));
  check('…et défile en lui-même plutôt que de déborder',
    /\.tselect-menu \{[\s\S]{0,600}max-height: 15rem;[\s\S]{0,80}overflow-y: auto/.test(css));

  check('le chevron pivote à l’ouverture',
    /\.tselect-open \.tselect-chevron \{\s*transform: rotate\(180deg\)/.test(css));
  check('l’entrée et la sortie sont deux animations distinctes',
    css.includes('@keyframes tselect-in') && css.includes('@keyframes tselect-out'));
  check('…toutes deux réglées par le token de mouvement',
    /animation: tselect-in var\(--p-motion\)/.test(css)
    && /animation: tselect-out var\(--p-motion-fast\)/.test(css));
  check('le focus du déclencheur est visible',
    /\.tselect-trigger:focus-visible \{[\s\S]{0,120}outline: 2px solid/.test(css));
  check('l’état désactivé est prévu', /\.tselect-trigger:disabled/.test(css));
  check('un placeholder est prévu', /\.tselect-placeholder/.test(css));
  check('la cible tactile fait au moins 44 px',
    /\.tselect-trigger \{[\s\S]{0,320}min-height: 44px/.test(css));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('9. Responsive et thème');
{
  const bloc900 = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('@media (max-width: 480px)'));
  check('une carte de réunion passe en une colonne sur mobile',
    /\.meeting-card-facts \{\s*flex-direction: column/.test(bloc900));
  check('…et « Rejoindre la réunion » prend toute la largeur',
    /\.meeting-card-actions \.btn \{[\s\S]{0,140}width: 100%/.test(bloc900));
  check('…avec une cible tactile suffisante',
    /\.meeting-card-actions \.btn \{[\s\S]{0,200}min-height: 44px/.test(bloc900));
  check('le sélecteur occupe la largeur de son filtre',
    /\.tselect,\s*\.filter \{\s*width: 100%/.test(bloc900));
  check('…et son menu ne déborde jamais',
    /\.tselect-menu \{\s*max-width: 100%/.test(bloc900));

  for (const [nom, source] of [
    ['EventLists', listes], ['Icon', icones], ['Links', liens],
    ['ThemedSelect', tselect], ['EventConfirmation', confirmation],
  ]) {
    check(`${nom} : aucune couleur en dur`, !/#[0-9a-fA-F]{3,8}\b/.test(source));
  }
  check('les nouveaux styles ne connaissent que les tokens',
    !/#[0-9a-fA-F]{3,8}\b/.test(css));
  check('la carte de réunion emprunte les surfaces du thème',
    /\.meeting-card \{[\s\S]{0,320}background: var\(--p-surface-raised\)/.test(css));
  check('…et son icône la couleur d’accent',
    /\.meeting-card-icon \{[\s\S]{0,260}color: var\(--p-primary\)/.test(css));
}

await close();
await stopMemoryMongo();
finish();
