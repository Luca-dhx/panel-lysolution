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
   * ── CE QU'IL MODÉLISE EN PLUS DEPUIS LE REGISTRE DES PORTS ────────────────
   * Un double qui ne rendait qu'un chemin ne pouvait pas non plus révéler
   * qu'un service « démarré » boucle sur EADDRINUSE : il n'avait ni statut,
   * ni PID, ni compteur de redémarrages, ni port. Or c'est exactement ce que
   * le moteur doit désormais PROUVER avant de déclarer un service démarré.
   *
   * Il modélise donc : `start` enregistre chemin, port, PID et statut ;
   * `delete` oublie tout ; `reload` ne change RIEN au chemin ; `jlist` rend
   * l'ensemble. Une règle explicite passée par `.on()` reste prioritaire.
   */
  _pm2(command) {
    if (!command.includes('pm2')) return null;

    if (command.includes('pm2 jlist')) {
      const liste = [...this.pm2.entries()].map(([name, etat]) => {
        const p = typeof etat === 'string' ? { execPath: etat } : etat;
        return {
          name,
          pid: p.pid ?? 1000 + name.length,
          pm2_env: {
            pm_exec_path: p.execPath,
            pm_cwd: p.cwd ?? String(p.execPath).replace(/\/src\/server\.js$/, ''),
            status: p.status ?? 'online',
            restart_time: p.restarts ?? 0,
            unstable_restarts: p.unstableRestarts ?? 0,
            env: p.port ? { PORT: String(p.port) } : {},
          },
        };
      });
      return { code: 0, stdout: JSON.stringify(liste), stderr: '' };
    }

    const suppression = command.match(/pm2 delete (\S+)/);
    if (suppression) this.pm2.delete(suppression[1]);

    const demarrage = command.match(/cd (\S+) &&[\s\S]*pm2 start (\S+) --name (\S+)/);
    if (demarrage) {
      const port = command.match(/PORT=(\d+)/);
      this.pm2.set(demarrage[3], {
        execPath: `${demarrage[1]}/${demarrage[2]}`,
        cwd: demarrage[1],
        status: 'online',
        restarts: 0,
        pid: 1000 + demarrage[3].length,
        port: port ? Number(port[1]) : null,
      });
    }

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

  /**
   * UN SEUL FICHIER — le contenu RÉEL est lu depuis le disque local.
   *
   * Le double ne se contente pas d'enregistrer l'intention : il transporte les
   * octets. C'est ce qui permet à un test de relire ensuite l'empreinte « sur
   * le serveur » et de constater qu'elle correspond — un double qui rendrait
   * seulement `{ok:true}` prouverait qu'on a appelé la fonction, pas que le
   * fichier est arrivé intact.
   */
  async uploadFile(localPath, remotePath) {
    const fs = await import('node:fs/promises');
    const contenu = await fs.readFile(localPath);
    this.uploads.push({ localPath, remotePath, bytes: contenu.length });
    this.files.set(remotePath, contenu);
    return { bytes: contenu.length };
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
