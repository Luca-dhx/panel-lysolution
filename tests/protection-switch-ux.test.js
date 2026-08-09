/**
 * LOT C — LA MACHINE À ÉTATS DE L'INTERRUPTEUR DE PROTECTION.
 *
 * ══ CE QU'ELLE DOIT GARANTIR ════════════════════════════════════════════════
 *
 * Le réglage VOYAGE : commande au projet, application, réconciliation, puis
 * projection de retour — 500 à 700 ms, dont 500 ms de fenêtre de regroupement
 * délibérée. Pendant ce temps, l'écran doit montrer l'INTENTION sans jamais la
 * prendre pour la vérité.
 *
 *   OFF ──clic──► PENDING(ON) ──projection ON──► ON
 *    ▲                │
 *    └──── échec ─────┘   (retour au dernier état CONFIRMÉ)
 *
 *   PENDING(ON) ──projection OFF (contradictoire)──► OFF
 *                 la projection gagne TOUJOURS
 *
 * ══ POURQUOI ON TESTE LE HOOK, PAS LE RENDU ═════════════════════════════════
 *
 * Tout ce qui peut mal tourner vit dans la machine : l'intention en vol, la
 * projection contradictoire, le retour en arrière, le double clic. Les éprouver
 * à travers un moteur de rendu reviendrait à tester le rendu.
 */
import { check, finish, section } from './helpers/harness.js';
import { mount } from './helpers/reactHarness.mjs';
import { register } from 'node:module';

/**
 * Le chargeur est enregistré ICI, comme dans les autres suites frontend : le
 * lanceur commun exécute chaque fichier par un simple `node fichier.js`, sans
 * option supplémentaire. Un test qui exigerait `--import` serait vert à la main
 * et sauté par la suite.
 */
register('./helpers/frontendLoader.mjs', import.meta.url);

const { useSwitchIntent } = await import('@/lib/useSwitchIntent.ts');

