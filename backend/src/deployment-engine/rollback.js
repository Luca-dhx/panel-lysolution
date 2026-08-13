/**
 * ROLLBACK — revenir à la version précédente, celle que le pipeline a mise de
 * côté en déployant.
 *
 * ══ CE QUI A CHANGÉ, ET POURQUOI IL LE FALLAIT (R10.2) ══════════════════════
 *
 * Ce module repointait un lien `current` vers un dossier `releases/<id>`.
 * Aucun des deux n'a jamais existé : le pipeline uploade dans un `backend/`
 * STABLE et publie les SPA par bascule `.next` → `.prev`. `listReleases()`
 * ne trouvait donc rien, et le rollback n'avait aucune cible — un filet de
 * sécurité qui n'aurait pas retenu.
 *
 * Il s'aligne désormais sur le mécanisme réel : chaque emplacement déployé
 * garde UNE génération précédente sous `<dossier>.prev`, et revenir en arrière
 * consiste à les échanger.
 *
 * ══ L'ÉCHANGE EST SON PROPRE INVERSE ═══════════════════════════════════════
 *
 *     rm -rf <tmp> && mv <cible> <tmp> && mv <prev> <cible> && mv <tmp> <prev>
 *
 * Après un retour arrière, la version qu'on vient de quitter devient le
 * `.prev`. Deux propriétés en découlent, et elles sont précieuses :
 *
 *   · un rollback raté se DÉFAIT par la même opération — la restauration n'est
 *     pas un second chemin de code qu'il faudrait maintenir en parallèle ;
 *   · rejouer un rollback ramène à la version de départ, ce qui est le
 *     comportement qu'un opérateur attend d'un interrupteur.
 *
 * ══ CE QU'UN ROLLBACK NE TOUCHE JAMAIS ═════════════════════════════════════
 *
 * Les données. `uploads/` et `storage/` sont des liens vers le partagé
 * persistant : ils suivent le dossier échangé et pointent toujours au même
 * endroit. Un retour arrière ne rend donc AUCUN média ni justificatif
 * invisible. Les migrations Mongo, elles, restent la responsabilité de leur
 * lot — revenir au code d'hier ne défait pas un schéma d'aujourd'hui.
 */
import { DeploymentError } from './errors.js';
import { restartBackend } from './pm2.js';
import { checkLocalHealth } from './health.js';
import { planTopology } from './topology.js';
import { DEFAULT_REMOTE_ROOT } from './config/project.profile.js';

/** Suffixe du dossier de secours, posé par le pipeline à chaque déploiement. */
export const PREV_SUFFIX = '.prev';
/** Nom de passage de l'échange. Jamais laissé derrière : voir `swapSlot`. */
const SWAP_SUFFIX = '.swap';

/**
 * LES EMPLACEMENTS QUI BASCULENT — dérivés de la topologie, jamais nommés ici.
 *
 * Le backend et chaque application publiable. Un projet qui gagnerait une SPA
 * la verrait apparaître sans qu'on touche à ce fichier : c'est le profil qui
 * décide de la composition, pas le rollback.
 */
export function rollbackSlots({ host, remoteRoot = DEFAULT_REMOTE_ROOT, profile } = {}) {
  const topo = planTopology({ host, remoteRoot, profile });
  const slots = topo.publishable.map((app) => ({
    id: app.id,
    role: app.role,
    target: app.remoteRoot,
    prev: `${app.remoteRoot}${PREV_SUFFIX}`,
    /** Ce qu'on exige d'une SPA pour la croire servable. */
    integrity: [{ id: 'index', test: 'f', path: 'index.html', message: 'index.html absent' }],
    versionFile: 'version.json',
  }));
  if (topo.backendDir) {
    slots.push({
      id: 'backend',
      role: 'server',
      target: topo.backendDir,
      prev: `${topo.backendDir}${PREV_SUFFIX}`,
      /**
       * Un backend sans `node_modules` ne démarre pas : basculer dessus
       * casserait le site pour rien. `npm ci` n'est PAS rejoué au rollback —
       * le `.prev` conserve l'installation de son propre déploiement.
       */
      integrity: [
        { id: 'package-json', test: 'f', path: 'package.json', message: 'package.json absent' },
        { id: 'server-entry', test: 'f', path: 'src/server.js', message: 'point d’entrée absent' },
        { id: 'dependencies', test: 'd', path: 'node_modules', message: 'dépendances non installées' },
      ],
      versionFile: 'build-manifest.json',
    });
  }
  return { topo, slots };
}

