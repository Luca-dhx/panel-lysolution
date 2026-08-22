import type {
  AccessibleProject,
  ContractAction,
  ContractOperation,
  ContractProtection,
  PanelUser,
  OwnProfile,
  PanelUserCreated,
  PanelUserRow,
  PanelVersion,
  ProjectAccountsRead,
  ProjectAccessMode,
  Role,
  PublicProject,
} from '@/types';
import type {
  Dashboard, FleetResult, ProjectOverview, ProjectTechnical,
  HeartbeatRow, HeartbeatStats, SearchFacets, TimelineEvent,
} from '@/types.supervision';
import type { FleetDiagnostic, ProjectDiagnostic } from '@/types.diagnostic';
import type { Meeting, MeetingScope, ProjectEvent, ProjectEventsSummary } from '@/types.events';
import type { PanelTheme } from '@/lib/useTheme';
import type { EmailSenderScreen, EmailSenderTestReport } from '@/types.emailSender';
import type {
  EmailTemplateDetail,
  EmailTemplatePreview,
  EmailTemplateReadiness,
  EmailTemplateScope,
  EmailTemplateScopeRef,
  EmailTemplateSummary,
  EmailTemplateTestSendResult,
  EmailTemplateVersionDetail,
  EmailTemplateVersionSummary,
} from '@/types.emailTemplates';
import type { ProjectDestination, ProjectDestinationsByEnvironment } from '@/types';
import type {
  ActionDescriptor, ActionPreparation, Execution, ExecutionRow, ExecutionStats,
} from '@/types.execution';
import type {
  Company, CompanyState, IntegratedApi, MediaDescriptor, ProbeResult, PublishResult, StoredMediaDescriptor,
  VersionDetail, VersionRow,  SaveResult,
} from '@/types.company';
import type {
  CapabilityView,
  CredentialSetView, IntegratedApiEnvironment, ProviderAvailability, ProviderView,
  ValidatedCredentialSet, WebhookStateView,
} from '@/types.integratedApi';
import type {
  DeploymentOverview, DeploymentReadiness, DeploymentRun, DeploymentTarget,
  DestinationInspection, PanelSelfInfo,
  ReleaseList, RunRow, StartedOperation, TargetDetail,
  DeployStreamEvent,
} from '@/types.deployment';
import type {
  ClientCompanyDetail,
  ClientCompanyLinkResult,
  ClientCompanyRow,
  ClientCompanySaveResult,
} from '@/types.clientCompany';
import type {
  BulkDeleteResult, BulkScopePreview, FinanceCriteria, FinanceListResult, FinanceProjectLine,
  FinanceScope, FinanceSummary, FinancialTransaction, ManualTransactionInput,
  ProviderFact, RecurringCost, RecurringCostInput, RecurringCostPatch, RecurringStopMode,
  RefundEligibility, RefundOutcome, RefundRequest, StripeRefundReason,
  PaymentRequest, PaymentRequestInput, PaymentDefaultsView, PaymentDefaultRetryResult,
} from '@/types.finance';

const TOKEN_KEY = 'panel_token';

export const tokenStore = {
  get(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
  },
};

/**
 * ══ LA TAXONOMIE DES ÉCHECS — UNE SEULE, ET ELLE DÉCIDE DU LOGOUT ═══════════
 *
 * Avant elle, le client ne connaissait que deux situations : « 401 » et « le
 * reste ». Un backend qui redémarre, une base momentanément injoignable, une
 * passerelle qui répond 502, un `fetch` qui rejette : tout tombait dans « le
 * reste », et l'appelant — au premier rang duquel `AuthContext` — traitait ce
 * fourre-tout comme une session perdue.
 *
 * Chaque famille appelle une conduite DIFFÉRENTE, et c'est tout l'objet de ce
 * type :
 *
 *   AUTH_INVALID         la session est PROUVÉE invalide → et seulement là,
 *                        on efface le jeton ;
 *   FORBIDDEN            authentifié, mais pas autorisé — la session est bonne ;
 *   SERVICE_UNAVAILABLE  le service démarre, s'arrête, ou sa base est absente ;
 *   SERVER_ERROR         le serveur a répondu, et sa réponse est un bogue ;
 *   NETWORK_ERROR        aucune réponse n'est jamais arrivée ;
 *   TIMEOUT             la réponse n'est pas arrivée à temps ;
 *   RATE_LIMITED         la demande était valable, mais trop fréquente ;
 *   CLIENT_ERROR         la demande était mal formée ou refusée sur le fond.
 *
 * Aucune de ces familles, sauf la première, ne peut déconnecter qui que ce soit.
 */
export type ApiFailureKind =
  | 'AUTH_INVALID'
  | 'FORBIDDEN'
  | 'SERVICE_UNAVAILABLE'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'CLIENT_ERROR';

/**
 * Réseau injoignable : aucune réponse n'a jamais été reçue.
 *
 * NON exporté, délibérément. Un consommateur n'a jamais besoin de comparer un
 * statut brut : `isOffline()` répond à la même question sans exposer le codage.
 * L'exporter créerait une seconde façon de poser la question, et c'est
 * exactement ainsi qu'une politique d'erreurs se met à diverger d'un écran à
 * l'autre.
 */
const OFFLINE_STATUS = 0;

/**
 * Les codes métier par lesquels le backend annonce une indisponibilité
 * TEMPORAIRE. Ils accompagnent un 503 et disent explicitement que la session
 * reste valide — c'est ce qui permet d'afficher « ça revient » plutôt que
 * « reconnectez-vous ».
 */
const CODES_INDISPONIBILITE = new Set([
  'PANEL_SERVICE_STARTING',
  'PANEL_SERVICE_STOPPING',
  'PANEL_DATABASE_UNAVAILABLE',
]);

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  /** La famille d'échec — à préférer TOUJOURS au statut brut. */
  readonly kind: ApiFailureKind;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: unknown,
    kind?: ApiFailureKind,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.kind = kind ?? classifyFailure(status, code);
  }

  /**
   * Réessayer À L'IDENTIQUE peut-il aboutir ?
   *
   * Vrai uniquement pour ce qui est transitoire par nature. Un 400, un 403 ou
   * un 409 métier donneront exactement le même refus au second essai : les
   * réessayer ne fait que retarder le message que l'utilisateur doit lire.
   */
  get retryable(): boolean {
    return this.kind === 'SERVICE_UNAVAILABLE'
      || this.kind === 'NETWORK_ERROR'
      || this.kind === 'TIMEOUT';
  }

  /**
   * Cette erreur prouve-t-elle que la session n'est plus valable ?
   *
   * C'est la SEULE question dont la réponse autorise à effacer le jeton. Elle
   * n'est jamais vraie pour une panne : une panne n'a aucune opinion sur une
   * identité, elle n'a simplement pas pu la vérifier.
   */
  get provesSessionInvalid(): boolean {
    return this.kind === 'AUTH_INVALID';
  }
}

/**
 * Le statut HTTP et le code métier décident ensemble — dans cet ordre de
 * précision : le CODE l'emporte quand il existe, parce qu'il en sait plus.
 *
 * `AUTH_INVALID` n'est PAS attribué ici sur la seule foi d'un 401 : la fonction
 * rend `CLIENT_ERROR` pour un 401 non confirmé, et c'est `request()` qui
 * promeut en `AUTH_INVALID` après vérification auprès de `/api/auth/me`. Un 401
 * peut parler d'autre chose que de notre session — un code d'appairage refusé,
 * par exemple — et le croire sur parole déconnectait sur une faute de frappe.
 */
function classifyFailure(status: number, code?: string): ApiFailureKind {
  if (code && CODES_INDISPONIBILITE.has(code)) return 'SERVICE_UNAVAILABLE';
  if (status === OFFLINE_STATUS) return 'NETWORK_ERROR';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 502 || status === 503) return 'SERVICE_UNAVAILABLE';
  if (status === 403) return 'FORBIDDEN';
  if (status >= 500) return 'SERVER_ERROR';
  /**
   * 429 N'EST PAS UN REFUS SUR LE FOND.
   *
   * La demande était recevable ; c'est sa FRÉQUENCE qui a été refusée. La
   * ranger dans CLIENT_ERROR ferait dire aux écrans « votre demande est
   * invalide » là où la bonne phrase est « réessayez plus tard » — et, sur
   * un écran de connexion, cela reviendrait à accuser un mot de passe qui
   * était peut-être le bon.
   */
  if (status === 429) return 'RATE_LIMITED';
  return 'CLIENT_ERROR';
}

/** Vrai si le serveur n'a jamais répondu — à distinguer d'une réponse en erreur. */
export function isOffline(err: unknown): boolean {
  return err instanceof ApiError && err.kind === 'NETWORK_ERROR';
}

/**
 * Vrai si le service est momentanément hors d'état de répondre — démarrage,
 * arrêt, base absente, passerelle sans amont. L'écran doit alors ATTENDRE.
 */
export function isServiceUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.kind === 'SERVICE_UNAVAILABLE';
}

/**
 * Vrai si le serveur a refusé pour cause de FRÉQUENCE, pas de contenu.
 *
 * Volontairement NON `retryable` : le réessai automatique de `request()`
 * relancerait la requête dans la seconde, ce qui ne peut qu'échouer — et
 * surtout consommerait une tentative de plus dans le seau. Attendre est le
 * geste de l'utilisateur, pas celui du client HTTP.
 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.kind === 'RATE_LIMITED';
}

/**
 * Le délai annoncé par le serveur, en secondes, ou `null` s'il n'en a annoncé
 * aucun. Lu dans `details` — jamais deviné côté client : un client qui
 * invente une durée finit toujours par la sous-estimer.
 */
export function retryAfterSeconds(err: unknown): number | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details as { retryAfterSeconds?: unknown } | null | undefined;
  const valeur = Number(details?.retryAfterSeconds);
  return Number.isFinite(valeur) && valeur > 0 ? valeur : null;
}

