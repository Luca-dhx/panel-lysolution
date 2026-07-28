/**
 * MIGRATIONS DU MOTEUR — passage d'une version de moteur à la suivante dans
 * un projet qui l'embarque.
 *
 * Le problème résolu : un projet livré en 2026 embarque le moteur 1.0.0.
 * Le standard passe en 1.1.0. Recopier le nouveau cœur ne suffit pas si le
 * PROFIL du projet doit gagner un champ (ex. `nginxRole`). Il faut savoir
 * quoi ajouter, et l'ajouter sans rien écraser.
 *
 * Trois règles absolues :
 *
 *  1. **Ne jamais réécrire aveuglément un profil.** Une migration décrit un
 *     changement PRÉCIS et VÉRIFIABLE. Si le projet a déjà la valeur voulue,
 *     la migration est « déjà appliquée » et ne touche à rien.
 *  2. **Ne jamais écraser une personnalisation.** Une migration ajoute ce qui
 *     manque ; elle ne remplace une valeur existante que si celle-ci est
 *     formellement invalide, et le signale.
 *  3. **Toujours produire un rapport.** Ce qui a été fait, ce qui ne l'a pas
 *     été, et pourquoi.
 *
 * Une migration est un objet :
 *   {
 *     from, to,                 versions concernées
 *     id, title, description,
 *     required,                 bloquante si non appliquée ?
 *     detect(ctx)  → { applied: bool, reason?: string }
 *     apply(ctx)   → { changed: bool, notes: string[] }   (peut être absente)
 *   }
 *
 * `ctx` fournit un accès au profil et au système de fichiers, injectés — ce
 * qui rend chaque migration testable sans toucher un vrai projet.
 */
import { compareVersions } from '../engineInfo.js';

/**
 * 1.0.0 → 1.1.0 — Nginx piloté par le profil.
 *
 * En 1.0.0, le générateur Nginx produisait des blocs codés en dur. En 1.1.0,
 * il itère sur `APPS` et lit `nginxRole`. Un profil de 1.0.0 ne déclare que
 * `role` : le moteur sait le déduire (compatibilité ascendante), mais un
 * profil explicite est préférable — la migration le SIGNALE sans rien casser.
 */
export const MIGRATION_NGINX_PROFILE_DRIVEN = Object.freeze({
  id: 'nginx-profile-driven',
  from: '1.0.0',
  to: '1.1.0',
  title: 'Nginx piloté par le profil',
  description:
    'Chaque application du profil devrait déclarer son `nginxRole` '
    + '(web · web-subdomain · api · static · proxy · server). En son absence, '
    + 'le moteur le déduit de `role` — le déploiement fonctionne, mais le '
    + 'profil reste implicite.',
  required: false,
  detect({ profile }) {
    const apps = profile?.APPS ?? [];
    if (apps.length === 0) return { applied: false, reason: 'profil sans APPS' };
    const missing = apps.filter((app) => !app.nginxRole).map((app) => app.id);
    return missing.length === 0
      ? { applied: true }
      : { applied: false, reason: `nginxRole absent pour : ${missing.join(', ')}` };
  },
  // Pas d'`apply` automatique : ajouter un champ dans un fichier de profil
  // écrit à la main relève d'une décision humaine. La migration explique quoi
  // faire — elle ne réécrit pas le profil.
  manualSteps: [
    'Ouvrir config/project.profile.js',
    'Ajouter `nginxRole` à chaque entrée de APPS :',
    '  application front sur le domaine principal → nginxRole: \'web\'',
    '  application front sur un sous-domaine      → nginxRole: \'web-subdomain\'',
    '  backend Node                               → nginxRole: \'server\'',
  ],
});

/**
 * 1.0.0 → 1.1.0 — Manifeste de moteur étendu.
 *
 * La 1.1.0 exige des champs supplémentaires (engineApiVersion, layoutVersion,
 * minimumCompatibleVersion, supportedProfiles, breakingChanges…).
 */
