// PRÉ-OUVERTURE EN PRODUCTION — la jonction L1.75 × L2 × L3.
//
// ══ POURQUOI CE FICHIER EST À PART ═══════════════════════════════════════════
//
// Il tourne en `ENV=PROD`. Un processus Node ne sert qu'UN environnement :
// `config/env.js` le lit une fois, au chargement, et refuse de démarrer sans
// lui. On ne peut donc pas éprouver le monde de production dans la suite
// principale, qui est en TEST — et l'éprouver « en TEST en faisant semblant »
// ne prouverait rien du tout.
//
// ══ CE QU'IL PROUVE, ET C'EST L'INVARIANT LE PLUS COÛTEUX À PERDRE ═══════════
//
//   ENV = PROD                    ← une instance de production, vraiment
//   commercialState = PREOPENING  ← installée, pas encore ouverte au commerce
//   capacité FINANCIAL_WRITE      ← elle toucherait de l'argent réel
//
//         →  environnement résolu : PROD, et il ne bouge PAS
//         →  décision : BLOCKED_PREOPENING
//         →  appels fournisseur : ZÉRO
//
// La ligne qui compte est la deuxième. Une pré-ouverture qui basculerait le
// monde en TEST « pour être prudente » recréerait `activeMode` sous un autre
// nom — exactement ce que L2 vient de supprimer — et un remboursement émis
// plus tard partirait du mauvais compte.
import { check, connectTestDatabase, finish, section, setTestEnv, startMemoryMongo, stopMemoryMongo } from './helpers/harness.js';

setTestEnv();
/**
 * APRÈS le harnais, et AVANT tout import du backend : c'est cet ordre qui fait
 * de ce processus une instance de PRODUCTION.
 *
 * Les deux identifiants de seed ci-dessous ne sont pas décoratifs : `config
 * /env.js` refuse de démarrer en PROD avec une adresse ou un mot de passe de
 * développement connus. Devoir les remplacer ici prouve, au passage, que ce
 * durcissement est bien actif — et qu'on est réellement dans le monde qu'on
 * prétend éprouver.
 */
process.env.ENV = 'PROD';
process.env.DB_PROD = 'panel_prod_preopening';
process.env.SEED_DEV_EMAIL = 'exploitation@ly-solution.test';
process.env.SEED_DEV_PASSWORD = 'preopening-suite-2026-XyZ';

await startMemoryMongo();
await connectTestDatabase();