/** Le dossier existe-t-il, et est-ce bien un dossier ? */
async function isDir(transport, path) {
  const res = await transport.exec(`test -d ${path} && echo OK || echo KO`);
  return /OK/.test(String(res.stdout || ''));
}

/**
 * La version déployée dans un dossier — telle que le BUILD l'y a écrite.
 *
 * `null` quand le fichier est absent : une version antérieure au manifeste
 * n'en porte pas, et c'est une réponse, pas une erreur. On ne devine jamais.
 */
export async function readSlotVersion(transport, dir, versionFile) {
  const res = await transport.exec(`cat ${dir}/${versionFile} 2>/dev/null || true`);
  const raw = String(res.stdout || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      commitHash: parsed.commitHash ?? null,
      shortCommit: parsed.shortCommit ?? null,
      branch: parsed.branch ?? null,
      builtAt: parsed.builtAt ?? null,
    };
  } catch {
    return null;
  }
}

/** Étiquette lisible d'une version — jamais une invention quand on ne sait pas. */
export function versionLabel(version) {
  if (!version) return null;
  return version.shortCommit || version.commitHash?.slice(0, 7) || version.builtAt || null;
}

/**
 * L'ÉTAT DU RETOUR ARRIÈRE — ce qui est déployé, et ce vers quoi on peut revenir.
 *
 * Ne modifie rien. C'est la lecture qu'on fait AVANT de décider.
 */
export async function describeRollbackState(transport, { host, remoteRoot, profile } = {}) {
  const { slots } = rollbackSlots({ host, remoteRoot, profile });

  const detail = [];
  for (const slot of slots) {
    // eslint-disable-next-line no-await-in-loop
    const hasPrev = await isDir(transport, slot.prev);
    // eslint-disable-next-line no-await-in-loop
    const current = await readSlotVersion(transport, slot.target, slot.versionFile);
    // eslint-disable-next-line no-await-in-loop
    const previous = hasPrev ? await readSlotVersion(transport, slot.prev, slot.versionFile) : null;
    detail.push({ id: slot.id, role: slot.role, target: slot.target, prev: slot.prev, hasPrev, current, previous });
  }

  const backend = detail.find((s) => s.id === 'backend') ?? detail[0] ?? null;
  /**
   * LE BACKEND FAIT FOI POUR NOMMER LA VERSION. C'est lui qui porte le
   * manifeste complet ; les SPA n'en ont qu'un extrait.
   */
  const current = versionLabel(backend?.current);
  const previous = versionLabel(backend?.previous);

  /**
   * ON NE PEUT REVENIR QUE SI **TOUS** LES EMPLACEMENTS ONT LEUR `.prev`.
   *
   * Un retour partiel — backend d'hier, SPA d'aujourd'hui — servirait une
   * interface à une API qui ne la comprend pas. Mieux vaut refuser franchement.
   */
  const missing = detail.filter((s) => !s.hasPrev).map((s) => s.id);
  return {
    host,
    current,
    previous,
    canRollback: detail.length > 0 && missing.length === 0,
    missingPrevious: missing,
    slots: detail,
  };
}

/**
 * INTÉGRITÉ d'un `.prev` : on ne bascule jamais vers un dossier incomplet.
 *
 * Tous les contrôles sont nécessaires, aucun n'est suffisant seul.
 */
export async function verifyPreviousIntegrity(transport, { host, remoteRoot, profile } = {}) {
  const { slots } = rollbackSlots({ host, remoteRoot, profile });
  const failed = [];
  for (const slot of slots) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await isDir(transport, slot.prev))) {
      failed.push({ id: slot.id, check: 'prev-dir', message: 'aucune version précédente' });
      continue;
    }
    for (const rule of slot.integrity) {
      // eslint-disable-next-line no-await-in-loop
      const res = await transport.exec(`test -${rule.test} ${slot.prev}/${rule.path} && echo OK || echo KO`);
      if (!/OK/.test(String(res.stdout || ''))) {
        failed.push({ id: slot.id, check: rule.id, message: rule.message });
      }
    }
  }
  return { ok: failed.length === 0, failed };
}

