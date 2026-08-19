/**
 * Contrat de transport d'exécution distante.
 *
 * TOUT le moteur (préflight, pipeline, nginx, certbot, pm2, health, backup)
 * parle exclusivement à cette interface. Il ne connaît ni ssh2, ni le réseau,
 * ni le mot de passe VPS. C'est ce qui rend le moteur :
 *   - UI-agnostic (aucune dépendance React / HTTP) ;
 *   - testable sans VPS réel (FakeTransport) ;
 *   - réutilisable par une future CLI, un panel multi-sites, un autre frontend.
 *
 * Une implémentation concrète doit fournir :
 *   - exec(command, opts)   -> { code, stdout, stderr }
 *   - writeFile(path, data) -> void         (écrit un fichier distant)
 *   - readFile(path)        -> string       (lit un fichier distant)
 *   - uploadDir(local, remote) -> { files, bytes }
 *   - close()               -> void
 *   - kind (getter)         -> 'ssh' | 'fake' | 'local'
 *
 * `exec` NE DOIT JAMAIS lever pour un code de sortie non nul : elle retourne le
 * code. Les erreurs de transport (connexion perdue, timeout) lèvent, elles, une
 * exception — la distinction « la commande a échoué » vs « je n'ai pas pu
 * exécuter » est essentielle pour le moteur.
 */
export class Transport {
  get kind() {
    return 'abstract';
  }

  // eslint-disable-next-line no-unused-vars
  async exec(command, opts = {}) {
    throw new Error('Transport.exec non implémenté');
  }

  // eslint-disable-next-line no-unused-vars
  async writeFile(remotePath, content) {
    throw new Error('Transport.writeFile non implémenté');
  }

  // eslint-disable-next-line no-unused-vars
  async readFile(remotePath) {
    throw new Error('Transport.readFile non implémenté');
  }

  // eslint-disable-next-line no-unused-vars
  async uploadDir(localPath, remotePath) {
    throw new Error('Transport.uploadDir non implémenté');
  }

  /**
   * UN SEUL FICHIER, en binaire.
   *
   * `writeFile` ne convient pas : il écrit du texte, et un octet d'image
   * réinterprété en UTF-8 arrive corrompu à destination — un fichier présent,
   * de la bonne taille apparente, mais d'empreinte différente. `uploadDir`,
   * lui, synchronise tout un dossier là où il ne faut transférer que ce qui
   * manque réellement.
   *
   * @returns {Promise<{bytes:number}>}
   */
  // eslint-disable-next-line no-unused-vars
  async uploadFile(localPath, remotePath) {
    throw new Error('Transport.uploadFile non implémenté');
  }

  async close() {
    /* no-op par défaut */
  }
}

/**
 * ══ IL N'Y A PLUS D'UTILITAIRE FACULTATIF ICI ═══════════════════════════════
 *
 * `execOrThrow(transport, command, { step })` occupait cette place : elle
 * exécutait, comparait le code de sortie à zéro, et levait sinon. Exactement ce
 * qu'il fallait faire.
 *
 * Elle n'a JAMAIS eu d'appelant. Pendant ce temps, les cinq commandes du chemin
 * critique du pipeline — dont la bascule qui publie la nouvelle version et le
 * `npm ci` du backend — étaient lancées, attendues, et leur code de sortie
 * ignoré.
 *
 * C'est le sort ordinaire d'une primitive facultative : elle rassure celui qui
 * l'écrit sans contraindre celui qui l'ignore. Elle est remplacée par
 * `remoteCommand.js`, qui exige une CLASSE et un IDENTIFIANT à chaque appel, et
 * qu'une garde d'architecture rend obligatoire sur le chemin critique.
 *
 * La laisser offrirait une seconde façon de faire — la mauvaise, puisque
 * personne ne l'avait adoptée.
 */

export default Transport;
