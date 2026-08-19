// LA GARDE ANTI-CAPACITÉ FANTÔME — une action exposée est une action servie.
//
// ── CE QUE CETTE SUITE EXISTE POUR EMPÊCHER ─────────────────────────────────
//
// Le registre a longtemps pu décrire une capacité que rien n'exécutait. Elle
// portait `migrated: false`, l'écran l'annonçait, l'API l'acceptait à l'octroi,
// et l'invocation répondait « déclarée mais pas encore servie par le Panel ».
//
// `billing.subscription.reconcile` a occupé cet état pendant toute sa vie. Ce
// n'était pas un accident isolé : c'était un état REPRÉSENTABLE, donc un état
// qu'on pouvait atteindre sans le vouloir, et dans lequel on pouvait rester.
//
// Le booléen a été supprimé. Cette suite garde l'invariant qui le remplace :
//
//     TOUTE ACTION DÉCLARÉE POSSÈDE UN HANDLER, ET RÉCIPROQUEMENT.
//
// ── POURQUOI UNE SUITE À PART ───────────────────────────────────────────────
//
// `capability-gateway.test.js` éprouve la MÉCANIQUE d'un appel. Celle-ci
// éprouve la FORME du registre, sans base de données ni invocation : elle doit
// pouvoir échouer vite, et pour une seule raison — quelqu'un a ajouté une
// action sans son exécutant.
import { existsSync } from 'node:fs';

import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const registry = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const adapters = await import('../backend/src/services/capabilities/providerAdapters.js');
const errors = await import('../backend/src/services/capabilities/capabilityErrors.js');
const providerRegistry = await import('../backend/src/services/integratedApi/providerRegistry.js');
const stripe = await import('../backend/src/services/integratedApi/stripe/stripeCapabilities.js');
const hostinger = await import('../backend/src/services/integratedApi/hostinger/hostingerCapabilities.js');

const definitions = registry.listCapabilityDefinitions();

/* ========================================================================== */
section('1. BIJECTION — chaque action déclarée a un handler, et l’inverse');
/* ========================================================================== */
{
  /**
   * LE CONTRÔLE DEMANDÉ PAR LA MISSION, ÉCRIT TEL QUEL.
   *
   *   for every exposed action:
   *     assert runtimeRegistry.has(action)
   *     assert typeof runtimeRegistry[action].handler === 'function'
   */
  for (const definition of definitions) {
    check(`${definition.code} — un exécutant existe`, adapters.hasAdapter(definition.code));
  }

  const declarees = new Set(definitions.map((d) => d.code));
  for (const code of adapters.listAdaptedCapabilities()) {
    check(`${code} — l’exécutant correspond à une action déclarée`, declarees.has(code));
  }

  /**
   * ET LA MÊME CHOSE PAR LA FONCTION D'ALIGNEMENT, qui est celle que le
   * démarrage du Panel appelle. Vérifier les deux n'est pas redondant : la
   * boucle ci-dessus nomme le coupable, celle-ci prouve que la garde EMBARQUÉE
   * le verrait aussi. Une garde qu'aucun test n'exerce finit par être
   * commentée.
   */
  const ecarts = adapters.assertAdapterAlignment(definitions);
  check(`assertAdapterAlignment ne relève aucun écart (${ecarts.length})`, ecarts.length === 0);
  ecarts.forEach((e) => console.error(`      · ${e}`));

  const registreEcarts = registry.assertRegistryAlignment();
  check(`assertRegistryAlignment ne relève aucun écart (${registreEcarts.length})`,
    registreEcarts.length === 0);
  registreEcarts.forEach((e) => console.error(`      · ${e}`));

  check(`validateStripeCapabilities est propre`, stripe.validateStripeCapabilities().length === 0);
  check(`validateHostingerCapabilities est propre`,
    hostinger.validateHostingerCapabilities().length === 0);
}

