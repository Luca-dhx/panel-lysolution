/* LE CONTRAT DE VARIABLES — une seule autorité, et un écart DÉTECTABLE AVANT.
 *
 * ══ LA PANNE QUE CE FICHIER REND IMPOSSIBLE À IGNORER ═══════════════════════
 *
 * Le Panel possède le vocabulaire d'un modèle (quelles variables, lesquelles
 * sont obligatoires, de quel type) ; chaque projet possède la façon de produire
 * les valeurs. Rien ne reliait ces deux autorités : l'audit a constaté qu'elles
 * s'accordaient « par chance », et que rien ne le vérifiait à l'exécution.
 *
 * Le coût du silence était précis. Ajouter une variable OBLIGATOIRE fait
 * échouer TOUS les envois de ce modèle, sur TOUS les projets déployés — pas
 * tout de suite, mais au prochain e-mail. Le premier symptôme est un client qui
 * n'a pas reçu sa réinitialisation de mot de passe, des semaines plus tard.
 *
 * L'empreinte referme cet écart : le projet renvoie celle qu'il a lue, le Panel
 * la compare à la sienne, et le désaccord se constate À LA DÉCLARATION.
 *
 * ══ POURQUOI UN ÉCART NE BLOQUE PAS ═════════════════════════════════════════
 *
 * Seul le rendu sait si les valeurs RÉELLEMENT fournies suffisent. Refuser
 * d'avance interdirait des envois parfaitement rendables au motif qu'un libellé
 * a bougé — et une alerte qui se déclenche pour rien finit par n'être plus lue.
 *
 * Panel en mémoire, aucun réseau. Runner autonome. */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const contract = await import('../backend/src/services/email/panelEmailTemplateContract.js');
const registry = await import('../backend/src/services/email/panelEmailTemplateRegistry.js');
const definitions = await import('../backend/src/services/email/panelEmailTemplateDefinitions.js');
const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const scopes = await import('../backend/src/services/email/panelEmailTemplateScope.js');

const CODE = 'PASSWORD_RESET_REQUEST';