export const MIGRATION_EXTENDED_MANIFEST = Object.freeze({
  id: 'extended-engine-manifest',
  from: '1.0.0',
  to: '1.1.0',
  title: 'Manifeste de moteur étendu',
  description:
    'Le manifeste doit déclarer engineApiVersion, minimumCompatibleVersion, '
    + 'layoutVersion, releaseDate, supportedProfiles et breakingChanges, afin '
    + 'que le moteur puisse répondre « qui suis-je » et « avec quoi suis-je '
    + 'compatible ».',
  required: true,
  detect({ manifest }) {
    const needed = ['engineApiVersion', 'minimumCompatibleVersion', 'layoutVersion',
      'releaseDate', 'supportedProfiles', 'breakingChanges'];
    const missing = needed.filter((field) => manifest?.[field] === undefined);
    return missing.length === 0
      ? { applied: true }
      : { applied: false, reason: `champs manquants : ${missing.join(', ')}` };
  },
  apply({ manifest }) {
    // Ajout des champs manquants avec des valeurs sûres — aucune valeur
    // existante n'est remplacée.
    const notes = [];
    const next = { ...manifest };
    const defaults = {
      engineApiVersion: '1',
      minimumCompatibleVersion: manifest?.version ?? '1.0.0',
      layoutVersion: '1',
      releaseDate: manifest?.lastStandardization ?? null,
      supportedProfiles: manifest?.compatibleProjects ?? [],
      breakingChanges: [],
    };
    let changed = false;
    for (const [key, value] of Object.entries(defaults)) {
      if (next[key] === undefined) {
        next[key] = value;
        notes.push(`ajout de ${key}`);
        changed = true;
      }
    }
    return { changed, notes, manifest: next };
  },
});

/**
 * 1.0.0 → 1.1.0 — Rollback dans le moteur.
 *
 * En 1.0.0, les assistants portaient leur propre logique de rollback. En
 * 1.1.0, elle appartient au moteur : un assistant qui la duplique encore est
 * un défaut.
 */
export const MIGRATION_ENGINE_ROLLBACK = Object.freeze({
  id: 'engine-owned-rollback',
  from: '1.0.0',
  to: '1.1.0',
  title: 'Rollback porté par le moteur',
  description:
    'La façade expose rollback(), listReleases() et verifyRelease(). Aucun '
    + 'assistant ne doit reconstruire de commandes de rollback.',
  required: true,
  detect({ engineFiles }) {
    return (engineFiles ?? []).includes('rollback.js')
      ? { applied: true }
      : { applied: false, reason: 'rollback.js absent du moteur' };
  },
  manualSteps: [
    'Copier deployment-engine/rollback.js depuis le moteur de référence',
    'Vérifier que la façade réexporte rollback / listReleases / verifyRelease',
    'Retirer toute logique de rollback des assistants (CLI, Manager)',
  ],
});

/** Catalogue ordonné des migrations connues. */
export const MIGRATIONS = Object.freeze([
  MIGRATION_EXTENDED_MANIFEST,
  MIGRATION_ENGINE_ROLLBACK,
  MIGRATION_NGINX_PROFILE_DRIVEN,
]);

/**
 * Migrations NÉCESSAIRES pour passer de `fromVersion` à `toVersion`.
 * Une migration est retenue si sa version cible est dans l'intervalle
 * ]fromVersion, toVersion].
 */
export function migrationsBetween(fromVersion, toVersion, catalogue = MIGRATIONS) {
  return catalogue.filter((migration) => {
    const afterFrom = compareVersions(migration.to, fromVersion) > 0;
    const upToTarget = compareVersions(migration.to, toVersion) <= 0;
    return afterFrom && upToTarget;
  });
}

/**
 * PLAN de migration — ce qui serait fait, sans rien faire.
 *
 * @param {object} args
 * @param {string} args.fromVersion  version du moteur embarqué par le projet
 * @param {string} args.toVersion    version visée
 * @param {object} args.context      { profile, manifest, engineFiles }
 * @returns {{fromVersion, toVersion, migrations: object[], pending: object[], blocked: boolean}}
 */
