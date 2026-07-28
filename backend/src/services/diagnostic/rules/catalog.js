// CATALOGUE DÉCLARATIF DES RÈGLES — toute la connaissance métier du
// diagnostic vit ici, et nulle part ailleurs.
//
// Ajouter un diagnostic = ajouter une entrée à ce tableau. Il n'existe aucun
// `if` de diagnostic ailleurs dans le code, aucune chaîne codée en dur dans
// une page. C'est la garantie que la logique reste lisible et auditable
// quand le catalogue aura triplé.
//
// ── LE CONTEXTE reçu par chaque règle ───────────────────────────────────────
// {
//   now       horodatage injecté (jamais Date.now() implicite)
//   project   descripteur de supervision (Phase 3A) :
//             { slug, name, type, environment, primaryDomain, urls,
//               versions: { software, contract, manifestFormat,
//                           deploymentEngine, duplicationEngine },
//               dates: { createdAt, pairedAt, lastHeartbeatAt, … } }
//   record    fiche brute { pairing, runtime, manifest, manifestSource }
//   health    santé Phase 3A { status, liveness, components[] }
//   panel     référence { contractVersion, minimumContractVersion,
//                         engines, thresholds, certificateWarningDays }
// }
//
// Toutes les règles sont PURES : elles lisent le contexte, rien d'autre.
import { CATEGORY, SEVERITY } from './engine.js';

