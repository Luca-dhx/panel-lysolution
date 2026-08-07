/**
 * INSTANCE DE PANEL ET ENVIRONNEMENT — le domaine choisit, l'ENV valide.
 *
 * ══ LA QUESTION TRANCHÉE ════════════════════════════════════════════════════
 *
 * Un projet choisit son Panel par l'URL qu'il appelle :
 *
 *   panel-test.exemple.com   → instance TEST
 *   panel.exemple.com        → instance PROD
 *
 * C'est le bon mécanisme : deux instances déployées, deux domaines, deux
 * bases. Mais une URL est une chaîne saisie dans un `.env`. Elle prouve
 * QUELLE MACHINE répond, jamais à quel monde elle appartient.
 *
 * ══ L'ACCIDENT QUE CE FICHIER REND IMPOSSIBLE ═══════════════════════════════
 *
 * Une adresse recopiée d'un projet à l'autre, une variable oubliée lors d'une
 * promotion TEST → PROD, et la production d'un client s'appaire au Panel de
 * recette. Rien n'aurait échoué : jetons valides, battements reçus,
 * projections appliquées. Le Panel de recette aurait simplement affiché,
 * durablement, les contrats et l'équipe d'un site en production.
 *
 * Les deux côtés DÉCLARENT donc leur environnement, et le bootstrap compare.
 * Aucune correction automatique, dans aucun sens : rapprocher TEST de PROD
 * « pour que ça marche » serait produire exactement l'accident visé.
 */
