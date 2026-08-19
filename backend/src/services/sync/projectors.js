/**
 * PROJECTEURS — une entrée par type d'entité appliqué, et rien d'autre.
 *
 * ── POURQUOI CETTE TABLE EXISTE ─────────────────────────────────────────────
 * Le moteur de synchronisation se terminait par une ligne spécifique :
 * `PanelDiagnostic.create(...)`. Tout le reste — déduplication, LWW, anti-écho,
 * accusés, journal — était pourtant parfaitement générique. Ajouter un type
 * métier obligeait donc à toucher le cœur, c'est-à-dire à risquer la mécanique
 * de livraison pour une raison d'affichage.
 *
 * Le cœur ne connaît plus que cette table. Ajouter INVOICE, PAYMENT, EVENT,
 * MEETING ou TEAM_MEMBER demandera un schéma et une fonction ici — pas une
 * ligne de plus dans `syncCore`.
 *
 * ── CONTRAT D'UN PROJECTEUR ─────────────────────────────────────────────────
 * Il reçoit `{ projectId, change }` et projette. Il ne décide ni de l'ordre ni
 * de l'idempotence : le cœur les a déjà tranchés. S'il lève, l'écriture est
 * REJETÉE — jamais appliquée à moitié.
 */
import {
  BRIDGE_ERROR_CODES,
  BridgeError,
  contractPayloadSchema,
  emailTemplateUsagePayloadSchema,
  nowIso,
  projectPresentationPayloadSchema,
  siteStatusPayloadSchema,
  teamMemberPayloadSchema,
} from '../../bridge/bridgeContract.js';
import { PanelDiagnostic } from '../../models/PanelSyncState.model.js';
export { stampOf } from './projectGeneration.js';
import {
  PanelProjectContract,
  PanelProjectEmailTemplateUsage,
  PanelProjectMember,
  PanelProjectPresentation,
  PanelProjectSiteStatus,
} from '../../models/PanelProjectProjection.model.js';

/** Code d'accusé d'un payload non conforme — stable, lisible par le projet. */
export const ENTITY_PAYLOAD_INVALID = 'ENTITY_PAYLOAD_INVALID';

/**
 * Valide un payload, ou lève une BridgeError exploitable. Les chemins fautifs
 * voyagent avec l'erreur ; aucune valeur ne l'accompagne — un payload peut
 * contenir des coordonnées, un message d'erreur ne doit pas les répandre.
 */
function parsePayload(schema, payload, label) {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  throw new BridgeError(
    BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
    `Payload ${label} non conforme.`,
    {
      code: ENTITY_PAYLOAD_INVALID,
      issues: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    },
  );
}

/** DIAGNOSTIC — échange de test, conservé tel quel (journal d'écritures). */
async function applyDiagnostic({ projectId, change }) {
  await PanelDiagnostic.create({ projectId, change, receivedAt: nowIso() });
}

/**
 * PROJECT_PRESENTATION — l'identité commerciale du projet.
 *
 * Un seul enregistrement par projet : chaque réception REMPLACE la
 * photographie précédente. C'est un état, pas un historique — et le cœur a
 * déjà écarté les écritures plus anciennes (LWW).
 */
async function applyProjectPresentation({ projectId, change, stamp }) {
  if (change.deleted) {
    await PanelProjectPresentation.deleteOne({ projectId });
    return;
  }
  const p = parsePayload(projectPresentationPayloadSchema, change.payload, 'PROJECT_PRESENTATION');
  await PanelProjectPresentation.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        companyName: p.companyName ?? null,
        tagline: p.tagline ?? null,
        logoUrl: p.logoUrl ?? null,
        faviconUrl: p.faviconUrl ?? null,
        /**
         * LE DESCRIPTEUR EST PERSISTÉ TEL QUEL — il ne se recompose pas.
         *
         * `registryStore.presentationOf` le lisait déjà (`projection.logo`) ;
         * il n'était ni accepté par le contrat, ni écrit ici, ni porté par le
         * modèle. Trois maillons sur quatre : le champ rendait donc toujours
         * `null`, et le Panel ne pouvait ni détecter un remplacement d'image
         * ni casser son cache.
         *
         * `?? null` et non `?? undefined` : l'absence PUBLIE la suppression du
         * média. Laisser l'ancien descripteur en place afficherait une image
         * que le projet a retirée.
         */
        logo: p.logo ?? null,
        favicon: p.favicon ?? null,
        contacts: {
          email: p.contacts?.email ?? null,
          phone: p.contacts?.phone ?? null,
          website: p.contacts?.website ?? null,
        },
        projectName: p.project?.name ?? null,
        description: p.project?.description ?? null,
        network: {
          website: p.network?.website ?? null,
          manager: p.network?.manager ?? null,
          backend: p.network?.backend ?? null,
        },
        sourceModifiedAt: change.modifiedAt,
        ...stamp,
      },
    },
    { upsert: true },
  );
}

