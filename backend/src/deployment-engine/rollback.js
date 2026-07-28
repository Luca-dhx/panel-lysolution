/**
 * ROLLBACK — retour à une release précédente.
 *
 * Toute la logique vit ici : aucun assistant (CLI, Manager, panel) ne doit
 * reconstruire des commandes de rollback. Ils appellent la façade, point.
 *
 * Séquence, strictement ordonnée :
 *   1. lister les releases disponibles ;
 *   2. résoudre la release cible (explicite, ou la précédente) ;
 *   3. VÉRIFIER SON INTÉGRITÉ avant de toucher quoi que ce soit ;
 *   4. mémoriser la release actuellement active (pour pouvoir revenir) ;
 *   5. repointer `current` de façon ATOMIQUE ;
 *   6. relancer le service ;
 *   7. contrôler la santé.
 *
 * Si l'une des étapes 5–7 échoue, on tente de RESTAURER la release qui était
 * active avant le rollback — un rollback raté ne doit pas laisser le site
 * dans un état pire que celui d'où l'on vient.
 */
import { DeploymentError } from './errors.js';
import { assertSafePath } from './safety.js';
import { restartBackend } from './pm2.js';
import { checkLocalHealth } from './health.js';
import { DEFAULT_REMOTE_ROOT } from './config/project.profile.js';

/** Chemins standard d'une cible. */
export function rollbackPaths(host, remoteRoot = DEFAULT_REMOTE_ROOT) {
  assertSafePath(remoteRoot);
  const siteRoot = `${remoteRoot}/${host}`;
  return {
    siteRoot,
    releasesDir: `${siteRoot}/releases`,
    currentLink: `${siteRoot}/current`,
  };
}

/**
 * Releases présentes sur le serveur, de la plus RÉCENTE à la plus ancienne.
 * L'identifiant de release est horodaté en tête, donc l'ordre lexicographique
 * inverse est l'ordre chronologique inverse.
 */
export async function listReleases(transport, { host, remoteRoot } = {}) {
  const { releasesDir } = rollbackPaths(host, remoteRoot);
  const res = await transport.exec(`ls -1 ${releasesDir} 2>/dev/null || true`);
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .reverse();
}