/* ========================================================================== */
section('2. LA GARDE MORD — un registre fautif est DÉTECTÉ, pas toléré');
/* ========================================================================== */
{
  /**
   * UNE GARDE QU'ON N'A JAMAIS VUE ÉCHOUER N'EST PAS UNE GARDE.
   *
   * On lui présente les deux dérives possibles, fabriquées à la main. Sans
   * cela, une `assertAdapterAlignment()` qui rendrait `[]` en toutes
   * circonstances — parce qu'on aurait inversé une condition, ou itéré sur un
   * tableau vide — passerait la section 1 sans rien protéger.
   */
  const fantome = adapters.assertAdapterAlignment([
    ...definitions,
    { code: 'billing.invente.tout', provider: 'STRIPE' },
  ]);
  check('une action sans exécutant est DÉTECTÉE', fantome.length === 1);
  check('…et le message la NOMME', fantome[0]?.includes('billing.invente.tout'));

  /**
   * La dérive inverse : un exécutant qu'aucune action ne déclare. On retire une
   * définition de la liste soumise à la garde, ce qui simule exactement ce qui
   * arrive quand on supprime une entrée du registre en oubliant sa table
   * d'adaptateurs.
   */
  const orphelin = adapters.assertAdapterAlignment(
    definitions.filter((d) => d.code !== 'email.sender.verify'),
  );
  check('un exécutant sans action déclarée est DÉTECTÉ', orphelin.length === 1);
  check('…et le message le NOMME', orphelin[0]?.includes('email.sender.verify'));
}

/* ========================================================================== */
section('3. L’ÉTAT INTERMÉDIAIRE N’EST PLUS REPRÉSENTABLE');
/* ========================================================================== */
{
  /**
   * On ne vérifie pas seulement que toutes les capacités sont servies : on
   * vérifie que le CHAMP qui permettait de dire le contraire n'existe plus.
   *
   * La différence est tout l'objet de la mission. Un booléen à `true` partout
   * se remet à `false` en une ligne ; un champ absent demande de le réintroduire
   * dans la fabrique, dans la vue publique et dans la passerelle.
   */
  for (const champ of ['migrated', 'migrationNote', 'effectNature']) {
    check(`aucune définition ne porte « ${champ} »`,
      definitions.every((d) => !(champ in d)));
  }
  for (const champ of ['migrated', 'migrationNote', 'effectNature', 'invocable', 'granted']) {
    check(`la vue publique ne porte pas « ${champ} »`,
      registry.describeCapabilities().every((c) => !(champ in c)));
  }

  check('listMigratedCapabilities n’existe plus', registry.listMigratedCapabilities === undefined);

  /**
   * LE REFUS « PAS ENCORE SERVIE » N'A PLUS DE FORMULATION.
   *
   * `CAPABILITY_NOT_AVAILABLE` subsiste — il couvre l'adaptateur manquant et la
   * sortie non conforme, deux bogues du Panel — mais son message ne doit plus
   * annoncer un état de déploiement à un projet qui n'y peut rien.
   */
  const message = errors.capabilityNotAvailable('x.y', 'NO_ADAPTER').message;
  check('le refus ne dit plus « pas encore servie »', !message.includes('pas encore servie'));

  check('CAPABILITY_NOT_GRANTED a disparu du vocabulaire',
    errors.CAPABILITY_ERROR_CODES.NOT_GRANTED === undefined);
  check('CAPABILITY_BLOCKED_PREOPENING a disparu du vocabulaire',
    errors.CAPABILITY_ERROR_CODES.BLOCKED_PREOPENING === undefined);
}

/* ========================================================================== */
section('4. SOURCE DE VÉRITÉ UNIQUE — aucune seconde liste ne subsiste');
/* ========================================================================== */
{
  /**
   * LE REGISTRE EST LA SEULE LISTE, ET LES CATALOGUES FOURNISSEUR EN DÉRIVENT.
   *
   * Chaque catalogue (Stripe, Hostinger, Brevo) décrit le contrat métier de son
   * fournisseur ; le registre les agrège. Ce qu'on interdit, c'est qu'un code
   * existe dans l'un sans exister dans l'autre — l'écart exact qui a laissé
   * `billing.subscription.reconcile` annoncée par le registre des fournisseurs
   * alors qu'elle avait quitté le registre des capacités.
   */
  for (const provider of ['STRIPE', 'BREVO', 'YOUSIGN', 'HOSTINGER']) {
    const definition = providerRegistry.getProviderDefinition(provider);
    for (const code of definition.capabilities) {
      check(`${provider} annonce « ${code} » → il est déclaré`, registry.isKnownCapability(code));
    }
    const duRegistre = registry.capabilitiesForProvider(provider).map((c) => c.code).sort();
    const duFournisseur = [...definition.capabilities].sort();
    check(`${provider} — les deux listes sont IDENTIQUES`,
      JSON.stringify(duRegistre) === JSON.stringify(duFournisseur));
  }

  /** Les modules d'autorisation supprimés ne doivent pas réapparaître. */
  const disparus = [
    '../backend/src/services/capabilities/capabilityGrants.js',
    '../backend/src/services/capabilities/commercialReadiness.service.js',
    '../backend/src/services/integratedApi/commercialReadiness.js',
  ];
  for (const chemin of disparus) {
    check(`${chemin.split('/').pop()} n’existe plus`,
      !existsSync(new URL(chemin, import.meta.url)));
  }
}