/**
 * CONTRACT — le contrat COURANT du projet, tel que lui-même le désigne.
 *
 * Un tombstone (`deleted`) signifie « plus aucun contrat pertinent » : on
 * efface la projection plutôt que de laisser un contrat périmé à l'écran.
 */
async function applyContract({ projectId, change, stamp }) {
  if (change.deleted) {
    await PanelProjectContract.deleteOne({ projectId });
    return;
  }
  const c = parsePayload(contractPayloadSchema, change.payload, 'CONTRACT');
  await PanelProjectContract.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        /**
         * « Aucun contrat en cours » est un ÉTAT, pas un trou. Le projet le
         * dit ; le Panel le rend. Sans ce champ, le dernier contrat terminé
         * était projeté comme l'engagement du moment.
         */
        hasCurrent: c.hasCurrentContract ?? Boolean(c.sourceContractId),
        sourceContractId: c.sourceContractId ?? null,
        status: c.status ?? null,
        document: c.document
          ? {
            available: c.document.available,
            status: c.document.status,
            downloadAvailable: c.document.downloadAvailable,
            filename: c.document.filename ?? null,
            pages: c.document.pages ?? 0,
            sha256: c.document.sha256 ?? null,
            version: c.document.version ?? 0,
            signatureRequired: c.document.signatureRequired ?? null,
            signatureStatus: c.document.signatureStatus ?? null,
            signedAt: c.document.signedAt ?? null,
            generatedAt: c.document.generatedAt ?? null,
            downloadPath: c.document.downloadPath ?? null,
          }
          : { available: false, status: 'NONE', downloadAvailable: false },
        reference: c.reference ?? null,
        createdAt: c.createdAt ?? null,
        activatedAt: c.activatedAt ?? null,
        pricing: {
          subscription: c.pricing?.subscription ?? null,
          launchFee: c.pricing?.launchFee ?? null,
        },
        /**
         * LE TAUX DE TVA EFFECTIF (L10.5) — reflété, jamais complété.
         *
         * `?? null` et surtout pas `?? 20` : une projection antérieure à ce lot
         * n'en porte aucun, et supposer un taux ferait facturer un client à une
         * valeur que personne n'a décidée. `null` se lit « inconnu », et la
         * facturation d'une prestation refuse alors explicitement.
         */
        taxRate: Number.isFinite(c.taxRate) ? c.taxRate : null,
        /**
         * LE DÉLAI DE GRÂCE (L10.6B-1) — reflété, jamais complété.
         *
         * `?? null` et surtout pas `?? 7` : supposer une clémence que personne
         * n'a accordée ferait fermer un site à une date que nul n'a décidée.
         */
        paymentGraceDays: Number.isInteger(c.paymentGraceDays) ? c.paymentGraceDays : null,
        // L'histoire est REMPLACÉE d'un bloc, comme le reste de la
        // photographie : le projet publie la liste, le Panel la reflète.
        previousContracts: (c.previousContracts ?? []).map((p) => ({
          sourceContractId: p.sourceContractId,
          status: p.status,
          reference: p.reference ?? null,
          createdAt: p.createdAt ?? null,
          activatedAt: p.activatedAt ?? null,
          endedAt: p.endedAt ?? null,
          cancellationReason: p.cancellationReason ?? null,
          document: p.document ?? { available: false, status: 'NONE', downloadAvailable: false },
          pricing: {
            subscription: p.pricing?.subscription ?? null,
            launchFee: p.pricing?.launchFee ?? null,
          },
        })),
        sourceModifiedAt: change.modifiedAt,
        ...stamp,
      },
    },
    { upsert: true },
  );
}

/**
 * TEAM_MEMBER — un membre de l'équipe du projet.
 *
 * Contrairement à l'identité et au contrat, c'est une COLLECTION : une ligne
 * par membre, identifiée par l'`entityId` que le projet lui donne. Un
 * tombstone efface la ligne — c'est ainsi qu'un départ se propage.
 */