/**
 * ÉCHANGE un emplacement avec son `.prev`. Son propre inverse.
 *
 * Le dossier de passage est retiré AVANT, jamais laissé derrière : un `.swap`
 * abandonné par une coupure ferait échouer l'échange suivant sur un `mv` qui
 * refuserait d'écraser.
 */
async function swapSlot(transport, slot) {
  const tmp = `${slot.target}${SWAP_SUFFIX}`;
  const res = await transport.exec(
    `rm -rf ${tmp} && mv ${slot.target} ${tmp} && mv ${slot.prev} ${slot.target} && mv ${tmp} ${slot.prev}`,
  );
  if (res.code !== 0) {
    throw new DeploymentError('ROLLBACK_SWAP_FAILED',
      `Échange impossible pour « ${slot.id} ».`, {
        step: 'rollback',
        details: { slot: slot.id, output: (res.stderr || res.stdout || '').slice(0, 400) },
      });
  }
}

/**
 * ROLLBACK complet vers la version précédente.
 *
 * Séquence, strictement ordonnée :
 *   1. lire l'état (déployé / précédent) ;
 *   2. VÉRIFIER l'intégrité de TOUS les `.prev` avant de toucher quoi que ce soit ;
 *   3. échanger chaque emplacement ;
 *   4. relancer le service ;
 *   5. contrôler la santé.
 *
 * Si 3, 4 ou 5 échoue, on RÉTABLIT en rejouant l'échange sur ce qui a déjà
 * basculé — un rollback raté ne doit pas laisser le site dans un état pire que
 * celui d'où l'on vient.
 *
 * @returns {Promise<{ok, from, to, healthy, steps, restored?}>}
 */
