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