/** Identifiant de la release actuellement active (cible du lien `current`). */
export async function currentRelease(transport, { host, remoteRoot } = {}) {
  const { currentLink } = rollbackPaths(host, remoteRoot);
  const res = await transport.exec(`readlink -f ${currentLink} 2>/dev/null || true`);
  const resolved = String(res.stdout || '').trim();
  if (!resolved) return null;
  const parts = resolved.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

/**
 * INTÉGRITÉ d'une release : on ne bascule jamais vers un dossier incomplet.
 *
 * Contrôles (tous nécessaires, aucun suffisant seul) :
 *  - le dossier existe ;
 *  - le backend et son `package.json` sont présents ;
 *  - ses dépendances sont installées (`node_modules`) — sinon le service ne
 *    démarrerait pas et on aurait cassé le site pour rien.
 */
export async function verifyReleaseIntegrity(transport, { host, remoteRoot, releaseId, serverDir = 'backend' } = {}) {
  const { releasesDir } = rollbackPaths(host, remoteRoot);
  const releaseDir = `${releasesDir}/${releaseId}`;
  const checks = [
    { id: 'release-dir', cmd: `test -d ${releaseDir}`, message: 'dossier de release absent' },
    { id: 'server-dir', cmd: `test -d ${releaseDir}/${serverDir}`, message: `dossier ${serverDir}/ absent` },
    { id: 'package-json', cmd: `test -f ${releaseDir}/${serverDir}/package.json`, message: 'package.json absent' },
    { id: 'dependencies', cmd: `test -d ${releaseDir}/${serverDir}/node_modules`, message: 'dépendances non installées' },
  ];
  const failed = [];
  for (const check of checks) {
    const res = await transport.exec(`${check.cmd} && echo OK || echo KO`);
    if (!/OK/.test(String(res.stdout || ''))) failed.push({ id: check.id, message: check.message });
  }
  return { ok: failed.length === 0, releaseId, releaseDir, failed };
}

/** Bascule ATOMIQUE du lien `current` (ln -sfn : remplacement en une opération). */
async function switchCurrent(transport, { host, remoteRoot, releaseId }) {
  const { releasesDir, currentLink } = rollbackPaths(host, remoteRoot);
  const res = await transport.exec(`ln -sfn ${releasesDir}/${releaseId} ${currentLink}`);
  if (res.code !== 0) {
    throw new DeploymentError('ROLLBACK_SWITCH_FAILED', 'Impossible de repointer le lien « current ».', {
      step: 'rollback',
      details: { releaseId, output: (res.stderr || res.stdout || '').slice(0, 400) },
    });
  }
}

/**
 * ROLLBACK complet.
 *
 * @param {object} args
 * @param {import('./transport/Transport.js').Transport} args.transport
 * @param {string} args.host
 * @param {number} args.backendPort
 * @param {string} [args.releaseId]   release cible ; par défaut la précédente
 * @param {string} [args.remoteRoot]
 * @param {'TEST'|'PROD'} [args.env]
 * @param {(evt:object)=>void} [args.onStep]
 * @returns {Promise<{ok:boolean, from:string|null, to:string, healthy:boolean, steps:object[], restored?:boolean}>}
 */
export async function rollbackToRelease({
  transport,
  host,
  backendPort,
  releaseId,
  remoteRoot = DEFAULT_REMOTE_ROOT,
  env = 'PROD',
  serverDir = 'backend',
  // Paramètres du contrôle de santé : réglables pour que les tests n'attendent
  // pas 16 secondes par scénario d'échec.
  healthRetries = 8,
  healthDelayMs = 2000,
  onStep = () => {},
}) {
  const steps = [];
  const record = (step, status, extra = {}) => {
    const entry = { step, status, ...extra };
    steps.push(entry);
    onStep(entry);
    return entry;
  };

  const { currentLink } = rollbackPaths(host, remoteRoot);
  const releases = await listReleases(transport, { host, remoteRoot });
  const from = await currentRelease(transport, { host, remoteRoot });
  record('rollback.inspect', 'done', { releases: releases.length, current: from });

  if (releases.length === 0) {
    throw new DeploymentError('ROLLBACK_NO_RELEASE', 'Aucune release disponible sur le serveur.', {
      step: 'rollback', details: { host },
    });
  }

  // Cible : celle demandée, sinon la plus récente qui n'est pas l'active.
  const target = releaseId ?? releases.find((r) => r !== from);
  if (!target) {
    throw new DeploymentError('ROLLBACK_NO_PREVIOUS_RELEASE',
      'Aucune release précédente : la seule release présente est déjà active.', {
        step: 'rollback', details: { host, current: from, releases },
      });
  }
  if (!releases.includes(target)) {
    throw new DeploymentError('ROLLBACK_RELEASE_NOT_FOUND', `Release introuvable : ${target}.`, {
      step: 'rollback', details: { host, requested: target, available: releases },
    });
  }
  if (target === from) {
    throw new DeploymentError('ROLLBACK_ALREADY_ACTIVE', `La release ${target} est déjà active.`, {
      step: 'rollback', details: { host, current: from },
    });
  }
  record('rollback.resolve', 'done', { from, to: target });

  // Intégrité AVANT toute modification : c'est ce qui rend le rollback sûr.
  const integrity = await verifyReleaseIntegrity(transport, { host, remoteRoot, releaseId: target, serverDir });
  if (!integrity.ok) {
    record('rollback.verify', 'failed', { failed: integrity.failed });
    throw new DeploymentError('ROLLBACK_RELEASE_CORRUPT',
      `La release ${target} est incomplète : ${integrity.failed.map((f) => f.message).join(', ')}.`, {
        step: 'rollback', details: integrity,
      });
  }
  record('rollback.verify', 'ok');

  const activate = async (id) => {
    await switchCurrent(transport, { host, remoteRoot, releaseId: id });
    await restartBackend(transport, {
      host, backendDir: `${currentLink}/${serverDir}`, port: backendPort, env,
    });
    return checkLocalHealth(transport, backendPort, { retries: healthRetries, delayMs: healthDelayMs });
  };

  try {
    const health = await activate(target);
    record('rollback.activate', 'done', { to: target });
    if (!health?.ok) {
      throw new DeploymentError('ROLLBACK_HEALTH_FAILED',
        `La release ${target} ne répond pas au contrôle de santé.`, {
          step: 'rollback', details: { health },
        });
    }
    record('rollback.health', 'ok', { to: target });
    return { ok: true, from, to: target, healthy: true, steps };
  } catch (err) {
    // Rollback en échec : on tente de remettre la release d'où l'on venait.
    // Ce n'est possible que si elle existe encore et reste intègre — sinon on
    // remonte l'échec tel quel plutôt que d'aggraver la situation.
    if (!from || from === target) throw err;
    record('rollback.restore', 'attempt', { back: from });
    const backIntegrity = await verifyReleaseIntegrity(transport, {
      host, remoteRoot, releaseId: from, serverDir,
    }).catch(() => ({ ok: false }));
    if (!backIntegrity.ok) {
      record('rollback.restore', 'impossible', { back: from });
      throw err;
    }
    try {
      const health = await activate(from);
      record('rollback.restore', 'done', { back: from, healthy: Boolean(health?.ok) });
      throw new DeploymentError('ROLLBACK_FAILED_RESTORED',
        `Rollback vers ${target} impossible (${err.message}) — la release ${from} a été restaurée.`, {
          step: 'rollback', details: { from, to: target, cause: err.code ?? err.message, steps },
        });
    } catch (restoreErr) {
      if (restoreErr.code === 'ROLLBACK_FAILED_RESTORED') throw restoreErr;
      record('rollback.restore', 'failed', { back: from });
      throw err;
    }
  }
}

export default { rollbackToRelease, listReleases, currentRelease, verifyReleaseIntegrity, rollbackPaths };
