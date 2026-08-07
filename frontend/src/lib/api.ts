import type {
  ContractAction,
  ContractOperation,
  ContractProtection,
  PanelUser,
  PanelVersion,
  PublicProject,
} from '@/types';
import type {
  Dashboard, FleetResult, ProjectOverview, ProjectTechnical,
  HeartbeatRow, HeartbeatStats, SearchFacets, TimelineEvent,
} from '@/types.supervision';
import type { FleetDiagnostic, ProjectDiagnostic } from '@/types.diagnostic';
import type { Meeting, MeetingScope, ProjectEvent, ProjectEventsSummary } from '@/types.events';
import type { PanelTheme } from '@/lib/useTheme';
import type { ProjectDestination, ProjectDestinationsByEnvironment } from '@/types';
import type {
  ActionDescriptor, ActionPreparation, Execution, ExecutionRow, ExecutionStats,
} from '@/types.execution';
import type {
  Company, CompanyState, IntegratedApi, MediaDescriptor, ProbeResult, PublishResult, StoredMediaDescriptor,
  VersionDetail, VersionRow,  SaveResult,
} from '@/types.company';
import type {
  DeploymentOverview, DeploymentRun, DeploymentTarget, DestinationInspection, PanelSelfInfo,
  ReleaseList, RunRow, StartedOperation, TargetDetail,
  DeployStreamEvent,
} from '@/types.deployment';

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

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
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

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let bodyInit: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyInit = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: bodyInit,
    });
  } catch {
    throw new ApiError(0, 'Impossible de contacter le serveur du Panel.');
  }

  let payload: Envelope<T> | null = null;
  try {
    payload = (await res.json()) as Envelope<T>;
  } catch {
    payload = null;
  }

  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    tokenStore.clear();
    if (window.location.pathname !== '/login') {
      window.location.assign('/login');
    }
    throw new ApiError(
      401,
      payload?.message ?? 'Session expirée. Veuillez vous reconnecter.',
      payload?.code,
      payload?.details,
    );
  }

  if (!res.ok || !payload || payload.success !== true) {
    throw new ApiError(
      res.status,
      payload?.message ?? `Erreur HTTP ${res.status}`,
      payload?.code,
      payload?.details,
    );
  }

  return payload.data as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: PanelUser }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    }),

  me: () => request<{ user: PanelUser }>('/api/auth/me'),

  version: () => request<PanelVersion>('/api/version'),

  listProjects: () => request<{ projects: PublicProject[] }>('/api/projects'),

  /**
   * DÉCLARE un projet à partir de son adresse. Aucune clé n'est transmise :
   * l'identifiant technique est généré par le serveur, à partir de l'identité
   * que le projet annonce lui-même. Le client ne le choisit jamais.
   */
  createProject: (body: { url: string; projectName?: string }) =>
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

  /* ── THÈME DU PANEL ──────────────────────────────────────────────────── */
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

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
