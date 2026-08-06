/**
 * POURQUOI UN FLUX S'EST ARRÊTÉ — fait observé, puis cause déduite.
 *
 * ══ LA DISTINCTION QUI STRUCTURE CE MODULE ══════════════════════════════════
 *
 * Un flux coupé produit toujours le même symptôme côté navigateur : une
 * réponse tronquée. Mais quatre pannes très différentes le produisent, et les
 * confondre a coûté un diagnostic entier :
 *
 *   · le client a fermé son onglet ;
 *   · le backend s'est redémarré LUI-MÊME, comme prévu ;
 *   · le backend est mort ;
 *   · l'écriture a échoué alors que le backend est vivant.
 *
 * Ce module ne devine pas. Il rassemble les FAITS observables — en-têtes
 * envoyés, réponse achevée, requête avortée, redémarrage annoncé, PID — et n'en
 * déduit une cause que lorsque ces faits la déterminent. Quand ils ne la
 * déterminent pas, il le DIT : `INDETERMINE` est une réponse honnête, et bien
 * plus utile qu'une cause inventée qu'on croira sur parole.
 */

export const CAUSES = Object.freeze({
  CLIENT_ABORT: 'CLIENT_ABORT',
  BACKEND_RESTART: 'BACKEND_RESTART',
  BACKEND_CRASH: 'BACKEND_CRASH',
  STREAM_WRITE_FAILED: 'STREAM_WRITE_FAILED',
  UPSTREAM_OR_PROXY_ABORT: 'UPSTREAM_OR_PROXY_ABORT',
  COMPLETED: 'COMPLETED',
  INDETERMINE: 'INDETERMINE',
});

/**
 * Déduit la cause à partir des seuls faits fournis.
 *
 * @param {object} faits
 * @param {boolean} faits.headersSent        les en-têtes étaient-ils partis ?
 * @param {boolean} faits.writableFinished   la réponse s'est-elle achevée ?
 * @param {boolean} faits.requestAborted     le CLIENT a-t-il raccroché ?
 * @param {boolean} faits.restartExpected    un redémarrage était-il annoncé ?
 * @param {boolean} faits.writeFailed        une écriture a-t-elle échoué ?
 * @param {boolean} faits.processAlive       le process répond-il encore ?
 * @returns {{cause:string, certain:boolean, explication:string, faits:object}}
 */
export function deduireCauseCoupure(faits = {}) {
  const {
    headersSent = false,
    writableFinished = false,
    requestAborted = false,
    restartExpected = false,
    writeFailed = false,
    processAlive = true,
  } = faits;

  const rendu = (cause, certain, explication) => ({
    cause,
    certain,
    explication,
    // Les faits voyagent AVEC la déduction : un lecteur doit pouvoir refaire
    // le raisonnement, et le contredire si les faits ne le portent pas.
    faits: { headersSent, writableFinished, requestAborted, restartExpected, writeFailed, processAlive },
  });

  // La réponse s'est achevée : il n'y a pas eu de coupure.
  if (writableFinished) return rendu(CAUSES.COMPLETED, true, 'La réponse s’est terminée normalement.');

  /**
   * L'ÉCRITURE A ÉCHOUÉ ALORS QUE LE PROCESS VIT.
   *
   * Placé AVANT le redémarrage : si nous sommes encore là pour constater
   * l'échec, ce n'est pas nous qui sommes morts.
   */
  if (writeFailed && processAlive) {
    return rendu(CAUSES.STREAM_WRITE_FAILED, true,
      'Le backend est vivant, mais une écriture dans le flux a échoué : le canal de réponse est rompu en aval.');
  }

  /**
   * LE CLIENT A RACCROCHÉ — fait DIRECTEMENT observable.
   *
   * Node lève `aborted` sur la requête : c'est le client, pas nous. Aucune
   * déduction n'est nécessaire.
   */
  if (requestAborted) {
    return rendu(CAUSES.CLIENT_ABORT, true,
      'Le client a fermé la connexion. L’opération serveur, elle, s’est poursuivie.');
  }

  /**
   * UN REDÉMARRAGE ÉTAIT ANNONCÉ.
   *
   * Le backend a écrit `APPLICATION_RESTART_EXPECTED` avant de se couper : la
   * coupure est prévue, pas subie. C'est le cas nominal d'un auto-déploiement.
   */
  if (restartExpected) {
    return rendu(CAUSES.BACKEND_RESTART, true,
      'Le backend avait annoncé son redémarrage avant la coupure : elle était attendue.');
  }

  /**
   * LE PROCESS NE RÉPOND PLUS, SANS REDÉMARRAGE ANNONCÉ.
   *
   * C'est un plantage. La certitude vient de la conjonction : personne n'a
   * annoncé de redémarrage, et le process n'est plus là.
   */
  if (!processAlive) {
    return rendu(CAUSES.BACKEND_CRASH, true,
      'Le flux s’est interrompu sans redémarrage annoncé, et le process ne répondait plus : plantage.');
  }

  /**
   * TOUT LE RESTE — on ne conclut PAS.
   *
   * En-têtes partis, réponse inachevée, client toujours là, process vivant :
   * un intermédiaire (proxy, équilibreur, délai Nginx) est le suspect le plus
   * probable. « Probable » n'est pas « établi » : on nomme l'hypothèse sans la
   * présenter comme un fait. Inventer une cause ici serait exactement la faute
   * que toute cette instrumentation cherche à rendre impossible.
   */
  if (headersSent) {
    return rendu(CAUSES.INDETERMINE, false,
      'Flux ouvert puis interrompu sans cause démontrable. Un intermédiaire (proxy, délai amont) '
      + 'est possible, mais les faits disponibles ne l’établissent pas.');
  }

  return rendu(CAUSES.INDETERMINE, false,
    'Connexion fermée avant l’envoi des en-têtes, sans cause démontrable.');
}

/** Le niveau de journal correspondant : une coupure attendue n'est pas une erreur. */
export function niveauPourCause(cause) {
  if (cause === CAUSES.COMPLETED) return 'info';
  if (cause === CAUSES.BACKEND_RESTART || cause === CAUSES.CLIENT_ABORT) return 'warning';
  return 'error';
}

export default { CAUSES, deduireCauseCoupure, niveauPourCause };