/* -------------------------------------------------------------------------- */
/*  Aides de comparaison — partagées, jamais dupliquées dans une règle        */
/* -------------------------------------------------------------------------- */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value) {
  const m = SEMVER_RE.exec(String(value ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const part of ['major', 'minor', 'patch']) {
    if (va[part] !== vb[part]) return va[part] < vb[part] ? -1 : 1;
  }
  return 0;
}

const isPaired = (ctx) => ctx.record?.pairing?.status === 'PAIRED';
const daysUntil = (iso, now) => Math.floor((new Date(iso).getTime() - now) / 86_400_000);
const componentOf = (ctx, id) => ctx.health?.components?.find((c) => c.id === id);

/* -------------------------------------------------------------------------- */
/*  CONNECTIVITÉ — le projet parle-t-il ?                                     */
/* -------------------------------------------------------------------------- */

const CONNECTIVITY_RULES = [
  {
    id: 'HEARTBEAT_OFFLINE',
    category: CATEGORY.CONNECTIVITY,
    component: 'heartbeat',
    severity: SEVERITY.CRITICAL,
    title: 'Projet hors ligne',
    description: 'Aucun signal reçu depuis le seuil hors ligne.',
    impact: 'Le Panel ne sait plus rien de l’état réel du projet. Une panne en cours passerait inaperçue.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'heartbeat', blocks: true },
    when: (ctx) => ctx.health?.liveness === 'OFFLINE' && {
      facts: {
        lastHeartbeatAt: ctx.project?.dates?.lastHeartbeatAt ?? null,
        offlineAfterS: ctx.panel?.thresholds?.offlineAfterS ?? null,
      },
    },
    explain: (ctx, f) => f.lastHeartbeatAt
      ? `Dernier signal reçu le ${f.lastHeartbeatAt}, soit au-delà du seuil de ${f.offlineAfterS} s configuré.`
      : 'Aucun signal n’a jamais été reçu, alors que le projet est appairé.',
    recommendation: () => ({
      action: 'Vérifier que le backend du projet tourne et que son PanelBridge est configuré',
      benefit: 'Rétablir la visibilité sur l’état réel du projet',
      risk: 'Aucun : il s’agit d’une vérification côté projet',
      prerequisites: ['Accès au serveur du projet'],
      futureAction: 'DIAGNOSE_REMOTE',
    }),
  },
  {
    id: 'HEARTBEAT_STALE',
    category: CATEGORY.CONNECTIVITY,
    component: 'heartbeat',
    severity: SEVERITY.MEDIUM,
    title: 'Signal périmé',
    description: 'Le dernier signal vieillit au-delà de la cadence attendue.',
    impact: 'L’état affiché n’est peut-être plus à jour ; une dégradation récente serait invisible.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'heartbeat', blocks: false },
    when: (ctx) => ctx.health?.liveness === 'STALE' && {
      facts: {
        lastHeartbeatAt: ctx.project?.dates?.lastHeartbeatAt ?? null,
        staleAfterS: ctx.panel?.thresholds?.staleAfterS ?? null,
      },
    },
    explain: (ctx, f) => `Dernier signal le ${f.lastHeartbeatAt}, au-delà du seuil de ${f.staleAfterS} s, mais en deçà du seuil hors ligne.`,
    recommendation: () => ({
      action: 'Contrôler la régularité des heartbeats du projet',
      benefit: 'Retrouver une observabilité fiable',
      risk: 'Aucun',
      prerequisites: [],
      futureAction: 'DIAGNOSE_REMOTE',
    }),
  },
  {
    id: 'NEVER_SEEN',
    category: CATEGORY.CONNECTIVITY,
    component: 'heartbeat',
    severity: SEVERITY.HIGH,
    title: 'Projet appairé mais jamais vu',
    description: 'L’appairage a réussi, mais aucun signal n’a jamais été reçu.',
    impact: 'L’appairage pourrait être incomplet côté projet : le pont sortant n’est peut-être pas actif.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'heartbeat', blocks: true },
    when: (ctx) => ctx.health?.liveness === 'NEVER_SEEN' && {
      facts: { pairedAt: ctx.project?.dates?.pairedAt ?? null },
    },
    explain: (ctx, f) => `Appairage établi le ${f.pairedAt}, aucun heartbeat reçu depuis.`,
    recommendation: () => ({
      action: 'Vérifier que le PanelBridge du projet émet bien ses heartbeats',
      benefit: 'Activer la supervision effective de ce projet',
      risk: 'Aucun',
      prerequisites: ['Accès à la configuration du projet'],
      futureAction: 'DIAGNOSE_REMOTE',
    }),
  },
  {
    id: 'NOT_PAIRED',
    category: CATEGORY.LIFECYCLE,
    component: 'bridge',
    severity: SEVERITY.INFO,
    title: 'Projet non appairé',
    description: 'Le projet est déclaré mais n’a pas encore établi son appairage.',
    impact: 'Aucun : c’est un état normal du cycle de vie (STANDALONE).',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'bridge', blocks: true },
    when: (ctx) => ctx.record?.pairing?.status === 'DECLARED' && {
      facts: { createdAt: ctx.project?.dates?.createdAt ?? null },
    },
    explain: (ctx, f) => `Fiche créée le ${f.createdAt}, statut d’appairage « DECLARED ».`,
    recommendation: () => ({
      action: 'Saisir le code d’appairage dans l’écran « Connexion Panel » du projet',
      benefit: 'Activer la supervision et la synchronisation',
      risk: 'Aucun : l’appairage est réversible à tout moment',
      prerequisites: ['Un code d’appairage valide (généré depuis la fiche projet)'],
      futureAction: 'ISSUE_PAIRING_CODE',
    }),
  },
  {
    id: 'PAIRING_REVOKED',
    category: CATEGORY.LIFECYCLE,
    component: 'bridge',
    severity: SEVERITY.INFO,
    title: 'Appairage révoqué',
    description: 'L’appairage a été révoqué : le projet fonctionne en autonomie.',
    impact: 'Aucun pour le projet (STANDALONE est un état normal). Le Panel ne le supervise plus.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'bridge', blocks: true },
    when: (ctx) => ctx.record?.pairing?.status === 'REVOKED' && {
      facts: { revokedAt: ctx.record?.pairing?.revokedAt ?? null },
    },
    explain: (ctx, f) => `Appairage révoqué le ${f.revokedAt} ; les credentials de pont ont été effacés.`,
    recommendation: () => ({
      action: 'Générer un nouveau code d’appairage si la supervision doit reprendre',
      benefit: 'Rétablir la supervision',
      risk: 'Aucun',
      prerequisites: [],
      futureAction: 'ISSUE_PAIRING_CODE',
    }),
  },
];

/* -------------------------------------------------------------------------- */
/*  COMPATIBILITÉ — le projet parle-t-il la même langue que l'écosystème ?    */
/* -------------------------------------------------------------------------- */