const config = (await import('../backend/src/config/env.js')).default;
const registry = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const gateway = await import('../backend/src/services/capabilities/capabilityGateway.service.js');
const contextModule = await import('../backend/src/services/capabilities/invocationContext.js');
const resolver = await import('../backend/src/services/capabilities/credentialResolver.js');
const commercial = await import('../backend/src/services/integratedApi/commercialReadiness.js');
const environmentModule = await import('../backend/src/services/integratedApi/environment.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CLE_PROD = 'xkeysib-PREOPENINGSENTINELLEPROD0000000000001';

/** Toute écriture financière du catalogue — aucune ne doit passer. */
const FINANCIERES = registry.listCapabilityDefinitions()
  .filter((c) => c.effectNature === commercial.EFFECT.FINANCIAL_WRITE)
  .map((c) => c.code);
const LEGALES = registry.listCapabilityDefinitions()
  .filter((c) => c.effectNature === commercial.EFFECT.LEGAL_WRITE)
  .map((c) => c.code);

/** Compte les appels sortants. Il doit rester à zéro, et c'est la preuve. */
let appelsFournisseur = 0;
const fournisseur = async () => {
  appelsFournisseur += 1;
  return { ok: true, status: 200, text: async () => JSON.stringify({ companyName: 'X' }) };
};

async function projet({ projectId, grants, commercialState }) {
  const at = new Date().toISOString();
  await registryStore.remove(projectId);
  await registryStore.insert({
    projectId,
    projectKey: projectId,
    projectName: `Projet ${projectId}`,
    createdAt: at,
    updatedAt: at,
    pairing: { status: 'PAIRED', bridgeTokenHash: 'h', pairedAt: at },
    // Une instance de PRODUCTION, qui l'a déclaré au Panel.
    runtime: { environment: 'PROD' },
    capabilityGrants: grants,
    commercialState,
  });
  return registryStore.getById(projectId);
}

async function invoquer(fiche, code, payload = {}) {
  try {
    return { ok: true, data: await gateway.invokeCapability({ code, panelProject: fiche, payload, fetchImpl: fournisseur }) };
  } catch (err) {
    return { ok: false, code: err?.code ?? null, error: err };
  }
}

await seedIntegratedApiCredentialSets();

/* ========================================================================== */
section('0. Cette instance est bien en PRODUCTION');
/* ========================================================================== */
{
  check('config.env vaut PROD', config.env === 'PROD');
  check('la primitive d’environnement rend PROD', environmentModule.runtimeEnvironment() === 'PROD');
  check('Brevo (portée ENVIRONMENT) résout vers PROD',
    environmentModule.resolveEnvironmentForProvider('BREVO') === 'PROD');
  check('il existe au moins une capacité FINANCIAL_WRITE à éprouver', FINANCIERES.length > 0);
}

/* ========================================================================== */
section('1. PRÉ-OUVERTURE — l’écriture réelle est refusée, le monde ne bouge pas');
/* ========================================================================== */
{
  const fiche = await projet({
    projectId: 'prod-preopening',
    grants: [...FINANCIERES, ...LEGALES, 'email.sender.verify'],
    commercialState: commercial.COMMERCIAL_STATE.PREOPENING,
  });

  const contexte = contextModule.buildInvocationContext({ panelProject: fiche });
  check('le contexte porte PROD', contexte.environment === 'PROD');
  check('…et l’état PREOPENING', contexte.commercialState === 'PREOPENING');

  for (const code of FINANCIERES) {
    const r = await invoquer(fiche, code);
    check(`${code} → BLOCKED_PREOPENING`, r.code === 'CAPABILITY_BLOCKED_PREOPENING');
    check(`${code} → issue BLOCKED`, r.error.outcome === 'BLOCKED');
    check(`${code} → l’effet refusé est nommé`, r.error.details?.effect === commercial.EFFECT.FINANCIAL_WRITE);
  }
  for (const code of LEGALES) {
    const r = await invoquer(fiche, code);
    check(`${code} (engagement juridique) → BLOCKED_PREOPENING`,
      r.code === 'CAPABILITY_BLOCKED_PREOPENING');
  }

  check('ZÉRO appel fournisseur', appelsFournisseur === 0);

  /**
   * LA LIGNE QUI COMPTE : le refus n'a RIEN changé au monde.
   *
   * Après le blocage, l'environnement résolu pour ce même projet est toujours
   * PROD. Si la pré-ouverture avait basculé quoi que ce soit, on le lirait ici.
   */
  const apres = contextModule.buildInvocationContext({ panelProject: fiche });
  check('après le refus, l’environnement est TOUJOURS PROD', apres.environment === 'PROD');
  check('…et la résolution de credentials vise TOUJOURS PROD',
    resolver.resolveCredentialEnvironment(apres, registry.getCapabilityDefinition('email.sender.verify')) === 'PROD');
}

/* ========================================================================== */
section('2. PRÉ-OUVERTURE ≠ COUPURE — configurer reste possible');
/* ========================================================================== */
{
  const fiche = await registryStore.getById('prod-preopening');

  // Le jeu PROD, configuré et validé par le vrai chemin L1.
  await controlPlane.saveCredentialSet('BREVO', 'PROD', {
    values: { apiKey: CLE_PROD, baseUrl: 'https://faux-brevo.test/v3' },
  }, ACTEUR);
  await controlPlane.validateCredentialSet('BREVO', 'PROD', {
    actor: ACTEUR,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ companyName: 'L.Y Solution' }) }),
  });

  const avant = appelsFournisseur;
  const r = await invoquer(fiche, 'email.sender.verify', {
    recipient: { email: 'ops@garage.fr' }, operationId: 'op-preopening-01',
  });

  /**
   * Une instance en pré-ouverture doit pouvoir être CONFIGURÉE : vérifier ses
   * clés, envoyer la réinitialisation de mot de passe qui permettra à son
   * administrateur d'ouvrir la session avec laquelle il l'ouvrira. Tout
   * bloquer la rendrait inutilisable — et on contournerait la pré-ouverture
   * pour travailler, ce qui la viderait de son sens.
   */
  check('une capacité de CONFIGURATION passe, même en pré-ouverture', r.ok === true);
  check('…et elle s’exécute bien en PROD', r.data.environment === 'PROD');
  check('…un appel fournisseur a eu lieu, cette fois', appelsFournisseur === avant + 1);
}