/**
 * ── TROP DE TENTATIVES : LE DIRE, ET DIRE COMBIEN DE TEMPS ────────────────
 *
 * La durée est arrondie à la minute SUPÉRIEURE. Annoncer « dans 47 secondes »
 * invite à compter, et un compte à rebours à la seconde est exactement ce
 * qu'un script automatise ; pour un humain, la minute suffit.
 *
 * Cette phrase n'apprend RIEN sur le compte : ni s'il existe, ni combien de
 * tentatives restent, ni si le mot de passe était proche.
 */
export function messageTropDeTentatives(secondes: number | null): string {
  const base = 'Trop de tentatives. Votre compte n’est pas bloqué.';
  if (!secondes) return base + ' Réessayez dans quelques minutes.';
  const minutes = Math.max(1, Math.ceil(secondes / 60));
  return base + ' Réessayez dans ' + minutes + ' minute' + (minutes > 1 ? 's' : '') + '.';
}

/** Vrai si l'erreur PROUVE que la session est invalide. Rien d'autre ne le prouve. */
export function provesSessionInvalid(err: unknown): boolean {
  return err instanceof ApiError && err.provesSessionInvalid;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  code?: string;
  message?: string;
  details?: unknown;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /**
   * Renvoyer au login quand la session est PROUVÉE invalide.
   *
   * Le nom a gardé sa forme historique, mais sa portée a changé : la
   * redirection n'a plus lieu sur un 401 quelconque, seulement sur un 401
   * confirmé par `/api/auth/me`. Mettre `false` conserve l'exception, sans la
   * redirection — ce dont `me()` a besoin pour laisser `AuthContext` décider.
   */
  redirectOnUnauthorized?: boolean;
  /** Nombre de tentatives supplémentaires sur erreur TRANSITOIRE. */
  retries?: number;
  /** Délai maximal d'une tentative. Au-delà : `TIMEOUT`, jamais un blocage. */
  timeoutMs?: number;
}

/**
 * IMPORT D'UNE IMAGE — multipart, donc hors du chemin JSON habituel.
 *
 * Le `Content-Type` n'est PAS posé à la main : le navigateur doit y écrire la
 * frontière du multipart, et l'imposer rendrait le corps illisible au serveur.
 * La réponse porte un chemin relatif (`/uploads/…`) ; c'est le Panel qui le
 * rendra absolu au moment de publier aux projets.
 */
export async function uploadImage(
  file: File,
  prefix = 'img',
  /**
   * RÔLE MÉTIER du média — logo, favicon, portrait d'équipe.
   *
   * Il n'est pas déduit du préfixe : un préfixe nomme un fichier, il ne dit
   * pas ce que l'image représente. Le descripteur publié aux projets porte ce
   * rôle, et c'est lui qu'ils lisent pour savoir quoi afficher où.
   */
  role?: string,
): Promise<{
  /** Chemin de stockage RELATIF — c'est lui que la fiche conserve. */
  url: string;
  /**
   * L'adresse UTILISABLE MAINTENANT : absolue si une destination sert déjà ce
   * média, sinon locale. Elle sert l'aperçu, jamais l'identité — et n'est donc
   * jamais enregistrée telle quelle.
   */
  publicUrl: string;
  /**
   * LE DESCRIPTEUR STABLE — la source de vérité de la fiche. Aucune adresse :
   * l'identité d'un média ne dépend pas du domaine courant.
   */
  descriptor: StoredMediaDescriptor;
  filename: string;
  media?: MediaDescriptor;
}> {
  const form = new FormData();
  form.append('file', file);

  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  const query = new URLSearchParams({ prefix });
  if (role) query.set('role', role);

  let res: Response;
  try {
    res = await fetch(`/api/uploads/image?${query.toString()}`, {
      method: 'POST',
      headers,
      body: form,
    });
  } catch {
    throw new ApiError(0, 'Impossible de contacter le serveur du Panel.');
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      payload?.error?.message || payload?.message || "L'image n'a pas pu être importée.",
    );
  }
  // Une autorité média antérieure ne rend ni `publicUrl` ni `descriptor` : on
  // retombe alors sur le chemin de stockage, qui a toujours été rendu. Aucun
  // `undefined` ne traverse l'écran, où il se confondrait avec « pas encore lu ».
  const brut = payload as {
    url: string; filename: string; publicUrl?: string;
    descriptor?: StoredMediaDescriptor; media?: MediaDescriptor;
  };
  return {
    ...brut,
    publicUrl: brut.publicUrl ?? brut.url,
    descriptor: brut.descriptor ?? { objectKey: brut.filename },
  };
}

/**
 * UNE SEULE REDIRECTION VERS /login PAR CHARGEMENT DE PAGE.
 *
 * Sans ce verrou, une rafale de requêtes qui échouent ensemble assignerait
 * `location` autant de fois qu'il y a de requêtes — chaque assignation annulant
 * les `fetch` en vol, ce qui amplifie la cascade au lieu de la calmer.
 */
let redirectionEnCours = false;

/**
 * ══ SEUL `/api/auth/me` FAIT AUTORITÉ SUR LA VALIDITÉ D'UNE SESSION ═════════
 *
 * ── CE QUI ARRIVAIT ─────────────────────────────────────────────────────────
 *
 * Toute réponse 401 valait « votre session a expiré » : jeton effacé,
 * redirection immédiate. Or un 401 ne parle pas forcément de NOTRE session — le
 * contrat du pont, par exemple, refuse un code d'appairage invalide avec ce
 * même statut. Une faute de frappe déconnectait l'utilisateur.
 *
 * ── LA VÉRIFICATION EST À VOL UNIQUE ────────────────────────────────────────
 *
 * Quand plusieurs requêtes reçoivent un 401 en même temps — ce qui est le cas
 * normal d'un écran qui charge six panneaux — elles ne déclenchent qu'UNE
 * vérification. Les autres attendent son verdict. Sans cela, six requêtes de
 * contrôle partiraient de front vers un backend déjà en difficulté, et leurs
 * verdicts pourraient diverger.
 *
 * ── UNE PANNE PENDANT LA VÉRIFICATION NE DÉCONNECTE PAS ─────────────────────
 *
 * Si le contrôle lui-même n'aboutit pas, on rend `false` : « je n'ai pas pu
 * vérifier » n'est pas « c'est invalide ». C'est exactement la confusion que
 * tout ce module existe pour supprimer.
 */
let verificationEnVol: Promise<boolean> | null = null;

async function sessionProuveeInvalide(path: string, token: string): Promise<boolean> {
  // Le contrôle EST `/api/auth/me` : le refaire depuis lui tournerait en rond.
  if (path.startsWith('/api/auth/me')) return true;
  // La connexion elle-même refuse des identifiants, pas une session.
  if (path.startsWith('/api/auth/login')) return false;

  if (!verificationEnVol) {
    verificationEnVol = (async () => {
      try {
        const controle = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        return controle.status === 401;
      } catch {
        // « Je n'ai pas pu vérifier » n'est pas « c'est invalide ». C'est la
        // confusion que tout ce module existe pour supprimer.
        return false;
      } finally {
        /**
         * LIBÉRÉ DÈS QUE LE VERDICT EST RENDU — et surtout pas plus tard.
         *
         * ── LE DÉFAUT QU'UNE LIBÉRATION DIFFÉRÉE INTRODUISAIT ───────────────
         * Une version antérieure relâchait ce verrou par un `setTimeout(…, 0)`.
         * Or `await` ne franchit que la file des microtâches : deux requêtes
         * successives peuvent parfaitement s'enchaîner sans qu'aucun minuteur
         * n'ait eu l'occasion de s'exécuter. La seconde réutilisait alors le
         * verdict de la première — y compris un « session invalide » rendu pour
         * une requête sans aucun rapport.
         *
         * Vider ici fait exactement ce qu'un verrou à vol unique doit faire :
         * les appelants CONCURRENTS partagent la promesse déjà en vol ; tout
         * appelant postérieur au verdict revérifie. Un verdict n'est jamais
         * réutilisé au-delà de la rafale qui l'a provoqué.
         */
        verificationEnVol = null;
      }
    })();
  }
  return verificationEnVol;
}

/** Attente courte entre deux tentatives — bornée, jamais infinie. */
const PALIERS_ATTENTE_MS = [250, 500, 1000, 2000];

function patienter(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Une TENTATIVE — sans réessai, sans décision d'authentification.
 *
 * Isolée pour que la politique de réessai, au-dessus, n'ait à connaître que
 * des `ApiError` déjà classées.
 */
async function tenter<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  let bodyInit: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(options.body);
  }

  /**
   * UN DÉLAI MAXIMAL, TOUJOURS.
   *
   * Un `fetch` sans borne peut attendre indéfiniment quand un proxy garde la
   * connexion ouverte sans jamais répondre — l'interface reste alors sur un
   * chargement que rien ne conclut. Une borne transforme cette attente en un
   * échec NOMMÉ, donc réessayable.
   */
  const delai = options.timeoutMs ?? 30_000;
  const minuteur = new AbortController();
  const echeance = setTimeout(() => minuteur.abort(), delai);

  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: bodyInit,
      signal: minuteur.signal,
    });
  } catch (err) {
    // `abort` déclenché par NOTRE minuteur : c'est un dépassement de délai, pas
    // une absence de réseau. Les confondre ferait afficher « serveur éteint »
    // pour un serveur simplement lent.
    if ((err as Error)?.name === 'AbortError') {
      throw new ApiError(
        408,
        'Le serveur du Panel n’a pas répondu à temps.',
        'PANEL_REQUEST_TIMEOUT',
        undefined,
        'TIMEOUT',
      );
    }
    throw new ApiError(
      OFFLINE_STATUS,
      'Impossible de contacter le serveur du Panel.',
      'PANEL_BACKEND_UNREACHABLE',
      undefined,
      'NETWORK_ERROR',
    );
  } finally {
    clearTimeout(echeance);
  }

  let payload: Envelope<T> | null = null;
  try {
    payload = (await res.json()) as Envelope<T>;
  } catch {
    // Corps non-JSON : c'est la signature d'une page d'erreur de proxy (nginx
    // rend du HTML sur 502/504). L'absence de corps n'est PAS une erreur
    // applicative — le classement se fera sur le seul statut.
    payload = null;
  }

  if (!res.ok || !payload || payload.success !== true) {
    throw new ApiError(
      res.status,
      payload?.message ?? messageParDefaut(res.status),
      payload?.code,
      payload?.details,
    );
  }

  return payload.data as T;
}

