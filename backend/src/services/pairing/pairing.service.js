// Appairage : codes à usage unique, bootstrap, authentification des requêtes
// entrantes, révocation. Voir docs/architecture/05_PAIRING.md.
import crypto from 'node:crypto';
import config from '../../config/env.js';
import {
  BRIDGE_ERROR_CODES,
  BridgeError,
  CONTRACT_VERSION,
  isContractCompatible,
  newBridgeId,
  nowIso,
} from '../../bridge/bridgeContract.js';
import {
  decryptSecret,
  encryptSecret,
  sha256Hex,
  timingSafeEqualHex,
} from '../../utils/panelCrypto.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import registryStore from '../registry/registryStore.js';
import { normalizeBackendUrl } from '../registry/projectIdentity.js';
import { validateManifest } from '../manifest/manifest.schema.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';

// Alphabet sans ambiguïté (pas de 0/O, 1/I/L) : le code est fait pour être
// recopié à la main entre deux écrans.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCodeBlock(length) {
  let block = '';
  for (const byte of crypto.randomBytes(length)) {
    block += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return block;
}

export function generatePairingCode() {
  return `PAIR-${randomCodeBlock(4)}-${randomCodeBlock(4)}-${randomCodeBlock(4)}`;
}

// Pose un nouveau code sur une fiche non appairée. Retourne le code EN CLAIR —
// c'est le seul moment où il existe hors hash.
export async function issuePairingCode(record) {
  if (record.pairing.status === 'PAIRED') {
    throw ApiError.conflict(
      'PANEL_PROJECT_ALREADY_PAIRED',
      'Ce projet est déjà appairé : révoquez l’appairage avant de générer un nouveau code.',
    );
  }
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + config.pairingCodeTtlS * 1000).toISOString();
  record.pairing.status = 'DECLARED';
  record.pairing.pairingCodeHash = sha256Hex(code);
  record.pairing.pairingCodeExpiresAt = expiresAt;
  await registryStore.save(record);
  return { code, expiresAt };
}

async function findRecordByCode(code) {
  const hash = sha256Hex(code);
  for (const record of await registryStore.list()) {
    const stored = record.pairing.pairingCodeHash;
    if (stored && timingSafeEqualHex(stored, hash)) return record;
  }
  return null;
}