// ═══════════════════════════════════════════════════════════════════════════
section('1 · L’empreinte est STABLE, et ne dépend que de ce qui casse un rendu');
{
  const a = contract.variableContractFingerprint(CODE);
  const b = contract.variableContractFingerprint(CODE);
  check('deux calculs donnent la même empreinte', a === b && a.length > 0);
  check('elle tient dans une borne raisonnable', a.length === 32);

  const canonique = contract.canonicalVariableContract(CODE);
  check('la forme canonique est triée par clé',
    JSON.stringify(canonique.map((v) => v.key))
    === JSON.stringify(canonique.map((v) => v.key).sort()));
  check('elle ne porte QUE clé, type et obligation',
    canonique.every((v) => Object.keys(v).sort().join(',') === 'key,required,type'));

  /**
   * CE QUI N'ENTRE PAS DANS L'EMPREINTE, et pourquoi c'est délibéré.
   *
   * Un libellé, une description, un ordre de déclaration : les réécrire n'a
   * jamais empêché un rendu. Les inclure ferait clignoter l'alerte à chaque
   * correction de faute d'orthographe.
   */
  const variables = registry.variablesFor(CODE);
  check('le contrat ne contient ni libellé ni description',
    !JSON.stringify(canonique).includes(variables[0].label ?? '§introuvable§'));

  check('chaque code du registre a une empreinte',
    registry.EMAIL_TEMPLATE_IDS.every((c) => contract.variableContractFingerprint(c).length === 32));
  const toutes = contract.allVariableContractFingerprints();
  check('l’ensemble des empreintes couvre le registre',
    Object.keys(toutes).length === registry.EMAIL_TEMPLATE_IDS.length);
  check('un code inconnu n’a pas d’empreinte',
    contract.variableContractFingerprint('CODE_INVENTE') === '');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · Deux modèles distincts ne partagent pas une empreinte');
{
  const vues = new Map();
  let collisions = 0;
  for (const code of registry.EMAIL_TEMPLATE_IDS) {
    const fp = contract.variableContractFingerprint(code);
    const memes = vues.get(fp) ?? [];
    // Deux modèles PEUVENT légitimement partager un contrat identique ; ce
    // qu'on vérifie est qu'une collision, si elle existe, s'explique par un
    // contrat réellement identique — pas par un hachage trop court.
    if (memes.length) {
      const identique = JSON.stringify(contract.canonicalVariableContract(code))
        === JSON.stringify(contract.canonicalVariableContract(memes[0]));
      if (!identique) collisions += 1;
    }
    vues.set(fp, [...memes, code]);
  }
  check('aucune collision entre contrats DIFFÉRENTS', collisions === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · La comparaison nomme les TROIS situations, et pas une de plus');
{
  const courante = contract.variableContractFingerprint(CODE);

  check('empreinte identique -> MATCH',
    contract.compareContractFingerprint(CODE, courante).status === contract.CONTRACT_COMPATIBILITY.MATCH);
  check('empreinte différente -> STALE',
    contract.compareContractFingerprint(CODE, 'empreinte-d-un-autre-temps').status
    === contract.CONTRACT_COMPATIBILITY.STALE);

  /**
   * UN PROJET ANTÉRIEUR AU LOT N'EST PAS EN PANNE.
   *
   * Il n'envoie pas d'empreinte parce que son logiciel ne sait pas encore le
   * faire. Le ranger avec les incompatibles ferait passer tout le parc en
   * alerte le jour du déploiement, et l'alerte serait fausse.
   */
  check('empreinte absente -> UNDECLARED, jamais STALE',
    contract.compareContractFingerprint(CODE, undefined).status
    === contract.CONTRACT_COMPATIBILITY.UNDECLARED);
  check('empreinte vide -> UNDECLARED aussi',
    contract.compareContractFingerprint(CODE, '   ').status
    === contract.CONTRACT_COMPATIBILITY.UNDECLARED);
  check('code inconnu -> UNKNOWN_TEMPLATE',
    contract.compareContractFingerprint('CODE_INVENTE', 'x').status
    === contract.CONTRACT_COMPATIBILITY.UNKNOWN_TEMPLATE);
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · LE VERDICT D’UN PROJET — ce que la réconciliation inscrit');
{
  const codes = definitions.codesToProvisionForProjects().slice(0, 3);
  const aJour = Object.fromEntries(codes.map((c) => [c, contract.variableContractFingerprint(c)]));

  const bon = contract.describeContractCompatibility(aJour, codes);
  check('un projet à jour est compatible', bon.compatible === true);
  check('…et tous ses modèles sont en MATCH', bon.match.length === codes.length);
  check('…sans aucun périmé', bon.stale.length === 0);

  const perime = { ...aJour, [codes[0]]: 'contrat-d-il-y-a-trois-mois' };
  const mauvais = contract.describeContractCompatibility(perime, codes);
  check('un contrat périmé rend le projet INCOMPATIBLE', mauvais.compatible === false);
  check('…et le modèle fautif est NOMMÉ', mauvais.stale.includes(codes[0]));
  check('…sans accuser les autres', mauvais.stale.length === 1);

  const muet = contract.describeContractCompatibility({}, codes);
  check('un projet muet n’est PAS déclaré incompatible', muet.compatible === true);
  check('…mais son silence est constaté', muet.undeclared.length === codes.length);
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · L’EMPREINTE EST BIEN CELLE QUE LE PANEL SERT AU PROJET');
{
  /**
   * ══ LA PROPRIÉTÉ QUI FERME LA BOUCLE ══════════════════════════════════════
   *
   * Le projet ne recalcule jamais l'empreinte : il RENVOIE celle qu'il a lue.
   * Encore faut-il que la projection la lui serve, et qu'elle soit la même que
   * celle contre laquelle le Panel comparera. Sans ce contrôle, les deux moitiés
   * du mécanisme pourraient diverger sans que rien ne l'indique — et c'est
   * exactement le genre de désaccord silencieux que ce lot supprime.
   */
  await templates.seedPanelTemplates();
  const projection = await templates.describeProjectionForScope(scopes.panelScope());
  check('la projection n’est pas vide', projection.length > 0);

  const ecarts = projection.filter(
    (item) => item.variableContractFingerprint !== contract.variableContractFingerprint(item.templateCode),
  );
  check(`la projection sert EXACTEMENT l’empreinte du registre (${ecarts.map((e) => e.templateCode).join(', ') || 'aucun écart'})`,
    ecarts.length === 0);

  check('chaque entrée porte aussi le contrat en clair',
    projection.every((item) => Array.isArray(item.variables)
      && item.variables.length === registry.variablesFor(item.templateCode).length));
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · LE RENDU RESTE STRICT — l’empreinte prévient, elle ne remplace pas');
{
  const renderer = await import('../backend/src/services/email/panelEmailTemplateRenderer.js');
  const stored = await templates.resolveTemplate(CODE, scopes.panelScope());
  const requises = registry.variablesFor(CODE).filter((v) => v.required).map((v) => v.key);

  const complet = Object.fromEntries(registry.sampleVariablesFor(CODE));
  let rendu = null;
  try {
    rendu = renderer.renderTemplate({ templateId: CODE, template: stored, variables: complet });
  } catch { rendu = null; }
  check('des valeurs complètes se rendent', Boolean(rendu?.subject));

  const ampute = { ...complet };
  delete ampute[requises[0]];
  let refus = null;
  try {
    renderer.renderTemplate({ templateId: CODE, template: stored, variables: ampute });
  } catch (e) { refus = e; }
  check('une variable OBLIGATOIRE manquante fait échouer le rendu',
    refus?.code === 'MISSING_REQUIRED_VARIABLE');
  check('…et le refus NOMME la variable',
    (refus?.details ?? []).some((d) => d.variable === requises[0]));

  let inconnue = null;
  try {
    renderer.renderTemplate({
      templateId: CODE, template: stored, variables: { ...complet, 'variable.inventee': 'x' },
    });
  } catch (e) { inconnue = e; }
  check('une variable INCONNUE fait échouer le rendu aussi',
    inconnue?.code === 'UNKNOWN_VARIABLE');

  /**
   * C'est précisément parce que le rendu est aussi strict que l'empreinte est
   * utile : sans elle, ces deux refus n'apparaissent qu'au premier envoi réel.
   */
  check('le rendu strict et l’empreinte visent bien le même vocabulaire',
    requises.every((k) => contract.canonicalVariableContract(CODE)
      .some((v) => v.key === k && v.required)));
}

// ---------------------------------------------------------------------------
await stopMemoryMongo();
finish();