const COMPATIBILITY_RULES = [
  {
    id: 'CONTRACT_MAJOR_MISMATCH',
    category: CATEGORY.COMPATIBILITY,
    component: 'bridge',
    severity: SEVERITY.CRITICAL,
    title: 'Contrat de pont incompatible',
    description: 'Le projet parle une majeure de contrat différente de celle du Panel.',
    impact: 'Les échanges de pont échouent : ni heartbeat, ni synchronisation possibles.',
    origin: 'PANEL_ANALYSIS',
    readiness: { criterion: 'compatibility', blocks: true },
    when: (ctx) => {
      const project = parseVersion(ctx.project?.versions?.contract);
      const panel = parseVersion(ctx.panel?.contractVersion);
      if (!project || !panel || project.major === panel.major) return false;
      return { facts: { projectVersion: ctx.project.versions.contract, panelVersion: ctx.panel.contractVersion } };
    },
    explain: (ctx, f) => `Le projet annonce le contrat ${f.projectVersion}, le Panel sert ${f.panelVersion} : les majeures diffèrent, ce qui est une rupture par définition.`,
    recommendation: (ctx, f) => ({
      action: `Aligner le projet sur la majeure de contrat ${parseVersion(f.panelVersion).major}.x`,
      benefit: 'Rétablir les échanges de pont',
      risk: 'Changement majeur : une période de double-service peut être nécessaire',
      prerequisites: ['Mise à jour du miroir de contrat du projet', 'Recette du pont'],
      futureAction: 'PLAN_CONTRACT_MIGRATION',
    }),
  },
  {
    id: 'CONTRACT_OUTDATED',
    category: CATEGORY.COMPATIBILITY,
    component: 'bridge',
    severity: SEVERITY.LOW,
    title: 'Contrat de pont en retard',
    description: 'Le projet parle une mineure de contrat antérieure à celle du Panel.',
    impact: 'Le projet ne publie pas les informations ajoutées depuis : la supervision est partielle.',
    origin: 'PANEL_ANALYSIS',
    readiness: { criterion: 'compatibility', blocks: false },
    when: (ctx) => {
      const cmp = compareVersions(ctx.project?.versions?.contract, ctx.panel?.contractVersion);
      if (cmp === null || cmp >= 0) return false;
      const project = parseVersion(ctx.project.versions.contract);
      const panel = parseVersion(ctx.panel.contractVersion);
      if (project.major !== panel.major) return false; // couvert par la règle majeure
      return { facts: { projectVersion: ctx.project.versions.contract, panelVersion: ctx.panel.contractVersion } };
    },
    explain: (ctx, f) => `Le projet parle ${f.projectVersion}, le Panel sert ${f.panelVersion}. Les évolutions étant additives, les échanges fonctionnent, mais les champs récents ne sont pas publiés.`,
    recommendation: (ctx, f) => ({
      action: `Mettre à jour le miroir de contrat du projet en ${f.panelVersion}`,
      benefit: 'Publier les informations de supervision ajoutées depuis (uptime, charge, versions de moteurs)',
      risk: 'Faible : évolution additive, rétrocompatible',
      prerequisites: ['Recopier les specs ratifiées', 'Relancer la suite de tests du projet'],
      futureAction: 'PLAN_CONTRACT_UPGRADE',
    }),
  },
  {
    id: 'CONTRACT_AHEAD',
    category: CATEGORY.COMPATIBILITY,
    component: 'bridge',
    severity: SEVERITY.MEDIUM,
    title: 'Contrat de pont plus récent que le Panel',
    description: 'Le projet parle une version de contrat postérieure à celle du Panel.',
    impact: 'Le Panel ignore les champs qu’il ne connaît pas : la supervision reste partielle de son côté.',
    origin: 'PANEL_ANALYSIS',
    readiness: { criterion: 'compatibility', blocks: false },
    when: (ctx) => {
      const cmp = compareVersions(ctx.project?.versions?.contract, ctx.panel?.contractVersion);
      if (cmp === null || cmp <= 0) return false;
      const project = parseVersion(ctx.project.versions.contract);
      const panel = parseVersion(ctx.panel.contractVersion);
      if (project.major !== panel.major) return false;
      return { facts: { projectVersion: ctx.project.versions.contract, panelVersion: ctx.panel.contractVersion } };
    },
    explain: (ctx, f) => `Le projet parle ${f.projectVersion}, le Panel ${f.panelVersion} : c’est le PANEL qui est en retard.`,
    recommendation: (ctx, f) => ({
      action: `Mettre à jour le Panel en contrat ${f.projectVersion}`,
      benefit: 'Exploiter toutes les informations que le projet publie déjà',
      risk: 'Faible : évolution additive',
      prerequisites: ['Recopier les specs ratifiées dans le Panel'],
      futureAction: 'PLAN_PANEL_UPGRADE',
    }),
  },
  {
    id: 'CONTRACT_UNKNOWN',
    category: CATEGORY.COMPATIBILITY,
    component: 'bridge',
    severity: SEVERITY.MEDIUM,
    title: 'Version de contrat inconnue',
    description: 'Le projet n’a jamais annoncé sa version de contrat.',
    impact: 'Impossible de garantir que les échanges de pont sont compatibles.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'compatibility', blocks: true },
    when: (ctx) => isPaired(ctx) && !ctx.project?.versions?.contract && { facts: {} },
    explain: () => 'Aucune version de contrat n’a été reçue, ni au bootstrap ni par heartbeat.',
    recommendation: () => ({
      action: 'Vérifier que le PanelBridge du projet annonce sa version de contrat',
      benefit: 'Permettre la vérification de compatibilité',
      risk: 'Aucun',
      prerequisites: [],
      futureAction: 'DIAGNOSE_REMOTE',
    }),
  },
];