/* ========================================================================== */
section('3. OUVERTE (LIVE) — l’écriture réelle n’est plus refusée pour CE motif');
/* ========================================================================== */
{
  const fiche = await projet({
    projectId: 'prod-live',
    grants: [...FINANCIERES],
    commercialState: commercial.COMMERCIAL_STATE.LIVE,
  });

  const avant = appelsFournisseur;
  const r = await invoquer(fiche, FINANCIERES[0]);

  /**
   * Le refus CHANGE DE NATURE : ce n'est plus l'ouverture commerciale.
   *
   * En L6.1 c'était « Stripe n'est pas migré ». Depuis L6.2B, la capacité EST
   * servie, et l'appel descend jusqu'au contrat d'entrée — que ce test ne
   * remplit pas. Le refus est donc encore plus tardif, et la démonstration
   * tient toujours : le blocage précédent venait de la POLITIQUE, et non d'un
   * hasard de calendrier de migration.
   */
  check(`${FINANCIERES[0]} n’est plus bloquée par la pré-ouverture`,
    r.code !== 'CAPABILITY_BLOCKED_PREOPENING');
  check('…et le refus vient d’une étape ULTÉRIEURE',
    r.code === 'CAPABILITY_NOT_AVAILABLE' || r.code === 'CAPABILITY_INPUT_INVALID');
  check('…et toujours ZÉRO appel fournisseur (rien n’est branché)',
    appelsFournisseur === avant);
}

/* ========================================================================== */
section('4. UNE INSTANCE DE TEST NE PEUT PAS PARLER À CE PANEL');
/* ========================================================================== */
{
  // Fail closed, dans l'autre sens : ce Panel sert PROD. Une fiche qui déclare
  // TEST est un désaccord de monde, pas une nuance de configuration.
  const at = new Date().toISOString();
  await registryStore.remove('projet-test-egare');
  await registryStore.insert({
    projectId: 'projet-test-egare',
    projectKey: 'projet-test-egare',
    projectName: 'Instance de recette égarée',
    createdAt: at,
    updatedAt: at,
    pairing: { status: 'PAIRED', bridgeTokenHash: 'h', pairedAt: at },
    runtime: { environment: 'TEST' },
    capabilityGrants: ['email.sender.verify'],
    commercialState: commercial.COMMERCIAL_STATE.LIVE,
  });
  const fiche = await registryStore.getById('projet-test-egare');

  const avant = appelsFournisseur;
  const r = await invoquer(fiche, 'email.sender.verify', {
    recipient: { email: 'ops@garage.fr' }, operationId: 'op-preopening-02',
  });
  check('fiche TEST sur un Panel PROD → CAPABILITY_ENVIRONMENT_MISMATCH',
    r.code === 'CAPABILITY_ENVIRONMENT_MISMATCH');
  check('…et la clé de production n’est jamais partie', appelsFournisseur === avant);
}

await stopMemoryMongo();
finish();
