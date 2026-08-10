/**
 * LOT D — « CONNEXION PROJET » ET « VITRINE » SONT DEUX FAITS.
 *
 * ══ CE QUE L'ÉCRAN DISAIT, ET POURQUOI C'ÉTAIT FAUX ═════════════════════════
 *
 * La fiche portait une ligne « État du site : En ligne », alimentée par
 * `runtime.lastHealth` et `liveness` — c'est-à-dire par le BATTEMENT DE CŒUR du
 * pont. Une vitrine SUSPENDUE par la protection contractuelle, donc
 * inaccessible à ses visiteurs, s'y affichait « En ligne » dès lors que son
 * backend répondait normalement.
 *
 * L'écran disait l'exact contraire du réel, et avec assurance.
 *
 * ══ LE CAS QUI TRANCHE ══════════════════════════════════════════════════════
 *
 *     heartbeat CONNECTÉ + SiteStatus SUSPENDED
 *       → Connexion projet : Connecté
 *       → Vitrine          : Suspendue
 *
 * Les deux lignes doivent pouvoir se contredire. C'est précisément quand elles
 * se contredisent qu'elles servent à quelque chose.
 */
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';
import { register } from 'node:module';

/**
 * Le chargeur est enregistré ICI, comme dans les autres suites frontend : le
 * lanceur commun exécute chaque fichier par un simple `node fichier.js`, sans
 * option supplémentaire. Un test qui exigerait `--import` serait vert à la main
 * et sauté par la suite.
 */
register('./helpers/frontendLoader.mjs', import.meta.url);

const {
  connectionState, vitrineState, vitrineSuspensionReason, instanceHealthState,
} = await import('@/lib/projectPresentation.ts');

/** Une fiche minimale — seuls les champs que ces fonctions lisent. */
const fiche = ({ liveness = 'ONLINE', health = { status: 'OK' }, siteStatus = null }) => ({
  pairing: { status: 'PAIRED' },
  liveness,
  runtime: { lastHealth: health },
  business: { siteStatus },
});