/* -------------------------------------------------------------------------- */
/*  MOTEURS — dérive du standard embarqué                                     */
/* -------------------------------------------------------------------------- */

function engineRules({ id, component, key, label }) {
  return [
    {
      id: `${id}_MAJOR_DRIFT`,
      category: CATEGORY.COMPATIBILITY,
      component,
      severity: SEVERITY.HIGH,
      title: `${label} : majeure divergente`,
      description: `Le ${label.toLowerCase()} du projet est sur une majeure différente du standard.`,
      impact: 'Une majeure est une rupture : les procédures de déploiement du standard ne s’appliquent plus telles quelles.',
      origin: 'PANEL_ANALYSIS',
      readiness: { criterion: 'engines', blocks: true },
      when: (ctx) => {
        const project = parseVersion(ctx.project?.versions?.[key === 'deployment' ? 'deploymentEngine' : 'duplicationEngine']);
        const standard = parseVersion(ctx.panel?.engines?.[key]);
        if (!project || !standard || project.major === standard.major) return false;
        return {
          facts: {
            projectVersion: ctx.project.versions[key === 'deployment' ? 'deploymentEngine' : 'duplicationEngine'],
            standardVersion: ctx.panel.engines[key],
          },
        };
      },
      explain: (ctx, f) => `Le projet embarque la version ${f.projectVersion}, le standard est en ${f.standardVersion} : majeures différentes.`,
      recommendation: (ctx, f) => ({
        action: `Migrer le ${label.toLowerCase()} du projet vers ${f.standardVersion}`,
        benefit: 'Retrouver un moteur conforme au standard, avec ses correctifs',
        risk: 'Majeur : consulter les ruptures déclarées dans le manifeste du moteur',
        prerequisites: ['Plan de migration du moteur', 'Suite de tests du projet verte'],
        futureAction: 'PLAN_ENGINE_MIGRATION',
      }),
    },
    {
      id: `${id}_OUTDATED`,
      category: CATEGORY.COMPATIBILITY,
      component,
      severity: SEVERITY.LOW,
      title: `${label} : version en retard`,
      description: `Le ${label.toLowerCase()} du projet est antérieur au standard.`,
      impact: 'Le projet ne bénéficie pas des correctifs et capacités ajoutés depuis.',
      origin: 'PANEL_ANALYSIS',
      readiness: { criterion: 'engines', blocks: false },
      when: (ctx) => {
        const field = key === 'deployment' ? 'deploymentEngine' : 'duplicationEngine';
        const cmp = compareVersions(ctx.project?.versions?.[field], ctx.panel?.engines?.[key]);
        if (cmp === null || cmp >= 0) return false;
        const project = parseVersion(ctx.project.versions[field]);
        const standard = parseVersion(ctx.panel.engines[key]);
        if (project.major !== standard.major) return false;
        return { facts: { projectVersion: ctx.project.versions[field], standardVersion: ctx.panel.engines[key] } };
      },
      explain: (ctx, f) => `Version embarquée ${f.projectVersion}, standard ${f.standardVersion} : évolution mineure disponible.`,
      recommendation: (ctx, f) => ({
        action: `Porter le ${label.toLowerCase()} en ${f.standardVersion}`,
        benefit: 'Bénéficier des correctifs et des nouvelles capacités du standard',
        risk: 'Faible : évolution mineure, rétrocompatible',
        prerequisites: ['Copier le cœur du moteur de référence', 'Exécuter le plan de migration'],
        futureAction: 'PLAN_ENGINE_UPGRADE',
      }),
    },
    {
      id: `${id}_UNKNOWN`,
      category: CATEGORY.OBSERVABILITY,
      component,
      severity: SEVERITY.LOW,
      title: `${label} : version non publiée`,
      description: `Le projet ne publie pas la version de son ${label.toLowerCase()}.`,
      impact: 'Impossible de détecter une dérive de ce moteur.',
      origin: 'PANEL_OBSERVATION',
      readiness: { criterion: 'engines', blocks: false },
      when: (ctx) => {
        const field = key === 'deployment' ? 'deploymentEngine' : 'duplicationEngine';
        if (!isPaired(ctx) || ctx.project?.versions?.[field]) return false;
        return { facts: { contractVersion: ctx.project?.versions?.contract ?? null } };
      },
      explain: (ctx, f) => f.contractVersion
        ? `Aucune version publiée. Le projet parle le contrat ${f.contractVersion} ; la publication des versions de moteurs a été ajoutée en 1.2.0.`
        : 'Aucune version publiée, et la version de contrat du projet est elle-même inconnue.',
      recommendation: () => ({
        action: 'Mettre le projet en contrat 1.2.0 pour qu’il publie ses versions de moteurs',
        benefit: 'Rendre la dérive de moteur détectable',
        risk: 'Faible : évolution additive',
        prerequisites: ['Recopier les specs ratifiées'],
        futureAction: 'PLAN_CONTRACT_UPGRADE',
      }),
    },
  ];
}

