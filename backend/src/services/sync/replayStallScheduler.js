/**
 * LE VEILLEUR DES REJEUX ENLISÉS — parce que le signal est le SILENCE.
 *
 * docs/architecture/WEBHOOK_CONTROL_PLANE.md §« `STALLED` ».
 *
 * ── POURQUOI IL EXISTE, ALORS QUE LE BATTEMENT SUFFISAIT PRESQUE ────────────
 *
 * L'acquittement d'un rejeu vit au battement du projet, et doit y rester : le
 * battement PORTE le curseur, et lui inventer un minuteur créerait une seconde
 * source pour une information déjà transportée.
 *
 * L'enlisement, non. Aucun message ne l'annonce — il se constate par l'ABSENCE
 * de message. Et le cas qui compte le plus est celui d'un projet ÉTEINT : s'il
 * fallait son battement pour constater qu'il ne bat plus, son rejeu resterait
 * « en vol » pour toujours et l'index d'unicité condamnerait l'écriture à ne
 * plus jamais être rejouable. On aurait refermé le piège d'un côté et rouvert
 * la même porte de l'autre.
 *
 * C'est la raison exacte de l'ordonnanceur d'échéances : une détection qui
 * dépend de quelqu'un n'est pas une détection.
 *
 * ── CE QU'IL NE FAIT PAS ────────────────────────────────────────────────────
 *
 * Il ne rejoue rien. Une lettre morte est déjà un renoncement après plusieurs
 * échecs, et la rejouer parce qu'un rejeu a échoué produirait exactement la
 * boucle qu'elle existe pour arrêter. Il NOMME, et nommer suffit : l'état
 * `STALLED` rouvre le geste pour un opérateur, qui décide.
 *
 * ── CADENCE ─────────────────────────────────────────────────────────────────
 *
 * Une minute. Le seuil se compte en dizaines de minutes : le balayage n'a
 * aucun besoin d'être fin, et la requête est bornée par l'index d'état. Le
 * premier passage a lieu AU DÉMARRAGE — un Panel redémarré après une nuit
 * constate immédiatement les enlisements de la nuit, sans attendre un tour.
 *
 * ── ARRÊT PROPRE ────────────────────────────────────────────────────────────
 *
 * `stopReplayStallScheduler()` coupe le minuteur et le repasse à `null` : un
 * second appel ne fait rien. Le minuteur est `unref` — il n'empêche jamais le
 * processus de se terminer.
 */
import logger from '../../utils/logger.js';
import { sweepStalledReplays } from './deadLetterReplay.service.js';

const TICK_MS = 60_000;

let timer = null;
let enCours = false;

/**
 * Un cycle. Se protège de lui-même : si un passage dure plus longtemps que
 * l'intervalle, le suivant s'efface plutôt que de travailler en double.
 */
export async function runReplayStallCycle() {
  if (enCours) return { skipped: true };
  enCours = true;
  try {
    return await sweepStalledReplays();
  } catch (err) {
    /**
     * Un balayage raté sera repris au cycle suivant. Il ne doit surtout pas
     * faire tomber le processus : ce veilleur observe un incident, il n'est
     * pas lui-même sur le chemin d'une écriture métier.
     */
    logger.warn(`Balayage des rejeux enlisés interrompu : ${err.message}`);
    return { stalled: 0, error: err.message };
  } finally {
    enCours = false;
  }
}

export function startReplayStallScheduler({ intervalMs = TICK_MS } = {}) {
  if (timer) return timer;
  void runReplayStallCycle();
  timer = setInterval(() => { void runReplayStallCycle(); }, intervalMs);
  timer.unref?.();
  logger.info(`Rejeux enlisés : balayage toutes les ${Math.round(intervalMs / 1000)} s.`);
  return timer;
}

export function stopReplayStallScheduler() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

export default { runReplayStallCycle, startReplayStallScheduler, stopReplayStallScheduler };
