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

export class SshTransport extends Transport {
  /**
   * @param {{host:string, username:string, password:string, port?:number, readyTimeout?:number}} creds
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

  async _connect() {
    if (this._client) return this._client;
    const { Client } = await import('ssh2'); // dépendance chargée à l'usage réel
    const client = new Client();
    await new Promise((resolve, reject) => {
      client
        .on('ready', resolve)
        .on('error', reject)
        .connect({
          host: this._creds.host,
          port: this._creds.port || 22,
          username: this._creds.username,
          password: this._creds.password, // jamais journalisé
          readyTimeout: this._creds.readyTimeout || 20_000,
          // On refuse les algorithmes trop faibles : sécurité par défaut de ssh2.
        });
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