/** Ce qu'on dit quand le serveur n'a rien dit — sans jamais accuser la session. */
function messageParDefaut(status: number): string {
  if (status === 502 || status === 503) {
    return 'Service momentanément indisponible. Votre session reste valide.';
  }
  if (status === 504) return 'Le serveur du Panel n’a pas répondu à temps.';
  if (status >= 500) return 'Le serveur a répondu par une erreur interne.';
  return `Erreur HTTP ${status}`;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  /**
   * RÉESSAI BORNÉ, ET SUR LES SEULES ERREURS TRANSITOIRES.
   *
   * Par défaut, seules les LECTURES sont réessayées : rejouer un POST déjà reçu
   * mais dont la réponse s'est perdue créerait un doublon — un second
   * déploiement, une seconde facture. Une écriture qui veut être réessayée doit
   * le demander explicitement, en connaissance de son idempotence.
   */
  const methode = (options.method ?? 'GET').toUpperCase();
  const essaisMax = options.retries ?? (methode === 'GET' ? PALIERS_ATTENTE_MS.length : 0);

  let derniere: ApiError | null = null;
  for (let tentative = 0; tentative <= essaisMax; tentative += 1) {
    try {
      return await tenter<T>(path, options);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      derniere = err;

      /**
       * LE 401 EST LE SEUL CAS OÙ L'ON INTERROGE L'AUTORITÉ.
       *
       * Et le verdict ne change QUE la classification. Aucun autre statut ne
       * peut produire `AUTH_INVALID`, donc aucun autre statut ne peut effacer
       * un jeton — c'est l'invariant que ce lot installe.
       */
      if (err.status === 401) {
        const token = tokenStore.get();
        const invalide = token ? await sessionProuveeInvalide(path, token) : false;
        if (!invalide) {
          // 401 qui ne parle pas de notre session : on le remonte tel quel,
          // sans toucher au jeton et sans rediriger.
          throw new ApiError(401, err.message, err.code, err.details, 'CLIENT_ERROR');
        }
        tokenStore.clear();
        if (
          options.redirectOnUnauthorized !== false
          && !redirectionEnCours
          && window.location.pathname !== '/login'
        ) {
          redirectionEnCours = true;
          window.location.assign('/login');
        }
        throw new ApiError(
          401,
          err.message || 'Session expirée. Veuillez vous reconnecter.',
          err.code,
          err.details,
          'AUTH_INVALID',
        );
      }

      const reste = tentative < essaisMax;
      if (!err.retryable || !reste) throw err;
      await patienter(PALIERS_ATTENTE_MS[Math.min(tentative, PALIERS_ATTENTE_MS.length - 1)]);
    }
  }
  // Inatteignable : la boucle rend ou lève. Présent pour que le type soit total.
  throw derniere ?? new ApiError(0, 'Requête impossible.');
}

/**
 * LA PORTÉE D'UN MODÈLE, SÉRIALISÉE — un seul endroit, et c'est délibéré.
 *
 * Le serveur REFUSE tout champ de portée trouvé dans un corps de requête : la
 * faille corrigée par L11.1 était exactement cela, un `PUT` portant
 * `{"projectId":"…"}` qui créait un document invisible de l'IHM et pourtant
 * servi en production. Concentrer la sérialisation ici garantit qu'aucun appel
 * ne peut, par distraction, remettre la portée dans le corps.
 *
 * Portée absente ⇒ aucun paramètre ⇒ le serveur retient PANEL. C'est le défaut
 * sûr : le contenu de L.Y Solution, jamais celui d'un client.
 */