// Bootstrap — POST /bridge/v1/pairings. `dto` est déjà validé par le miroir
// zod ; l'ordre des vérifications est contractuel (05_PAIRING.md §2).
export async function bootstrap(dto) {
  if (!isContractCompatible(dto.contractVersion)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED,
      'Version majeure du contrat non supportée.',
    );
  }

  const record = await findRecordByCode(dto.pairingCode);
  const codeInvalid = new BridgeError(
    BRIDGE_ERROR_CODES.PAIRING_CODE_INVALID,
    'Code d’appairage invalide ou expiré.',
  );
  if (!record) throw codeInvalid;
  if (new Date(record.pairing.pairingCodeExpiresAt).getTime() < Date.now()) throw codeInvalid;
  if (record.pairing.status === 'PAIRED') {
    throw new BridgeError(BRIDGE_ERROR_CODES.ALREADY_PAIRED, 'Projet déjà appairé.');
  }

  /**
   * ══ L'ENVIRONNEMENT DOIT CONCORDER — et la question se pose EN PREMIER ═════
   *
   * ── POURQUOI CE CONTRÔLE A REMONTÉ ────────────────────────────────────────
   * Il venait après la réconciliation de la clé technique. Or une production
   * qui se présente au Panel de recette annonce la MÊME clé que la recette
   * déjà enregistrée : elle butait donc sur « un autre projet porte déjà cette
   * clé technique » — un message qui parle d'un détail d'index alors que la
   * vraie cause, la seule actionnable, est une adresse de Panel recopiée d'un
   * environnement à l'autre.
   *
   * Le refus le plus fondamental passe donc devant, et la fiche n'est même pas
   * touchée : on refuse un monde étranger avant de discuter d'identifiants.
   *
   * ── CE QUE LE DOMAINE PROUVE, ET CE QU'IL NE PROUVE PAS ───────────────────
   * Un projet choisit SON instance de Panel par l'URL qu'il appelle :
   * `panel-test.exemple.com` ou `panel.exemple.com`. C'est le bon mécanisme —
   * deux instances, deux domaines, deux bases. Mais une URL est une chaîne
   * saisie dans un `.env` : elle prouve QUELLE MACHINE répond, jamais à quel
   * monde elle appartient.
   *
   * Une adresse recopiée d'un projet à l'autre, une variable oubliée lors d'une
   * promotion TEST → PROD, et la production d'un client se relie au Panel de
   * recette. Le pont fonctionnerait parfaitement : jetons valides, battements
   * reçus, projections appliquées. Le Panel de recette afficherait simplement,
   * et durablement, les contrats et l'équipe d'un site en production.
   *
   * ── POURQUOI ON NE DEVINE JAMAIS ─────────────────────────────────────────
   * On ne lit pas `hostname.includes('test')` : un domaine n'est pas une
   * déclaration, et « panel.garage-test.fr » n'est pas une recette. Les deux
   * côtés DISENT leur environnement, et on compare ce qui est dit.
   *
   * ── FAIL CLOSED ──────────────────────────────────────────────────────────
   * Aucune correction automatique, dans aucun sens. Rapprocher TEST de PROD
   * « pour que ça marche » serait précisément produire l'accident qu'on
   * empêche. On refuse, on nomme les deux valeurs, et l'opérateur corrige son
   * `.env`.
   *
   * ── C'EST AUSSI CE QUI FONDE LA DOCTRINE MONO-INSTANCE ───────────────────
   * Une instance de Panel ne peut héberger QUE des fiches de son propre
   * environnement. Un écran qui regrouperait « la recette et la production
   * d'un même client » ne pourrait donc jamais afficher deux fiches vivantes :
   * la seconde serait toujours une fiche jamais appairée.
   */
  if (dto.environment !== config.env) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.ENVIRONMENT_MISMATCH,
      `Ce projet se declare en ${dto.environment} alors que cette instance du Panel sert `
      + `${config.env}. Verifiez l'adresse du Panel configuree dans le projet : chaque `
      + 'environnement a la sienne.',
    );
  }

  // ── RÉCONCILIATION DE LA CLÉ ─────────────────────────────────────────────
  // Le PROJET est propriétaire de sa clé : il la dérive de son propre nom et
  // l'annonce ici. Le Panel, lui, ne fait que la pré-calculer au moment de la
  // déclaration — parfois sans avoir pu la lire (projet en contrat 1.3.x, dont
  // le ping ne l'annonce pas encore). Exiger l'égalité stricte revenait donc à
  // refuser l'appairage sous le motif « code invalide » chaque fois que la
  // dérivation locale différait — un message qui n'a jamais désigné la vraie
  // cause, et que l'utilisateur ne pouvait corriger qu'en devinant la clé.
  //
  // Le secret d'appairage reste le CODE, à usage unique et déjà vérifié
  // ci-dessus : c'est lui qui prouve qu'on parle au bon projet. La clé n'est
  // qu'un identifiant technique — on l'ADOPTE au lieu de la contester.
  // Rien à adopter si le projet n'annonce pas de clé : on garde la nôtre
  // plutôt que d'écraser une valeur connue par une absence.
  const announcedKey = typeof dto.projectKey === 'string' ? dto.projectKey.trim() : '';

  /**
   * ══ L'IDENTITÉ LOGIQUE N'EST PLUS POSÉE ICI ═══════════════════════════════
   *
   * L'appairage écrivait `record.logicalProjectKey = announcedKey`, pour
   * regrouper à l'écran la recette et la production d'un même client. La
   * doctrine a changé : une fiche du Panel EST une instance appairée, et rien
   * ne regroupe plus deux fiches.
   *
   * Cette écriture était de toute façon sans emploi réel ici : le contrôle de
   * concordance d'environnement, quelques lignes plus bas, interdit à un Panel
   * de recette d'appairer une instance de production. Deux « sœurs » ne
   * pouvaient donc jamais coexister appairées dans le même Panel.
   *
   * Le champ reste en base sur les fiches qui le portent — on ne détruit
   * aucune donnée historique — mais plus rien ne l'écrit ni ne le lit.
   *
   * ══ CE QUI SUBSISTE : LA RÉCONCILIATION DE LA CLÉ TECHNIQUE ═══════════════
   *
   * Le projet reste propriétaire de sa clé et le Panel l'adopte, sauf si une
   * AUTRE fiche la détient déjà — l'index est unique, et deux fiches ne
   * peuvent pas la partager. Anti-collision pur : cette clé ne détermine
   * aucun périmètre métier.
   */
  if (announcedKey.length > 0 && announcedKey !== record.projectKey) {
    const collision = await registryStore.getByKey(announcedKey);
    if (collision && collision.projectId !== record.projectId) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
        'Un autre projet du registre porte déjà cette clé technique.',
      );
    }
    logger.info(
      `Clé réconciliée à l’appairage : « ${record.projectKey} » -> « ${announcedKey} » (le projet fait foi).`,
    );
    record.projectKey = announcedKey;
    record.projectKeySource = 'RECONCILED';
  }

  // Contrat ≥ 1.1.0 : Manifest joint au bootstrap. Canal OFFICIEL — validé
  // AVANT de consommer le code : un Manifest non conforme refuse le bootstrap
  // sans griller le code d'appairage. La forme a déjà été vérifiée par le
  // miroir ; on vérifie ici la majeure du format et la cohérence d'identité.
  let bridgeManifest = null;
  if (dto.manifest !== undefined) {
    const validation = validateManifest(dto.manifest);
    if (!validation.valid) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
        'Manifest joint au bootstrap non conforme.',
        { issues: validation.errors },
      );
    }
    // La cohérence reste EXIGÉE, mais contre la clé que le projet vient
    // d'annoncer : un Manifest qui se contredit lui-même est un vrai défaut.
    if (validation.manifest.project.key !== record.projectKey) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
        'Le Manifest joint ne correspond pas au projet appairé (project.key).',
      );
    }
    bridgeManifest = validation.manifest;
  }

  // Le code n'est consommé QU'ICI : tous les refus ci-dessus laissent la fiche
  // intacte, donc le code réutilisable. On mémorise le hash validé pour que
  // l'écriture finale puisse exiger qu'il soit TOUJOURS en place — sans quoi
  // deux bootstraps simultanés porteurs du même code réussiraient tous les deux.
  const consumedHash = record.pairing.pairingCodeHash;
  record.pairing.pairingCodeHash = null;
  record.pairing.pairingCodeExpiresAt = null;

  const bridgeToken = crypto.randomBytes(32).toString('hex');
  record.pairing.status = 'PAIRED';
  record.pairing.bridgeTokenHash = sha256Hex(bridgeToken);
  record.pairing.bridgeTokenEncrypted = encryptSecret(bridgeToken);
  record.pairing.pairedAt = nowIso();
  record.pairing.revokedAt = null;

  record.runtime.environment = dto.environment;
  record.runtime.softwareVersion = dto.softwareVersion;
  record.runtime.contractVersion = dto.contractVersion;
  // L'adresse est stockée NORMALISÉE (comparaison de doublons exacte). Un
  // bootstrap qui n'en annonce aucune ne doit pas effacer celle qu'on a
  // saisie à la déclaration : on ne remplace que ce qui est réellement dit.
  const announcedUrl = normalizeBackendUrl(dto.publicBackendUrl);
  if (announcedUrl) record.runtime.publicBackendUrl = announcedUrl;

  // Le Manifest reçu par le pont fait foi : il remplace toute saisie manuelle.
  if (bridgeManifest !== null) {
    record.manifest = bridgeManifest;
    record.manifestSource = 'BRIDGE';
    record.manifestUpdatedAt = nowIso();
  }
  // CONSOMMATION ATOMIQUE : une seule écriture porte à la fois l'effacement du
  // code et l'appairage complet, et elle n'a lieu que si le code est encore
  // celui qu'on a validé. Un perdant de course n'écrit RIEN et se voit refusé
  // comme n'importe quel code déjà utilisé.
  const consumed = await registryStore.saveIfPairingCodeMatches(record, consumedHash);
  if (!consumed) throw codeInvalid;

  /**
   * LE PROJET ANNONCE SA DESTINATION — le Panel l'enregistre, sans déployer.
   *
   * Le bootstrap est le canal le plus complet : il porte l'URL du backend ET
   * le manifeste, donc les trois adresses. C'est aussi le seul moment où un
   * projet fraîchement appairé peut se faire connaître.
   *
   * Best-effort assumé, comme la découverte descendante plus bas : refuser un
   * appairage parce qu'une adresse est mal formée serait disproportionné, et
   * la première projection poussée rattrapera l'annonce.
   */
  /**
   * ── SEULE L'ADRESSE ANNONCÉE COMPTE ICI, PAS CELLE DU MANIFESTE ───────────
   *
   * `publicBackendUrl` est l'adresse à laquelle le projet dit « rappelez-moi » :
   * c'est l'adresse OPÉRATIONNELLE, celle où il répond à l'instant présent.
   * `manifest.network.urls` est DESCRIPTIF — il peut nommer le domaine visé
   * alors que le service répond ailleurs (recette locale, port éphémère,
   * déploiement en cours). Faire gagner le manifeste ferait appeler une
   * adresse où personne n'écoute, et conclure que le projet est en panne.
   *
   * Les adresses du site et du Manager viendront de la projection poussée,
   * qui porte la photographie réseau complète. La destination est donc
   * incomplète à cet instant — et le dit.
   */
  try {
    const { announceDestination } = await import('../registry/projectDestination.service.js');
    await announceDestination({
      record,
      urls: { backend: announcedUrl ?? null },
      source: 'BOOTSTRAP',
    });
  } catch {
    // L'appairage a réussi ; l'annonce se rattrapera au premier push.
  }

  await recordEvent({
    projectId: record.projectId,
    type: EVENT_TYPES.PROJECT_PAIRED,
    source: 'PROJECT',
    summary: `Appairage établi (${dto.environment}, version ${dto.softwareVersion}).`,
    data: { environment: dto.environment, softwareVersion: dto.softwareVersion, contractVersion: dto.contractVersion },
  });
  if (bridgeManifest !== null) {
    await recordEvent({
      projectId: record.projectId,
      type: EVENT_TYPES.MANIFEST_UPDATED,
      source: 'PROJECT',
      summary: 'Manifest transmis par le pont au bootstrap.',
    });
  }

  // ── DÉCOUVERTE DESCENDANTE (contrat >= 1.3.0) ───────────────────────────
  // Le projet repart d'ici en sachant qui il représente et avec quels accès.
  // Sans cela, il resterait aveugle jusqu'à son premier pull — et afficherait
  // entre-temps un site sans identité.
  //
  // Best-effort ASSUMÉ : si l'entreprise n'est pas configurée, ou si la
  // lecture échoue, l'appairage aboutit quand même. Refuser un appairage
  // parce qu'un logo manque serait disproportionné, et le projet rattrapera
  // la configuration au premier pull.
  const discovery = await buildDiscoveryPayload(record);

  return {
    projectId: record.projectId,
    bridgeToken,
    panel: { name: config.panelName, contractVersion: CONTRACT_VERSION },
    ...discovery,
  };
}

