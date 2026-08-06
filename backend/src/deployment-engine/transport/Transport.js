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
 * Exécute une commande et lève une DeploymentError si le code de sortie est ≠ 0.
 * Utilitaire partagé par les modules qui exigent le succès d'une étape.
 */
export async function execOrThrow(transport, command, { step, timeoutMs, input } = {}) {
  const res = await transport.exec(command, { timeoutMs, input });
  if (res.code !== 0) {
    const { DeploymentError } = await import('../errors.js');
    // On tronque stderr et ne révèle jamais la commande complète (peut contenir
    // des chemins sensibles, jamais de secret : le mot de passe passe hors ligne
    // de commande).
    const detail = (res.stderr || res.stdout || '').trim().slice(0, 500);
    throw new DeploymentError('REMOTE_COMMAND_FAILED', `Échec de commande distante (${step || 'exec'}).`, {
      step,
      details: { code: res.code, stderr: detail },
    });
  }
  return res;
}

export default Transport;