function scopeQuery(scope?: EmailTemplateScopeRef): string {
  if (!scope || scope.scopeType === 'PANEL') return '';
  const params = new URLSearchParams({ scope: 'PROJECT', projectId: scope.scopeId });
  return `?${params.toString()}`;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: PanelUser }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    }),

  forgotPassword: (email: string) =>
    request<{ accepted: boolean; message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: { email },
    }),

  resetPassword: (token: string, password: string, passwordConfirmation: string) =>
    request<{ reset: boolean }>('/api/auth/reset-password', {
      method: 'POST',
      body: { token, password, passwordConfirmation },
    }),

  me: () => request<{ user: PanelUser }>('/api/auth/me', { redirectOnUnauthorized: false }),

  version: () => request<PanelVersion>('/api/version'),

  listProjects: () => request<{ projects: PublicProject[] }>('/api/projects'),

  /**
   * DÉCLARE un projet à partir de son adresse. Aucune clé n'est transmise :
   * l'identifiant technique est généré par le serveur, à partir de l'identité
   * que le projet annonce lui-même. Le client ne le choisit jamais.
   */
  createProject: (body: {
    url: string;
    projectName?: string;
    /**
     * L'ENVIRONNEMENT VISÉ — transmis quand l'écran le connaît déjà.
     *
     * Un raccourci « appairer la production » sait ce qu'il crée : le
     * redemander à l'utilisateur serait lui faire ressaisir une information
     * qu'on tient. Omis, le comportement reste celui d'avant.
     */
    environment?: 'TEST' | 'PROD';
  }) =>
    request<{ project: PublicProject; pairingCode: string; pairingCodeExpiresAt: string }>(
      '/api/projects',
      { method: 'POST', body },
    ),

  getProject: (projectId: string) =>
    request<{ project: PublicProject; destinations: ProjectDestinationsByEnvironment }>(
      `/api/projects/${projectId}`,
    ),

  /* ── DESTINATIONS D'UN PROJET ─────────────────────────────────────────────
     DEUX actions, et deux seulement. Le Panel ne déploie pas, ne redéploie pas
     et ne migre pas : c'est le projet qui annonce son déménagement depuis son
     propre poste. Ne jamais ajouter ici de « déployer » ou de « basculer ». */

  /** L'opérateur constate qu'il ne reste rien sur le serveur d'une destination RETIRÉE. */
  markDestinationEmpty: (destinationId: string) =>
    request<ProjectDestination>(`/api/projects/destinations/${destinationId}/empty`, {
      method: 'POST',
    }),

  /** Retire la fiche des listes. Audit et historique conservés. */
  deleteDestination: (destinationId: string) =>
    request<ProjectDestination>(`/api/projects/destinations/${destinationId}`, {
      method: 'DELETE',
    }),

  /* ── CONTRAT — le Panel DEMANDE, le projet décide ────────────────────── */
  getContractOperations: (projectId: string) =>
    request<{
      operations: ContractOperation[];
      reachable: boolean;
      environment: string | null;
      history: ContractAction[];
      /**
       * État LU sur le projet, jamais une copie du Panel — `null` si le projet
       * ne répond pas ou ne connaît pas encore ce réglage.
       */
      contractProtection: ContractProtection | null;
    }>(`/api/projects/${projectId}/contract/operations`),

  /**
   * Règle la protection contractuelle. Rend l'état CONSTATÉ par le projet
   * après réconciliation — pas la valeur demandée.
   */
  setContractProtection: (projectId: string, enabled: boolean) =>
    request<{ action: ContractAction; contractProtection: ContractProtection | null }>(
      `/api/projects/${projectId}/contract/protection`,
      { method: 'POST', body: { enabled } },
    ),

  cancelContract: (projectId: string, operationId: string, reason?: string) =>
    request<{ action: ContractAction }>(`/api/projects/${projectId}/contract/cancel`, {
      method: 'POST',
      body: { operationId, ...(reason ? { reason } : {}) },
    }),

  /**
   * Télécharge le document contractuel.
   *
   * Un simple lien ne suffirait pas : la route exige le jeton du Panel, et un
   * `<a href>` ne porte aucun en-tête. On récupère donc le flux, puis on
   * déclenche l'enregistrement — le fichier ne fait que passer.
   *
   * ── CE QUI NE MARCHAIT PAS ────────────────────────────────────────────
   * Le lien était créé mais JAMAIS inséré dans le document, et l'URL objet
   * révoquée dans la foulée du clic. Firefox ignore le clic d'un lien absent
   * du document ; et révoquer avant que le navigateur ne se soit emparé du
   * flux annule un téléchargement qui n'a pas encore commencé. Le clic
   * paraissait sans effet, sans la moindre erreur.
   *
   * Une réponse d'erreur lue en `blob()` produisait par ailleurs un « PDF »
   * de trois lignes de JSON : on vérifie donc que c'est bien un fichier.
   */
  async downloadContractDocument(projectId: string, filename: string): Promise<void> {
    const token = tokenStore.get();
    const res = await fetch(`/api/projects/${projectId}/contract/document`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const corps = await res.json().catch(() => null);
      throw new ApiError(
        res.status,
        corps?.message ?? 'Le document n’a pas pu être récupéré.',
        corps?.code,
      );
    }
    const type = res.headers.get('content-type') ?? '';
    if (/application\/json|text\/html/i.test(type)) {
      const corps = await res.json().catch(() => null);
      throw new ApiError(res.status, corps?.message ?? 'Le serveur n’a pas renvoyé de fichier.');
    }

    // Le nom vient du serveur quand il le donne : c'est lui qui sait s'il rend
    // l'original ou le signé.
    const disposition = res.headers.get('content-disposition') ?? '';
    const trouve = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);

    const blob = await res.blob();
    if (blob.size === 0) throw new ApiError(502, 'Le document reçu est vide.');

    const url = URL.createObjectURL(blob);
    const lien = document.createElement('a');
    lien.href = url;
    lien.download = trouve ? decodeURIComponent(trouve[1].trim()) : (filename || 'contrat.pdf');
    lien.rel = 'noopener';
    lien.style.display = 'none';
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    // Après le clic, jamais avant.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  },

  /* ── EXPÉDITEUR E-MAIL GLOBAL (R10.4) ────────────────────────────────── */
  /**
   * Une seule surface pour l'expéditeur de TOUT le parc. Aucune variante par
   * projet : c'est l'invariant du lot, et l'absence d'une seconde méthode ici
   * est la façon la plus simple de ne pas le trahir.
   */
  getEmailSender: () => request<EmailSenderScreen>('/api/email-sender'),
  saveEmailSender: (body: { senderEmail: string; senderName: string }) =>
    request<EmailSenderScreen>('/api/email-sender', { method: 'PUT', body }),
  /**
   * L'ADRESSE DE CONTACT PUBLIC — même écran, autre autorité.
   *
   * Elle est écrite dans l'entreprise du Panel, puis publiée aux projets par le
   * canal existant. Une chaîne vide efface l'adresse : c'est une intention
   * légitime, et le backend la normalise en `null`.
   */
  savePublicContactEmail: (publicContactEmail: string) =>
    request<EmailSenderScreen>('/api/email-sender/public-contact', {
      method: 'PUT',
      body: { publicContactEmail },
    }),
  /** ENVOIE un e-mail réel. À ne jamais appeler pour rafraîchir un écran. */
  sendEmailSenderTest: (recipientEmail: string) =>
    request<EmailSenderTestReport>('/api/email-sender/test', {
      method: 'POST',
      body: { recipientEmail },
    }),
  /** RELIT un test — c'est ce qui permet d'attendre le webhook sans renvoyer. */
  readEmailSenderTest: (testId: string) =>
    request<EmailSenderTestReport>(`/api/email-sender/test/${testId}`),

  /* ── MODÈLES E-MAIL — SCOPÉS (L11.1) ─────────────────────────────────────
   *
   * La portée voyage en QUERY, jamais dans le corps : le serveur refuse tout
   * champ de portée trouvé dans un corps (`PANEL_EMAIL_TEMPLATE_SCOPE_IN_BODY`).
   * Ce n'est pas une contrainte de style — c'est la correction d'une faille où
   * un `PUT` portant `{"projectId":"…"}` créait un document invisible de l'IHM
   * et pourtant servi en production.
   *
   * `scopeQuery()` est le SEUL endroit du client qui sérialise une portée.
   */
  /* ── COMPTES DU PANEL ET ACCÈS AUX PROJETS (L12.B-F) ─────────────────────
   *
   * Le frontend ne constitue JAMAIS l'autorité : il envoie un mode et, en
   * EXPLICIT, une liste d'identifiants. Le serveur vérifie chacun contre le
   * registre, refuse les inconnus et les non appairés, et écarte lui-même la
   * liste dans les modes où elle n'est pas lue.
   */
  /**
   * SON PROPRE PROFIL — aucune identité n'est transmise : le serveur lit la
   * session. Il n'existe aucun paramètre par lequel désigner quelqu'un d'autre.
   */
  getOwnProfile: () => request<OwnProfile>('/api/panel-users/me'),
  /**
   * Un seul champ, et c'est volontaire : le serveur REFUSE tout le reste
   * (`PANEL_USER_SELF_FORBIDDEN_FIELD`). Élargir ce type sans élargir la
   * doctrine produirait un écran qui promet ce que l'API refuse.
   */
  updateOwnProfile: (data: { displayName: string }) =>
    request<PanelUser>('/api/panel-users/me', { method: 'PATCH', body: data }),

  /**
   * LES COMPTES D'UN PROJET — lecture VIVANTE chez l'autorité voisine.
   *
   * `retries: 0` : ce n'est pas une lecture idempotente bon marché, c'est un
   * aller-retour vers un autre service. Le réessai automatique masquerait une
   * indisponibilité que l'écran doit justement annoncer.
   */
  getProjectAccounts: (projectId: string) =>
    request<ProjectAccountsRead>(`/api/projects/${projectId}/accounts`, { retries: 0 }),

  listPanelUsers: () => request<PanelUserRow[]>('/api/panel-users'),
  listAccessibleProjects: () => request<AccessibleProject[]>('/api/panel-users/projects'),

  /* ── ADMINISTRATION DES COMPTES — SUPER_ADMIN, côté serveur ───────────────
   *
   * ══ UN SEUL `PATCH`, ET NON UNE ROUTE PAR CHAMP ═══════════════════════════
   *
   * `setPanelUserEnabled` et `setPanelUserProjectAccess` ont disparu. Deux
   * appels pour une seule décision d'opérateur, c'était deux événements
   * d'audit et un état intermédiaire observable — un compte réactivé une
   * demi-seconde avant de recevoir ses accès. Le serveur accepte les quatre
   * champs ensemble, et n'accepte QUE ceux-là.
   *
   * AUCUN MOT DE PASSE NE TRANSITE PAR CES APPELS. La création n'en demande
   * pas ; la prise de possession passe par le lien d'activation.
   */
  createPanelUser: (data: { email: string; displayName: string; role: Role }) =>
    request<PanelUserCreated>('/api/panel-users', { method: 'POST', body: data }),
  updatePanelUser: (
    userId: string,
    data: {
      displayName?: string;
      role?: Role;
      enabled?: boolean;
      projectAccess?: { mode: ProjectAccessMode; projectIds?: string[] };
    },
  ) => request<PanelUserRow & { changed: string[] }>(`/api/panel-users/${userId}`, {
    method: 'PATCH',
    body: data,
  }),
  deletePanelUser: (userId: string) =>
    request<{ userId: string; email: string; deleted: boolean; selfDeletion: boolean }>(
      `/api/panel-users/${userId}`,
      { method: 'DELETE' },
    ),
  /** (Re)déclenche le lien d'activation. Ne rend jamais le jeton, ni le lien. */
  sendPanelUserInvitation: (userId: string) =>
    request<{ userId: string; email: string; invitation: { sent: boolean; code: string | null } }>(
      `/api/panel-users/${userId}/invitation`,
      { method: 'POST' },
    ),

  /* ── FÉDÉRATION D'IDENTITÉ (L12.B-UI) ────────────────────────────────────
   *
   * `returnUrl` est envoyé au SERVEUR pour qu'il le valide contre les origines
   * qu'il connaît pour ce projet — jamais pour qu'il l'utilise tel quel. Le
   * serveur rend une adresse RECOMPOSÉE, et c'est celle-là qu'on suit.
   *
   * `state` est transmis pour le journal : il permettra de rapprocher une
   * émission d'une consommation. Il ne décide de rien côté Panel — c'est le
   * PROJET qui l'a émis et qui le vérifiera.
   */
  issueFederationAssertion: (projectId: string, data: { returnUrl: string; state: string }) =>
    request<{
      assertion: string;
      returnUrl: string | null;
      audience: string;
      issuer: string;
      expiresAt: string;
      kid: string;
      jti: string;
    }>(`/api/federation/projects/${projectId}/assertion`, {
      method: 'POST',
      body: data,
    }),

  listEmailTemplateScopes: () =>
    request<EmailTemplateScope[]>('/api/email-templates/scopes'),
  listEmailTemplates: (scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateSummary[]>(`/api/email-templates${scopeQuery(scope)}`),
  getEmailTemplate: (templateId: string, scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateDetail>(`/api/email-templates/${templateId}${scopeQuery(scope)}`),
  updateEmailTemplate: (templateId: string, data: {
    name?: string;
    description?: string;
    subject?: string;
    html?: string;
    enabled?: boolean;
    expectedVersion: number;
  }, scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateDetail>(`/api/email-templates/${templateId}${scopeQuery(scope)}`, {
      method: 'PUT',
      body: data,
    }),
  previewEmailTemplate: (
    templateId: string,
    draft?: { subject?: string; html?: string },
    scope?: EmailTemplateScopeRef,
  ) =>
    request<EmailTemplatePreview>(`/api/email-templates/${templateId}/preview${scopeQuery(scope)}`, {
      method: 'POST',
      body: draft ?? {},
    }),
  getEmailTemplateReadiness: (templateId: string, scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateReadiness>(`/api/email-templates/${templateId}/readiness${scopeQuery(scope)}`),
  sendEmailTemplateTest: (templateId: string, recipientEmail: string, scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateTestSendResult>(`/api/email-templates/${templateId}/test-send${scopeQuery(scope)}`, {
      method: 'POST',
      body: { recipientEmail },
    }),
  listEmailTemplateVersions: (templateId: string, scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateVersionSummary[]>(`/api/email-templates/${templateId}/versions${scopeQuery(scope)}`),
  getEmailTemplateVersion: (templateId: string, version: number, scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateVersionDetail>(`/api/email-templates/${templateId}/versions/${version}${scopeQuery(scope)}`),
  restoreEmailTemplateVersion: (templateId: string, version: number, scope?: EmailTemplateScopeRef) =>
    request<EmailTemplateDetail>(
      `/api/email-templates/${templateId}/versions/${version}/restore${scopeQuery(scope)}`,
      { method: 'POST' },
    ),
  getTheme: () => request<{ theme: PanelTheme }>('/api/theme'),
  saveTheme: (theme: PanelTheme) =>
    request<{ theme: PanelTheme }>('/api/theme', { method: 'PUT', body: theme }),
  resetTheme: () => request<{ theme: PanelTheme }>('/api/theme/reset', { method: 'POST' }),

  /* ── AGENDA (réunions) et HISTORIQUE (événements) — aucun pont ────────── */
  listMeetings: (scope: MeetingScope, projectId?: string) =>
    request<{ meetings: Meeting[] }>(
      `/api/meetings?scope=${scope}${projectId ? `&projectId=${projectId}` : ''}`,
    ),

  planMeeting: (body: Record<string, unknown>) =>
    request<{ meeting: Meeting }>('/api/meetings', { method: 'POST', body }),

  updateMeeting: (meetingId: string, body: Record<string, unknown>) =>
    request<{ meeting: Meeting }>(`/api/meetings/${meetingId}`, { method: 'PUT', body }),

  updateEvent: (eventId: string, body: Record<string, unknown>) =>
    request<{ event: ProjectEvent }>(`/api/events/${eventId}`, { method: 'PUT', body }),

  cancelMeeting: (meetingId: string, reason?: string) =>
    request<{ meeting: Meeting }>(`/api/meetings/${meetingId}/cancel`, {
      method: 'POST', body: { reason },
    }),

  rescheduleMeeting: (meetingId: string, body: Record<string, unknown>) =>
    request<{ previous: Meeting; next: Meeting }>(`/api/meetings/${meetingId}/reschedule`, {
      method: 'POST', body,
    }),

  /** `projectId` est exigé : la vue globale se demande avec `scope=all`. */
  listEvents: (params: { projectId?: string; type?: string; status?: string; all?: boolean }) => {
    const q = new URLSearchParams();
    if (params.projectId) q.set('projectId', params.projectId);
    if (params.type) q.set('type', params.type);
    if (params.status) q.set('status', params.status);
    if (params.all) q.set('scope', 'all');
    return request<{ events: ProjectEvent[] }>(`/api/events?${q.toString()}`);
  },

  pendingEvents: () => request<{ events: ProjectEvent[] }>('/api/events/pending'),

  projectEvents: (projectId: string) =>
    request<ProjectEventsSummary>(`/api/events/project/${projectId}`),

  addPastEvent: (body: Record<string, unknown>) =>
    request<{ event: ProjectEvent }>('/api/events', { method: 'POST', body }),

  confirmEvent: (eventId: string, body: Record<string, unknown>) =>
    request<{ event: ProjectEvent }>(`/api/events/${eventId}/confirm`, { method: 'POST', body }),

  missEvent: (eventId: string, body: Record<string, unknown>) =>
    request<{ event: ProjectEvent }>(`/api/events/${eventId}/miss`, { method: 'POST', body }),

  generatePairingCode: (projectId: string) =>
    request<{ pairingCode: string; pairingCodeExpiresAt: string }>(
      `/api/projects/${projectId}/pairing-code`,
      { method: 'POST' },
    ),

  revokePairing: (projectId: string) =>
    request<{ project: PublicProject }>(`/api/projects/${projectId}/pairing`, {
      method: 'DELETE',
    }),

  removeProject: (projectId: string) =>
    request<{ removed: true }>(`/api/projects/${projectId}`, { method: 'DELETE' }),

  updateManifest: (projectId: string, manifest: unknown) =>
    request<{ project: PublicProject; unknownFeatures: string[] }>(
      `/api/projects/${projectId}/manifest`,
      { method: 'PUT', body: { manifest } },
    ),
};

/**
 * SUPERVISION — surface strictement en LECTURE (Phase 3A).
 *
 * Organisée en niveaux de divulgation progressive : on ne charge le détail
 * technique d'un projet que si l'utilisateur va le chercher. Un parc de
 * plusieurs centaines de projets ne coûte donc pas plus cher à afficher
 * qu'un parc de trois.
 */
export const supervision = {
  /** Niveau 0 — quelques indicateurs. */
  dashboard: () => request<Dashboard>('/api/supervision/dashboard'),

  /** Niveau 1 — le parc, filtrable. */
  fleet: (criteria: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(criteria)) {
      if (value) params.set(key, value);
    }
    const query = params.toString();
    return request<FleetResult>(`/api/supervision/fleet${query ? `?${query}` : ''}`);
  },

  facets: () => request<SearchFacets>('/api/supervision/facets'),

  events: (limit = 50) => request<{ items: TimelineEvent[] }>(`/api/supervision/events?limit=${limit}`),

  /** Niveau 2 — la fiche projet. */
  project: (projectId: string) => request<ProjectOverview>(`/api/supervision/projects/${projectId}`),

  /** Niveau 3 — détails techniques, à la demande. */
  technical: (projectId: string) =>
    request<ProjectTechnical>(`/api/supervision/projects/${projectId}/technical`),

  heartbeats: (projectId: string, limit = 50) =>
    request<{ stats: HeartbeatStats; items: HeartbeatRow[] }>(
      `/api/supervision/projects/${projectId}/heartbeats?limit=${limit}`,
    ),

  projectEvents: (projectId: string, limit = 50) =>
    request<{ items: TimelineEvent[] }>(
      `/api/supervision/projects/${projectId}/events?limit=${limit}`,
    ),
};

/**
 * DIAGNOSTIC — surface d'ANALYSE, strictement en lecture (Phase 3B).
 *
 * La supervision restitue ce qui a été observé ; le diagnostic explique ce
 * qui a été observé. Ni l'une ni l'autre ne contacte un projet.
 */
export const diagnostic = {
  /** Analyse du parc : readiness moyenne, compatibilité croisée, top risques. */
  fleet: () => request<FleetDiagnostic>('/api/diagnostic/fleet'),

  /** Analyse complète d'un projet. */
  project: (projectId: string) =>
    request<ProjectDiagnostic>(`/api/diagnostic/projects/${projectId}`),

  /** Le catalogue de règles — rend le moteur auditable depuis l'interface. */
  catalog: () => request<unknown>('/api/diagnostic/catalog'),
};

/**
 * PILOTAGE — la seule surface d'écriture du Panel vers les projets (Phase 3C).
 *
 * Il n'existe volontairement AUCUNE fonction « exécuter directement » : on
 * prépare, on crée une exécution, on confirme. C'est la traduction côté
 * client de la règle du moteur — aucune action ne le contourne.
 */
export const executions = {
  /** Le catalogue d'actions : l'interface n'en code aucune en dur. */
  actions: () => request<{ items: ActionDescriptor[] }>('/api/executions/actions'),

  /** Compteurs — niveau 0. */
  stats: () => request<ExecutionStats>('/api/executions/stats'),

  /** Ce qui attend, ce qui tourne — niveau 1. */
  queue: () => request<{ items: ExecutionRow[] }>('/api/executions/queue'),

  /** L'historique, filtrable — niveau 1. */
  history: (filters: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
    }
    const query = params.toString();
    return request<{ items: ExecutionRow[] }>(`/api/executions${query ? `?${query}` : ''}`);
  },

  /** Le détail complet, journal compris — niveaux 2 et 3. */
  detail: (executionId: string) => request<Execution>(`/api/executions/${executionId}`),

  /**
   * PRÉPARE : évalue les politiques sans rien créer. C'est ce qui permet à
   * l'écran d'expliquer un refus AVANT de proposer le moindre bouton.
   */
  prepare: (body: { type: string; projectId?: string | null; parameters?: Record<string, unknown> }) =>
    request<ActionPreparation>('/api/executions/prepare', { method: 'POST', body }),

  /** Crée une exécution — SIMULATION par défaut, comme le backend. */
  create: (body: {
    type: string;
    projectId?: string | null;
    parameters?: Record<string, unknown>;
    mode?: 'SIMULATION' | 'EXECUTION';
  }) => request<Execution>('/api/executions', { method: 'POST', body: { mode: 'SIMULATION', ...body } }),

  confirm: (executionId: string, decision: 'APPROVED' | 'REJECTED', comment?: string) =>
    request<Execution>(`/api/executions/${executionId}/confirm`, {
      method: 'POST',
      body: { decision, comment: comment ?? null },
    }),

  cancel: (executionId: string, reason?: string) =>
    request<Execution>(`/api/executions/${executionId}/cancel`, {
      method: 'POST',
      body: { reason: reason ?? null },
    }),
};

/**
 * ENTREPRISE et API INTÉGRÉES — Phase 4.
 *
 * `update` et `publish` sont deux appels distincts, et c'est délibéré :
 * modifier ne diffuse rien, publier fige une version et l'envoie au parc.
 * Fusionner les deux ferait partir une configuration à chaque frappe.
 */
export const company = {
  current: () => request<CompanyState>('/api/company'),

  /**
   * CRÉER — et diffuser aussitôt.
   *
   * Une entreprise créée mais non publiée n'existe pour aucun projet. Créer,
   * c'est déclarer qui l'on est ; il n'y a rien à retenir avant de le dire.
   */
  create: (body: Partial<Company>) =>
    request<SaveResult>('/api/company', { method: 'POST', body }),

  /**
   * ENREGISTRER — c'est-à-dire DIFFUSER.
   *
   * Il n'y a plus de brouillon : ce que l'écran montre est ce que les projets
   * appliquent. Enregistrer sans rien avoir changé rend `published: false` —
   * un succès silencieux, pas une erreur.
   */
  update: (body: Record<string, unknown>) =>
    request<SaveResult>('/api/company', { method: 'PATCH', body }),

  /**
   * REDIFFUSER la version en vigueur — sans rien enregistrer.
   *
   * L'ecran proposait « Enregistrez de nouveau » quand une diffusion n'avait
   * pas abouti. Enregistrer touche la fiche et peut creer une version, alors
   * que seul le transport avait manque. Cette action ne fait qu'une chose.
   */
  republish: () =>
    request<{ version: number; recipients: number }>('/api/company/republish', { method: 'POST' }),

  versions: () =>
    request<{ currentVersion: number | null; items: VersionRow[] }>('/api/company/versions'),

  version: (version: number) =>
    request<VersionDetail>(`/api/company/versions/${version}`),

  restore: (version: number) =>
    request<PublishResult>(`/api/company/versions/${version}/restore`, { method: 'POST' }),

  apis: () => request<{ items: IntegratedApi[] }>('/api/company/integrated-apis'),

  createApi: (body: { key: string; label: string; provider: string; category?: string }) =>
    request<IntegratedApi>('/api/company/integrated-apis', { method: 'POST', body }),

  updateApi: (apiId: string, body: Record<string, unknown>) =>
    request<IntegratedApi>(`/api/company/integrated-apis/${apiId}`, { method: 'PATCH', body }),

  deleteApi: (apiId: string) =>
    request<{ deleted: true; revoked: number }>(`/api/company/integrated-apis/${apiId}`, {
      method: 'DELETE',
    }),

  /**
   * Enregistre des identifiants. Seul appel du Panel qui transporte des
   * secrets en clair — inévitable, il faut bien les saisir. Ils sont chiffrés
   * à réception et ne ressortent jamais.
   */
  setCredentials: (apiId: string, mode: 'TEST' | 'PROD', values: Record<string, string>, remove: string[] = []) =>
    request<IntegratedApi>(`/api/company/integrated-apis/${apiId}/credentials/${mode}`, {
      method: 'PUT',
      body: { values, remove },
    }),

  grant: (apiId: string, projectId: string, keys: string[] = []) =>
    request<IntegratedApi>(`/api/company/integrated-apis/${apiId}/grants`, {
      method: 'POST',
      body: { projectId, keys },
    }),

  revoke: (apiId: string, projectId: string) =>
    request<IntegratedApi>(`/api/company/integrated-apis/${apiId}/grants/${projectId}`, {
      method: 'DELETE',
    }),
};

/**
 * PLAN DE CONTRÔLE INTEGRATEDAPI (L1) — surface distincte de `company`.
 *
 * L'ancien coffre (`company.apis`, ci-dessus) reste en place pendant toute la
 * migration : il diffuse encore des identifiants aux projets. Celui-ci n'en
 * diffuse aucun, et c'est précisément pour cela qu'il ne le remplace pas
 * silencieusement.
 */
export const integratedApis = {
  /** Le catalogue code-first et l'état de chaque jeu. */
  list: () => request<{ items: ProviderView[] }>('/api/integrated-apis'),

  /** « Sur quoi puis-je compter, ici, maintenant ? » */
  availability: () => request<{ items: ProviderAvailability[] }>('/api/integrated-apis/availability'),

  /**
   * Le catalogue des CAPACITÉS (L3) — ce qu'un projet peut demander, et ce qui
   * est réellement servi. Distinct de `list()` : celui-là décrit des
   * FOURNISSEURS et leurs clés, celui-ci des VERBES MÉTIER. Les mélanger dans
   * une même réponse, c'est reperdre la séparation que tout le lot installe.
   */
  capabilities: () => request<{ capabilities: CapabilityView[] }>('/api/integrated-apis/capabilities'),

  /**
   * ── QUATRE APPELS ONT ÉTÉ SUPPRIMÉS ICI ───────────────────────────────────
   *
   *   grants / setGrants                    éditaient les capacités cochées
   *   commercialReadiness / setCommercialReadiness   ouvraient le commerce
   *
   * Les routes correspondantes n'existent plus côté Panel. `capabilities()`
   * ci-dessus reste le seul appel de cette famille : il rend le catalogue de
   * l'INSTANCE, sans état par projet et sans rien à cocher.
   */

  get: (provider: string) => request<ProviderView>(`/api/integrated-apis/${provider}`),

  /**
   * Enregistre des identifiants. Seul appel qui transporte des secrets en
   * clair — il faut bien les saisir. Ils sont chiffrés à réception et ne
   * ressortent jamais.
   *
   * `environment` est un choix de PROVISIONNEMENT (préparer le jeu TEST ou le
   * jeu PROD), jamais un sélecteur d'exécution : aucune action métier ne
   * l'acceptera d'un client.
   *
   * Un champ laissé vide CONSERVE la valeur existante. Pour retirer une clé,
   * il faut la nommer dans `remove`.
   */
  saveCredentials: (
    provider: string,
    environment: IntegratedApiEnvironment | null,
    values: Record<string, string>,
    remove: string[] = [],
  ) =>
    request<CredentialSetView>(`/api/integrated-apis/${provider}/credentials`, {
      method: 'PUT',
      body: { environment, values, remove },
    }),

  /** Appel RÉEL au fournisseur, en lecture seule. Aucune opération métier. */
  validate: (provider: string, environment: IntegratedApiEnvironment | null) =>
    request<ValidatedCredentialSet>(`/api/integrated-apis/${provider}/validate`, {
      method: 'POST',
      body: { environment },
    }),
};

/**
 * PLAN DE CONTRÔLE WEBHOOK (L5) — état, dérive, et réconciliation.
 *
 * `environment` n'est JAMAIS un paramètre : le backend le résout depuis son
 * propre runtime. Le laisser choisir au navigateur rouvrirait exactement la
 * porte que la doctrine d'environnement ferme.
 */
export const webhookControlPlane = {
  /** L'état de tous les fournisseurs. Aucun appel distant, aucune écriture. */
  list: () => request<{ environment: IntegratedApiEnvironment; items: WebhookStateView[] }>(
    '/api/webhook-control-plane',
  ),

  get: (provider: string) => request<WebhookStateView>(`/api/webhook-control-plane/${provider}`),

  /**
   * ÉCRITURE chez le fournisseur — DEV uniquement, côté backend.
   * Elle crée, met à jour ou retire un endpoint sur un compte réel.
   */
  reconcile: (provider?: string) => request<Record<string, unknown>>(
    provider ? `/api/webhook-control-plane/${provider}/reconcile` : '/api/webhook-control-plane/reconcile',
    { method: 'POST' },
  ),
};

/**
 * SONDE d'une URL de projet, avant appairage. N'écrit rien : elle constate
 * qu'une adresse répond, que c'est bien un ProjectBridge, et que les contrats
 * sont compatibles.
 */
export const probeProject = (url: string) =>
  request<ProbeResult>('/api/projects/probe', { method: 'POST', body: { url } });

/**
 * DÉPLOIEMENT — Phase 4.
 *
 * Le mot de passe SSH figure dans les CORPS de requête et dans aucun type de
 * réponse : il monte, il ne redescend jamais. Il n'est pas non plus conservé
 * côté navigateur — chaque opération le redemande.
 *
 * Aucune fonction ne « lance et attend » : toutes rendent un `runId`, et
 * l'état s'obtient en interrogeant `run()`. C'est ce qui permet au Panel de
 * se déployer lui-même sans qu'une requête coupée fasse perdre le résultat.
 */
export const deployment = {
  /**
   * PRÉREQUIS — appelé AVANT de proposer le bouton, jamais après l'avoir cliqué.
   *
   * C'est cet appel qui remplace la découverte de l'indisponibilité PAR le
   * déploiement lui-même. Il est en lecture, ne transporte aucun secret, et
   * rend un état structuré : l'écran sait alors nommer ce qui manque au lieu
   * d'afficher « serveur injoignable » sur quatre pannes différentes.
   */
  readiness: (targetId?: string) =>
    request<DeploymentReadiness>(
      `/api/deployment/readiness${targetId ? `?targetId=${encodeURIComponent(targetId)}` : ''}`,
    ),

  overview: () => request<DeploymentOverview>('/api/deployment'),

  /** Ce que le Panel sait de lui-même — à consulter avant de configurer. */
  self: () => request<PanelSelfInfo>('/api/deployment/self'),

  target: (targetId: string) => request<TargetDetail>(`/api/deployment/targets/${targetId}`),

  createTarget: (body: Partial<DeploymentTarget>) =>
    request<DeploymentTarget>('/api/deployment/targets', { method: 'POST', body }),

  updateTarget: (targetId: string, body: Partial<DeploymentTarget>) =>
    request<DeploymentTarget>(`/api/deployment/targets/${targetId}`, { method: 'PATCH', body }),

  /**
   * Suppression de la FICHE — refusée tant que la destination n'est pas vidée.
   * Ne convient qu'aux destinations jamais mises en ligne : dès qu'une
   * quarantaine 410 est posée, passer par `destroyTarget`.
   */
  deleteTarget: (targetId: string) =>
    request<{ deleted: true }>(`/api/deployment/targets/${targetId}`, { method: 'DELETE' }),

  // — Retrait d'une destination ---------------------------------------------
  /** Inventaire du serveur AVANT retrait — lecture seule, affichée à l'écran. */
  inspectTarget: (targetId: string, sshPassword: string) =>
    request<DestinationInspection>(`/api/deployment/targets/${targetId}/inspect`, {
      method: 'POST', body: { sshPassword },
    }),

  /** Retrait : vide la destination du serveur et pose la quarantaine 410. */
  deprovision: (
    targetId: string,
    sshPassword: string,
    confirmHostname: string,
    removePersistentData = false,
  ) =>
    request<StartedOperation>(`/api/deployment/targets/${targetId}/deprovision`, {
      method: 'POST', body: { sshPassword, confirmHostname, removePersistentData },
    }),

  /**
   * Suppression DÉFINITIVE de la fiche. Rend un `StartedOperation` quand une
   * quarantaine doit être levée sur le serveur, sinon la suppression est
   * immédiate — l'appelant distingue les deux par la présence de `runId`.
   */
  destroyTarget: (targetId: string, confirmHostname: string, sshPassword?: string) =>
    request<StartedOperation | { deleted: true }>(`/api/deployment/targets/${targetId}/delete`, {
      method: 'POST', body: { confirmHostname, sshPassword },
    }),

  // — Opérations : toutes rendent un runId ---------------------------------
  testConnection: (targetId: string, sshPassword: string) =>
    request<StartedOperation>(`/api/deployment/targets/${targetId}/test-connection`, {
      method: 'POST', body: { sshPassword },
    }),

  preflight: (targetId: string, sshPassword: string) =>
    request<StartedOperation>(`/api/deployment/targets/${targetId}/preflight`, {
      method: 'POST', body: { sshPassword },
    }),

  simulate: (targetId: string, sshPassword: string) =>
    request<StartedOperation>(`/api/deployment/targets/${targetId}/simulate`, {
      method: 'POST', body: { sshPassword },
    }),

  deploy: (targetId: string, sshPassword: string, confirmProduction = false) =>
    request<StartedOperation>(`/api/deployment/targets/${targetId}/deploy`, {
      method: 'POST', body: { sshPassword, confirmProduction },
    }),

  rollback: (targetId: string, sshPassword: string, releaseId: string) =>
    request<StartedOperation>(`/api/deployment/targets/${targetId}/rollback`, {
      method: 'POST', body: { sshPassword, releaseId },
    }),

  releases: (targetId: string, sshPassword: string) =>
    request<ReleaseList>(`/api/deployment/targets/${targetId}/releases`, {
      method: 'POST', body: { sshPassword },
    }),

  // — Suivi ----------------------------------------------------------------
  run: (runId: string) => request<DeploymentRun>(`/api/deployment/runs/${runId}`),

  /**
   * FLUX REPRENABLE des évènements d'un run (NDJSON, une ligne = un évènement).
   *
   * Rend un itérateur asynchrone : l'appelant consomme les évènements au fil de
   * l'eau, sans jamais recharger le run entier. `since` est le dernier `seq`
   * réellement traité — c'est lui qui rend la reprise exacte après la coupure
   * provoquée par le redémarrage du backend en auto-déploiement.
   *
   * L'itérateur se TERMINE normalement à la fin du run (évènement `end`) ; toute
   * autre fin (coupure réseau, backend qui redémarre) remonte en exception, à
   * charge de l'appelant de rappeler la méthode avec le curseur à jour.
   */
  async *streamRun(
    runId: string,
    since: number,
    signal: AbortSignal,
  ): AsyncGenerator<DeployStreamEvent, void, void> {
    const headers: Record<string, string> = {};
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(
      `/api/deployment/runs/${runId}/stream?since=${since}`,
      { headers, signal },
    );
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, 'Flux de suivi indisponible.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // NDJSON : on ne rend que les lignes COMPLÈTES ; un fragment reste en
        // tampon jusqu'à l'arrivée de son saut de ligne.
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            try {
              yield JSON.parse(line) as DeployStreamEvent;
            } catch {
              // Ligne tronquée par une coupure : on l'ignore plutôt que de
              // corrompre l'état. Le curseur n'a pas avancé, elle reviendra.
            }
          }
          nl = buffer.indexOf('\n');
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  },

  runs: (targetId?: string) =>
    request<{ items: RunRow[] }>(
      `/api/deployment/runs${targetId ? `?targetId=${targetId}` : ''}`,
    ),
};

/**
 * REGISTRE FINANCIER (L10.1) — un seul moteur, deux écrans.
 *
 * La fiche projet et la page Finances globale appellent EXACTEMENT ces
 * fonctions, avec une portée différente. Il n'y a pas de « surface projet » et
 * de « surface globale » : un second jeu d'appels aurait fini par calculer le
 * bénéfice deux fois, et les deux chiffres auraient divergé.
 *
 * Aucun appel ici ne parle à Stripe, ne rembourse, n'importe ni ne synchronise.
 * Ces verbes appartiennent aux lots suivants.
 */
const financeQuery = (criteria: FinanceCriteria = {}): string => {
  const params = new URLSearchParams();
  const poser = (clef: string, valeur: unknown) => {
    if (valeur === undefined || valeur === null || valeur === '') return;
    params.set(clef, String(valeur));
  };
  poser('scope', criteria.scope);
  poser('projectId', criteria.projectId);
  poser('period', criteria.period);
  poser('start', criteria.start);
  poser('end', criteria.end);
  poser('category', criteria.category);
  poser('flow', criteria.flow);
  poser('search', criteria.search);
  poser('sort', criteria.sort);
  poser('limit', criteria.limit);
  if (criteria.includeDeleted) params.set('includeDeleted', '1');
  const query = params.toString();
  return query ? `?${query}` : '';
};

/**
 * LES ENTREPRISES CLIENTES — l'identité JURIDIQUE des clients de L.Y Solution.
 *
 * ══ UN OBJET À PART, ET NON UNE SECTION DE `finances` ═══════════════════════
 *
 * `finances` est le REGISTRE DES MOUVEMENTS : ce qui est entré, ce qui est
 * sorti, ce qui reste dû. Une entreprise cliente n’est aucun de ces faits —
 * c'est une PERSONNE MORALE, qui existe avant le premier euro et continue
 * d’exister après le dernier.
 *
 * Elle est aussi volontairement HORS de `api.*`, où vivent les projets :
 * confondre le site et la société qui l’exploite est précisément l’erreur que
 * ce chantier répare.
 */
export const clientCompanies = {
  /* ══════════════════════════════════════════════════════════════════════════
     LES ENTREPRISES CLIENTES — l'identité JURIDIQUE des clients.

     Volontairement HORS de `/api/company` : celle-là est L.Y Solution, le
     VENDEUR. Celles-ci sont ses CLIENTS, et c'est leur identité que porte le
     « Facturer à » d'une facture.
     ══════════════════════════════════════════════════════════════════════════ */

  listClientCompanies: (params: { search?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.status) q.set('status', params.status);
    const suffixe = q.toString() ? `?${q}` : '';
    return request<{ clientCompanies: ClientCompanyRow[] }>(`/api/client-companies${suffixe}`);
  },

  getClientCompany: (clientCompanyId: string) =>
    request<{ clientCompany: ClientCompanyDetail }>(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}`,
    ),

  createClientCompany: (body: Record<string, unknown>) =>
    request<ClientCompanySaveResult>('/api/client-companies', { method: 'POST', body }),

  updateClientCompany: (clientCompanyId: string, body: Record<string, unknown>) =>
    request<ClientCompanySaveResult>(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}`,
      { method: 'PATCH', body },
    ),

  archiveClientCompany: (clientCompanyId: string) =>
    request<{ clientCompany: ClientCompanyDetail; alreadyArchived: boolean }>(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}/archive`,
      { method: 'POST' },
    ),

  restoreClientCompany: (clientCompanyId: string) =>
    request<{ clientCompany: ClientCompanyDetail; alreadyActive: boolean }>(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}/restore`,
      { method: 'POST' },
    ),

  /**
   * SUPPRESSION PHYSIQUE — refusée dès qu'un projet ou un document existe.
   *
   * Le backend est l'autorité de ce refus (`PANEL_CLIENT_COMPANY_HAS_PROJECTS`).
   * L’écran ne le devine pas : il propose le geste, et affiche le message.
   */
  deleteClientCompany: (clientCompanyId: string) =>
    request<{ deleted: boolean }>(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}`,
      { method: 'DELETE' },
    ),

  linkProjectToClientCompany: (clientCompanyId: string, projectId: string) =>
    request<ClientCompanyLinkResult>(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}/projects`,
      { method: 'POST', body: { projectId } },
    ),

  unlinkProjectFromClientCompany: (projectId: string) =>
    request<{ unlinked: boolean; unchanged: boolean }>(
      `/api/client-companies/projects/${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    ),

  /**
   * DÉPOSE un document administratif — Kbis, attestation, mandat, RIB.
   *
   * `multipart`, donc hors du chemin JSON : le `Content-Type` n’est PAS posé à
   * la main — le navigateur doit y écrire la frontière du multipart, et
   * l’imposer rendrait le corps illisible au serveur.
   */
  async uploadClientDocument(
    clientCompanyId: string,
    file: File,
    meta: { label: string; type?: string | null; documentDate?: string | null },
  ): Promise<ClientCompanyDetail> {
    const form = new FormData();
    form.append('file', file);
    form.append('label', meta.label);
    if (meta.type) form.append('type', meta.type);
    if (meta.documentDate) form.append('documentDate', meta.documentDate);

    const headers: Record<string, string> = {};
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`/api/client-companies/${encodeURIComponent(clientCompanyId)}/documents`, {
        method: 'POST', headers, body: form,
      });
    } catch {
      throw new ApiError(0, 'Impossible de contacter le serveur du Panel.');
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok || payload?.success !== true) {
      throw new ApiError(
        res.status,
        payload?.message ?? 'Le document n’a pas pu être enregistré.',
        payload?.code,
      );
    }
    return payload.data.clientCompany as ClientCompanyDetail;
  },

  /**
   * TÉLÉCHARGE un document — par la route AUTHENTIFIÉE, jamais un lien nu.
   *
   * Un document client vit dans le stockage PRIVÉ : il n’a aucune adresse
   * publique, et un `<a href>` ne porterait aucun jeton. Le flux est donc
   * récupéré ici puis l’enregistrement est déclenché — le fichier ne fait que
   * passer, et aucune adresse permanente n’existe.
   */
  async downloadClientDocument(
    clientCompanyId: string,
    documentId: string,
    fallbackName = 'document',
  ): Promise<void> {
    const token = tokenStore.get();
    const res = await fetch(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}/documents/${encodeURIComponent(documentId)}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    if (!res.ok) {
      const corps = await res.json().catch(() => null);
      throw new ApiError(
        res.status,
        corps?.message ?? 'Le document n’a pas pu être récupéré.',
        corps?.code,
      );
    }

    const disposition = res.headers.get('content-disposition') ?? '';
    /** La forme encodée (RFC 5987) d’abord : c’est elle qui porte les accents. */
    const encode = /filename[*]=UTF-8[']['](.+?)(?:;|$)/i.exec(disposition);
    const simple = /filename="([^"]+)"/i.exec(disposition);
    const nom = encode
      ? decodeURIComponent(encode[1].trim())
      : (simple ? simple[1].trim() : fallbackName);

    const blob = await res.blob();
    if (blob.size === 0) throw new ApiError(502, 'Le document reçu est vide.');

    const url = URL.createObjectURL(blob);
    const lien = document.createElement('a');
    lien.href = url;
    lien.download = nom;
    lien.rel = 'noopener';
    lien.style.display = 'none';
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  },

  removeClientDocument: (clientCompanyId: string, documentId: string) =>
    request<{ clientCompany: ClientCompanyDetail }>(
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}/documents/${encodeURIComponent(documentId)}`,
      { method: 'DELETE' },
    ),
};

