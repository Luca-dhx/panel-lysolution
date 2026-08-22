// APPARTENANCE DES RESSOURCES STRIPE — deux projets, un compte (L6.2A).
//
// Ce que cette suite prouve :
//
//   UNE SEULE AUTORITÉ      un identifiant ne peut appartenir qu'à un projet
//   CROSS-PROJECT IMPOSSIBLE A ne touche pas les ressources de B, ni l'inverse
//   PAYLOAD SANS POUVOIR    le projet ne propose jamais son propriétaire
//   MONDES SÉPARÉS          TEST et PROD ne se voient pas
//   REFUS INDISTINGUABLE    « inconnue » et « à un autre » se ressemblent
//   IDEMPOTENCE             N liaisons concurrentes → une seule ligne
//   FENÊTRE DE RÉCUPÉRATION un orphelin n'est à personne, et le rejeu le répare
//   AUCUN SECRET            ni clé, ni identifiant complet dans un inventaire
//
// Aucun appel Stripe : ce lot ne migre aucune capacité.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const binding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const ownership = await import('../backend/src/services/integratedApi/stripe/stripeResourceOwnership.js');
const capabilities = await import('../backend/src/services/integratedApi/stripe/stripeCapabilities.js');
const adaptersStripe = await import('../backend/src/services/integratedApi/stripe/stripeAdapters.js');
const environment = await import('../backend/src/services/integratedApi/environment.js');
const { default: PanelStripeResourceBinding } = await import(
  '../backend/src/models/PanelStripeResourceBinding.model.js'
);

const { STRIPE_RESOURCE_TYPES: TYPES, BINDING_SOURCES, BIND_OUTCOMES, REFUSAL_REASONS } = binding;

const A = 'projet-a';
const B = 'projet-b';

const CUS_A = 'cus_AAAAAAAAAAAAAAAA';
const CUS_B = 'cus_BBBBBBBBBBBBBBBB';
const SUB_A = 'sub_AAAAAAAAAAAAAAAA';
const CUS_PROD_A = 'cus_PRODAAAAAAAAAAAA';

/** Capture une erreur, ou `null` si l'appel a réussi. */
async function caught(promise) {
  try { await promise; return null; } catch (err) { return err; }
}

/* ========================================================================== */
section('1. UNE SEULE AUTORITÉ — le registre, et l’index qui le tient');
/* ========================================================================== */
{
  const cree = await binding.bindResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
    createdByOperationId: 'op-l62a-000000000001',
  });
  check('le lien est créé', cree.outcome === BIND_OUTCOMES.CREATED);
  check('…au nom du projet A', cree.binding.projectId === A);
  check('…avec la source PANEL_CREATED', cree.binding.source === BINDING_SOURCES.PANEL_CREATED);
  check('…et l’opération qui l’a produit', cree.binding.createdByOperationId === 'op-l62a-000000000001');

  await binding.bindResource({
    projectId: B, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_B,
  });
  await binding.bindResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.SUBSCRIPTION, resourceId: SUB_A,
  });

  // Le type est fermé, et l'identifiant doit correspondre à sa famille.
  const typeInconnu = await caught(binding.bindResource({
    projectId: A, environment: 'TEST', resourceType: 'CUSTOMER_V2', resourceId: CUS_A,
  }));
  check('un type inventé est refusé', typeInconnu?.code === 'STRIPE_BINDING_INVALID');

  const mauvaisPrefixe = await caught(binding.bindResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.SUBSCRIPTION, resourceId: CUS_A,
  }));
  check('un client présenté comme abonnement est refusé', mauvaisPrefixe?.code === 'STRIPE_BINDING_INVALID');

  const sansProjet = await caught(binding.bindResource({
    projectId: '', environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: 'cus_ORPHELIN00000000',
  }));
  check('un lien sans propriétaire est refusé', sansProjet?.code === 'STRIPE_BINDING_INVALID');
}

