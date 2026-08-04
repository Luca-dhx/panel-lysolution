/**
 * FINITIONS — actions de navigation, cartes projet, chronologie, imminence.
 *
 * Ce que ces contrôles verrouillent : qu'aucune action du Panel ne retombe sur
 * le bleu souligné du navigateur, que la carte d'un projet dise PEU, que
 * l'historique redevienne une chronologie dont les notes internes restent
 * fermées, et qu'une réunion proche le dise — « Demain », « Dans 20 min » —
 * avec une date CIVILE, pas un compte d'heures.
 *
 * Le calcul d'imminence est exécuté pour de vrai : c'est une fonction pure,
 * elle se teste sans navigateur.
 */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

// Le calcul d'imminence vit dans le frontend : on branche la résolution des
// alias `@/` ici, pour que ce runner s'exécute avec un simple `node`.
register('./helpers/frontendLoader.mjs', import.meta.url);

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

const css = lire('frontend/src/components.css');
const projets = lire('frontend/src/pages/ProjectsPage.tsx');
const fiche = lire('frontend/src/pages/ProjectDetailPage.tsx');
const timeline = lire('frontend/src/components/EventTimeline.tsx');
const listes = lire('frontend/src/components/EventLists.tsx');
const labels = lire('frontend/src/components/eventLabels.ts');
const api = lire('frontend/src/lib/api.ts');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Plus un seul lien bleu souligné');
{
  // Le Panel ne stylait pas ses `<a>` : tout lien hors barre latérale
  // retombait sur le rendu par défaut du navigateur.
  check('les liens prennent la couleur du thème',
    /^a \{[\s\S]{0,120}color: var\(--p-primary\);[\s\S]{0,60}text-decoration: none;/m.test(css));
  check('…et ne se soulignent qu’au survol',
    /^a:hover \{\s*text-decoration: underline;/m.test(css));
  check('un lien habillé en bouton ne se souligne JAMAIS',
    /\.btn,\s*\.btn:hover,[\s\S]{0,80}text-decoration: none;/.test(css));
  check('une action de navigation a sa propre classe',
    css.includes('.link-nav,') && css.includes('.link-back'));
  check('…avec un survol thémé', /\.link-nav:hover,\s*\.link-back:hover \{[\s\S]{0,80}color: var\(--p-primary\)/.test(css));
  check('…et un focus visible',
    /\.link-nav:focus-visible,\s*\.link-back:focus-visible \{[\s\S]{0,120}outline: 2px solid/.test(css));

  check('le retour vers les projets clients est une action, pas un lien nu',
    /<Link className="link-back" to="\/projects">/.test(fiche));
  check('…avec son icône', /link-back[\s\S]{0,120}<Icon name="chevron-down"/.test(fiche));
  check('« Voir » reste un bouton', /className="btn btn-secondary btn-small" to=\{`\/projects\//.test(projets));
  check('aucune couleur bleue en dur dans les écrans concernés',
    !/color:\s*blue|#0000ff/i.test(css + projets + fiche));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. La carte projet dit peu');
{
  check('elle porte l’identité', /projectDisplayName\(project\)/.test(projets)
    && /projectInitials\(project\)|projectLogoUrl/.test(projets));
  check('…un slogan court', /project-card-tagline/.test(projets));
  check('…l’état du site', /siteState\(project\)/.test(projets));
  check('…l’état du contrat', /contractState\(contract\.status\)/.test(projets));
  check('…l’adresse mise en forme', /LinkChip icon="globe"/.test(projets));
  check('…et une seule action', (projets.match(/className="btn btn-secondary btn-small"/g) || []).length === 1);

  // Ce qui appartient à la fiche a quitté la carte.
  check('le dernier contact a quitté la carte', !/lastContact/.test(projets));
  check('l’état du lien avec le Panel aussi', !/connectionState/.test(projets));
  check('le montant de l’abonnement aussi', !/formatAmount|formatInterval/.test(projets));
  check('la note interne aussi', !/project\.note/.test(projets));

  // …mais l'alerte de synchronisation reste : ce n'est pas du décor, c'est le
  // seul signe qu'une donnée affichée est peut-être périmée.
  check('l’identité non synchronisée reste signalée',
    projets.includes('Identité non synchronisée'));

  check('la carte est aérée et sans surcharge de bordures',
    /\.project-card \{[\s\S]{0,200}display: grid/.test(css));
  check('…avec un survol discret',
    /\.project-card:hover \{\s*border-color: var\(--p-border-strong\)/.test(css));
  check('un slogan trop long est tronqué proprement',
    /\.project-card-tagline \{[\s\S]{0,200}-webkit-line-clamp: 2/.test(css));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Chronologie : compacte, dépliable, notes fermées');
{
  check('la fiche projet affiche une chronologie', fiche.includes('<EventTimeline'));
  check('…strictement bornée au projet courant',
    /EventTimeline events=\{historique\}/.test(fiche));
  check('une seule ligne verticale porte la chronologie',
    /\.timeline::before \{[\s\S]{0,220}width: 1px/.test(css));
  check('chaque événement a son icône de type', /const ICONES: Record<EventType, IconName>/.test(timeline));

  check('l’entrée compacte montre le titre, la date et l’état',
    /timeline-title/.test(timeline) && /formatDateTime\(event\.occurredAt\)/.test(timeline)
    && /eventStatusState\(event\.status\)/.test(timeline));
  check('…et l’auteur du constat quand il existe', /event\.confirmedBy \?/.test(timeline));

  // Le point sensible : les notes internes ne sont PAS dans la liste compacte.
  check('les notes internes ne s’affichent qu’une fois l’entrée ouverte',
    /\{ouvert \? \([\s\S]{0,400}Compte rendu/.test(timeline));
  check('…le résumé compact se limite à UNE ligne',
    /const resume = event\.outcome[\s\S]{0,140}split\(\/\\r\?\\n\/\)\[0\]/.test(timeline)
    && /\.timeline-resume \{[\s\S]{0,200}white-space: nowrap/.test(css));
  check('…et disparaît quand le détail est ouvert', /resume && !ouvert/.test(timeline));

  check('le détail porte le compte rendu, les participants et le résultat',
    timeline.includes('Compte rendu') && timeline.includes('Participants')
    && timeline.includes('Ce qui en est ressorti'));
  check('…le motif de non-tenue', /event\.missedReason \?/.test(timeline));
  check('…le lien avec la réunion d’origine', /event\.sourceMeetingId \?/.test(timeline));
  check('…et l’audit des corrections, avant/après',
    /event\.revisions\.length > 0/.test(timeline) && /change\.from/.test(timeline)
    && /change\.to/.test(timeline));

  check('une seule entrée s’ouvre à la fois',
    /setOuvert\(\(actuel\) => \(actuel === event\._id \? null : event\._id\)\)/.test(timeline));
  check('l’état d’ouverture est annoncé aux lecteurs d’écran',
    /aria-expanded=\{ouvert\}/.test(timeline) && /aria-controls=\{detailId\}/.test(timeline));
  check('l’entrée entière est cliquable au clavier',
    /<button\s+type="button"\s+className="timeline-entry"/.test(timeline));
  check('la cible tactile fait au moins 44 px',
    /\.timeline-entry \{[\s\S]{0,320}min-height: 44px/.test(css));
  check('l’ouverture est animée, brièvement',
    css.includes('@keyframes timeline-open')
    && /animation: timeline-open var\(--p-motion\)/.test(css));
  check('…donc coupée pour qui a demandé moins d’animations',
    lire('frontend/src/tokens.css').includes('prefers-reduced-motion'));
  check('le chevron pivote à l’ouverture',
    /\.timeline-item-open \.timeline-chevron \{\s*transform: rotate\(180deg\)/.test(css));
  check('aucune couleur en dur dans la chronologie', !/#[0-9a-fA-F]{3,8}\b/.test(timeline));

  const bloc900 = css.slice(css.indexOf('@media (max-width: 900px)'), css.indexOf('@media (max-width: 480px)'));
  check('la chronologie se resserre sur mobile sans rien perdre',
    /\.timeline-item \{\s*padding-left: 2\.25rem/.test(bloc900));
  check('…et un long compte rendu revient à la ligne',
    /\.timeline-block p,[\s\S]{0,200}overflow-wrap: anywhere/.test(css));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Imminence d’une réunion — le calcul, pour de vrai');
{
  // Le module est du TypeScript sans annotation exotique : on le charge via le
  // chargeur du dépôt s'il est disponible, sinon on rejoue la fonction.
  const source = labels;
  check('le calcul est une fonction PURE, l’instant est un paramètre',
    /export function meetingImminence\([\s\S]{0,200}maintenant: Date = new Date\(\)/.test(source));
  check('…et aucune carte ne pose de minuteur',
    !/setInterval/.test(listes) && !/setInterval/.test(timeline));

  check('« demain » se décide sur la DATE civile, jamais sur 24 heures',
    /const jour = \(d: Date\) =>[\s\S]{0,120}getFullYear\(\), d\.getMonth\(\), d\.getDate\(\)/.test(source)
    && !/24 \* 60 \* 60/.test(source));
  check('…dans le fuseau déjà utilisé par le Panel',
    !/toISOString|UTC/.test(source));

  for (const [libelle, motif] of [
    ['Demain', "label: 'Demain'"],
    ['Maintenant', "label: 'Maintenant'"],
    ['Dans X min', 'Dans ${minutes} min'],
    ['Dans moins d’une heure', 'Dans moins d’une heure'],
    ['Dans X h', 'Dans ${heures} h'],
  ]) {
    check(`le libellé « ${libelle} » existe`, source.includes(motif));
  }
  check('les autres réunions gardent leur état neutre',
    /return \{ \.\.\.neutre, imminent: false \};/.test(source));
  check('la pastille imminente emprunte le ton d’alerte du thème',
    (source.match(/tone: 'warn', imminent: true/g) || []).length >= 3);

  check('la carte de réunion affiche cette pastille',
    /meetingImminence\(meeting\.scheduledAt, meeting\.status\)/.test(listes));
  check('…avec une icône horloge quand elle est imminente',
    /etat\.imminent \? <Icon name="clock"/.test(listes));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4 bis. L’imminence CALCULÉE — cas par cas');
{
  const { meetingImminence } = await import('@/components/eventLabels');
  // Un instant de référence fixe : mardi 4 août 2026, 14 h 00, heure locale.
  const maintenant = new Date(2026, 7, 4, 14, 0, 0);
  const a = (h, m = 0, jours = 0) => {
    const d = new Date(maintenant);
    d.setDate(d.getDate() + jours);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const dire = (iso, statut = 'PLANNED') => meetingImminence(iso, statut, maintenant);

  check('dans 3 h → « Dans 3 h »', dire(a(17)).label === 'Dans 3 h');
  check('dans 45 min → « Dans moins d’une heure »',
    dire(a(14, 45)).label === 'Dans moins d’une heure');
  check('dans 15 min → « Dans 15 min »', dire(a(14, 15)).label === 'Dans 15 min');
  check('dans 5 min → « Dans 5 min »', dire(a(14, 5)).label === 'Dans 5 min');
  check('l’heure atteinte, l’ordonnanceur en retard → « Maintenant »',
    dire(a(13, 59)).label === 'Maintenant');
  check('…et à la minute exacte aussi', dire(a(14, 0)).label === 'Maintenant');

  check('demain matin → « Demain »', dire(a(9, 0, 1)).label === 'Demain');
  check('demain tard → « Demain » aussi', dire(a(23, 30, 1)).label === 'Demain');
  check('ce soir 23 h 30 n’est PAS demain', dire(a(23, 30)).label === 'Dans 10 h');
  check('après-demain retombe sur l’état neutre', dire(a(9, 0, 2)).label === 'Prévue');

  check('toutes les formes proches sont en ton d’alerte',
    [a(17), a(14, 15), a(9, 0, 1)].every((iso) => dire(iso).tone === 'warn'));
  check('…et marquées imminentes', dire(a(17)).imminent === true);
  check('une réunion lointaine ne l’est pas', dire(a(9, 0, 2)).imminent === false);

  check('une réunion ANNULÉE garde son état', dire(a(17), 'CANCELLED').label === 'Annulée');
  check('une réunion REPORTÉE aussi', dire(a(17), 'RESCHEDULED').label === 'Reportée');
  check('une réunion à confirmer aussi',
    dire(a(9), 'DONE_PENDING_CONFIRMATION').label === 'À confirmer');
  check('une date illisible ne casse rien', dire('pas-une-date').label === 'Prévue');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Téléchargement du contrat côté Panel');
{
  check('le lien de téléchargement entre RÉELLEMENT dans le document',
    /document\.body\.appendChild\(lien\)/.test(api) && /lien\.remove\(\)/.test(api));
  check('…et l’URL objet n’est révoquée qu’APRÈS le clic',
    /lien\.click\(\);[\s\S]{0,200}setTimeout\(\(\) => URL\.revokeObjectURL/.test(api));
  check('aucune ouverture d’onglet sur une URL blob',
    !/window\.open\(/.test(api) && !/location\.href = (url|objectUrl)/.test(api));
  check('une erreur JSON n’est jamais prise pour un PDF',
    /application\\\/json\|text\\\/html/.test(api));
  check('…et un fichier vide est refusé', /blob\.size === 0/.test(api));
  check('le nom vient des en-têtes quand le serveur le donne',
    /content-disposition/.test(api) && /filename\\\*\?=/.test(api));
}

finish();
