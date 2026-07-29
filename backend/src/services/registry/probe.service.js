// SONDE D'URL — Phase 4, LOT 5.
//
// « Renseigner une URL, et le Panel découvre. »
//
// ── CE QUI EST RÉELLEMENT POSSIBLE AVANT L'APPAIRAGE ────────────────────────
// Une seule route du ProjectBridge est publique : `GET /ping`. Tout le reste
// (identité, Manifest, santé, opérations) exige le bridgeToken, qui n'existe
// qu'une fois l'appairage fait. C'est délibéré : un projet ne doit pas
// divulguer sa composition à qui connaît son URL.
//
// La sonde fait donc exactement ce qui est permis, et le dit :
//   · l'adresse répond-elle ?
//   · est-ce bien un ProjectBridge ?
//   · quelle version de contrat parle-t-il, et sommes-nous compatibles ?
//   · est-il déjà appairé à un Panel ?
//
// C'est peu, mais c'est ce qui évite les trois échecs les plus courants d'un
// premier appairage : mauvaise URL, contrat majeur incompatible, projet déjà
// appairé ailleurs. La découverte COMPLÈTE vient après, par l'action
// DISCOVER_PROJECT — quand le Panel a le droit de la demander.
import ProjectBridgeClient from '../../bridge/ProjectBridgeClient.js';
import {
  CONTRACT_VERSION,
  LOCAL_ERROR_CODES,
  isContractCompatible,
} from '../../bridge/bridgeContract.js';

const majorOf = (version) => String(version ?? '').split('.')[0] || '?';

/**
 * Sonde une URL de projet.
 *
 * Ne lève jamais : une URL injoignable est un RÉSULTAT de sonde, pas une
 * erreur d'exécution. L'écran doit pouvoir l'afficher tranquillement.
 *
 * @returns {{reachable, isProjectBridge, contractVersion, compatible, alreadyPaired, reason, checkedAt}}
 */
export async function probeProjectUrl(url, { timeoutMs = 8_000, fetchImpl } = {}) {
  const checkedAt = new Date().toISOString();
  const base = { url, reachable: false, isProjectBridge: false, contractVersion: null, compatible: false, alreadyPaired: null, checkedAt };

  let normalized;
  try {
    normalized = new URL(String(url).trim());
    if (!/^https?:$/.test(normalized.protocol)) throw new Error('protocole');
  } catch {
    return { ...base, reason: `Adresse refusée parce que « ${url} » n’est pas une URL http(s) valide.` };
  }

  const client = new ProjectBridgeClient({
    baseUrl: normalized.origin + normalized.pathname.replace(/\/+$/, ''),
    timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  let probe;
  try {
    probe = await client.probe();
  } catch (err) {
    // On distingue « rien au bout du fil » de « quelque chose répond, mais
    // ce n'est pas un pont » : les deux se corrigent différemment.
    const unreachable = err.code === LOCAL_ERROR_CODES.PROJECT_UNREACHABLE;
    return {
      ...base,
      reachable: !unreachable,
      reason: unreachable
        ? `Aucune réponse de ${normalized.origin} : vérifiez l’adresse, le DNS et que le backend est démarré.`
        : `${normalized.origin} répond, mais pas comme un ProjectBridge (${err.code ?? err.message}).`,
    };
  }

  const contractVersion = probe.contractVersion;
  const compatible = contractVersion ? isContractCompatible(contractVersion) : false;
  const isProjectBridge = probe.data?.service === 'project-bridge' || contractVersion !== null;

  return {
    ...base,
    reachable: true,
    isProjectBridge,
    contractVersion,
    compatible,
    // Le ping public expose `paired` : un projet déjà appairé ailleurs
    // refuserait le bootstrap, autant le savoir avant de brûler un code.
    alreadyPaired: probe.data?.paired ?? null,
    panelContractVersion: CONTRACT_VERSION,
    reason: describeProbe({ contractVersion, compatible, alreadyPaired: probe.data?.paired ?? null }),
  };
}

function describeProbe({ contractVersion, compatible, alreadyPaired }) {
  if (!contractVersion) {
    return 'Le projet répond mais n’annonce aucune version de contrat : appairage impossible à garantir.';
  }
  if (!compatible) {
    return `Appairage impossible parce que le projet parle le contrat ${contractVersion} (majeure ${majorOf(contractVersion)}) et le Panel le ${CONTRACT_VERSION} (majeure ${majorOf(CONTRACT_VERSION)}) : les majeures doivent concorder.`;
  }
  if (alreadyPaired === true) {
    return `Projet joignable et compatible (contrat ${contractVersion}), mais DÉJÀ APPAIRÉ : il doit être désappairé de son Panel actuel avant d’être repris.`;
  }
  return `Projet joignable, ProjectBridge confirmé, contrat ${contractVersion} compatible : prêt pour l’appairage.`;
}

export default { probeProjectUrl };