/**
 * Charge utile de découverte jointe au bootstrap.
 *
 * `syncCursor` positionne le projet APRÈS les écritures déjà livrées ici :
 * sans lui, son premier pull rejouerait la configuration qu'il vient de
 * recevoir. Ce n'est pas incorrect — la synchronisation est idempotente —
 * mais c'est du travail inutile et un journal trompeur.
 */
async function buildDiscoveryPayload(record) {
  try {
    const [{ getActiveCompany, getPublishedConfiguration }, { apisForProject }, { currentCursor }] =
      await Promise.all([
        import('../company/company.service.js'),
        import('../company/integratedApi.service.js'),
        import('../sync/syncCore.service.js'),
      ]);

    const company = await getActiveCompany();
    const published = company ? await getPublishedConfiguration(company.companyId) : null;

    return {
      company: published?.payload ?? null,
      integratedApis: await apisForProject(record),
      syncCursor: await currentCursor(),
    };
  } catch (err) {
    logger.warn(`Découverte non jointe à l’appairage de ${record.projectKey} : ${err.message}`);
    return {};
  }
}

// Authentifie une requête entrante /bridge/v1 par son Bearer. Retourne la
// fiche du projet appelant, ou null. Comparaison en temps constant.
export async function authenticateBridgeToken(bearerToken) {
  if (!bearerToken) return null;
  const hash = sha256Hex(bearerToken);
  for (const record of await registryStore.list()) {
    if (record.pairing.status !== 'PAIRED') continue;
    const stored = record.pairing.bridgeTokenHash;
    if (stored && timingSafeEqualHex(stored, hash)) return record;
  }
  return null;
}

