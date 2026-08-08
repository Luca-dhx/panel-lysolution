/**
 * PILOTAGE D'UNE INSTANCE SB AUTO DISTANTE — côté test.
 *
 * Le test ne touche jamais la base ni les modules du projet : il lui parle par
 * commandes, et lit ce que ses propres services répondent. C'est la seule
 * façon de garantir qu'aucune preuve n'a été écrite par la main qui la relève.
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'sbauto-instance.mjs');

/** Racine du backend SB Auto — dépôt voisin, jamais modifié par ces tests. */
export const SBAUTO_BACKEND = path.resolve(HERE, '../../../SB Auto 06/backend');

/**
 * Démarre une instance réelle et rend son pilote.
 *
 * @param {object} opts
 * @param {string} opts.mongoUri    le mongod éphémère, partagé — bases distinctes
 * @param {string} opts.dbName      LA base de CETTE instance, et d'aucune autre
 * @param {'TEST'|'PROD'} opts.env  l'environnement qu'elle sert
 * @param {string} opts.projectName son nom, d'où le pont dérive sa clé
 */
export async function startSbAutoInstance({ mongoUri, dbName, env, projectName, silent = true }) {
  const child = fork(CHILD, [], {
    silent,
    env: {
      ...process.env,
      SBAUTO_HARNESS: JSON.stringify({ mongoUri, dbName, env, projectName, sbautoBackend: SBAUTO_BACKEND }),
    },
  });

  if (silent) {
    // Les journaux de l'instance restent lisibles en cas d'échec, préfixés —
    // sans quoi deux instances écriraient l'une par-dessus l'autre.
    child.stderr?.on('data', (d) => process.stderr.write(`    [${projectName}] ${d}`));
  }

  const pending = new Map();
  let sequence = 0;
  let ready;
  const readiness = new Promise((resolve) => { ready = resolve; });

  child.on('message', (msg) => {
    if (msg?.ready) { ready(); return; }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.data);
    else {
      const err = new Error(msg.error);
      err.code = msg.code;
      slot.reject(err);
    }
  });
  child.on('exit', (code) => {
    for (const [, slot] of pending) slot.reject(new Error(`Instance arrêtée (code ${code}).`));
    pending.clear();
  });

  await readiness;

  const send = (cmd, args) => new Promise((resolve, reject) => {
    const id = (sequence += 1);
    pending.set(id, { resolve, reject });
    child.send({ id, cmd, args });
  });

  const boot = await send('boot');

  return {
    env,
    projectName,
    dbName,
    /** L'URL publique de CETTE instance — celle qu'elle annonce au Panel. */
    publicBackendUrl: `http://127.0.0.1:${boot.port}`,
    /** Renseigné après l'appairage : l'identifiant que le Panel lui a donné. */
    projectId: null,

    pair(args) { return send('pair', args); },
    heartbeat() { return send('heartbeat'); },
    pull(args) { return send('pull', args); },
    state() { return send('state'); },
    raw() { return send('raw'); },
    identity() { return send('identity'); },
    /** Ce que la page « Aide » affichera — via son vrai contrôleur. */
    help() { return send('help'); },
    applyForeign(args) { return send('applyForeign', args); },
    /** Renomme l’entreprise par le VRAI chemin métier — Company.save(). */
    renameCompany(args) { return send('renameCompany', args); },
    /** Un cycle de synchronisation réel : vidange d’outbox puis rattrapage. */
    syncNow() { return send('syncNow'); },
    outboxPending() { return send('outboxPending'); },
    severDatabase() { return send('severDatabase'); },
    restoreDatabase() { return send('restoreDatabase'); },
    async stop() {
      try { await send('stop'); } catch { /* le processus part, c'est le but */ }
      child.kill();
    },
  };
}