async function applyTeamMember({ projectId, change, stamp }) {
  if (change.deleted) {
    await PanelProjectMember.deleteOne({ projectId, entityId: change.entityId });
    return;
  }
  const m = parsePayload(teamMemberPayloadSchema, change.payload, 'TEAM_MEMBER');
  await PanelProjectMember.updateOne(
    { projectId, entityId: change.entityId },
    {
      $set: {
        projectId,
        entityId: change.entityId,
        sourceUserId: m.sourceUserId,
        email: m.email,
        name: m.name ?? null,
        role: m.role,
        createdAt: m.createdAt ?? null,
        sourceModifiedAt: change.modifiedAt,
        ...stamp,
      },
    },
    { upsert: true },
  );

  // ── LE ROSTER NE SE MÉLANGE PAS ENTRE GÉNÉRATIONS ──────────────────────
  // Un membre est une LIGNE : rien ne l'efface sinon un tombstone nommant son
  // `entityId`. Après un redéploiement PROD → TEST, la nouvelle instance ne
  // connaît pas les membres de l'ancienne : elle ne peut pas les enterrer, et
  // ils restaient donc affichés comme l'équipe actuelle.
  //
  // Dès qu'un membre d'une NOUVELLE génération arrive, les lignes des
  // générations précédentes sont retirées : c'est la photographie qui remplace
  // la photographie, et non deux équipes superposées.
  if (stamp?.sourceGeneration) {
    await PanelProjectMember.deleteMany({
      projectId,
      sourceGeneration: { $ne: stamp.sourceGeneration },
    });
  }
}

/**
 * PROJECT_SITE_STATUS — « ce site est-il accessible, et sinon pourquoi ? »
 *
 * Un seul enregistrement par instance : c'est un ÉTAT, pas un journal. Le
 * Panel ne recalcule RIEN — ni le verdict, ni la cause. Les deux viennent du
 * projet, qui est seul à connaître ses contrats vivants et ses suspensions
 * techniques. En déduire quoi que ce soit ici rouvrirait précisément l'écart
 * que cette projection ferme.
 *
 * Un tombstone efface la ligne : « je ne sais plus » est une réponse, un
 * ancien statut affiché comme courant n'en est pas une.
 */
async function applyProjectSiteStatus({ projectId, change, stamp }) {
  if (change.deleted) {
    await PanelProjectSiteStatus.deleteOne({ projectId });
    return;
  }
  const s = parsePayload(siteStatusPayloadSchema, change.payload, 'PROJECT_SITE_STATUS');
  await PanelProjectSiteStatus.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        accessible: s.accessible,
        status: s.status,
        suspensionSource: s.suspensionSource,
        reason: s.reason ?? null,
        suspendedAt: s.suspendedAt ?? null,
        contractProtectionEnabled: s.contractProtectionEnabled,
        technicalSuspension: s.technicalSuspension,
        /**
         * REFLÉTÉ, jamais complété (L10.6A). `undefined` sur une projection
         * antérieure au lot : le champ reste absent, et la confirmation
         * financière refuse de conclure plutôt que de supposer.
         */
        ...(s.causes ? { causes: s.causes } : {}),
        sourceModifiedAt: change.modifiedAt,
        ...stamp,
      },
    },
    { upsert: true },
  );

  /**
   * ── LA BOUCLE DE CONFIRMATION SE FERME ICI (L10.6A) ─────────────────────
   *
   * Ce projecteur est le POINT UNIQUE par lequel un état de site entre dans le
   * Panel — que le projet l'ait poussé en temps réel ou que le Panel l'ait tiré
   * après une absence. Y brancher la confirmation garantit que les deux voies
   * appliquent exactement la même logique métier : il n'y en a qu'une.
   *
   * Le cœur a déjà écarté les snapshots plus anciens (dernier-écrit-gagne) : un
   * retardataire n'arrive jamais jusqu'ici, et ne peut donc pas faire régresser
   * une confirmation acquise.
   *
   * Best-effort : un état de site correctement projeté ne doit pas être perdu
   * parce qu'un incident financier n'a pas pu être mis à jour. Le snapshot
   * suivant reprendra.
   */
  await confirmerDefautsDePaiement({ projectId, snapshot: { ...s, sourceModifiedAt: change.modifiedAt } })
    .catch(() => null);
}

/**
 * Import DYNAMIQUE : la table des projecteurs ne doit pas tirer le domaine
 * financier dans son graphe de chargement. Elle l'appelle, elle n'en dépend pas.
 */
