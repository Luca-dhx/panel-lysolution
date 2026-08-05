/**
 * Transport SSH RÉEL (production).
 *
 * Implémentation concrète du contrat Transport au-dessus de `ssh2`. C'est le
 * SEUL module du moteur qui connaît le réseau et le mot de passe VPS — et il ne
 * le reçoit qu'au moment de se connecter, jamais il ne le stocke ni le journalise.
 *
 * `ssh2` est importé PARESSEUSEMENT (dynamic import) : le moteur et ses tests se
 * chargent sans cette dépendance ; elle n'est requise que pour un déploiement
 * réel. Installez-la avec `npm install` côté backend (voir package.json).
 */
import { Transport } from './Transport.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 20_000;
/**
 * Plafond PROPRE à la tentative de connexion, indépendant de `readyTimeout`.
 *
 * `readyTimeout` est celui de ssh2 : il couvre la poignée de main, et selon la
 * façon dont la connexion meurt, ssh2 peut terminer par `timeout` ou `close`
 * sans jamais émettre `error`. Ce plafond-ci est le nôtre : il garantit que la
 * promesse se règle, quoi qu'il arrive en dessous.
 */
const CONNECT_TIMEOUT_MS = READY_TIMEOUT_MS + 10_000;

export class SshTransport extends Transport {
  /**
   * @param {{host:string, username:string, password:string, port?:number, readyTimeout?:number, connectTimeoutMs?:number, clientFactory?:Function}} creds
   */
  constructor(creds) {
    super();
    if (!creds || !creds.host || !creds.username || !creds.password) {
      throw new Error('SshTransport : host, username et password sont requis.');
    }
    this._creds = creds;
    this._client = null;
    this._sftp = null;
  }

  get kind() {
    return 'ssh';
  }

  /** Fabrique du client ssh2 — injectable pour éprouver les chemins de sortie. */
  async _newClient() {
    if (this._creds.clientFactory) return this._creds.clientFactory();
    const { Client } = await import('ssh2'); // dépendance chargée à l'usage réel
    return new Client();
  }

  /**
   * Ouvre la connexion — et se règle TOUJOURS, sur n'importe quelle issue.
   *
   * ── LE DÉFAUT QU'ELLE CORRIGE ─────────────────────────────────────────────
   * Cette promesse n'écoutait que `ready` et `error`. Or une tentative SSH peut
   * mourir sans jamais émettre `error` : le serveur ferme avant la poignée de
   * main (`close`), le pair coupe (`end`), ou ssh2 abandonne sur son propre
   * délai (`timeout`). Dans ces cas la promesse restait pendante POUR TOUJOURS.
   * Le préflight attendait donc indéfiniment sa première commande, l'étape
   * « Connexion sécurisée au serveur » ne recevait jamais d'issue, et le flux
   * NDJSON ne se fermait pas : ni succès, ni erreur, ni rapport.
   *
   * Tous les chemins de sortie sont désormais couverts, une seule fois, et le
   * client est refermé en cas d'échec — sinon la socket restait ouverte.
   */
  async _connect() {
    if (this._client) return this._client;
    const client = await this._newClient();
    const plafond = this._creds.connectTimeoutMs || CONNECT_TIMEOUT_MS;

    await new Promise((resolve, reject) => {
      let regle = false;
      let minuteur = null;

      /**
       * Les écouteurs restent en place APRÈS le règlement — et c'est voulu.
       *
       * `error` est un évènement spécial de Node : émis sans écouteur, il est
       * relancé comme exception non gérée et TUE LE PROCESSUS. Or ssh2 émet
       * régulièrement une erreur tardive après l'abandon d'une connexion
       * (« Connection lost before handshake » arrive après notre propre
       * délai). Détacher les écouteurs une fois la promesse réglée faisait
       * donc tomber le backend en plein préflight — exactement la panne qu'on
       * cherche à supprimer. Ils restent donc attachés, et `terminer` ne fait
       * plus rien après la première issue.
       */
      const terminer = (err) => {
        if (regle) return; // exactement une issue, jamais deux
        regle = true;
        if (minuteur) clearTimeout(minuteur);
        if (err) {
          // Échec : on rend la socket. Sans cela, une tentative ratée laissait
          // un client ssh2 vivant, donc une socket ouverte, à chaque essai.
          try { client.end?.(); } catch { /* déjà mort */ }
          try { client.destroy?.(); } catch { /* idem */ }
          reject(err);
        } else {
          resolve();
        }
      };

      const surPret = () => terminer(null);
      const surErreur = (err) => terminer(err instanceof Error ? err : new Error(String(err)));
      const surFermeture = () => terminer(new Error('Connexion SSH fermée avant la fin de la négociation.'));
      const surFin = () => terminer(new Error('Connexion SSH interrompue par le serveur.'));
      const surDelai = () => terminer(new Error(`Délai de connexion SSH dépassé (${plafond} ms).`));

      minuteur = setTimeout(surDelai, plafond);
      minuteur.unref?.();

      client
        .on('ready', surPret)
        .on('error', surErreur)
        .on('close', surFermeture)
        .on('end', surFin)
        .on('timeout', surDelai);

      try {
        client.connect({
          host: this._creds.host,
          port: this._creds.port || 22,
          username: this._creds.username,
          password: this._creds.password, // jamais journalisé
          readyTimeout: this._creds.readyTimeout || READY_TIMEOUT_MS,
          // On refuse les algorithmes trop faibles : sécurité par défaut de ssh2.
        });
      } catch (err) {
        // `connect()` peut lever de façon synchrone (options invalides, hôte
        // vide) : sans ce filet, l'exception court-circuiterait la promesse.
        terminer(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this._client = client;
    return client;
  }

  async exec(command, opts = {}) {
    const client = await this._connect();
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let code = null;
        const timer = setTimeout(() => {
          stream.close();
          reject(new Error(`Timeout de commande distante (${timeoutMs} ms).`));
        }, timeoutMs);
        timer.unref?.();
        stream
          .on('close', (exitCode) => {
            clearTimeout(timer);
            resolve({ code: exitCode ?? code ?? 0, stdout, stderr });
          })
          .on('data', (d) => {
            stdout += d.toString('utf8');
          })
          .stderr.on('data', (d) => {
            stderr += d.toString('utf8');
          });
        if (opts.input) {
          stream.end(opts.input);
        }
      });
    });
  }