import {
  check, connectTestDatabase, finish, rejectsWith, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const pairing = await import('../backend/src/services/pairing/pairing.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const config = (await import('../backend/src/config/env.js')).default;
const { CONTRACT_VERSION } = await import('../backend/src/bridge/bridgeContract.js');

/** Cette instance de Panel sert TEST — c'est le harnais qui le fixe. */
check('l’instance de Panel sous test sert bien TEST', config.env === 'TEST');

const dto = (pairingCode, environment) => ({
  contractVersion: CONTRACT_VERSION,
  projectKey: 'garage-exemple',
  projectName: 'Garage Exemple',
  environment,
  softwareVersion: '1.0.0',
  publicBackendUrl: 'https://api.garage-exemple.fr',
  pairingCode,
});

async function ficheAvecCode(url, name) {
  const { record, pairingCode } = await registre.declareProject({
    publicBackendUrl: url, projectName: name, bridgeIdentity: null, environment: null,
  });
  return { record, pairingCode };
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('APPAIRAGE VALIDE — le projet et le Panel parlent du même monde');
{
  await registryStore.clear();
  const { pairingCode } = await ficheAvecCode('https://api.projet-test.fr', 'Projet Test');

  const res = await pairing.bootstrap(dto(pairingCode, 'TEST'));
  check('un projet TEST s’appaire au Panel TEST', typeof res.bridgeToken === 'string');

  const fiche = (await registryStore.list())[0];
  check('…et son environnement est enregistré tel qu’il l’a déclaré',
    fiche.runtime.environment === 'TEST');
  check('…sans que le Panel ne l’ait deviné depuis un domaine',
    !fiche.runtime.publicBackendUrl.includes('test') || fiche.runtime.environment === 'TEST');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('APPAIRAGE REFUSÉ — un projet PROD ne se relie pas à un Panel TEST');
{
  await registryStore.clear();
  const { pairingCode } = await ficheAvecCode('https://api.projet-prod.fr', 'Projet Prod');

  check('le refus est explicite et nommé', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(dto(pairingCode, 'PROD'))),
    'BRIDGE_ENVIRONMENT_MISMATCH',
  ));

  /**
   * ── LE CODE N'EST PAS CONSOMMÉ ────────────────────────────────────────────
   * Le refus arrive AVANT la consommation : l'opérateur corrige l'adresse du
   * Panel dans son `.env` et réessaie avec le même code. Griller le code
   * l'obligerait à en regénérer un pour une erreur de configuration.
   */
  const fiche = (await registryStore.list())[0];
  check('…et le code d’appairage reste utilisable',
    fiche.pairing.pairingCodeHash !== null);
  check('…la fiche n’est pas appairée', fiche.pairing.status === 'DECLARED');
  check('…aucun jeton n’a été posé', fiche.pairing.bridgeTokenHash === null);
  check('…et aucun environnement n’a été enregistré',
    fiche.runtime.environment === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUNE CORRECTION AUTOMATIQUE, DANS AUCUN SENS');
{
  await registryStore.clear();
  const { pairingCode } = await ficheAvecCode('https://api.jamais-corrige.fr', 'Jamais Corrigé');

  await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(dto(pairingCode, 'PROD'))),
    'BRIDGE_ENVIRONMENT_MISMATCH',
    'un PROD n’est jamais rapproché de TEST',
  );

  const fiche = (await registryStore.list())[0];
  check('le Panel n’a rien réécrit pour « faire marcher » l’appairage',
    fiche.runtime.environment === null && fiche.pairing.status === 'DECLARED');

  // Et le même code fonctionne dès que le projet dit la vérité.
  const res = await pairing.bootstrap(dto(pairingCode, 'TEST'));
  check('…le même code réussit une fois l’environnement corrigé',
    typeof res.bridgeToken === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ENVIRONNEMENT NE SE DEVINE PAS DEPUIS UN NOM DE DOMAINE');
{
  await registryStore.clear();
  /**
   * « garage-test.fr » est le domaine d'un vrai client dont la raison sociale
   * contient « test ». Déduire l'environnement d'un `hostname.includes('test')`
   * classerait sa PRODUCTION en recette. On ne lit que ce qui est déclaré.
   */
  const { pairingCode } = await ficheAvecCode('https://api.garage-test.fr', 'Garage Test SARL');

  const res = await pairing.bootstrap(dto(pairingCode, 'TEST'));
  check('un domaine contenant « test » n’influence aucune décision',
    typeof res.bridgeToken === 'string');

  const fiche = (await registryStore.list())[0];
  check('…seule la déclaration compte', fiche.runtime.environment === 'TEST');

  const source = (await import('node:fs')).readFileSync(
    new URL('../backend/src/services/pairing/pairing.service.js', import.meta.url), 'utf8',
  );
  // On ignore les COMMENTAIRES : ils citent volontairement le mauvais patron
  // pour dire qu'on ne le fait pas. Seul le code exécutable est jugé.
  const codeExecutable = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ');
  check('aucune déduction d’environnement depuis un hôte dans le code',
    !/includes\(\s*['"]test['"]\s*\)/i.test(codeExecutable));
  check('la comparaison porte sur les deux valeurs DÉCLARÉES',
    /dto\.environment !== config\.env/.test(source));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DEUX INSTANCES D’UN MÊME PROJET — isolation intégrale');
{
  await registryStore.clear();

  // Sur CETTE instance (TEST), seule la recette peut s'appairer. La production
  // s'appairera sur l'autre instance de Panel, avec son propre code et son
  // propre jeton : c'est tout l'objet de la séparation.
  const a = await ficheAvecCode('https://api.iso-test.fr', 'Iso Recette');
  const resA = await pairing.bootstrap({ ...dto(a.pairingCode, 'TEST'), projectKey: 'iso' });

  const b = await ficheAvecCode('https://api.iso-autre.fr', 'Iso Production');
  check('la production est refusée par le Panel de recette', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap({ ...dto(b.pairingCode, 'PROD'), projectKey: 'iso' })),
    'BRIDGE_ENVIRONMENT_MISMATCH',
  ));

  const fiches = await registryStore.list();
  const appairee = fiches.find((f) => f.pairing.status === 'PAIRED');
  const enAttente = fiches.find((f) => f.pairing.status === 'DECLARED');

  check('un seul jeton existe sur cette instance',
    fiches.filter((f) => f.pairing.bridgeTokenHash).length === 1);
  check('…celui de la recette', appairee.runtime.environment === 'TEST');
  check('…et l’autre fiche reste intacte',
    enAttente.pairing.bridgeTokenHash === null && enAttente.runtime.environment === null);
  check('les deux jetons ne pourraient jamais être le même',
    resA.bridgeToken !== enAttente.pairing.bridgeTokenEncrypted);
}

await stopMemoryMongo();
finish();