async function confirmerDefautsDePaiement(args) {
  const { confirmFromSiteStatus } = await import(
    '../finance/paymentDefaults/paymentDefaults.service.js'
  );
  return confirmFromSiteStatus(args);
}

/** Table FERMÉE — le cœur n'applique que ce qui y figure. */
/**
 * DÉCLARATION D'USAGE DES MODÈLES D'E-MAIL — et sa réconciliation IMMÉDIATE.
 *
 * ══ POURQUOI LA RÉCONCILIATION EST ICI, DANS LE PROJECTEUR ═════════════════
 *
 * Elle aurait pu attendre le prochain démarrage du Panel. Le scénario qui
 * l'interdit est le seul qui compte vraiment : un projet DUPLIQUÉ, appairé à
 * l'instant, qui envoie son premier e-mail dans la minute — l'activation du
 * premier accès d'administration. Différer la pose, c'est refuser ce message-là,
 * et le refuser au pire moment de la vie d'un projet.
 *
 * Le pont garantit déjà tout ce qu'il faut pour que ce soit sûr : l'écriture
 * arrive une seule fois (anti-écho par `writeId`), dans l'ordre (LWW sur
 * `modifiedAt`), et une livraison rejouée est un non-événement.
 *
 * ══ LA RÉVISION DÉCIDE S'IL Y A QUELQUE CHOSE À FAIRE ══════════════════════
 *
 * Un projet redémarre plusieurs fois par jour et redéclare à chaque fois. Sans
 * cette comparaison, chaque démarrage produirait une écriture, une entrée de
 * journal et une réconciliation complète — du bruit dans lequel un vrai
 * changement finirait par se perdre. Révision identique ⇒ on rafraîchit
 * l'horodatage de réception, et rien d'autre.
 *
 * ══ UNE RÉCONCILIATION QUI ÉCHOUE NE PERD PAS LA DÉCLARATION ═══════════════
 *
 * La projection est écrite AVANT : si la pose des instances échoue à mi-chemin,
 * l'état désiré est tout de même enregistré, et le filet de démarrage
 * (`reconcileProjectTemplates`) le rattrapera. L'inverse — réconcilier puis
 * écrire — perdrait la déclaration sur la première panne.
 */
async function applyProjectEmailTemplateUsage({ projectId, change, stamp }) {
  if (change.deleted) {
    /**
     * Le projet retire sa déclaration entière. On efface la PROJECTION — plus
     * aucun modèle n'est actif pour lui — mais JAMAIS les instances : le
     * contenu écrit par un humain ne disparaît pas parce qu'un runtime s'est
     * tu. Le voir disparaître de l'écran est réversible ; le perdre ne l'est pas.
     */
    await PanelProjectEmailTemplateUsage.deleteOne({ projectId });
    return;
  }

  const u = parsePayload(emailTemplateUsagePayloadSchema, change.payload, 'PROJECT_EMAIL_TEMPLATE_USAGE');
  const connue = await PanelProjectEmailTemplateUsage.findOne({ projectId }).select('revision').lean();
  const inchangee = connue?.revision === u.revision;

  await PanelProjectEmailTemplateUsage.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        templateCodes: u.templateCodes,
        revision: u.revision,
        declaredAt: u.declaredAt ?? null,
        sourceModifiedAt: change.modifiedAt,
        ...stamp,
      },
    },
    { upsert: true },
  );

  if (inchangee) return;

  /**
   * L'import est DYNAMIQUE, et c'est délibéré : le service de modèles importe
   * le registre, le validateur et le moteur de rendu. Le charger au sommet de
   * ce fichier ferait entrer tout le domaine e-mail dans le noyau de
   * synchronisation, que la garde d'architecture veut mince.
   */
  const { reconcileDeclaredProjectEmailTemplates } = await import(
    '../email/panelEmailTemplate.service.js'
  );
  const rapport = await reconcileDeclaredProjectEmailTemplates(projectId, u.templateCodes, {
    actor: { userId: 'bridge', userEmail: '' },
  });

  await PanelProjectEmailTemplateUsage.updateOne(
    { projectId },
    {
      $set: {
        lastReconciliation: {
          at: nowIso(),
          provisioned: rapport.provisioned,
          existing: rapport.existing,
          unknown: rapport.unknown,
          forbidden: rapport.forbidden,
          removed: rapport.removed,
        },
      },
    },
  );
}