const ENGINE_RULES = [
  ...engineRules({ id: 'DEPLOYMENT_ENGINE', component: 'deploymentEngine', key: 'deployment', label: 'Moteur de déploiement' }),
  ...engineRules({ id: 'DUPLICATION_ENGINE', component: 'duplicationEngine', key: 'duplication', label: 'Moteur de duplication' }),
];

/* -------------------------------------------------------------------------- */
/*  SÉCURITÉ                                                                  */
/* -------------------------------------------------------------------------- */

const SECURITY_RULES = [
  {
    id: 'CERTIFICATE_EXPIRED',
    category: CATEGORY.SECURITY,
    component: 'ssl',
    severity: SEVERITY.CRITICAL,
    title: 'Certificat expiré',
    description: 'La date d’expiration publiée par le projet est dépassée.',
    impact: 'Le site est inaccessible en HTTPS : les navigateurs bloquent l’accès.',
    origin: 'PROJECT_DECLARATION',
    readiness: { criterion: 'ssl', blocks: true },
    when: (ctx) => {
      const expiry = ctx.record?.runtime?.certificate?.expiresAt;
      if (!expiry) return false;
      const days = daysUntil(expiry, ctx.now);
      return days < 0 && { facts: { expiresAt: expiry, daysOverdue: Math.abs(days) } };
    },
    explain: (ctx, f) => `Le projet a publié une expiration au ${f.expiresAt}, dépassée depuis ${f.daysOverdue} jour(s).`,
    recommendation: () => ({
      action: 'Renouveler le certificat du domaine',
      benefit: 'Rétablir l’accès HTTPS',
      risk: 'Aucun si le renouvellement est automatisé (certbot)',
      prerequisites: ['Accès au serveur', 'DNS pointant correctement'],
      futureAction: 'RENEW_CERTIFICATE',
    }),
  },
  {
    id: 'CERTIFICATE_EXPIRING',
    category: CATEGORY.SECURITY,
    component: 'ssl',
    severity: SEVERITY.HIGH,
    title: 'Certificat expirant',
    description: 'Le certificat arrive à échéance dans la fenêtre d’alerte.',
    impact: 'Sans renouvellement, le site deviendra inaccessible en HTTPS.',
    origin: 'PROJECT_DECLARATION',
    readiness: { criterion: 'ssl', blocks: false },
    when: (ctx) => {
      const expiry = ctx.record?.runtime?.certificate?.expiresAt;
      if (!expiry) return false;
      const days = daysUntil(expiry, ctx.now);
      const threshold = ctx.panel?.certificateWarningDays ?? 21;
      if (days < 0 || days > threshold) return false;
      // Plus l'échéance approche, plus c'est grave.
      return { severity: days <= 7 ? SEVERITY.CRITICAL : SEVERITY.HIGH, facts: { expiresAt: expiry, daysLeft: days, threshold } };
    },
    explain: (ctx, f) => `Expiration publiée au ${f.expiresAt}, dans ${f.daysLeft} jour(s) — sous le seuil d’alerte de ${f.threshold} jours.`,
    recommendation: () => ({
      action: 'Renouveler le certificat avant échéance',
      benefit: 'Éviter une coupure HTTPS',
      risk: 'Aucun',
      prerequisites: ['Accès au serveur'],
      futureAction: 'RENEW_CERTIFICATE',
    }),
  },
  {
    id: 'SSL_STATE_UNKNOWN',
    category: CATEGORY.OBSERVABILITY,
    component: 'ssl',
    severity: SEVERITY.LOW,
    title: 'État SSL non publié',
    description: 'Le projet ne publie ni état SSL ni date d’expiration.',
    impact: 'Une expiration de certificat ne serait détectée qu’au moment de la panne.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'ssl', blocks: false },
    when: (ctx) => {
      if (!isPaired(ctx)) return false;
      const declared = ctx.record?.runtime?.components?.ssl;
      const expiry = ctx.record?.runtime?.certificate?.expiresAt;
      return !declared && !expiry && { facts: {} };
    },
    explain: () => 'Ni `runtime.components.ssl`, ni date d’expiration de certificat n’ont été publiés par le projet.',
    recommendation: () => ({
      action: 'Instrumenter le projet pour qu’il publie son état SSL dans ses heartbeats',
      benefit: 'Anticiper les expirations de certificat au lieu de les subir',
      risk: 'Aucun',
      prerequisites: ['Contrat 1.2.0 côté projet'],
      futureAction: 'PLAN_INSTRUMENTATION',
    }),
  },
  {
    id: 'COMPONENT_ERROR',
    category: CATEGORY.CONFIGURATION,
    component: 'declared',
    severity: SEVERITY.HIGH,
    title: 'Composant en erreur',
    description: 'Le projet déclare lui-même qu’un de ses composants est en erreur.',
    impact: 'Une fonction du projet est indisponible ou dégradée.',
    origin: 'PROJECT_DECLARATION',
    readiness: { criterion: 'components', blocks: true },
    when: (ctx) => {
      const declared = ctx.record?.runtime?.components ?? {};
      const failing = Object.entries(declared).filter(([, status]) => status === 'ERROR').map(([id]) => id);
      return failing.length > 0 && { facts: { failing } };
    },
    explain: (ctx, f) => `Le projet publie l’état ERROR pour : ${f.failing.join(', ')}.`,
    recommendation: (ctx, f) => ({
      action: `Diagnostiquer les composants en erreur côté projet (${f.failing.join(', ')})`,
      benefit: 'Rétablir les fonctions concernées',
      risk: 'Aucun côté Panel : le diagnostic se fait sur le projet',
      prerequisites: ['Accès aux journaux du projet'],
      futureAction: 'DIAGNOSE_REMOTE',
    }),
  },
  {
    id: 'BACKEND_DEGRADED',
    category: CATEGORY.CONFIGURATION,
    component: 'backend',
    severity: SEVERITY.MEDIUM,
    title: 'Backend dégradé',
    description: 'Le projet se déclare lui-même en état dégradé.',
    impact: 'Le service fonctionne partiellement ; certaines fonctions peuvent échouer.',
    origin: 'PROJECT_DECLARATION',
    readiness: { criterion: 'backend', blocks: false },
    when: (ctx) => ctx.record?.runtime?.lastHealth?.status === 'DEGRADED' && {
      facts: { details: ctx.record.runtime.lastHealth.details ?? null },
    },
    explain: (ctx, f) => f.details
      ? `Le projet déclare l’état DEGRADED avec le détail : « ${f.details} ».`
      : 'Le projet déclare l’état DEGRADED, sans détail complémentaire.',
    recommendation: () => ({
      action: 'Consulter les journaux du projet pour identifier la dégradation',
      benefit: 'Revenir à un service nominal',
      risk: 'Aucun côté Panel',
      prerequisites: ['Accès aux journaux du projet'],
      futureAction: 'DIAGNOSE_REMOTE',
    }),
  },
];

