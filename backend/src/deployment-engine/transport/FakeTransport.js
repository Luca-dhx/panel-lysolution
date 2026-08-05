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
    /** Nom de process PM2 → chemin du script réellement enregistré. */
    this.pm2 = new Map(opts.pm2 ? Object.entries(opts.pm2) : []);
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

  /**
   * ÉTAT PM2 SIMULÉ — parce que PM2 en a un, et qu'il décide de tout.
   *
   * PM2 mémorise le chemin du script au premier `start` : ni `reload` ni
   * `restart` ne le recalculent. Un double qui répondait « 0 » à tout ne
   * pouvait donc pas révéler qu'un rechargement relance l'ancien fichier —
   * exactement le défaut observé en production, où deux déploiements verts
   * ont laissé tourner un backend vieux de plusieurs commits.
   *
   * Ce double modélise donc le strict nécessaire : `start` enregistre un
   * chemin, `delete` l'oublie, `reload` ne change RIEN, `jlist` le rend.
   * Une règle explicite passée par `.on()` reste prioritaire.
   */
  _pm2(command) {
    if (!command.includes('pm2')) return null;

    if (command.includes('pm2 jlist')) {
      const liste = [...this.pm2.entries()].map(([name, execPath]) => ({
        name,
        pm2_env: { pm_exec_path: execPath, pm_cwd: execPath.replace(/\/src\/server\.js$/, '') },
      }));
      return { code: 0, stdout: JSON.stringify(liste), stderr: '' };
    }

    const suppression = command.match(/pm2 delete (\S+)/);
    if (suppression) this.pm2.delete(suppression[1]);

    const demarrage = command.match(/cd (\S+) &&[\s\S]*pm2 start (\S+) --name (\S+)/);
    if (demarrage) this.pm2.set(demarrage[3], `${demarrage[1]}/${demarrage[2]}`);

    // `reload` : volontairement SANS effet sur le chemin mémorisé.
    return { code: 0, stdout: '', stderr: '' };
  }

  async exec(command, opts = {}) {
    this.commands.push({ command, opts });
    const rule = this._resolve(command);
    if (rule && rule.throw) throw rule.throw;
    if (!rule) {
      const pm2 = this._pm2(command);
      if (pm2) return pm2;
    }
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