/* ========================================================================== */
section('2. CROSS-PROJECT — mécaniquement impossible');
/* ========================================================================== */
{
  // LE test du lot : B tente de s'approprier la ressource de A.
  const vol = await caught(binding.bindResource({
    projectId: B, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
  }));
  check('B ne peut pas lier la ressource de A', vol?.code === 'STRIPE_RESOURCE_ALREADY_BOUND');
  check('…et c’est un conflit, pas un succès silencieux', vol?.statusCode === 409);

  const lignes = await PanelStripeResourceBinding.countDocuments({
    environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('…et il n’existe toujours qu’UNE ligne pour cette ressource', lignes === 1);

  // A lit sa ressource : autorisé. B la lit : refusé.
  const sien = await binding.describeOwnership({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('A accède à sa propre ressource', sien.allowed === true);

  const autrui = await binding.describeOwnership({
    projectId: B, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('B n’accède pas à celle de A', autrui.allowed === false);
  check('…motif interne OTHER_PROJECT', autrui.reason === REFUSAL_REASONS.OTHER_PROJECT);

  const inverse = await binding.describeOwnership({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_B,
  });
  check('A n’accède pas à celle de B', inverse.allowed === false);

  // L'ATTAQUE : un identifiant Stripe parfaitement valide, mais pas à soi.
  const attaque = await caught(binding.assertOwnedResource({
    projectId: B, environment: 'TEST', resourceType: TYPES.SUBSCRIPTION, resourceId: SUB_A,
  }));
  check('abonnement valide mais non possédé → refus', attaque?.code === binding.STRIPE_RESOURCE_NOT_OWNED);
  check('…en 403', attaque?.statusCode === 403);
}

/* ========================================================================== */
section('3. LE REFUS NE RENSEIGNE PAS');
/* ========================================================================== */
{
  const inconnue = await caught(binding.assertOwnedResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: 'cus_NEXISTEPAS000000',
  }));
  const autrui = await caught(binding.assertOwnedResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_B,
  }));

  // Si les deux refus différaient, on aurait un oracle d'existence : présenter
  // un identifiant et lire dans la nuance du refus s'il existe chez nous.
  check('« inconnue » et « à un autre » rendent le MÊME code',
    inconnue.code === autrui.code && inconnue.code === binding.STRIPE_RESOURCE_NOT_OWNED);
  check('…le MÊME message', inconnue.message === autrui.message);
  check('…le MÊME statut', inconnue.statusCode === autrui.statusCode);
  check('…et le détail ne porte que le type',
    JSON.stringify(inconnue.details) === JSON.stringify(autrui.details));
  check('le message ne cite aucun identifiant',
    !inconnue.message.includes(CUS_B) && !autrui.message.includes(CUS_B));
  check('…ni aucun projet', !autrui.message.includes(B));
}

/* ========================================================================== */
section('4. LES MONDES SONT SÉPARÉS');
/* ========================================================================== */
{
  // Le MÊME identifiant peut exister dans les deux mondes — ce sont deux objets.
  await binding.bindResource({
    projectId: A, environment: 'PROD', resourceType: TYPES.CUSTOMER, resourceId: CUS_PROD_A,
  });
  const memeIdAilleurs = await binding.bindResource({
    projectId: B, environment: 'PROD', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('le même identifiant peut être lié dans l’AUTRE monde',
    memeIdAilleurs.outcome === BIND_OUTCOMES.CREATED);
  check('…à un autre projet, sans conflit', memeIdAilleurs.binding.projectId === B);

  // …mais la lecture reste strictement cloisonnée.
  const depuisTest = await binding.describeOwnership({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_PROD_A,
  });
  check('une ressource PROD est invisible depuis TEST', depuisTest.allowed === false);
  check('…et se présente comme inexistante', depuisTest.reason === REFUSAL_REASONS.NO_BINDING);

  const depuisProd = await binding.describeOwnership({
    projectId: A, environment: 'PROD', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('en PROD, `cus_A` appartient à B — A est refusé', depuisProd.allowed === false);

  // Les listes du propriétaire ne franchissent pas la frontière non plus.
  const enTest = await binding.listOwnedResourceIds({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER,
  });
  const enProd = await binding.listOwnedResourceIds({
    projectId: A, environment: 'PROD', resourceType: TYPES.CUSTOMER,
  });
  check('A possède un client en TEST', enTest.length === 1 && enTest[0] === CUS_A);
  check('…et un autre en PROD', enProd.length === 1 && enProd[0] === CUS_PROD_A);
  check('les deux listes ne se mélangent pas', enTest[0] !== enProd[0]);

  // Le monde vient du runtime, jamais d'un appelant.
  check('Stripe reste à portée ENVIRONMENT',
    environment.resolveEnvironmentForProvider('STRIPE') === 'TEST');
  let refus = null;
  try { environment.assertEnvironmentServed('PROD'); } catch (err) { refus = err; }
  check('demander PROD depuis une instance TEST → refus',
    String(refus?.code) === environment.INTEGRATED_API_ENVIRONMENT_MISMATCH);
}

/* ========================================================================== */
section('5. LE PAYLOAD DU PROJET N’EST JAMAIS UNE PREUVE');
/* ========================================================================== */
{
  /**
   * L'API n'a AUCUN paramètre par lequel un appelant pourrait proposer un
   * propriétaire : `projectId` est un argument nommé que seule la passerelle
   * renseigne depuis le contexte authentifié. On le vérifie sur la SIGNATURE,
   * parce qu'un test d'usage ne prouverait que l'usage qu'on en fait.
   */
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js', import.meta.url), 'utf8',
  );
  check('aucune lecture d’un corps de requête dans le service',
    !/req\.body|payload\.|\.body\b/.test(source));
  check('aucun repli sur un projectId « proposé »',
    !/claimedProjectId|requestedProjectId|projectIdFromPayload/.test(source));

  // Et les contrats de capacité refusent le champ, comme en L6.1.
  for (const code of capabilities.STRIPE_CAPABILITY_CODES) {
    const schema = capabilities.STRIPE_CAPABILITIES[code].inputSchema;
    const base = code === 'billing.checkout.create'
      ? { contractRef: 'CTR-1', paymentType: 'LAUNCH_FEE', successUrl: 'https://a.fr', cancelUrl: 'https://b.fr', operationId: 'op-l62a-000000000001' }
      : code === 'billing.invoice.list' ? { customerId: CUS_A, operationId: 'op-l62a-000000000001' }
        : code === 'billing.checkout.retrieve' ? { checkoutSessionId: 'cs_X0000000000000', operationId: 'op-l62a-000000000001' }
          : { subscriptionId: SUB_A, operationId: 'op-l62a-000000000001' };
    check(`${code} : « projectId » refusé en entrée`,
      schema.safeParse({ ...base, projectId: B }).success === false);
    check(`${code} : « environment » refusé en entrée`,
      schema.safeParse({ ...base, environment: 'PROD' }).success === false);
  }
}

/* ========================================================================== */
section('6. IDEMPOTENCE ET CONCURRENCE');
/* ========================================================================== */
{
  // Rejeu du MÊME acte : le lien existe déjà, et ce n'est pas une erreur.
  const rejeu = await binding.bindResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
    createdByOperationId: 'op-l62a-000000000001',
  });
  check('rejouer la même liaison → ALREADY_BOUND', rejeu.outcome === BIND_OUTCOMES.ALREADY_BOUND);
  check('…et rend la ligne existante', rejeu.binding.projectId === A);

  // N tentatives SIMULTANÉES pour la même ressource : une seule ligne.
  const RES = 'cus_CONCURRENCE00001';
  const resultats = await Promise.allSettled(
    Array.from({ length: 8 }, () => binding.bindResource({
      projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: RES,
    })),
  );
  const abouties = resultats.filter((r) => r.status === 'fulfilled');
  const creees = abouties.filter((r) => r.value.outcome === BIND_OUTCOMES.CREATED);
  check('les 8 tentatives concurrentes aboutissent toutes', abouties.length === 8);
  check('…mais UNE SEULE a créé', creees.length === 1);
  check('…et la base ne porte qu’une ligne',
    (await PanelStripeResourceBinding.countDocuments({
      environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: RES,
    })) === 1);

  // Deux PROJETS concurrents sur la même ressource : un gagne, l'autre est refusé.
  const DISPUTE = 'cus_DISPUTE000000001';
  const course = await Promise.allSettled([
    binding.bindResource({ projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: DISPUTE }),
    binding.bindResource({ projectId: B, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: DISPUTE }),
  ]);
  const gagnants = course.filter((r) => r.status === 'fulfilled' && r.value.outcome === BIND_OUTCOMES.CREATED);
  const perdants = course.filter((r) => r.status === 'rejected');
  check('un seul projet gagne la course', gagnants.length === 1);
  check('…et l’autre est refusé, jamais silencieusement ignoré', perdants.length === 1);
  check('…avec un conflit explicite', perdants[0]?.reason?.code === 'STRIPE_RESOURCE_ALREADY_BOUND');

  // On retrouve le lien d'une opération, sans connaître la ressource — c'est ce
  // qui permet à un rejeu de converger.
  const parOperation = await PanelStripeResourceBinding.findOne({
    createdByOperationId: 'op-l62a-000000000001',
  }).lean();
  check('un lien se retrouve par son opération', parOperation?.resourceId === CUS_A);
}

/* ========================================================================== */
section('7. LA FENÊTRE ENTRE STRIPE ET LE LIEN');
/* ========================================================================== */
{
  /**
   * Stripe a créé l'objet, le lien n'a pas été écrit : l'orphelin existe chez le
   * fournisseur et n'appartient à personne chez nous. On prouve ici la seule
   * chose qui rende cette fenêtre acceptable — l'orphelin n'est accessible à
   * PERSONNE, et le rejeu de la même opération le répare.
   */
  const ORPHELIN = 'cus_ORPHELIN00000001';

  for (const projet of [A, B]) {
    const verdict = await binding.describeOwnership({
      projectId: projet, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: ORPHELIN,
    });
    check(`l’orphelin n’est accessible ni à ${projet}`, verdict.allowed === false);
  }

  // Le rejeu de LA MÊME opération écrit le lien manquant.
  const repare = await binding.bindResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: ORPHELIN,
    createdByOperationId: 'op-l62a-000000000002',
  });
  check('le rejeu de l’opération répare le lien', repare.outcome === BIND_OUTCOMES.CREATED);
  check('…et la ressource appartient enfin à A',
    (await binding.describeOwnership({
      projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: ORPHELIN,
    })).allowed === true);
}

/* ========================================================================== */
section('8. RÉVOCATION — neutralise sans réattribuer');
/* ========================================================================== */
{
  const REVOQUE = 'cus_REVOQUE000000001';
  await binding.bindResource({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: REVOQUE,
  });
  const revocation = await binding.revokeBinding({
    environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: REVOQUE, reason: 'client supprimé',
  });
  check('la révocation aboutit', revocation.revoked === true);

  const apres = await binding.describeOwnership({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: REVOQUE,
  });
  check('le propriétaire ne peut plus s’en servir', apres.allowed === false);
  check('…motif REVOKED', apres.reason === REFUSAL_REASONS.REVOKED);

  // LE point : révoquer ne libère PAS l'identifiant.
  const recuperation = await caught(binding.bindResource({
    projectId: B, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: REVOQUE,
  }));
  check('un autre projet ne peut pas récupérer une ressource révoquée',
    recuperation?.code === 'STRIPE_RESOURCE_ALREADY_BOUND');

  check('…et elle sort des listes du propriétaire',
    !(await binding.listOwnedResourceIds({
      projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER,
    })).includes(REVOQUE));
}

/* ========================================================================== */
section('9. DIAGNOSTIC — des nombres, jamais un annuaire');
/* ========================================================================== */
{
  const inventaire = await binding.describeBindingInventory({ projectId: A });
  check('l’inventaire compte les liens', inventaire.total > 0);
  const rendu = JSON.stringify(inventaire);
  check('…sans aucun identifiant Stripe',
    !rendu.includes(CUS_A) && !rendu.includes(SUB_A) && !rendu.includes('cus_'));
  check('…mais avec l’environnement et le type',
    inventaire.byEnvironmentAndType.some((e) => e.environment === 'TEST' && e.resourceType === TYPES.CUSTOMER));

  // Le masque suffit à reconnaître, jamais à désigner.
  const masque = binding.maskResourceId(CUS_A);
  check('le masque garde le préfixe et quatre caractères',
    masque.startsWith('cus_') && masque.endsWith(CUS_A.slice(-4)) && masque.length < CUS_A.length);
  check('…et ne permet pas de reconstituer l’identifiant', !masque.includes(CUS_A.slice(4, 12)));
}

/* ========================================================================== */
section('10. L’APPARTENANCE EST LA SEULE AUTORITÉ D’ACCÈS');
/* ========================================================================== */
{
  /**
   * ── CE QUE CETTE SECTION PROUVAIT, ET CE QU'ELLE PROUVE MAINTENANT ─────────
   *
   * Elle vérifiait que l'appartenance et l'ouverture commerciale restaient
   * INDÉPENDANTES : fermer un commerce ne devait pas faire perdre un lien.
   *
   * L'ouverture commerciale a été supprimée. L'indépendance n'a donc plus de
   * second terme — et ce qui reste est plus fort : l'appartenance est
   * désormais la SEULE autorité qui décide qu'un projet peut toucher une
   * ressource Stripe. On vérifie donc qu'elle ne s'appuie sur rien d'autre.
   */
  const verdict = await binding.describeOwnership({
    projectId: A, environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('le lien de A tient par lui-même', verdict.allowed === true);

  const source = await (await import('node:fs/promises')).readFile(
    new URL('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js', import.meta.url), 'utf8',
  );
  check('le registre ne consulte AUCUN état commercial',
    !/commercialState|commercialReadiness|PREOPENING/.test(source));
  check('…ni activeMode', !/activeMode/.test(source));
  /**
   * ET IL NE CONSULTE AUCUN OCTROI NON PLUS.
   *
   * C'est le contrôle qui remplace celui d'indépendance : si le registre
   * d'appartenance avait un jour lu `capabilityGrants`, leur suppression aurait
   * emporté l'isolation avec elle.
   */
  check('…ni la moindre liste de capacités accordées',
    !/capabilityGrants|grantedCodes|isGranted/.test(source));
}

/* ========================================================================== */
section('11. ROUTAGE WEBHOOK FUTUR — un événement ne peut pas se tromper de projet');
/* ========================================================================== */
{
  /**
   * On n'active aucun webhook ici. On prouve que la RÉSOLUTION future est sûre :
   * partir de l'identifiant porté par l'événement et retrouver le projet par le
   * registre — jamais par une métadonnée seule, qui est modifiable.
   */
  const evenementDeA = { object: { id: SUB_A, customer: CUS_A } };
  const evenementDeB = { object: { id: CUS_B } };

  const cibleA = await binding.findBinding({
    environment: 'TEST', resourceType: TYPES.SUBSCRIPTION, resourceId: evenementDeA.object.id,
  });
  check('un événement portant l’abonnement de A désigne A', cibleA?.projectId === A);

  const cibleB = await binding.findBinding({
    environment: 'TEST', resourceType: TYPES.CUSTOMER, resourceId: evenementDeB.object.id,
  });
  check('un événement portant le client de B désigne B', cibleB?.projectId === B);
  check('…et jamais le même projet que le précédent', cibleA.projectId !== cibleB.projectId);

  // Un événement portant une ressource inconnue ne se dispatche à personne.
  const inconnue = await binding.findBinding({
    environment: 'TEST', resourceType: TYPES.SUBSCRIPTION, resourceId: 'sub_JAMAISVUE0000001',
  });
  check('un événement inconnu ne désigne AUCUN projet', inconnue === null);

  // Le monde compte aussi : un événement PROD ne réveille pas un projet TEST.
  const mauvaisMonde = await binding.findBinding({
    environment: 'PROD', resourceType: TYPES.SUBSCRIPTION, resourceId: SUB_A,
  });
  check('un événement de l’autre monde ne désigne personne', mauvaisMonde === null);
}

/* ========================================================================== */
section('12. LE CONTRAT L6.1 S’APPUIE SUR LE REGISTRE');
/* ========================================================================== */
{
  // Une seule liste de familles, désormais.
  check('les familles viennent du modèle',
    ownership.STRIPE_RESOURCE_KIND_VALUES.length === Object.keys(TYPES).length);

  // Sans résolveur injecté, c'est le registre qui répond.
  const parDefaut = await ownership.describeResourceOwnership({
    projectId: A, environment: 'TEST', kind: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('le contrat L6.1 autorise via le registre', parDefaut.allowed === true);

  const refuse = await ownership.describeResourceOwnership({
    projectId: B, environment: 'TEST', kind: TYPES.CUSTOMER, resourceId: CUS_A,
  });
  check('…et refuse un autre projet', refuse.allowed === false);
  check('…sans nommer le propriétaire', refuse.boundProjectId === null);

  const readiness = ownership.describeBindingReadiness();
  check('le registre est déclaré disponible', readiness.available === true);
  check('la route active est « le Panel crée »',
    readiness.activeRoute === ownership.BINDING_ROUTES.CREATED_BY_PANEL);
  check('la déclaration par le projet reste refusée',
    readiness.refusedRoute.startsWith('REFUSED'));

  /**
   * L6.2A ne migrait rien ; L6.2B a servi la première capacité. L'invariant que
   * cette section défend n'a pas changé pour autant : aucune capacité qui EXIGE
   * de posséder une ressource préexistante n'est ouverte, parce que le registre
   * de liens ne contient encore aucun client ni abonnement. Servir l'une
   * d'elles reviendrait à croire l'identifiant que le projet présente — ce que
   * tout ce fichier s'emploie à rendre impossible.
   */
  const exigeantes = capabilities.STRIPE_CAPABILITY_CODES
    .filter((c) => capabilities.STRIPE_CAPABILITIES[c].requiresResourceOwnership);
  /**
   * NEUF depuis la nouvelle tentative, qui rejoint la famille FACTURE.
   *
   * Elle accepte, elle, un identifiant de facture — et c’est précisément
   * pourquoi elle exige un lien : l’identifiant n’est pas une preuve, il est
   * un filtre. Sans lien, on retenterait la collecte de la facture d’un autre.
   */
  check('neuf capacités exigent une ressource préexistante', exigeantes.length === 9);
  /**
   * L6.2C en sert UNE : la lecture de session. Elle le peut parce que le Panel
   * crée et lie lui-même des sessions depuis L6.2B — l'appartenance est donc
   * PROUVABLE, et non supposée. Les trois autres exigent un client ou un
   * abonnement que le Panel n'a jamais créés : les servir reviendrait à croire
   * l'identifiant présenté, ce que ce fichier entier s'emploie à empêcher.
   */
  // Figurer au catalogue EST la déclaration de service : le filtre sur
  // `migrated` a disparu avec le booléen.
  const servies = [...exigeantes];
  check('toutes les neuf sont servies', servies.length === 9);
  check('…dont la nouvelle tentative sur une facture',
    servies.includes('billing.invoice.retry'));
  check('…la lecture de session', servies.includes('billing.checkout.retrieve'));
  check('…celle d’un abonnement (L6.2F)', servies.includes('billing.subscription.retrieve'));
  /**
   * L10.4 — LE REMBOURSEMENT MUTE UNE INTENTION DE PAIEMENT.
   *
   * Famille que le Panel ne crée pas davantage qu'un abonnement, et qu'il
   * n'accepte pas plus sur parole. Elle est ADOPTÉE à la projection du revenu
   * (L10.3) par filiation de la session ou de l'abonnement possédé qui l'a
   * produite — trois preuves réunies au même instant : ressource porteuse
   * possédée, webhook signé, filiation désignée par Stripe. Aucune ne vient
   * d'un navigateur, et c'est ce qui rend la famille servable.
   */
  check('…et le remboursement d’une intention de paiement (L10.4)',
    servies.includes('billing.refund'));
  /**
   * L6.2G — LES DEUX RÉSILIATIONS S'APPUIENT SUR LA MÊME PREUVE.
   *
   * Elles n'ouvrent aucune voie d'ancrage nouvelle : elles MUTENT un abonnement
   * déjà adopté par filiation. C'est ce qui les rend servables sans rien céder —
   * l'identifiant que le projet présente ne vaut toujours rien par lui-même.
   */
  check('…et les deux résiliations (L6.2G)',
    servies.includes('billing.subscription.cancel_at_period_end')
    && servies.includes('billing.subscription.cancel_now'));
  check('elles portent bien la famille ABONNEMENT',
    ['billing.subscription.cancel_at_period_end', 'billing.subscription.cancel_now']
      .every((c) => capabilities.STRIPE_CAPABILITIES[c].resourceKind
        === binding.STRIPE_RESOURCE_TYPES.SUBSCRIPTION));

  /**
   * DEUX VOIES D'ANCRAGE, ET C'EST NOUVEAU.
   *
   * La session est ancrée parce que le Panel la CRÉE. L'abonnement, non : Stripe
   * le fabrique au paiement. Il est ancré par FILIATION — la session qui l'a
   * produit est possédée, et Stripe lui-même désigne le lien.
   *
   * C'est la première adoption du plan de contrôle, et elle reste une preuve :
   * on n'a pas assoupli la règle, on a trouvé une seconde façon de la satisfaire.
   */
  check('la session est ancrée par CRÉATION',
    capabilities.STRIPE_CAPABILITIES['billing.checkout.retrieve'].resourceKind
    === binding.STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION);
  check('l’abonnement est ancré par FILIATION',
    capabilities.STRIPE_CAPABILITIES['billing.subscription.retrieve'].resourceKind
    === binding.STRIPE_RESOURCE_TYPES.SUBSCRIPTION);

  /**
   * UNE SEULE reste fermée : le listing de factures. Il exige un CLIENT, famille
   * qu'aucun lien n'ancre encore, et demanderait de surcroît une liste plus
   * large que son dû. Aucun abonnement ne figure plus dans les fermées — L6.2G
   * les a toutes ouvertes, sur la preuve de L6.2F et sur rien d'autre.
   */
  /**
   * L6.3B — PLUS AUCUNE NE RESTE FERMÉE.
   *
   * `billing.invoice.list` était la dernière, et ce n'est pas le calendrier qui
   * l'a ouverte : son contrat d'entrée demandait un `customerId` AU PROJET.
   * Elle prend désormais le CONTRAT, et le Panel remonte au client par le lien
   * qu'il a lui-même écrit en L6.2D. Elle a cessé d'exiger ce qu'on ne pouvait
   * pas lui accorder.
   */
  const fermees = exigeantes.filter((c) => !adaptersStripe.STRIPE_ADAPTERS[c]);
  check('aucune capacité exigeant une ressource ne reste fermée', fermees.length === 0);
  check('…et les trois nouvelles portent bien la famille CLIENT',
    ['billing.invoice.list', 'billing.invoice.retrieve', 'billing.portal.create']
      .every((c) => capabilities.STRIPE_CAPABILITIES[c].resourceKind
        === binding.STRIPE_RESOURCE_TYPES.CUSTOMER));
}

await stopMemoryMongo();
finish();
