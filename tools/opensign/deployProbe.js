// SONDE DE DÉPLOIEMENT — que sait le Panel de sa propre cible TEST ?
//
// Campagne de migration Yousign → OpenSign.
//
//   node tools/opensign/deployProbe.js
//
// Lecture seule. Aucune connexion SSH, aucun déploiement, aucune écriture.
// Elle répond à une seule question avant d'engager quoi que ce soit : le Panel
// a-t-il une cible de déploiement enregistrée, laquelle, et dans quel état la
// croit-il ?
import { connectDatabase, disconnectDatabase } from '../../backend/src/config/db.js';
import config from '../../backend/src/config/env.js';

await connectDatabase();

const { default: PanelDeploymentTarget } = await import('../../models/PanelDeploymentTarget.model.js')
  .catch(() => ({ default: null }));

console.log(`\n=== CIBLES DE DÉPLOIEMENT (runtime ${config.env}) ===\n`);

if (!PanelDeploymentTarget) {
  console.log('modèle PanelDeploymentTarget introuvable — surface absente de ce dépôt.');
} else {
  const cibles = await PanelDeploymentTarget.find({}).lean();
  console.log(`${cibles.length} cible(s)`);
  for (const c of cibles) {
    // Aucune valeur d'identification distante n'est affichée : hôte SSH,
    // utilisateur et chemins suffisent à décider, et un mot de passe n'a rien
    // à faire dans une sortie de terminal.
    console.log(JSON.stringify({
      targetId: c.targetId,
      name: c.name,
      environment: c.environment,
      url: c.url ?? c.publicUrl ?? null,
      host: c.host ?? null,
      sshHost: c.sshHost ? '(renseigné)' : null,
      sshUser: c.sshUser ?? null,
      status: c.status ?? null,
      lastDeployedAt: c.lastDeployedAt ?? null,
      lastRelease: c.lastRelease ?? c.currentRelease ?? null,
    }, null, 1));
  }
}

const { default: PanelDeploymentRun } = await import('../../models/PanelDeploymentRun.model.js')
  .catch(() => ({ default: null }));
if (PanelDeploymentRun) {
  const runs = await PanelDeploymentRun.find({}).sort({ startedAt: -1 }).limit(5).lean();
  console.log(`\n=== ${runs.length} DERNIERS RUNS ===`);
  for (const r of runs) {
    console.log(JSON.stringify({
      runId: r.runId, targetId: r.targetId, kind: r.kind ?? r.type ?? null,
      status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null,
      release: r.releaseId ?? null,
    }));
  }
}

await disconnectDatabase();
