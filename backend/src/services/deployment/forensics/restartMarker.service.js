/**
 * MARQUEUR DE REPRISE — un redémarrage ATTENDU n'est pas un incident.
 *
 * ══ LE CAS QU'IL TRAITE ═════════════════════════════════════════════════════
 *
 * Le backend déploie parfois SA PROPRE application. À l'étape `pm2`, il
 * redémarre donc le processus qui est en train d'exécuter le déploiement : la
 * requête HTTP se coupe, le flux s'arrête, et le run reste « en cours ».
 *
 * Vu de la reprise au démarrage, c'est indiscernable d'un plantage — et le run
 * était alors classé `interrupted`, alors qu'il s'agissait du fonctionnement
 * NORMAL d'un auto-déploiement. L'écran, lui, affichait une erreur serveur
 * générique pour une coupure parfaitement prévue.
 *
 * Le marqueur transforme cette coupure en fait déclaré : « je vais redémarrer,
 * voici ce que je faisais ». Au boot suivant, on le lit AVANT de conclure quoi
 * que ce soit.
 *
 * ══ POURQUOI EN BASE, ET PAS EN MÉMOIRE NI DANS UN FICHIER ══════════════════
 *
 * En mémoire : elle disparaît avec le process — c'est précisément ce qu'on
 * cherche à traverser. Dans un fichier : le nouveau process peut tourner
 * ailleurs (release différente, conteneur neuf) et ne le trouverait pas. La
 * base est le seul endroit que les deux processus partagent avec certitude.
 */
import mongoose from 'mongoose';

import { EVENTS, LEVELS, SOURCES, journal } from './runJournal.service.js';

const markerSchema = new mongoose.Schema(
  {
    /** Un seul marqueur vivant à la fois : la clé est constante. */
    key: { type: String, default: 'SINGLETON', unique: true },
    run: { type: String, required: true },
    target: { type: String, default: null },
    operation: { type: String, default: 'DEPLOYMENT' },
    /** L'étape que le process AURAIT dû exécuter ensuite. */
    nextExpectedStep: { type: String, default: null },
    expectedProcessName: { type: String, default: null },
    expectedPort: { type: Number, default: null },
    /** Le PID qui s'attendait à mourir — pour distinguer d'un simple relais. */
    pidBefore: { type: Number, default: null },
    writtenAt: { type: Date, required: true },
  },
  { versionKey: false },
);

const RestartMarker = mongoose.models.PanelDeploymentRestartMarker
  ?? mongoose.model('PanelDeploymentRestartMarker', markerSchema);

/**
 * DÉCLARE un redémarrage volontaire, AVANT de le déclencher.
 *
 * L'ordre n'est pas négociable : la ligne qui suit l'appel peut être la
 * dernière que ce process exécute. Tout ce qui doit survivre s'écrit d'abord.
 */
export async function ecrireMarqueurReprise({
  runId, targetId = null, operation = 'DEPLOYMENT',
  nextExpectedStep = null, expectedProcessName = null, expectedPort = null,
}) {
  try {
    await RestartMarker.findOneAndUpdate(
      { key: 'SINGLETON' },
      {
        $set: {
          run: runId,
          target: targetId,
          operation,
          nextExpectedStep,
          expectedProcessName,
          expectedPort,
          pidBefore: process.pid,
          writtenAt: new Date(),
        },
      },
      { upsert: true },
    );
    return true;
  } catch {
    // Un marqueur non écrit dégrade le diagnostic ; il ne doit pas empêcher le
    // déploiement de se poursuivre.
    return false;
  }
}

/** Le marqueur vivant, s'il y en a un. */
export async function lireMarqueurReprise() {
  try {
    return await RestartMarker.findOne({ key: 'SINGLETON' }).lean();
  } catch {
    return null;
  }
}

/** Efface le marqueur — UNIQUEMENT après constat de reprise. */
export async function effacerMarqueurReprise(runId = null) {
  try {
    const filtre = runId ? { key: 'SINGLETON', run: runId } : { key: 'SINGLETON' };
    await RestartMarker.deleteOne(filtre);
    return true;
  } catch {
    return false;
  }
}

/**
 * CONSOMME le marqueur au démarrage — avant toute reprise générique.
 *
 * ── POURQUOI CET ORDRE ──────────────────────────────────────────────────────
 * `recoverOrphanRuns()` classe tout run « en cours » comme interrompu. Appelé
 * en premier, il aurait qualifié d'incident un redémarrage parfaitement
 * attendu. On lit donc le marqueur d'abord, on qualifie ce run-là, et la
 * reprise générique ne traite ensuite que ce qui reste vraiment inexpliqué.
 *
 * Le marqueur n'est effacé qu'après avoir été CONSTATÉ : s'il ne correspond ni
 * au service ni à la destination courante, on le garde et on le signale plutôt
 * que d'effacer une trace qu'on n'a pas comprise.
 *
 * @returns {Promise<{consumed:boolean, runId?:string, reason?:string}>}
 */
export async function consommerMarqueurReprise() {
  const marqueur = await lireMarqueurReprise();
  if (!marqueur) return { consumed: false, reason: 'AUCUN_MARQUEUR' };

  const memeProcess = marqueur.pidBefore === process.pid;
  if (memeProcess) {
    // Le process n'a pas changé : le redémarrage n'a pas eu lieu. On ne
    // conclut rien, et on laisse le marqueur en place.
    return { consumed: false, runId: marqueur.run, reason: 'PROCESS_INCHANGE' };
  }

  await journal(marqueur.run, {
    source: SOURCES.SYSTEM,
    level: LEVELS.INFO,
    eventCode: EVENTS.APPLICATION_RESTART_COMPLETED,
    stepId: marqueur.nextExpectedStep,
    processName: marqueur.expectedProcessName,
    port: marqueur.expectedPort,
    pid: process.pid,
    message: 'Le service a redémarré comme prévu : ce n’était pas une panne. '
      + `Ancien pid ${marqueur.pidBefore}, nouveau pid ${process.pid}.`,
    details: {
      operation: marqueur.operation,
      nextExpectedStep: marqueur.nextExpectedStep,
      expectedProcessName: marqueur.expectedProcessName,
      expectedPort: marqueur.expectedPort,
      pidBefore: marqueur.pidBefore,
      pidAfter: process.pid,
      downtimeMs: Date.now() - new Date(marqueur.writtenAt).getTime(),
    },
  });

  await effacerMarqueurReprise(marqueur.run);
  return { consumed: true, runId: marqueur.run, nextExpectedStep: marqueur.nextExpectedStep };
}

export default {
  ecrireMarqueurReprise, lireMarqueurReprise, effacerMarqueurReprise, consommerMarqueurReprise,
};