/* ========================================================================== */
section('5. INVENTAIRE — 22 actions, toutes servies');
/* ========================================================================== */
{
  check('22 actions déclarées', definitions.length === 22);
  check('…et 22 exécutants', adapters.listAdaptedCapabilities().length === 22);
  check('billing.subscription.reconcile n’est plus déclarée',
    !registry.isKnownCapability('billing.subscription.reconcile'));
  /**
   * `webhook.endpoint.ensure` était soupçonnée d'être la capacité fantôme. Elle
   * ne l'a jamais été : elle est servie, et son idempotence est convergente —
   * elle compare l'état désiré au réel avant d'agir, ce qui la rend rejouable.
   */
  check('webhook.endpoint.ensure est déclarée ET servie',
    registry.isKnownCapability('webhook.endpoint.ensure')
    && adapters.hasAdapter('webhook.endpoint.ensure'));
  check('…et rejouable sans doublon',
    registry.getCapabilityDefinition('webhook.endpoint.ensure').idempotency === 'SAFE_RETRY');
}

/* ========================================================================== */
section('6. LE CONTRAT D’ENTRÉE ET LE RENDU DISENT LA MÊME CHOSE');
/* ========================================================================== */
{
  /**
   * ══ DEUX CONTRATS, UN SEUL PANEL ══════════════════════════════════════════
   *
   * Le rendu des modèles accepte, pour un montant, DEUX formes : un entier de
   * centimes, ou `{ amount, currency }` — la seconde existe pour qu'un montant
   * en USD ne s'affiche pas avec « € ». L'entrée de la capacité, elle,
   * n'acceptait que des scalaires.
   *
   * Ils se contredisaient donc, et c'est l'entrée qui gagnait : tout envoi
   * portant un montant sous sa forme complète était refusé à la passerelle,
   * avant d'atteindre le rendu qui l'attendait. Concrètement, les e-mails de
   * facturation d'un projet et le bouton « envoi de test » de tout modèle
   * portant un montant — donc, pour ces modèles, l'écran entier.
   *
   * Cette section les tient ensemble. Elle ne vérifie pas une implémentation :
   * elle vérifie que ce que le rendu sait lire, l'entrée l'accepte.
   */
  const envoi = registry.getCapabilityDefinition('email.send_template');
  const entree = (variables) => envoi.inputSchema.safeParse({
    templateRef: 'UN_MODELE',
    recipient: { email: 'destinataire@exemple.test' },
    variables,
    operationId: 'operation-abcdefgh',
  }).success;

  check('un montant avec sa devise est accepté',
    entree({ 'facture.total': { amount: 11880, currency: 'EUR' } }));
  check('…sans devise aussi (le rendu retient l’euro)',
    entree({ 'facture.total': { amount: 11880 } }));
  check('…et des centimes nus, la forme courte',
    entree({ 'facture.total': 11880 }));

  /** La largeur s'arrête là : un objet quelconque n'a toujours aucun sens. */
  check('un objet inconnu reste REFUSÉ', !entree({ 'facture.total': { foo: 'bar' } }));
  check('un montant à virgule reste REFUSÉ — les centimes sont entiers',
    !entree({ 'facture.total': { amount: 118.8 } }));

  /**
   * ET LES ÉCHANTILLONS DU CATALOGUE PASSENT LEUR PROPRE PORTE.
   *
   * `sampleVariablesFor` alimente l'envoi de test : un échantillon que l'entrée
   * refuse, c'est un bouton qui ne peut PAS fonctionner, pour ce modèle, jamais.
   * Le vérifier modèle par modèle évite d'attendre qu'un opérateur le découvre.
   */
  const { EMAIL_TEMPLATE_IDS, sampleVariablesFor } = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');
  const codes = Object.values(EMAIL_TEMPLATE_IDS);
  const refuses = codes.filter((code) => !entree(Object.fromEntries(sampleVariablesFor(code))));
  check(`les ${codes.length} échantillons du catalogue franchissent le contrat d’entrée`,
    refuses.length === 0, refuses.join(', '));
}

finish();
