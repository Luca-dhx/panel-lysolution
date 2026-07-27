/**
 * Transport SIMULÉ, en mémoire.
 *
 * Sert à deux choses :
 *   1. les tests unitaires du moteur (préflight, pipeline, backup…) sans VPS ;
 *   2. le mode « dry-run » d'un vrai déploiement (on rejoue le pipeline sans
 *      toucher à un serveur).
 *
 * On programme des réponses par MOTIF de commande (chaîne ou RegExp). La
 * première règle qui matche gagne. Un système de fichiers virtuel stocke les
 * writeFile/readFile. Toutes les commandes exécutées sont enregistrées pour
 * assertion.
 */
import { Transport } from './Transport.js';

export class FakeTransport extends Transport {
  /**
   * @param {object} [opts]
   * @param {Array<{match: string|RegExp, code?: number, stdout?: string, stderr?: string, throw?: Error}>} [opts.responses]
   * @param {{code:number, stdout:string, stderr:string}} [opts.defaultResponse]
   */
  constructor(opts = {}) {
    super();
    this.responses = opts.responses ? [...opts.responses] : [];
    this.defaultResponse = opts.defaultResponse || { code: 0, stdout: '', stderr: '' };
    this.commands = []; // historique des commandes exécutées
    this.files = new Map(); // FS virtuel : remotePath -> content
    this.uploads = []; // historique des uploads
  }

  get kind() {
    return 'fake';
  }

  /** Ajoute une règle de réponse. Chaînable. */
  on(match, response) {
    this.responses.push({ match, ...response });
    return this;
  }

  _resolve(command) {
    // Dernière règle enregistrée qui matche = gagnante. Cela permet à un `.on()`
    // ajouté après coup de SURCHARGER une règle de base (sémantique d'override).
    for (let i = this.responses.length - 1; i >= 0; i -= 1) {
      const rule = this.responses[i];
      const m = rule.match;
      const hit = m instanceof RegExp ? m.test(command) : command.includes(m);
      if (hit) return rule;
    }
    return null;
  }

  async exec(command, opts = {}) {
    this.commands.push({ command, opts });
    const rule = this._resolve(command);
    if (rule && rule.throw) throw rule.throw;
    if (rule) {
      return {
        code: rule.code ?? 0,
        stdout: rule.stdout ?? '',
        stderr: rule.stderr ?? '',
      };
    }
    return { ...this.defaultResponse };
  }

  async writeFile(remotePath, content) {
    this.files.set(remotePath, String(content));
  }

  async readFile(remotePath) {
    if (!this.files.has(remotePath)) {
      const err = new Error(`Fichier distant introuvable : ${remotePath}`);
      err.code = 'ENOENT';
      throw err;
    }
    return this.files.get(remotePath);
  }

  async uploadDir(localPath, remotePath) {
    this.uploads.push({ localPath, remotePath });
    return { files: 1, bytes: 0 };
  }

  /** True si une commande contenant `needle` (string|RegExp) a été exécutée. */
  ran(needle) {
    return this.commands.some(({ command }) =>
      needle instanceof RegExp ? needle.test(command) : command.includes(needle)
    );
  }

  /** Index de la première commande qui matche (pour vérifier l'ORDRE des étapes). */
  indexOf(needle) {
    return this.commands.findIndex(({ command }) =>
      needle instanceof RegExp ? needle.test(command) : command.includes(needle)
    );
  }
}

export default FakeTransport;