export const finances = {
  /** Revenus, coûts, net et points du graphique — sur TOUT ce que le filtre retient. */
  summary: (criteria: FinanceCriteria = {}) =>
    request<FinanceSummary>(`/api/finances/summary${financeQuery(criteria)}`),

  /** La liste, bornée. `total` dit combien il y en a vraiment. */
  list: (criteria: FinanceCriteria = {}) =>
    request<FinanceListResult>(`/api/finances/transactions${financeQuery(criteria)}`),

  /**
   * LE DÉTAIL — le mouvement, et son fait fournisseur s'il en a un.
   *
   * `providerFact` est `null` pour une saisie manuelle ou une occurrence de
   * coût récurrent : il n'y a rien à dire, et un bloc vide se lirait comme une
   * donnée manquante.
   */
  detail: (transactionId: string) =>
    request<{
      transaction: FinancialTransaction;
      providerFact: ProviderFact | null;
      refundRequests: RefundRequest[];
    }>(`/api/finances/transactions/${transactionId}`),

  /**
   * PEUT-ON REMBOURSER, ET DE COMBIEN ? — aucun appel Stripe.
   *
   * Tout vient du registre : le montant encaissé, ce qui a déjà été rendu, ce
   * qui reste. L'écran ne calcule RIEN lui-même — un restant calculé côté
   * navigateur finirait par diverger de celui que le serveur oppose, et
   * l'opérateur verrait un bouton actif sur un refus certain.
   */
  /* ── Prestations à facturer (L10.5) ──────────────────────────────────── */

  /**
   * LES PRESTATIONS — surface distincte de `/transactions`, et c'est le point :
   * une somme DUE n'est pas un mouvement, et n'entre dans aucun total.
   */
  paymentRequests: (projectId?: string | null) =>
    request<{ items: PaymentRequest[] }>(
      `/api/finances/payment-requests${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),

  /**
   * CRÉE ET ENVOIE. Le serveur calcule la TVA depuis le contrat du projet et
   * fige le triplet HT / TVA / TTC — l'écran n'envoie que le HT.
   */
  createPaymentRequest: (body: PaymentRequestInput) =>
    request<{ paymentRequest: PaymentRequest }>('/api/finances/payment-requests', {
      method: 'POST', body,
    }),

  /* ── Impayés d'abonnement (L10.6B-3) ─────────────────────────────────── */

  /**
   * LES INCIDENTS D'UN PROJET — incident actif, historique et détail d'un coup.
   *
   * ══ POURQUOI UN SEUL APPEL ════════════════════════════════════════════
   *
   * Parce que le serveur y applique UN SEUL instant de référence. Trois
   * requêtes auraient donné trois `now` différents, et l'écran aurait pu
   * afficher « grâce en cours » dans un bloc et « expirée » dans le suivant,
   * pour le même incident, à une seconde d'intervalle.
   *
   * ══ CE QUE LE CLIENT NE RECONSTRUIT PAS ═══════════════════════════════
   *
   * Rien. Ni l'échéance de grâce, ni l'accessibilité, ni l'état de la cause :
   * `display` porte des états et des phrases déjà décidés par le serveur.
   * Recalculer ici afficherait la politique COURANTE du contrat sur un
   * incident qui en a figé une autre.
   *
   * Aucun appel Stripe, aucun e-mail, aucune mutation : c'est un GET, et il
   * le reste.
   */
  paymentDefaults: (projectId: string) =>
    request<PaymentDefaultsView>(
      `/api/finances/payment-defaults?projectId=${encodeURIComponent(projectId)}`,
    ),

  /**
   * RETENTER LA COLLECTE D’UN IMPAYÉ — le seul verbe de cette surface.
   *
   * Il ne crée ni facture, ni abonnement, ni session : la créance existe
   * déjà, seule la tentative est nouvelle. Et il ne marque jamais « payé » —
   * c’est le webhook de Stripe qui l’établira, par le même chemin que les
   * tentatives que Stripe programme lui-même.
   */
  retryPaymentDefault: (paymentDefaultId: string) =>
    request<PaymentDefaultRetryResult>(
      `/api/finances/payment-defaults/${encodeURIComponent(paymentDefaultId)}/retry`,
      { method: 'POST' },
    ),

  /** ANNULE — la demande RESTE, avec son histoire et son motif. */
  cancelPaymentRequest: (paymentRequestId: string, reason?: string) =>
    request<{ paymentRequest: PaymentRequest }>(
      `/api/finances/payment-requests/${paymentRequestId}/cancel`,
      { method: 'POST', body: { reason: reason ?? null } },
    ),

  refundEligibility: (transactionId: string) =>
    request<RefundEligibility>(`/api/finances/transactions/${transactionId}/refund`),

  /**
   * REMBOURSE — le seul appel du Panel qui rende de l'argent.
   *
   * Le corps ne porte qu'un montant et deux raisons. Aucun identifiant Stripe,
   * aucun environnement : le serveur les résout depuis le mouvement, et les
   * accepter d'ici reviendrait à laisser le navigateur désigner la ressource à
   * muter chez le fournisseur.
   *
   * `amountCents: null` = remboursement TOTAL du restant.
   */
  refund: (
    transactionId: string,
    body: { amountCents: number | null; reason?: StripeRefundReason | null; note?: string | null },
  ) => request<RefundOutcome>(`/api/finances/transactions/${transactionId}/refund`, {
    method: 'POST', body,
  }),

  /** La répartition par projet — la page globale, et elle seule. */
  byProject: (criteria: FinanceCriteria = {}) =>
    request<{ items: FinanceProjectLine[] }>(`/api/finances/by-project${financeQuery(criteria)}`),

  create: (body: ManualTransactionInput) =>
    request<{ transaction: FinancialTransaction }>('/api/finances/transactions', {
      method: 'POST', body,
    }),

  update: (transactionId: string, body: Partial<ManualTransactionInput>) =>
    request<{ transaction: FinancialTransaction }>(`/api/finances/transactions/${transactionId}`, {
      method: 'PATCH', body,
    }),

  /** Suppression LOGIQUE : la ligne quitte les totaux, le document reste. */
  remove: (transactionId: string, reason?: string) =>
    request<{ transaction: FinancialTransaction }>(`/api/finances/transactions/${transactionId}`, {
      method: 'DELETE', body: { reason: reason ?? null },
    }),

  /**
   * COMBIEN « tout supprimer » retirerait — sans rien retirer.
   * Appelé AVANT d'ouvrir la confirmation : une question posée sans chiffre
   * n'est pas une question à laquelle on peut répondre.
   */
  bulkScope: (scope: FinanceScope, projectId?: string | null) =>
    request<BulkScopePreview>(
      `/api/finances/bulk-scope?scope=${scope}${projectId ? `&projectId=${projectId}` : ''}`,
    ),

  /** Réservé aux comptes DEV côté backend. Portée explicite, confirmation retapée. */
  bulkDelete: (body: {
    scope: FinanceScope; projectId?: string | null; confirm: string; reason?: string;
  }) =>
    request<BulkDeleteResult>('/api/finances/transactions/bulk-delete', { method: 'POST', body }),

  /* ── COÛTS RÉCURRENTS — les RÈGLES, jamais des mouvements ─────────────── */

  recurringCosts: (criteria: { scope?: FinanceScope; projectId?: string | null } = {}) =>
    request<{ items: RecurringCost[] }>(
      `/api/finances/recurring-costs${financeQuery(criteria)}`,
    ),

  createRecurringCost: (body: RecurringCostInput) =>
    request<{ recurringCost: RecurringCost }>('/api/finances/recurring-costs', {
      method: 'POST', body,
    }),

  /**
   * MODIFIER — `mode` est obligatoire, et il n'a pas de défaut.
   * « À partir de quand ? » est une décision de l'utilisateur ; en choisir une
   * à sa place réécrirait son historique sans le lui demander.
   */
  reviseRecurringCost: (recurringCostId: string, body: RecurringCostPatch) =>
    request<{ recurringCost: RecurringCost; revisedOccurrences: number; unchanged: boolean }>(
      `/api/finances/recurring-costs/${recurringCostId}`,
      { method: 'PATCH', body },
    ),

  stopRecurringCost: (recurringCostId: string, mode: RecurringStopMode, reason?: string) =>
    request<{ recurringCost: RecurringCost; cancelledOccurrences: number }>(
      `/api/finances/recurring-costs/${recurringCostId}/stop`,
      { method: 'POST', body: { mode, reason: reason ?? null } },
    ),

  /* ── JUSTIFICATIFS — protocole Media PRIVÉ ────────────────────────────── */

  /**
   * DÉPOSE ou REMPLACE un justificatif.
   *
   * `multipart`, donc hors du chemin JSON : le `Content-Type` n'est PAS posé à
   * la main — le navigateur doit y écrire la frontière du multipart, et
   * l'imposer rendrait le corps illisible au serveur. Même geste que
   * `uploadImage`, plus haut.
   */
  async uploadReceipt(transactionId: string, file: File): Promise<FinancialTransaction> {
    const form = new FormData();
    form.append('file', file);
    const headers: Record<string, string> = {};
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`/api/finances/transactions/${transactionId}/receipt`, {
        method: 'POST', headers, body: form,
      });
    } catch {
      throw new ApiError(0, 'Impossible de contacter le serveur du Panel.');
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok || payload?.success !== true) {
      throw new ApiError(
        res.status,
        payload?.message ?? 'Le justificatif n’a pas pu être enregistré.',
        payload?.code,
      );
    }
    return payload.data.transaction as FinancialTransaction;
  },

  /**
   * TÉLÉCHARGE le justificatif — par la route AUTHENTIFIÉE, jamais un lien nu.
   *
   * ── POURQUOI PAS UN SIMPLE `<a href>` ─────────────────────────────────
   * La route exige le jeton du Panel, et un lien n'en porte aucun. Le flux est
   * donc récupéré ici, puis l'enregistrement est déclenché : le fichier ne fait
   * que passer, et aucune adresse permanente n'existe.
   *
   * Le nom vient du serveur (`Content-Disposition`, forme encodée d'abord) : il
   * sait s'il rend un PDF ou une image, et sous quel nom l'utilisateur l'a
   * déposé. Même mécanique que le document contractuel, plus haut.
   */
  async downloadReceipt(transactionId: string, fallbackName = 'justificatif'): Promise<void> {
    const token = tokenStore.get();
    const res = await fetch(`/api/finances/transactions/${transactionId}/receipt`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const corps = await res.json().catch(() => null);
      throw new ApiError(
        res.status,
        corps?.message ?? 'Le justificatif n’a pas pu être récupéré.',
        corps?.code,
      );
    }

    const disposition = res.headers.get('content-disposition') ?? '';
    // La forme encodée (RFC 5987) d'abord : c'est elle qui porte les accents.
    const encode = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const simple = /filename="([^"]+)"/i.exec(disposition);
    const nom = encode
      ? decodeURIComponent(encode[1].trim())
      : (simple ? simple[1].trim() : fallbackName);

    const blob = await res.blob();
    if (blob.size === 0) throw new ApiError(502, 'Le justificatif reçu est vide.');

    const url = URL.createObjectURL(blob);
    const lien = document.createElement('a');
    lien.href = url;
    lien.download = nom;
    lien.rel = 'noopener';
    lien.style.display = 'none';
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    // Après le clic, jamais avant : révoquer trop tôt annule un téléchargement
    // que le navigateur n'a pas encore commencé.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  },

  removeReceipt: (transactionId: string) =>
    request<{ transaction: FinancialTransaction }>(
      `/api/finances/transactions/${transactionId}/receipt`,
      { method: 'DELETE' },
    ),
};

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