const SITE = (patch) => ({
  accessible: true,
  status: 'ACTIVE',
  suspensionSource: 'NONE',
  reason: null,
  suspendedAt: null,
  contractProtectionEnabled: false,
  technicalSuspension: false,
  modifiedAt: null,
  receivedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

/* ────────────────────────────────────────────────────────────────────────── */
section('CONNECTÉ + VITRINE ACTIVE');
{
  const p = fiche({ siteStatus: SITE({}) });
  check('connexion : Connecté', connectionState(p).label === 'Connecté');
  check('vitrine : Active', vitrineState(p).label === 'Active');
  check('…aucune cause de suspension', vitrineSuspensionReason(p) === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('LE CAS QUI TRANCHE — connecté ET vitrine SUSPENDUE');
{
  const p = fiche({
    liveness: 'ONLINE',
    health: { status: 'OK' },
    siteStatus: SITE({
      accessible: false,
      status: 'SUSPENDED',
      suspensionSource: 'CONTRACT',
      contractProtectionEnabled: true,
      reason: 'Aucun contrat actif',
    }),
  });

  check('CONNEXION PROJET : Connecté', connectionState(p).label === 'Connecté');
  check('VITRINE : Suspendue', vitrineState(p).label === 'Suspendue');
  check('…les deux se contredisent, et c’est le but',
    connectionState(p).tone === 'ok' && vitrineState(p).tone !== 'ok');
  check('…la cause est nommée : contractuelle',
    vitrineSuspensionReason(p) === 'Protection contractuelle');

  /**
   * ET LA SANTÉ TECHNIQUE RESTE BONNE. C'est exactement ce qui rendait
   * l'ancien libellé trompeur : l'instance va bien, le site n'est pas servi.
   */
  check('…tandis que l’instance, elle, est saine',
    instanceHealthState(p).label === 'Instance saine');
  check('…et ce libellé ne parle PLUS de « site »',
    !/site/i.test(instanceHealthState(p).label));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('SUSPENSION TECHNIQUE, PROTECTION CONTRAT DÉSACTIVÉE');
{
  const p = fiche({
    siteStatus: SITE({
      accessible: false,
      status: 'SUSPENDED',
      suspensionSource: 'TECHNICAL',
      technicalSuspension: true,
      contractProtectionEnabled: false,
      reason: 'Maintenance planifiée',
    }),
  });

  check('vitrine : Suspendue', vitrineState(p).label === 'Suspendue');
  check('…la cause est TECHNIQUE, jamais contractuelle',
    /technique/i.test(vitrineSuspensionReason(p)));
  check('…et le motif du projet est repris tel quel',
    vitrineSuspensionReason(p).includes('Maintenance planifiée'));
  check('…aucune mention de contrat',
    !/contrat/i.test(vitrineSuspensionReason(p)));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('PROJET HORS LIGNE — la dernière projection reste lisible');
{
  const p = fiche({
    liveness: 'OFFLINE',
    health: null,
    siteStatus: SITE({
      accessible: false,
      status: 'SUSPENDED',
      suspensionSource: 'CONTRACT',
      contractProtectionEnabled: true,
    }),
  });

  check('connexion : ne communique plus',
    connectionState(p).label === 'Ne communique plus');
  /**
   * LE DERNIER ÉTAT CONNU RESTE AFFICHABLE. Une projection reçue avant la
   * coupure ne devient pas fausse parce que le projet s'est tu — elle devient
   * ancienne, et c'est sa date qui le dit.
   */
  check('VITRINE : la dernière valeur reçue reste affichée',
    vitrineState(p).label === 'Suspendue');
  check('…et elle n’est jamais présentée comme active', vitrineState(p).tone !== 'ok');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('AUCUNE PROJECTION REÇUE — on le dit, on ne suppose pas');
{
  const p = fiche({ siteStatus: null });
  check('vitrine : aucun état reçu', vitrineState(p).label === 'Aucun état reçu');
  check('…jamais « Active »', vitrineState(p).label !== 'Active');
  check('…ton neutre, pas rassurant', vitrineState(p).tone === 'neutral');
  check('…et aucune cause inventée', vitrineSuspensionReason(p) === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('LE HEARTBEAT NE MODIFIE JAMAIS L’ÉTAT DE LA VITRINE');
{
  const suspendue = SITE({
    accessible: false,
    status: 'SUSPENDED',
    suspensionSource: 'CONTRACT',
  });

  const avant = vitrineState(fiche({ liveness: 'ONLINE', siteStatus: suspendue }));
  const apres = vitrineState(fiche({ liveness: 'STALE', siteStatus: suspendue }));
  const jamais = vitrineState(fiche({ liveness: 'NEVER_SEEN', siteStatus: suspendue }));

  check('la vitrine ne dépend pas de la vivacité du pont',
    avant.label === apres.label && apres.label === jamais.label);
  check('…elle reste Suspendue dans les trois cas', avant.label === 'Suspendue');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('AUCUN ÉCRAN N’APPELLE PLUS L’ANCIEN LIBELLÉ');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  /**
   * Résolu depuis CE FICHIER, jamais depuis le répertoire courant.
   *
   * `path.resolve('frontend/src')` partait de `process.cwd()` — donc de
   * `Panel/backend` quand la suite est lancée par `npm test`, où ce dossier
   * n'existe pas. Le test passait à la main depuis la racine et échouait dans
   * la commande canonique : la pire des deux situations, puisqu'on ne le
   * découvrait qu'en lisant le journal complet.
   */
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src');

  const fichiers = [];
  const parcourir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) parcourir(f);
      else if (/\.(ts|tsx)$/.test(e.name)) fichiers.push(f);
    }
  };
  parcourir(racine);

  const code = (f) => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const appelants = fichiers.filter((f) => /\bsiteState\s*\(/.test(code(f)));
  check(`plus aucun appel à siteState${appelants.length ? ` — ${appelants.map((f) => path.basename(f))}` : ''}`,
    appelants.length === 0);

  /**
   * ON LIT LE CODE, PAS LES COMMENTAIRES.
   *
   * L'ancien libellé est cité dans l'explication qui accompagne la correction —
   * c'est même le seul endroit où il doit subsister, pour que le prochain
   * lecteur sache ce qui a été réparé. Ce qu'on interdit, c'est de le RENDRE.
   */
  const detail = code(path.join(racine, 'pages/ProjectDetailPage.tsx'));
  check('la fiche ne RÉAFFICHE plus « État du site »', !detail.includes('État du site'));
  check('…elle porte « Connexion projet »', detail.includes('Connexion projet'));
  check('…et « Vitrine »', detail.includes('<dt>Vitrine</dt>'));
}

finish();