/* -------------------------------------------------------------------------- */
/*  CONFIGURATION & OBSERVABILITÉ                                             */
/* -------------------------------------------------------------------------- */

const CONFIGURATION_RULES = [
  {
    id: 'MANIFEST_MISSING',
    category: CATEGORY.CONFIGURATION,
    component: 'manifest',
    severity: SEVERITY.MEDIUM,
    title: 'Manifest absent',
    description: 'Aucun Manifest n’a été publié ni saisi pour ce projet.',
    impact: 'Le Panel ne connaît ni les modules, ni les capacités, ni la topologie du projet.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'manifest', blocks: true },
    when: (ctx) => !ctx.record?.manifest && { facts: { pairing: ctx.record?.pairing?.status ?? null } },
    explain: (ctx, f) => `Aucun Manifest en base (statut d’appairage : ${f.pairing}). Ni le pont ni la saisie manuelle n’en ont fourni.`,
    recommendation: () => ({
      action: 'Faire publier son Manifest au projet (contrat ≥ 1.1.0)',
      benefit: 'Rendre les modules, capacités et topologie du projet visibles',
      risk: 'Aucun',
      prerequisites: ['Contrat ≥ 1.1.0 côté projet'],
      futureAction: 'FETCH_MANIFEST',
    }),
  },
  {
    id: 'MANIFEST_MANUAL',
    category: CATEGORY.CONFIGURATION,
    component: 'manifest',
    severity: SEVERITY.LOW,
    title: 'Manifest saisi manuellement',
    description: 'Le Manifest provient d’une saisie, non du pont.',
    impact: 'Le Manifest peut diverger de la réalité du projet sans que personne ne le sache.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'manifest', blocks: false },
    when: (ctx) => ctx.record?.manifestSource === 'MANUAL' && { facts: {} },
    explain: () => 'La source du Manifest est « MANUAL » : il a été saisi côté Panel, et non transmis par le projet.',
    recommendation: () => ({
      action: 'Mettre le projet en contrat ≥ 1.1.0 pour qu’il transmette son Manifest',
      benefit: 'Le Manifest devient auto-descriptif et ne peut plus diverger',
      risk: 'Aucun',
      prerequisites: ['Contrat ≥ 1.1.0 côté projet'],
      futureAction: 'PLAN_CONTRACT_UPGRADE',
    }),
  },
  {
    id: 'DOMAIN_UNKNOWN',
    category: CATEGORY.OBSERVABILITY,
    component: 'dns',
    severity: SEVERITY.LOW,
    title: 'Domaine principal inconnu',
    description: 'Le projet ne publie pas son domaine public.',
    impact: 'Impossible de relier ce projet à une adresse depuis le Panel.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'network', blocks: false },
    when: (ctx) => isPaired(ctx) && !ctx.project?.primaryDomain && { facts: {} },
    explain: () => 'Ni `manifest.network.primaryDomain`, ni URL publique de backend n’ont été publiés.',
    recommendation: () => ({
      action: 'Renseigner l’identité réseau du projet dans son Manifest',
      benefit: 'Relier le projet à son adresse publique depuis le Panel',
      risk: 'Aucun',
      prerequisites: ['Contrat 1.2.0 côté projet'],
      futureAction: 'PLAN_INSTRUMENTATION',
    }),
  },
  {
    id: 'DESCRIPTOR_INCOMPLETE',
    category: CATEGORY.OBSERVABILITY,
    component: 'manifest',
    severity: SEVERITY.INFO,
    title: 'Descripteur incomplet',
    description: 'Le projet ne déclare pas son type ou sa topologie.',
    impact: 'Le parc est plus difficile à filtrer et à comprendre d’un coup d’œil.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'manifest', blocks: false },
    when: (ctx) => {
      if (!ctx.record?.manifest) return false; // couvert par MANIFEST_MISSING
      const missing = [];
      if (!ctx.project?.type) missing.push('type');
      if (!ctx.project?.layout) missing.push('layout');
      return missing.length > 0 && { facts: { missing } };
    },
    explain: (ctx, f) => `Le Manifest ne déclare pas : ${f.missing.join(', ')}.`,
    recommendation: () => ({
      action: 'Compléter le descripteur dans le registre déclaratif du projet',
      benefit: 'Rendre le parc lisible et filtrable par type',
      risk: 'Aucun',
      prerequisites: ['Contrat 1.2.0 côté projet'],
      futureAction: 'PLAN_INSTRUMENTATION',
    }),
  },
  {
    id: 'COMPONENTS_NOT_PUBLISHED',
    category: CATEGORY.OBSERVABILITY,
    component: 'observability',
    severity: SEVERITY.LOW,
    title: 'Composants non instrumentés',
    description: 'Le projet ne publie l’état d’aucun de ses composants internes.',
    impact: 'La santé affichée repose uniquement sur le silence et les versions : une panne interne resterait invisible.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'components', blocks: false },
    when: (ctx) => {
      if (!isPaired(ctx)) return false;
      const declared = ctx.record?.runtime?.components;
      return (!declared || Object.keys(declared).length === 0) && {
        facts: { contractVersion: ctx.project?.versions?.contract ?? null },
      };
    },
    explain: (ctx, f) => `Aucun composant publié dans les heartbeats${f.contractVersion ? ` (contrat ${f.contractVersion})` : ''}. La publication de composants a été ajoutée en contrat 1.2.0.`,
    recommendation: () => ({
      action: 'Instrumenter le projet pour publier l’état de ses composants (frontend, base, SSL, DNS)',
      benefit: 'Détecter une panne interne avant qu’elle ne devienne un silence',
      risk: 'Aucun',
      prerequisites: ['Contrat 1.2.0 côté projet'],
      futureAction: 'PLAN_INSTRUMENTATION',
    }),
  },
  {
    id: 'RUNTIME_NOT_PUBLISHED',
    category: CATEGORY.OBSERVABILITY,
    component: 'observability',
    severity: SEVERITY.INFO,
    title: 'Métriques d’exécution non publiées',
    description: 'Le projet ne publie ni uptime ni charge.',
    impact: 'Impossible de repérer un projet qui redémarre en boucle ou dont la mémoire dérive.',
    origin: 'PANEL_OBSERVATION',
    readiness: { criterion: 'components', blocks: false },
    when: (ctx) => isPaired(ctx)
      && ctx.record?.runtime?.uptimeSeconds === null
      && !ctx.record?.runtime?.load
      && { facts: {} },
    explain: () => 'Ni `runtime.uptimeSeconds` ni `runtime.load` n’ont été reçus dans les heartbeats.',
    recommendation: () => ({
      action: 'Publier l’instantané d’exécution dans les heartbeats du projet',
      benefit: 'Repérer les redémarrages en boucle et les dérives mémoire',
      risk: 'Aucun',
      prerequisites: ['Contrat 1.2.0 côté projet'],
      futureAction: 'PLAN_INSTRUMENTATION',
    }),
  },
];