export async function rollbackToPrevious({
  transport,
  host,
  backendPort,
  remoteRoot = DEFAULT_REMOTE_ROOT,
  profile,
  env = 'PROD',
  // Réglables pour que les recettes n'attendent pas 16 s par scénario d'échec.
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

  const { topo, slots } = rollbackSlots({ host, remoteRoot, profile });
  const state = await describeRollbackState(transport, { host, remoteRoot, profile });
  record('rollback.inspect', 'done', {
    current: state.current, previous: state.previous, slots: slots.length,
  });

  if (!state.canRollback) {
    throw new DeploymentError('ROLLBACK_NO_PREVIOUS_VERSION',
      'Aucune version précédente à restaurer : ce serveur n’a reçu qu’un seul déploiement, '
      + `ou son dossier de secours a été retiré (${state.missingPrevious.join(', ') || 'aucun emplacement'}).`, {
        step: 'rollback', details: { host, missing: state.missingPrevious },
      });
  }
  record('rollback.resolve', 'done', { from: state.current, to: state.previous });

  const integrity = await verifyPreviousIntegrity(transport, { host, remoteRoot, profile });
  if (!integrity.ok) {
    record('rollback.verify', 'failed', { failed: integrity.failed });
    throw new DeploymentError('ROLLBACK_PREVIOUS_CORRUPT',
      `La version précédente est incomplète : ${integrity.failed.map((f) => `${f.id} — ${f.message}`).join(', ')}.`, {
        step: 'rollback', details: integrity,
      });
  }
  record('rollback.verify', 'ok');

  /** Ce qui a réellement basculé — la liste que la restauration rejouera. */
  const swapped = [];
  const undo = async () => {
    for (const slot of [...swapped].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await swapSlot(transport, slot).catch(() => null);
    }
  };

  try {
    for (const slot of slots) {
      // eslint-disable-next-line no-await-in-loop
      await swapSlot(transport, slot);
      swapped.push(slot);
    }
    record('rollback.activate', 'done', { slots: swapped.map((s) => s.id) });

    await restartBackend(transport, {
      host, backendDir: topo.backendDir, port: backendPort, env,
    });
    const health = await checkLocalHealth(transport, backendPort, {
      retries: healthRetries, delayMs: healthDelayMs,
    });
    if (!health?.ok) {
      throw new DeploymentError('ROLLBACK_HEALTH_FAILED',
        'La version précédente ne répond pas au contrôle de santé.', {
          step: 'rollback', details: { health },
        });
    }
    record('rollback.health', 'ok', { to: state.previous });
    return { ok: true, from: state.current, to: state.previous, healthy: true, steps };
  } catch (err) {
    if (swapped.length === 0) throw err;

    record('rollback.restore', 'attempt', { back: state.current });
    await undo();
    /**
     * On relance sur la version rétablie. Sans cela, PM2 continuerait de faire
     * tourner le code qu'on vient de retirer du disque.
     */
    const restoredHealth = await restartBackend(transport, {
      host, backendDir: topo.backendDir, port: backendPort, env,
    })
      .then(() => checkLocalHealth(transport, backendPort, { retries: healthRetries, delayMs: healthDelayMs }))
      .catch(() => null);
    record('rollback.restore', 'done', {
      back: state.current, healthy: Boolean(restoredHealth?.ok),
    });

    throw new DeploymentError('ROLLBACK_FAILED_RESTORED',
      `Retour arrière impossible (${err.message}) — la version ${state.current ?? 'précédemment active'} a été rétablie.`, {
        step: 'rollback',
        details: { from: state.current, to: state.previous, cause: err.code ?? err.message, steps },
      });
  }
}

/* -------------------------------------------------------------------------- */
/*  ADAPTATEURS — le vocabulaire historique, sur le mécanisme réel            */
/* -------------------------------------------------------------------------- */

/**
 * « Quelles versions sont disponibles ? », dans le vocabulaire des appelants.
 *
 * ══ POURQUOI ON GARDE CE NOM ══════════════════════════════════════════════
 *
 * `listReleases` est consommé par la façade, par le service d'exécution, par
 * un contrôle de migration et par le CLI. Renommer partout aurait mêlé une
 * correction de comportement à un renommage de surface — deux revues en une.
 *
 * Ce qu'il rend a CHANGÉ, et c'est le point : il rendait une liste vide et un
 * `current` nul sur toute destination réelle. Il rend désormais les versions
 * réellement présentes, déployée d'abord.
 */
export async function listReleases(transport, { host, remoteRoot, profile } = {}) {
  const state = await describeRollbackState(transport, { host, remoteRoot, profile });
  return [state.current, state.previous].filter(Boolean);
}

/** La version actuellement servie. `null` si le serveur n'a rien reçu. */
export async function currentRelease(transport, { host, remoteRoot, profile } = {}) {
  const state = await describeRollbackState(transport, { host, remoteRoot, profile });
  return state.current;
}

/**
 * Intégrité de la version de secours.
 *
 * `releaseId` est ACCEPTÉ et ignoré : il n'existe qu'une seule version
 * précédente par emplacement, et c'est elle qu'on vérifie. L'accepter évite de
 * casser les appelants ; le documenter évite de laisser croire qu'on peut
 * viser une release arbitraire.
 */
export async function verifyReleaseIntegrity(transport, { host, remoteRoot, profile } = {}) {
  const result = await verifyPreviousIntegrity(transport, { host, remoteRoot, profile });
  return { ...result, releaseId: null };
}

/**
 * @deprecated Nom historique. `releaseId` est ignoré : le pipeline ne conserve
 * qu'UNE génération précédente par emplacement, et c'est vers elle qu'on
 * revient. Viser une release arbitraire n'a jamais fonctionné.
 */
export async function rollbackToRelease(args) {
  return rollbackToPrevious(args);
}

export default {
  rollbackToPrevious,
  describeRollbackState,
  verifyPreviousIntegrity,
  rollbackSlots,
  readSlotVersion,
  versionLabel,
  // Adaptateurs historiques.
  rollbackToRelease,
  listReleases,
  currentRelease,
  verifyReleaseIntegrity,
};
