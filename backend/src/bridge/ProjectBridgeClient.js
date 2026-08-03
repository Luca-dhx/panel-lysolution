// ============================================================================
// SEUL fichier du Panel autorisé à parler réseau à un projet.
// Côté client du contrat docs/spec/ProjectBridge.openapi.yaml — le symétrique
// exact du PanelClient.js embarqué dans les projets.
// Discipline : timeout court, jamais d'exception brute qui fuit vers un écran,
// erreurs mappées vers BridgeError (dont PROJECT_UNREACHABLE, code local).
// ============================================================================
import {
  BRIDGE_ERROR_CODES,
  BridgeError,
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  LOCAL_ERROR_CODES,
  PROJECT_API_ROUTES,
} from './bridgeContract.js';

// UNE méthode par chemin du contrat — la conformité l'exige et le vérifie.
// `probe()` n'y figure donc PAS : ce n'est pas un chemin de plus, c'est une
// variante de `ping()` qui conserve l'en-tête de version.
export const PROJECT_BRIDGE_CLIENT_METHODS = Object.freeze([
  'ping',
  'getIdentity',
  'getHealth',
  'getManifest',
  'deliverChanges',
  'readLocalChanges',
  'listOperations',
  'invokeOperation',
  'notifyUnpair',
]);

const DEFAULT_TIMEOUT_MS = 10_000;

export class ProjectBridgeClient {
  constructor({ baseUrl, bridgeToken, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error('ProjectBridgeClient : baseUrl requis.');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.bridgeToken = bridgeToken ?? null;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async #request(method, path, { body, query, authenticated = true } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION };
    if (authenticated) {
      if (!this.bridgeToken) {
        throw new BridgeError(BRIDGE_ERROR_CODES.UNAUTHORIZED, 'Aucun bridgeToken fourni au client.');
      }
      headers.authorization = `Bearer ${this.bridgeToken}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch {
      throw new BridgeError(
        LOCAL_ERROR_CODES.PROJECT_UNREACHABLE,
        'Le projet ne répond pas (réseau, timeout ou service arrêté).',
      );
    } finally {
      clearTimeout(timer);
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok || json?.success !== true) {
      const code = json?.code ?? BRIDGE_ERROR_CODES.INTERNAL;
      const message = json?.message ?? `Réponse inattendue du projet (HTTP ${response.status}).`;
      throw new BridgeError(code, message, json?.details ? { remoteDetails: json.details } : null);
    }
    return json.data;
  }

  // -- discovery -------------------------------------------------------------
  ping() {
    return this.#request('GET', PROJECT_API_ROUTES.ping, { authenticated: false });
  }

  /**
   * SONDE — ping + version de contrat annoncée.
   *
   * La version voyage dans l'EN-TÊTE `X-Bridge-Contract-Version`, pas dans le
   * corps : `ping()` la perd donc. Avant d'appairer, c'est précisément ce
   * qu'on veut savoir — d'où cette variante, qui reste dans le seul fichier
   * autorisé à parler réseau.
   */
  async probe() {
    const url = new URL(this.baseUrl + PROJECT_API_ROUTES.ping);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION },
        signal: controller.signal,
      });
    } catch {
      throw new BridgeError(
        LOCAL_ERROR_CODES.PROJECT_UNREACHABLE,
        'Le projet ne répond pas (réseau, timeout ou service arrêté).',
      );
    } finally {
      clearTimeout(timer);
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    const contractVersion = response.headers?.get?.(CONTRACT_VERSION_HEADER) ?? null;

    // Un 409 sur le ping est INFORMATIF, pas un échec de sonde : il signifie
    // « je t'entends, mais nos majeures divergent » — et l'en-tête porte
    // alors la version du projet, qui est exactement ce qu'on cherche.
    if (!response.ok && response.status !== 409) {
      throw new BridgeError(
        json?.code ?? BRIDGE_ERROR_CODES.INTERNAL,
        json?.message ?? `Réponse inattendue du projet (HTTP ${response.status}).`,
      );
    }
    return { data: json?.data ?? null, contractVersion, status: response.status };
  }

  // -- identity --------------------------------------------------------------
  getIdentity() {
    return this.#request('GET', PROJECT_API_ROUTES.identity);
  }

  getHealth() {
    return this.#request('GET', PROJECT_API_ROUTES.health);
  }

  // Manifeste officiel du projet (contrat ≥ 1.1.0) — relisible à tout moment.
  getManifest() {
    return this.#request('GET', PROJECT_API_ROUTES.manifest);
  }

  // -- sync ------------------------------------------------------------------
  deliverChanges(changes) {
    return this.#request('POST', PROJECT_API_ROUTES.syncPush, { body: { changes } });
  }

  readLocalChanges({ cursor, limit } = {}) {
    return this.#request('GET', PROJECT_API_ROUTES.syncPull, { query: { cursor, limit } });
  }

  // -- operations ------------------------------------------------------------
  listOperations() {
    return this.#request('GET', PROJECT_API_ROUTES.operations);
  }

  invokeOperation(operationId, { invocationId, params }) {
    const path = PROJECT_API_ROUTES.operationInvoke.replace(
      '{operationId}',
      encodeURIComponent(operationId),
    );
    return this.#request('POST', path, { body: { invocationId, params } });
  }

  // -- pairing ---------------------------------------------------------------
  /**
   * Récupère un document du projet — flux BINAIRE, pas du JSON.
   *
   * Le chemin vient de la projection (`document.downloadPath`) : c'est le
   * projet qui dit où aller le chercher, jamais le Panel qui le devine.
   */
  async fetchDocument(path) {
    const url = new URL(path, this.baseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
          authorization: `Bearer ${this.bridgeToken}`,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  notifyUnpair() {
    return this.#request('POST', PROJECT_API_ROUTES.unpair, { body: {} });
  }
}

export default ProjectBridgeClient;
