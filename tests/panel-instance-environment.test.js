/**
 * PANEL_ENV ET PROJECT_ENV — DEUX DIMENSIONS, ET UNE SEULE AUTORITÉ.
 *
 * ══ CE QUE CE FICHIER AFFIRMAIT, ET POURQUOI IL A CHANGÉ ════════════════════
 *
 * Il affirmait qu'un projet de PRODUCTION ne pouvait pas s'appairer à un Panel
 * de RECETTE : les deux côtés déclaraient leur monde, et le bootstrap exigeait
 * l'égalité. L'accident visé était réel — une adresse de Panel recopiée d'un
 * environnement à l'autre, et la production d'un client se reliant au Panel
 * d'essai sans que rien n'échoue.
 *
 * Mais la règle interdisait du même geste ce qu'un plan de contrôle doit savoir
 * faire : ADMINISTRER UNE PRODUCTION. Administrer n'est pas agir en son nom.
 * Deux choses distinctes avaient été soudées :
 *
 *     PANEL_ENV     le monde où tourne le PLAN DE CONTRÔLE
 *     PROJECT_ENV   le monde où tourne le PROJET administré
 *
 * ══ CE QUI TIENT LA PORTE MAINTENANT ════════════════════════════════════════
 *
 * L'environnement d'un projet est ÉPINGLÉ SUR SA FICHE — déclaré par
 * l'opérateur, ou fixé au seul instant où le projet prouve son identité par un
 * code à usage unique — et il ne bouge plus jamais. Un battement ne le déplace
 * pas. Un corps de requête encore moins.
 *
 * Le refus d'origine SURVIT donc entièrement : une production qui se présente
 * avec le code d'une fiche enregistrée en recette est toujours rejetée, et
 * l'`.env` recopié toujours attrapé. Ce qui disparaît, c'est l'exigence que le
 * Panel vive dans le même monde que ce qu'il administre.
 *
 * ══ ET LA RAISON POUR LAQUELLE L'ÉPINGLE N'EST PAS DÉCORATIVE ═══════════════
 *
 * Sans elle, lever la contrainte ouvrait un chemin d'ÉLÉVATION : un projet
 * enregistré en recette n'aurait eu qu'à annoncer `PROD` à son battement
 * suivant pour repartir avec les identifiants Stripe, Brevo et OpenSign du
 * monde réel. Un champ à changer, sur un chemin qu'il contrôle. La dernière
 * section de ce fichier ne teste rien d'autre.
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
const {
  authoritativeEnvironmentOf, observedEnvironmentOf, environmentContradicted,
} = await import('../backend/src/services/registry/projectEnvironment.js');
const { resolveInstanceEnvironment } = await import(
  '../backend/src/services/capabilities/invocationContext.js');
const { resolveEnvironmentForProvider } = await import(
  '../backend/src/services/integratedApi/environment.js');

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

async function ficheAvecCode(url, name, environment = null) {
  const { record, pairingCode } = await registre.declareProject({
    publicBackendUrl: url, projectName: name, bridgeIdentity: null, environment,
  });
  return { record, pairingCode };
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN PROJET DE RECETTE S’APPAIRE AU PANEL DE RECETTE');
{
  await registryStore.clear();
  const { pairingCode } = await ficheAvecCode('https://api.projet-test.fr', 'Projet Test');

  const res = await pairing.bootstrap(dto(pairingCode, 'TEST'));
  check('un projet TEST s’appaire au Panel TEST', typeof res.bridgeToken === 'string');

  const fiche = (await registryStore.list())[0];
  check('…son environnement est enregistré tel qu’il l’a déclaré',
    fiche.runtime.environment === 'TEST');
  check('…et ÉPINGLÉ sur la fiche', fiche.declaredEnvironment === 'TEST');
  check('…sans que le Panel ne l’ait deviné depuis un domaine',
    !fiche.runtime.publicBackendUrl.includes('test') || fiche.runtime.environment === 'TEST');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN PROJET DE PRODUCTION S’APPAIRE AUSSI — c’est le cœur du lot');
{
  await registryStore.clear();
  const { pairingCode } = await ficheAvecCode('https://api.projet-prod.fr', 'Projet Prod');

  const res = await pairing.bootstrap(dto(pairingCode, 'PROD'));
  check('un projet PROD s’appaire à un Panel TEST', typeof res.bridgeToken === 'string');

  const fiche = (await registryStore.list())[0];
  check('la fiche est appairée', fiche.pairing.status === 'PAIRED');
  check('…un jeton de pont a bien été posé', fiche.pairing.bridgeTokenHash !== null);
  check('…et son monde ÉPINGLÉ est PROD', fiche.declaredEnvironment === 'PROD');
  check('l’autorité de la fiche est PROD', authoritativeEnvironmentOf(fiche) === 'PROD');

  /**
   * LA PROPRIÉTÉ CENTRALE DE TOUT CE LOT.
   *
   * Le Panel tourne en TEST. Le projet est en PROD. La résolution fournisseur
   * doit rendre PROD — sinon le plan de contrôle imposerait son propre monde à
   * un projet qui n'est pas le sien, et une production consommerait des
   * identifiants d'essai.
   */
  check('le Panel tourne toujours en TEST', config.env === 'TEST');
  const monde = resolveInstanceEnvironment(fiche);
  check('…et le contexte d’invocation du projet porte PROD', monde === 'PROD');
  for (const fournisseur of ['STRIPE', 'BREVO', 'OPENSIGN']) {
    check(`${fournisseur} : Panel TEST + projet PROD → PROD`,
      resolveEnvironmentForProvider(fournisseur, {
        runtimeEnvironment: 'TEST', projectEnvironment: monde,
      }) === 'PROD');
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA MATRICE COMPLÈTE — PANEL_ENV n’entre jamais dans la décision');
{
  /**
   * Quatre combinaisons, une seule règle : pour une capacité exercée POUR UN
   * PROJET, c'est le monde du PROJET qui décide. Les deux premières lignes
   * suffiraient à prouver que le Panel n'impose rien ; les quatre prouvent en
   * plus qu'on n'a pas simplement tout forcé vers PROD.
   */
  const MATRICE = [
    { panel: 'TEST', projet: 'TEST', attendu: 'TEST' },
    { panel: 'TEST', projet: 'PROD', attendu: 'PROD' },
    { panel: 'PROD', projet: 'TEST', attendu: 'TEST' },
    { panel: 'PROD', projet: 'PROD', attendu: 'PROD' },
  ];
  for (const { panel, projet, attendu } of MATRICE) {
    for (const fournisseur of ['STRIPE', 'BREVO', 'OPENSIGN']) {
      check(`${fournisseur} : Panel ${panel} + projet ${projet} → ${attendu}`,
        resolveEnvironmentForProvider(fournisseur, {
          runtimeEnvironment: panel, projectEnvironment: projet,
        }) === attendu);
    }
  }

  /**
   * ── UN FOURNISSEUR À COMPTE UNIQUE N’A PAS DE MONDE ──────────────────────
   * On ne lui en invente pas un pour faire tenir la matrice : Hostinger n'a
   * qu'un portefeuille, et lui attribuer TEST ou PROD dédoublerait un compte
   * qui n'existe qu'une fois.
   */
  for (const { panel, projet } of MATRICE) {
    check(`HOSTINGER : Panel ${panel} + projet ${projet} → aucun monde`,
      resolveEnvironmentForProvider('HOSTINGER', {
        runtimeEnvironment: panel, projectEnvironment: projet,
      }) === null);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA FICHE FAIT LOI — un projet ne choisit pas son monde après coup');
{
  await registryStore.clear();
  /**
   * L'ACCIDENT D'ORIGINE, QUI RESTE INTERDIT.
   *
   * L'opérateur a déclaré cette fiche en recette. Le projet se présente en
   * production — `.env` recopié, promotion mal faite, ou pire. Le refus est le
   * même qu'avant ; seule sa référence a changé.
   */
  const { pairingCode } = await ficheAvecCode('https://api.epingle.fr', 'Épinglé', 'TEST');

  check('un PROD est refusé par une fiche enregistrée en TEST', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(dto(pairingCode, 'PROD'))),
    'BRIDGE_ENVIRONMENT_MISMATCH',
  ));

  /**
   * ── LE CODE N'EST PAS CONSOMMÉ ────────────────────────────────────────────
   * Le refus arrive AVANT la consommation : l'opérateur corrige son `.env` et
   * réessaie avec le même code. Griller le code l'obligerait à en regénérer un
   * pour une erreur de configuration.
   */
  const fiche = (await registryStore.list())[0];
  check('…et le code d’appairage reste utilisable', fiche.pairing.pairingCodeHash !== null);
  check('…la fiche n’est pas appairée', fiche.pairing.status === 'DECLARED');
  check('…aucun jeton n’a été posé', fiche.pairing.bridgeTokenHash === null);
  check('…aucun environnement de runtime n’a été enregistré',
    fiche.runtime.environment === null);
  check('…et l’épingle de l’opérateur n’a pas bougé', fiche.declaredEnvironment === 'TEST');

  // Et le même code fonctionne dès que le projet dit la vérité.
  const res = await pairing.bootstrap(dto(pairingCode, 'TEST'));
  check('le même code réussit une fois l’environnement corrigé',
    typeof res.bridgeToken === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUNE CORRECTION AUTOMATIQUE, DANS AUCUN SENS');
{
  await registryStore.clear();
  const { pairingCode } = await ficheAvecCode('https://api.jamais-corrige.fr', 'Jamais Corrigé', 'PROD');

  await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(dto(pairingCode, 'TEST'))),
    'BRIDGE_ENVIRONMENT_MISMATCH',
    'un TEST n’est jamais rapproché d’une fiche PROD',
  );

  const fiche = (await registryStore.list())[0];
  check('le Panel n’a rien réécrit pour « faire marcher » l’appairage',
    fiche.declaredEnvironment === 'PROD' && fiche.pairing.status === 'DECLARED');
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

  const res = await pairing.bootstrap(dto(pairingCode, 'PROD'));
  check('un domaine contenant « test » n’influence aucune décision',
    typeof res.bridgeToken === 'string');

  const fiche = (await registryStore.list())[0];
  check('…seule la déclaration compte', fiche.declaredEnvironment === 'PROD');

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
  check('la comparaison porte sur la FICHE, plus sur le monde du Panel',
    /dto\.environment !== epingle/.test(codeExecutable));
  check('…et `config.env` n’entre plus dans la décision d’appairage',
    !/dto\.environment\s*!==\s*config\.env/.test(codeExecutable));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE BATTEMENT NE PROMEUT PAS — le chemin d’élévation est fermé');
{
  await registryStore.clear();
  /**
   * ══ LE SCÉNARIO D'ATTAQUE, EN TROIS LIGNES ═══════════════════════════════
   *
   * Un projet s'appaire honnêtement en recette. Puis, au battement suivant, il
   * annonce `PROD`. Si le Panel le croyait, il lui servirait la clé Stripe de
   * production — celle qui débite de vraies cartes.
   *
   * Ce n'était pas exploitable tant que l'appairage exigeait l'égalité avec le
   * monde du Panel : un projet ne pouvait de toute façon vivre que dans le
   * monde de son Panel. La levée de cette contrainte rend la lecture de
   * l'annonce dangereuse — c'est pourquoi l'épingle a été posée AVANT.
   */
  const { pairingCode } = await ficheAvecCode('https://api.malin.fr', 'Malin', 'TEST');
  await pairing.bootstrap(dto(pairingCode, 'TEST'));

  const fiche = (await registryStore.list())[0];
  fiche.runtime.environment = 'PROD';   // ce que le projet ANNONCE

  check('l’annonce du projet est bien lue comme un constat',
    observedEnvironmentOf(fiche) === 'PROD');
  check('…la contradiction est détectée', environmentContradicted(fiche) === true);
  check('…mais l’autorité reste l’épingle', authoritativeEnvironmentOf(fiche) === 'TEST');
  check('…le contexte d’invocation reste en TEST',
    resolveInstanceEnvironment(fiche) === 'TEST');
  check('…et STRIPE reste résolu sur le monde de RECETTE',
    resolveEnvironmentForProvider('STRIPE', {
      runtimeEnvironment: 'TEST', projectEnvironment: resolveInstanceEnvironment(fiche),
    }) === 'TEST');

  /**
   * Et la réciproque : une fiche PROD n'est pas rétrogradée non plus par un
   * projet qui annoncerait TEST. L'épingle tient dans les deux sens.
   */
  const p = await ficheAvecCode('https://api.reciproque.fr', 'Réciproque', 'PROD');
  await pairing.bootstrap({ ...dto(p.pairingCode, 'PROD'), projectKey: 'reciproque' });
  const fichePr = (await registryStore.list()).find((f) => f.projectKey === 'reciproque');
  fichePr.runtime.environment = 'TEST';
  check('une fiche PROD n’est pas rétrogradée par une annonce TEST',
    authoritativeEnvironmentOf(fichePr) === 'PROD');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DEUX INSTANCES D’UN MÊME PROJET, SUR LE MÊME PANEL');
{
  await registryStore.clear();
  /**
   * ── LA DOCTRINE MONO-INSTANCE TOMBE ──────────────────────────────────────
   *
   * Elle disait qu'un Panel ne pouvait héberger que des fiches de son propre
   * monde : un écran regroupant « la recette et la production d'un client »
   * n'aurait jamais pu afficher deux fiches vivantes.
   *
   * Les deux vivent maintenant côte à côte, chacune avec son jeton, son monde
   * épinglé et sa résolution fournisseur.
   */
  const a = await ficheAvecCode('https://api.iso-test.fr', 'Iso Recette', 'TEST');
  const resA = await pairing.bootstrap({ ...dto(a.pairingCode, 'TEST'), projectKey: 'iso-test' });

  const b = await ficheAvecCode('https://api.iso-prod.fr', 'Iso Production', 'PROD');
  const resB = await pairing.bootstrap({ ...dto(b.pairingCode, 'PROD'), projectKey: 'iso-prod' });

  const fiches = await registryStore.list();
  check('les deux fiches sont appairées',
    fiches.filter((f) => f.pairing.status === 'PAIRED').length === 2);
  check('…deux jetons distincts', resA.bridgeToken !== resB.bridgeToken);

  const recette = fiches.find((f) => f.projectKey === 'iso-test');
  const production = fiches.find((f) => f.projectKey === 'iso-prod');
  check('…la recette résout sur le monde de recette',
    resolveInstanceEnvironment(recette) === 'TEST');
  check('…la production sur le monde de production',
    resolveInstanceEnvironment(production) === 'PROD');
  check('…depuis une seule et même instance de Panel', config.env === 'TEST');
}

await stopMemoryMongo();
finish();