export function planMigration({ fromVersion, toVersion, context = {}, catalogue = MIGRATIONS }) {
  const candidates = migrationsBetween(fromVersion, toVersion, catalogue);
  const migrations = candidates.map((migration) => {
    let detection;
    try {
      detection = migration.detect(context);
    } catch (err) {
      detection = { applied: false, reason: `détection impossible : ${err.message}` };
    }
    return {
      id: migration.id,
      title: migration.title,
      from: migration.from,
      to: migration.to,
      required: migration.required === true,
      applied: detection.applied === true,
      reason: detection.reason ?? null,
      automatic: typeof migration.apply === 'function',
      manualSteps: migration.manualSteps ?? [],
    };
  });
  const pending = migrations.filter((m) => !m.applied);
  return {
    fromVersion,
    toVersion,
    migrations,
    pending,
    // Bloquant si une migration REQUISE reste non appliquée.
    blocked: pending.some((m) => m.required),
  };
}

/**
 * EXÉCUTION des migrations automatiques nécessaires.
 *
 * N'exécute que ce qui n'est pas déjà appliqué, et uniquement les migrations
 * disposant d'un `apply`. Les autres sont reportées telles quelles dans le
 * rapport, avec leurs étapes manuelles.
 *
 * @returns rapport complet — jamais une exception pour une migration manuelle.
 */
export function runMigrations({ fromVersion, toVersion, context = {}, catalogue = MIGRATIONS }) {
  const plan = planMigration({ fromVersion, toVersion, context, catalogue });
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const results = [];
  let workingContext = { ...context };

  for (const entry of plan.migrations) {
    if (entry.applied) {
      results.push({ ...entry, action: 'skipped', outcome: 'déjà appliquée' });
      continue;
    }
    const migration = byId.get(entry.id);
    if (typeof migration.apply !== 'function') {
      results.push({ ...entry, action: 'manual', outcome: 'intervention manuelle requise' });
      continue;
    }
    try {
      const applied = migration.apply(workingContext);
      if (applied.manifest) workingContext = { ...workingContext, manifest: applied.manifest };
      if (applied.profile) workingContext = { ...workingContext, profile: applied.profile };
      results.push({
        ...entry,
        action: applied.changed ? 'applied' : 'noop',
        outcome: applied.changed ? (applied.notes ?? []).join(', ') : 'rien à changer',
      });
    } catch (err) {
      results.push({ ...entry, action: 'failed', outcome: err.message });
    }
  }

  const failed = results.filter((r) => r.action === 'failed');
  const manual = results.filter((r) => r.action === 'manual');
  return {
    fromVersion,
    toVersion,
    ok: failed.length === 0,
    // Le projet est « à jour » quand plus rien de REQUIS n'attend.
    upToDate: results.every((r) => r.action === 'skipped' || r.action === 'applied' || r.action === 'noop' || !r.required),
    applied: results.filter((r) => r.action === 'applied'),
    skipped: results.filter((r) => r.action === 'skipped'),
    manual,
    failed,
    results,
    context: workingContext,
  };
}

/** Rapport lisible (texte) d'une exécution de migration. */
export function renderMigrationReport(report) {
  const lines = [
    `Migration du moteur ${report.fromVersion} → ${report.toVersion}`,
    ''.padEnd(50, '─'),
  ];
  for (const r of report.results) {
    const mark = { applied: '✓', skipped: '·', noop: '·', manual: '!', failed: '✗' }[r.action] ?? '?';
    lines.push(`${mark} [${r.action}] ${r.title}${r.required ? ' (requise)' : ''}`);
    if (r.reason) lines.push(`    constat : ${r.reason}`);
    if (r.outcome) lines.push(`    résultat : ${r.outcome}`);
    if (r.action === 'manual' && r.manualSteps.length) {
      for (const step of r.manualSteps) lines.push(`      → ${step}`);
    }
  }
  lines.push(''.padEnd(50, '─'));
  lines.push(
    report.failed.length > 0
      ? `${report.failed.length} migration(s) en échec.`
      : report.manual.length > 0
        ? `${report.manual.length} migration(s) à traiter manuellement.`
        : 'Moteur à jour.',
  );
  return lines.join('\n');
}

export default {
  MIGRATIONS,
  migrationsBetween,
  planMigration,
  runMigrations,
  renderMigrationReport,
};
