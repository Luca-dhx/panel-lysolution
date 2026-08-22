#!/usr/bin/env node
// PILOTE LE MOTEUR OFFICIEL DE DÉPLOIEMENT, depuis une console.
//
// ── CE QUE CE SCRIPT FAIT, ET SURTOUT CE QU'IL NE FAIT PAS ──────────────────
//
// Le moteur se pilote normalement depuis l'écran « Déploiement » du Panel. Cet
// écran n'ajoute rien au mécanisme : il collecte un mot de passe SSH, ouvre une
// exécution (`createRun`) et lance le worker détaché (`startDeploymentWorker`).
// Ce script fait exactement ces trois gestes, dans le même ordre, avec les
// mêmes fonctions — puis suit l'exécution jusqu'à son terme.
//
// Il ne réimplémente AUCUNE étape du pipeline : ni upload, ni build, ni bascule,
// ni nginx, ni PM2, ni contrôle de santé. Il n'ouvre pas de session SSH lui-même.
// Tout cela reste dans le worker officiel, qui reste le seul à savoir déployer.
//
// C'est important : un script qui « déploierait presque comme le moteur »
// finirait par diverger de lui, et le premier écart se découvrirait en
// production.
//
// ── POURQUOI PASSER PAR LE WORKER PLUTÔT QUE D'APPELER L'EXÉCUTEUR ──────────
//
// Parce que le worker détient le cycle de vie complet d'une exécution : le
// battement de cœur, la reprise après mort du parent, la clôture, la
// finalisation de la destination. L'appeler directement obligerait à recopier
// cette mécanique, et une copie approximative du suivi d'un déploiement est
// pire que pas de suivi du tout.
//
// Usage :
//   node src/scripts/deploy-drive.js --list
//   node src/scripts/deploy-drive.js --target <id> --op DEPLOYMENT
//   node src/scripts/deploy-drive.js --run <runId>            (suivre / relire)

import process from 'node:process';

import { config } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { getTargetOrThrow, listTargets, markDeploying } from '../services/deployment/deploymentTarget.service.js';
import { OPERATIONS } from '../services/deployment/deploymentExecutor.service.js';
import {
  activeRunFor, createRun, describeRun, getRunOrThrow, readEventsSince,
} from '../services/deployment/deploymentRun.service.js';
import { startDeploymentWorker } from '../services/deployment/deploymentWorker.service.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const has = (name) => process.argv.includes(`--${name}`);
const ACTEUR = 'deploy-drive@console';
const attendre = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Suit une exécution jusqu'à son état terminal, en relayant son journal. */
async function suivre(runId, { timeoutMs = 20 * 60 * 1000 } = {}) {
  let curseur = 0;
  const debut = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const lot = await readEventsSince(runId, curseur).catch(() => null);
    for (const e of lot?.events ?? []) {
      curseur = Math.max(curseur, e.seq ?? curseur);
      const etiquette = e.stepId ? `[${e.stepId}] ` : '';
      const niveau = e.level && e.level !== 'INFO' ? `${e.level} ` : '';
      console.log(`    ${niveau}${etiquette}${e.message ?? e.eventCode ?? ''}`.trimEnd());
    }

    // eslint-disable-next-line no-await-in-loop
    const doc = await getRunOrThrow(runId).catch(() => null);
    const vue = doc ? describeRun(doc) : null;
    if (vue && vue.status !== 'running' && vue.status !== 'queued') return vue;

    if (Date.now() - debut > timeoutMs) {
      console.error('  ✗ délai dépassé — l’exécution continue côté serveur.');
      return vue;
    }
    // eslint-disable-next-line no-await-in-loop
    await attendre(2500);
  }
}

async function main() {
  await connectDatabase();

  if (has('list')) {
    for (const t of await listTargets()) {
      console.log(`${t.targetId}  ${String(t.environment).padEnd(4)}  ${String(t.host).padEnd(32)}  ssh=${t.sshUser}@${t.sshHost}:${t.sshPort}  self=${t.selfHosted === true}`);
    }
    await disconnectDatabase();
    return;
  }

  const suivi = arg('run');
  if (suivi) {
    const vue = await suivre(suivi);
    console.log(`\n${vue?.status === 'ok' ? '✓' : '✗'} run ${suivi} — ${vue?.status}`);
    await disconnectDatabase();
    process.exitCode = vue?.status === 'ok' ? 0 : 1;
    return;
  }

  const targetId = arg('target');
  const operationType = arg('op') ?? OPERATIONS.CONNECTION_TEST;
  if (!targetId) throw new Error('--target requis');
  if (!OPERATIONS[operationType]) throw new Error(`--op inconnue : ${operationType}`);

  const sshPassword = process.env.VPS_PASS;
  if (!sshPassword) throw new Error('VPS_PASS absent du .env : le moteur exige un mot de passe SSH.');

  const target = await getTargetOrThrow(targetId);
  const encours = await activeRunFor(target.targetId);
  if (encours) {
    throw new Error(`Une exécution est déjà en cours sur « ${target.name} » (${encours.operationType}, ${encours.runId}).`);
  }

  console.log(`\n▸ ${operationType} — « ${target.name} » (${target.environment}) · ${target.host}`);
  console.log(`  ssh ${target.sshUser}@${target.sshHost}:${target.sshPort} · base ${config.dbName}`);

  const selfDeployment = target.selfHosted === true && operationType === OPERATIONS.DEPLOYMENT;
  const runId = await createRun({ target, operationType, user: ACTEUR, selfDeployment });
  if (operationType === OPERATIONS.DEPLOYMENT || operationType === OPERATIONS.ROLLBACK) {
    await markDeploying(target.targetId, runId);
  }
  console.log(`  run ${runId}${selfDeployment ? ' · AUTO-DÉPLOIEMENT (le Panel distant redémarrera)' : ''}\n`);

  startDeploymentWorker({ runId, targetId: target.targetId, operationType, sshPassword, user: ACTEUR });

  const vue = await suivre(runId);
  const ok = vue?.status === 'ok';
  console.log(`\n${ok ? '✓' : '✗'} ${operationType} — ${vue?.status ?? 'inconnu'}`);
  if (!ok && vue?.error) console.log(`  cause : ${vue.error.code ?? ''} ${vue.error.message ?? ''}`);

  await disconnectDatabase();
  process.exitCode = ok ? 0 : 1;
}

main().catch(async (err) => {
  console.error(`✗ ${err?.message ?? err}`);
  await disconnectDatabase().catch(() => null);
  process.exitCode = 1;
});