export const PROJECTORS = Object.freeze({
  DIAGNOSTIC: applyDiagnostic,
  PROJECT_PRESENTATION: applyProjectPresentation,
  CONTRACT: applyContract,
  TEAM_MEMBER: applyTeamMember,
  PROJECT_SITE_STATUS: applyProjectSiteStatus,
  PROJECT_EMAIL_TEMPLATE_USAGE: applyProjectEmailTemplateUsage,
});

/** Types réellement appliqués — dérivés de la table, jamais réécrits à côté. */
export const PROJECTED_ENTITY_TYPES = Object.freeze(Object.keys(PROJECTORS));

/**
 * LESQUELLES DE CES ENTITÉS SONT UN ÉTAT MÉTIER — la question se tranche ici.
 *
 * Recevoir l'une d'elles signifie que le Panel détient une photographie neuve
 * de ce que le projet EST. C'est cela, et seulement cela, qui date la
 * fraîcheur métier d'une fiche (`runtime.lastBusinessSyncAt`).
 *
 * `DIAGNOSTIC` en est exclu : c'est un journal d'échanges, écrit par les
 * sondes du pont. Le laisser avancer la fraîcheur ferait paraître « à jour »
 * une fiche dont on n'a jamais reçu autre chose qu'un ping de test — ce qui
 * est précisément le mensonge qu'on cherche à rendre impossible.
 *
 * La liste est DÉRIVÉE de la table des projecteurs : ajouter INVOICE ou EVENT
 * l'inclura d'office, et il faudra un geste délibéré pour l'en retirer.
 */
const NON_METIER = Object.freeze(['DIAGNOSTIC']);
export const BUSINESS_ENTITY_TYPES = Object.freeze(
  Object.keys(PROJECTORS).filter((t) => !NON_METIER.includes(t)),
);

/** `true` si recevoir cette entité prouve un état métier neuf. */
export function isBusinessEntity(entityType) {
  return BUSINESS_ENTITY_TYPES.includes(entityType);
}

/**
 * « La projection de cette entité existe-t-elle pour ce projet ? »
 *
 * ── À QUOI CELA SERT ────────────────────────────────────────────────────────
 * Le cœur écarte une écriture déjà vue (`DUPLICATE`) ou plus ancienne que
 * l'état connu (`IGNORED`). Ces deux raccourcis supposent que ce qui a été
 * accusé a été ÉCRIT. Cette supposition peut être fausse : une écriture
 * refusée pour un payload invalide, puis corrigée à la source, revient avec un
 * état déjà consigné ; l'accusé retire alors l'écriture de la file du projet
 * sans que rien ne soit jamais projeté. La donnée est perdue en silence, et
 * plus rien ne la ramène.
 *
 * On vérifie donc, avant de se taire, que la projection est bien là. Sinon on
 * applique — c'est une RÉPARATION, pas un doublon.
 *
 * Un type absent de cette table (`DIAGNOSTIC`, qui est un journal, pas un
 * état) garde la déduplication stricte : le rejouer créerait des lignes en
 * double.
 */
export const PROJECTION_PRESENT = Object.freeze({
  PROJECT_PRESENTATION: ({ projectId }) => PanelProjectPresentation.exists({ projectId }),
  CONTRACT: ({ projectId }) => PanelProjectContract.exists({ projectId }),
  PROJECT_SITE_STATUS: ({ projectId }) => PanelProjectSiteStatus.exists({ projectId }),
  PROJECT_EMAIL_TEMPLATE_USAGE: ({ projectId }) => PanelProjectEmailTemplateUsage.exists({ projectId }),
  // Une collection : la présence se juge SUR LA LIGNE, pas sur le projet.
  TEAM_MEMBER: ({ projectId, change }) =>
    PanelProjectMember.exists({ projectId, entityId: change.entityId }),
});

/**
 * Faut-il appliquer alors que le cœur s'apprêtait à passer son tour ?
 *
 * Un tombstone est exclu : « absente » est précisément l'état qu'il vise, le
 * réappliquer sans fin n'apprendrait rien.
 */
export async function needsRepair(projectId, change) {
  if (change.deleted === true) return false;
  const probe = PROJECTION_PRESENT[change.entityType];
  if (!probe) return false;
  return !(await probe({ projectId, change }));
}

export default { PROJECTORS, PROJECTED_ENTITY_TYPES, ENTITY_PAYLOAD_INVALID };