  async _getSftp() {
    if (this._sftp) return this._sftp;
    const client = await this._connect();
    this._sftp = await new Promise((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    return this._sftp;
  }

  async writeFile(remotePath, content) {
    const sftp = await this._getSftp();
    await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath);
      ws.on('close', resolve).on('error', reject);
      ws.end(Buffer.from(String(content), 'utf8'));
    });
  }

  async readFile(remotePath) {
    const sftp = await this._getSftp();
    return new Promise((resolve, reject) => {
      let data = '';
      const rs = sftp.createReadStream(remotePath);
      rs.on('data', (d) => (data += d.toString('utf8')));
      rs.on('end', () => resolve(data));
      rs.on('error', reject);
    });
  }

  /**
   * Envoie un dossier local vers le VPS via `tar | ssh` n'est pas disponible
   * ici : on s'appuie sur SFTP récursif. Pour de gros volumes, préférer un
   * artefact `.tar.gz` uploadé puis détendu (voir pipeline.build).
   */
  async uploadDir(localPath, remotePath) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const sftp = await this._getSftp();

    const mkdirp = (p) =>
      new Promise((resolve) => {
        sftp.mkdir(p, () => resolve()); // ignore « existe déjà »
      });
    const putFile = (local, remote) =>
      new Promise((resolve, reject) => {
        sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
      });

    let files = 0;
    let bytes = 0;
    const walk = async (localDir, remoteDir) => {
      await mkdirp(remoteDir);
      const entries = await fs.readdir(localDir, { withFileTypes: true });
      for (const entry of entries) {
        const l = path.join(localDir, entry.name);
        const r = `${remoteDir}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(l, r);
        } else if (entry.isFile()) {
          await putFile(l, r);
          files += 1;
          bytes += (await fs.stat(l)).size;
        }
      }
    };
    await walk(localPath, remotePath);
    return { files, bytes };
  }

  async close() {
    try {
      this._sftp?.end?.();
    } catch {
      /* ignore */
    }
    try {
      this._client?.end?.();
    } catch {
      /* ignore */
    }
    this._sftp = null;
    this._client = null;
  }
}

export default SshTransport;
