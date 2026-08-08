// ============================================================================
// SEUL fichier du Panel autorisé à parler réseau à une AUTRE INSTANCE DU PANEL.
//
// ══ POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST ICI ══════════════════════
//
// Le Panel a DEUX axes réseau sortants, et un seul avait sa discipline :
//
//   Panel → PROJET   contrat ProjectBridge, un client unique et exclusif
//                    (`ProjectBridgeClient.js`) ;
//   Panel → PANEL    relais des médias vers l'instance qui les détient.
//
// Le second vivait dans `services/upload/mediaAuthority.js` : un service métier
// qui ouvrait sa propre socket. La règle d'exclusivité ne le voyait pas comme
// une violation de son INTENTION — il ne parle pas à un projet — mais elle le
// voyait comme un `fetch` de plus, et elle avait raison de s'en méfier : rien
// n'empêchait qu'un deuxième, puis un troisième, apparaissent ailleurs.
//
// Le transport est donc sorti du service. `mediaAuthority.js` garde ce qui lui
// appartient — DÉCIDER qui détient les médias — et ne sait plus émettre. Les
// deux axes ont maintenant la même forme : une décision quelque part, une
// socket ici, et nulle part ailleurs.
//
// ══ CE QUE CE CLIENT NE FAIT JAMAIS ═════════════════════════════════════════
//
//   · suivre une redirection — une redirection vers un autre hôte ferait sortir
//     la lecture de l'autorité sans que personne ne le sache ;
//   · attendre indéfiniment — un relais sans borne suspend la requête du
//     navigateur aussi longtemps que l'amont reste muet ;
//   · fabriquer ou stocker un secret — il RÉÉMET l'en-tête `Authorization`
//     reçu. Les deux instances partagent la clé de signature : le jeton de
//     l'utilisateur est déjà valide en face. Rien à provisionner.
// ============================================================================

/** Plafond du relais. Au-delà, l'amont est considéré comme muet. */
const RELAY_TIMEOUT_MS = 30_000;

export class MediaAuthorityClient {
  /**
   * @param {object} opts
   * @param {string}   opts.baseUrl     base absolue de l'autorité média.
   * @param {number}   [opts.timeoutMs] plafond par relais.
   * @param {Function} [opts.fetchImpl] injectable pour les tests.
   */
  constructor({ baseUrl, timeoutMs = RELAY_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error('MediaAuthorityClient : baseUrl requise.');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Relaie une requête vers l'autorité et rend sa réponse TELLE QUELLE.
   *
   * La réponse n'est ni lue ni interprétée : un média est un flux binaire, et
   * le consommer ici pour le réémettre doublerait la mémoire utilisée par
   * chaque image servie. L'appelant la transmet au navigateur.
   *
   * @param {string} chemin  chemin à relayer, commençant par `/`
   * @returns {Promise<Response>}
   */
  async relay(chemin, { method = 'GET', headers = {}, body } = {}) {
    return this.fetchImpl(`${this.baseUrl}${chemin}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

export default MediaAuthorityClient;