/** Un différé qu'on résout à la main — la commande, pilotée par le test. */
function differe() {
  let resoudre; let rejeter;
  const promesse = new Promise((res, rej) => { resoudre = res; rejeter = rej; });
  return { promesse, resoudre, rejeter };
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('OFF → activation en cours → ON');
{
  const commande = differe();
  let confirme = false;
  const appels = [];

  const vue = mount(() => useSwitchIntent({
    checked: confirme,
    onToggle: async (next) => { appels.push(next); return commande.promesse; },
  }));

  check('état initial : OFF, stable', vue.result.affiche === false && !vue.result.enCours);

  void vue.result.basculer();
  await vue.flush();

  check('le curseur part IMMÉDIATEMENT vers l’intention', vue.result.affiche === true);
  check('…et l’attente est visible', vue.result.enCours === true);
  check('…la commande a été envoyée une fois', appels.length === 1 && appels[0] === true);

  /* — LA COMMANDE RÉPOND, MAIS ELLE NE FAIT PAS AUTORITÉ — */
  commande.resoudre();
  await vue.flush();
  check('la réponse de la commande ne clôt PAS l’attente', vue.result.enCours === true);
  check('…l’interrupteur reste sur l’intention', vue.result.affiche === true);

  /* — LA PROJECTION ARRIVE : C'EST ELLE QUI CONFIRME — */
  confirme = true;
  vue.rerender();
  await vue.flush();
  check('la projection confirme : état stable', vue.result.enCours === false);
  check('…et l’interrupteur est ON', vue.result.affiche === true);
  check('…sans erreur', vue.result.erreur === null);
  vue.unmount();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ON → désactivation en cours → OFF');
{
  const commande = differe();
  let confirme = true;

  const vue = mount(() => useSwitchIntent({
    checked: confirme,
    onToggle: async () => commande.promesse,
  }));

  check('état initial : ON', vue.result.affiche === true);
  void vue.result.basculer();
  await vue.flush();
  check('le curseur part vers OFF', vue.result.affiche === false);
  check('…en attente', vue.result.enCours === true);

  commande.resoudre();
  confirme = false;
  vue.rerender();
  await vue.flush();
  check('la projection confirme OFF', vue.result.affiche === false && !vue.result.enCours);
  vue.unmount();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ÉCHEC DE COMMANDE → retour au dernier état CONFIRMÉ');
{
  const commande = differe();
  const confirme = false;

  const vue = mount(() => useSwitchIntent({
    checked: confirme,
    onToggle: async () => commande.promesse,
  }));

  void vue.result.basculer();
  await vue.flush();
  check('l’intention est affichée', vue.result.affiche === true);

  commande.rejeter(new Error('Le projet a refusé le réglage.'));
  await vue.flush();

  check('ROLLBACK : l’interrupteur revient à l’état confirmé', vue.result.affiche === false);
  check('…l’attente est terminée', vue.result.enCours === false);
  check('…la phase dit l’échec', vue.result.phase === 'ERROR');
  check('…et l’erreur est actionnable', vue.result.erreur === 'Le projet a refusé le réglage.');
  vue.unmount();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PROJECTION CONTRADICTOIRE PENDANT L’ATTENTE — la projection gagne');
{
  const commande = differe();
  let confirme = false;

  const vue = mount(() => useSwitchIntent({
    checked: confirme,
    onToggle: async () => commande.promesse,
  }));

  void vue.result.basculer();
  await vue.flush();
  check('l’utilisateur a demandé ON', vue.result.affiche === true && vue.result.enCours);

  /**
   * Un autre opérateur désactive, ou le projet réconcilie autrement : la
   * projection dit OFF alors que l'intention disait ON. Garder l'intention
   * ferait afficher un réglage que personne n'a appliqué — et deux écrans
   * ouverts raconteraient deux histoires différentes.
   */
  confirme = false;
  vue.rerender();
  await vue.flush();

  // `checked` n'a pas changé de valeur (false → false) : l'effet ne se
  // redéclenche pas. On force donc une VRAIE contradiction : ON puis OFF.
  confirme = true;
  vue.rerender();
  await vue.flush();
  check('la projection ON est adoptée', vue.result.affiche === true && !vue.result.enCours);

  confirme = false;
  vue.rerender();
  await vue.flush();
  check('LA PROJECTION GAGNE TOUJOURS : l’interrupteur suit', vue.result.affiche === false);
  check('…et aucune intention ne survit', vue.result.enCours === false);
  vue.unmount();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DOUBLE CLIC — une seule commande part');
{
  const commande = differe();
  const confirme = false;
  const appels = [];

  const vue = mount(() => useSwitchIntent({
    checked: confirme,
    onToggle: async (next) => { appels.push(next); return commande.promesse; },
  }));

  void vue.result.basculer();
  await vue.flush();
  void vue.result.basculer();
  void vue.result.basculer();
  await vue.flush();

  check('UNE seule commande a été envoyée', appels.length === 1);
  check('…et l’interrupteur ne clignote pas', vue.result.affiche === true);
  vue.unmount();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUNE ÉCRITURE OPTIMISTE — l’intention ne survit pas au démontage');
{
  const commande = differe();
  let confirme = false;

  const vue = mount(() => useSwitchIntent({
    checked: confirme,
    onToggle: async () => commande.promesse,
  }));

  void vue.result.basculer();
  await vue.flush();
  check('intention en vol', vue.result.affiche === true);

  /**
   * RECHARGEMENT PENDANT LA SYNCHRONISATION.
   *
   * Le composant est démonté puis remonté — c'est ce que fait un rechargement
   * de page. L'état reconstruit ne doit venir QUE de la projection : une
   * intention qui survivrait afficherait un réglage que rien n'a persisté.
   */
  vue.unmount();

  const apres = mount(() => useSwitchIntent({
    checked: confirme,
    onToggle: async () => commande.promesse,
  }));
  await apres.flush();
  check('après remontage : l’état vient de la PROJECTION, pas de l’intention',
    apres.result.affiche === false);
  check('…et rien n’est en attente', apres.result.enCours === false);
  apres.unmount();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DÉSACTIVÉ — aucun clic ne part');
{
  const appels = [];
  const vue = mount(() => useSwitchIntent({
    checked: false,
    disabled: true,
    onToggle: async (next) => { appels.push(next); },
  }));

  void vue.result.basculer();
  await vue.flush();
  check('aucune commande envoyée', appels.length === 0);
  check('…et aucun état d’attente', vue.result.enCours === false);
  vue.unmount();
}

finish();