// Copie sortante du token — réservée au ProjectBridgeClient (jamais une API).
export function getOutboundBridgeToken(record) {
  if (!record.pairing.bridgeTokenEncrypted) return null;
  return decryptSecret(record.pairing.bridgeTokenEncrypted);
}

async function eraseCredentials(record) {
  record.pairing.status = 'REVOKED';
  record.pairing.bridgeTokenHash = null;
  record.pairing.bridgeTokenEncrypted = null;
  record.pairing.pairingCodeHash = null;
  record.pairing.pairingCodeExpiresAt = null;
  record.pairing.revokedAt = nowIso();
  await registryStore.save(record);
  await recordEvent({
    projectId: record.projectId,
    type: EVENT_TYPES.PROJECT_UNPAIRED,
    source: 'PANEL_OBSERVATION',
    severity: 'WARNING',
    summary: 'Appairage révoqué : les credentials de pont ont été effacés.',
  });
}

// Le projet se débranche lui-même (DELETE /bridge/v1/pairings/current).
export async function unpairByProject(record) {
  await eraseCredentials(record);
  return { unpaired: true };
}

// Révocation décidée côté Panel. Retourne le token capturé AVANT effacement,
// pour la notification de courtoisie (best-effort) vers le projet.
export async function revokeFromPanel(record) {
  if (record.pairing.status !== 'PAIRED') {
    await eraseCredentials(record);
    return { previousToken: null };
  }
  const previousToken = getOutboundBridgeToken(record);
  await eraseCredentials(record);
  return { previousToken };
}