/* -------------------------------------------------------------------------- */
/*  LE CATALOGUE                                                              */
/* -------------------------------------------------------------------------- */

export const RULES = Object.freeze([
  ...CONNECTIVITY_RULES,
  ...COMPATIBILITY_RULES,
  ...ENGINE_RULES,
  ...SECURITY_RULES,
  ...CONFIGURATION_RULES,
]);

/**
 * Actions futures référencées par les recommandations.
 *
 * IMPORTANT : ce sont des ÉTIQUETTES, pas des points d'exécution. La Phase
 * 3B n'exécute rien. Elles existent pour que la Phase 3C (pilotage) sache à
 * quoi rattacher chaque recommandation, sans avoir à réinterpréter du texte.
 */
export const FUTURE_ACTIONS = Object.freeze([
  'DIAGNOSE_REMOTE',
  'ISSUE_PAIRING_CODE',
  'FETCH_MANIFEST',
  'PLAN_CONTRACT_UPGRADE',
  'PLAN_CONTRACT_MIGRATION',
  'PLAN_PANEL_UPGRADE',
  'PLAN_ENGINE_UPGRADE',
  'PLAN_ENGINE_MIGRATION',
  'PLAN_INSTRUMENTATION',
  'RENEW_CERTIFICATE',
]);

export default RULES;
