/**
 * Transport DÉCORATEUR qui enregistre chaque opération distante dans un
 * RunRecorder (commande, exit code, stdout/stderr — redigés et bornés), sans
 * modifier le comportement du transport sous-jacent (SSH réel ou FakeTransport).
 *
 * C'est ce qui permet au rapport technique de contenir le détail de chaque
 * commande exécutée sur le VPS, tout en gardant le pipeline inchangé.
 */
import { Transport } from './Transport.js';

export class RecordingTransport extends Transport {
  constructor(inner, recorder) {
    super();
    this._inner = inner;
    this._recorder = recorder;
  }

  get kind() {
    return this._inner.kind;
  }

  async exec(command, opts = {}) {
    let res;
    try {
      res = await this._inner.exec(command, opts);
    } catch (err) {
      // Erreur de transport (connexion perdue, timeout) : on la journalise
      // comme un exec échoué puis on la propage.
      this._recorder.recordExec(command, { code: null, stdout: '', stderr: String(err?.message || err) });
      throw err;
    }
    this._recorder.recordExec(command, res);
    return res;
  }

  async writeFile(remotePath, content) {
    const r = await this._inner.writeFile(remotePath, content);
    this._recorder.recordFileWrite(remotePath);
    return r;
  }

  async readFile(remotePath) {
    return this._inner.readFile(remotePath);
  }

  async uploadDir(localPath, remotePath) {
    const r = await this._inner.uploadDir(localPath, remotePath);
    this._recorder.noteRemote('created', `${remotePath} (${r?.files ?? '?'} fichiers)`);
    return r;
  }

  async close() {
    return this._inner.close?.();
  }
}

export default RecordingTransport;
