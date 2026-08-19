import { DeploymentError } from './errors.js';

/**
 * LE CONTRAT D'EXÉCUTION DISTANTE — une commande n'a pas « fini », elle a
 * RÉUSSI ou ÉCHOUÉ.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * Le moteur exécutait ses commandes distantes par `transport.exec(...)` et, sur
 * le chemin critique du pipeline, n'en lisait JAMAIS le code de sortie. Les cinq
 * commandes de `pipeline.js` — création des dossiers de release, BASCULE des
 * applications publiées, liens des données persistantes, `npm ci` — étaient
 * lancées et attendues, jamais vérifiées.
 *
 * Concrètement : `npm ci --omit=dev` pouvait retourner 1, l'étape
 * « Installation & configuration » passait au vert, et le déploiement ne
 * découvrait le problème qu'au contrôle de santé — plusieurs étapes plus loin,
 * après avoir publié une release dont les dépendances n'étaient pas installées.
 * L'injection d'échec du lot précédent l'a établi.
 *
 * Un utilitaire `execOrThrow` existait pourtant dans `Transport.js`. Il n'avait
 * AUCUN appelant — écrit une fois, jamais adopté. C'est le sort habituel d'une
 * primitive facultative : ce module la rend obligatoire pour les commandes
 * critiques, et une garde d'architecture le vérifie.
 *
 * ══ CE QU'IL AJOUTE ═════════════════════════════════════════════════════════
 *
 *   · un RÉSULTAT NORMALISÉ, identique pour tous les appelants ;
 *   · une CLASSE explicite — aucune commande n'est « best-effort » par oubli ;
 *   · des ERREURS TYPÉES distinguant « la commande a échoué » de « je n'ai pas
 *     pu l'exécuter » ;
 *   · des sorties BORNÉES et CAVIARDÉES avant tout rapport ;
 *   · un IDENTIFIANT stable, non sensible, affichable à la place de la ligne
 *     shell.
 */

/**
 * ══ LES CLASSES DE COMMANDE ═════════════════════════════════════════════════
 *
 * La classe n'est pas une nuance de journal : elle décide de ce qui arrive
 * quand la commande échoue. Elle est donc OBLIGATOIRE — une commande sans
 * classe est refusée, précisément pour qu'aucune ne devienne best-effort par
 * inadvertance.
 */
export const COMMAND_CLASS = Object.freeze({
  /** Le déploiement ne peut pas continuer sans elle. Échec → erreur typée. */
  CRITICAL: 'CRITICAL',
  /** Son échec est acceptable et JOURNALISÉ. Jamais implicite. */
  BEST_EFFORT: 'BEST_EFFORT',
  /** Elle POSE UNE QUESTION. Son code de sortie est une réponse, pas un échec. */
  PROBE: 'PROBE',
  /** Ménage après coup. Un ménage raté ne défait pas un travail réussi. */
  CLEANUP: 'CLEANUP',
  /** Réparation après échec. Son échec ne doit jamais masquer l'erreur primaire. */
  ROLLBACK: 'ROLLBACK',
});

/**
 * POLITIQUE DE DÉLAIS — centralisée, jamais devinée au point d'appel.
 *
 * Une commande distante sans délai peut bloquer un déploiement indéfiniment :
 * l'écran reste « en cours », personne ne sait s'il faut attendre ou relancer.
 * Les valeurs viennent de ce qu'on observe réellement — une installation de
 * dépendances est longue, un lien symbolique ne l'est jamais.
 */
export const TIMEOUTS = Object.freeze({
  QUICK: 30_000,
  FILESYSTEM: 60_000,
  SERVICE: 60_000,
  INSTALL: 300_000,
  BUILD: 600_000,
  CERTBOT: 180_000,
  HEALTH: 30_000,
});

/** Taille maximale conservée de chaque flux — pour un diagnostic, pas pour une archive. */
const TAIL_MAX = 2_000;

/**
 * CAVIARDAGE — appliqué AVANT toute conservation, jamais après.
 *
 * Une sortie de commande distante contient volontiers une URI Mongo (message
 * d'erreur de connexion), un jeton, ou le contenu d'un `.env` mal recopié. Le
 * rapport est relu, exporté, parfois collé dans un ticket : ce qui n'est pas
 * caviardé ici finit par circuler.
 */
const MOTIFS_SECRETS = [
  [/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://«caviardé»'],
  [/\b[A-Za-z0-9_-]*(SECRET|TOKEN|PASSWORD|API_?KEY)[A-Za-z0-9_-]*\s*=\s*\S+/gi, '$1=«caviardé»'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«clé privée caviardée»'],
  [/\bAuthorization:\s*\S+/gi, 'Authorization: «caviardé»'],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, '«jeton caviardé»'],
];

export function redactOutput(texte) {
  let sortie = String(texte ?? '');
  for (const [motif, remplacement] of MOTIFS_SECRETS) sortie = sortie.replace(motif, remplacement);
  return sortie;
}

/** Fin de flux, caviardée et bornée. La fin porte l'erreur ; le début, le bruit. */
export function tail(texte, max = TAIL_MAX) {
  const caviarde = redactOutput(texte).trimEnd();
  return caviarde.length <= max ? caviarde : `…${caviarde.slice(-max)}`;
}

export class RemoteCommandError extends DeploymentError {
  constructor(code, message, meta) {
    super(code, message, meta);
    this.name = 'RemoteCommandError';
  }
}

/**
 * EXÉCUTE UNE COMMANDE DISTANTE, ET DIT CE QU'ELLE A FAIT.
 *
 * @param {object} transport            le transport (SSH, simulé, local)
 * @param {object} spec
 * @param {string} spec.commandId       identifiant STABLE et non sensible
 *                                      (`dependencies.npm_ci`) — c'est lui qui
 *                                      apparaît dans les rapports, jamais la
 *                                      ligne shell, qui peut porter des chemins.
 * @param {string} spec.command         la ligne réellement exécutée
 * @param {string} spec.commandClass    COMMAND_CLASS — obligatoire
 * @param {number} [spec.timeoutMs]     défaut selon la classe
 * @param {string} [spec.step]          étape du pipeline, pour l'erreur typée
 * @param {number[]} [spec.okExitCodes] codes acceptés (défaut : [0])
 * @returns {Promise<object>} résultat normalisé
 */
export async function runRemoteCommand(transport, {
  commandId,
  command,
  commandClass,
  timeoutMs,
  step = null,
  okExitCodes = [0],
  input,
} = {}) {
  if (!commandId) throw new Error('runRemoteCommand : commandId requis (identifiant stable, non sensible).');
  if (!Object.values(COMMAND_CLASS).includes(commandClass)) {
    /**
     * PAS DE CLASSE PAR DÉFAUT, ET C'EST LE POINT.
     *
     * Un défaut à `CRITICAL` ferait échouer des sondes légitimes ; un défaut à
     * `BEST_EFFORT` rendrait silencieux tout ce qu'on oublie de classer — c'est
     * exactement la situation qu'on répare. On exige donc une décision.
     */
    throw new Error(`runRemoteCommand : classe manquante ou inconnue pour « ${commandId} ».`);
  }

  const delai = timeoutMs ?? TIMEOUTS.QUICK;
  const debut = Date.now();
  let brut;
  try {
    brut = await transport.exec(command, { timeoutMs: delai, input });
  } catch (err) {
    /**
     * ══ LE TRANSPORT A LEVÉ : ON N'A PAS PU EXÉCUTER ═══════════════════════
     *
     * Connexion perdue, délai dépassé, canal refusé. Ce n'est PAS « la commande
     * a échoué » — on ne sait pas si elle a tourné, ni jusqu'où. La distinction
     * compte : une installation interrompue par une coupure réseau peut avoir
     * à moitié écrit ses fichiers.
     *
     * Dans tous les cas, ce n'est jamais un succès.
     */
    const timedOut = /timeout|timed out/i.test(err?.message || '');
    const code = timedOut ? 'REMOTE_COMMAND_TIMEOUT' : 'REMOTE_COMMAND_CONNECTION_LOST';
    const resultat = {
      commandId,
      commandClass,
      exitCode: null,
      signal: null,
      stdoutTail: '',
      stderrTail: tail(err?.message || ''),
      durationMs: Date.now() - debut,
      timedOut,
      connectionLost: !timedOut,
      ok: false,
    };
    /**
     * ══ UNE SONDE AUSSI DOIT LEVER QUAND ON N'A PAS PU LA POSER ═════════════
     *
     * Une sonde tolère un code de sortie non nul : c'est sa RÉPONSE — « ce
     * fichier n'existe pas », « ce port est libre ». Elle ne tolère pas de ne
     * pas avoir été exécutée : connexion refusée, délai dépassé, canal fermé.
     *
     * Confondre les deux effacerait la distinction la plus utile du
     * diagnostic. Le préflight en donne le cas exact : lorsque `id -un` échoue
     * parce que l'authentification est refusée, le rapport doit dire
     * « authentification refusée » — pas « l'utilisateur distant est vide »,
     * qui est la réponse qu'on lirait si l'on traitait l'impossibilité
     * d'exécuter comme un résultat.
     *
     * L'appelant qui veut vraiment ignorer l'incident garde `.catch()` — mais
     * il l'écrit, et cela se voit.
     */
    const erreurTransport = new RemoteCommandError(
      code,
      timedOut
        ? `Commande distante « ${commandId} » interrompue après ${delai} ms.`
        : `Connexion perdue pendant la commande distante « ${commandId} ».`,
      { step, details: { commandId, commandClass, durationMs: resultat.durationMs, stderrTail: resultat.stderrTail } }
    );
    /**
     * LA CAUSE D'ORIGINE EST CONSERVÉE, ET C'EST INDISPENSABLE.
     *
     * L'erreur du transport porte le message qui NOMME la panne :
     * « All configured authentication methods failed », « connect ECONNREFUSED
     * 195.35.0.211:22 ». Le diagnostic du préflight s'en sert pour distinguer
     * une authentification refusée d'un port fermé — deux causes qui appellent
     * deux gestes différents.
     *
     * L'envelopper sans la conserver remplacerait ce diagnostic par
     * « connexion perdue », qui est vrai et inutile.
     */
    erreurTransport.cause = err;
    throw erreurTransport;
  }

  /**
   * ══ UN CODE DE SORTIE ABSENT N'EST PAS UN SUCCÈS ═══════════════════════════
   *
   * Le transport SSH rendait `code: exitCode ?? 0` — un flux fermé SANS code,
   * c'est-à-dire une connexion coupée ou un process tué par signal, était donc
   * indiscernable d'une réussite. C'est le défaut le plus grave de l'inventaire,
   * parce qu'il transforme une panne réseau en déploiement vert.
   */
  const exitCode = brut?.code === null || brut?.code === undefined ? null : Number(brut.code);
  const signal = brut?.signal ?? null;
  const resultat = {
    commandId,
    commandClass,
    exitCode,
    signal,
    stdout: brut?.stdout ?? '',
    stderr: brut?.stderr ?? '',
    stdoutTail: tail(brut?.stdout ?? ''),
    stderrTail: tail(brut?.stderr ?? ''),
    durationMs: Date.now() - debut,
    timedOut: false,
    connectionLost: false,
    ok: exitCode !== null && okExitCodes.includes(exitCode),
  };

  if (resultat.ok) return resultat;

  /**
   * Une SONDE rend son verdict, elle n'échoue pas : `test -f …` qui répond 1
   * dit « le fichier n'existe pas », ce qui est une réponse parfaitement
   * valide. L'appelant décide.
   */
  if (commandClass === COMMAND_CLASS.PROBE) return resultat;

  if (exitCode === null) {
    throw new RemoteCommandError(
      signal ? 'REMOTE_COMMAND_SIGNALLED' : 'REMOTE_COMMAND_CONNECTION_LOST',
      signal
        ? `Commande distante « ${commandId} » interrompue par le signal ${signal}.`
        : `Commande distante « ${commandId} » terminée sans code de sortie (connexion perdue ?).`,
      { step, details: { commandId, commandClass, signal, stderrTail: resultat.stderrTail } }
    );
  }

  const erreur = new RemoteCommandError(
    'REMOTE_COMMAND_FAILED',
    `Commande distante « ${commandId} » échouée (code ${exitCode}).`,
    {
      step,
      details: {
        commandId,
        commandClass,
        exitCode,
        durationMs: resultat.durationMs,
        stdoutTail: resultat.stdoutTail,
        stderrTail: resultat.stderrTail,
      },
    }
  );

  /**
   * BEST_EFFORT, CLEANUP et ROLLBACK ne lèvent pas : elles RENDENT leur échec.
   *
   * Un ménage raté ne défait pas un travail réussi, et un rollback qui échoue
   * ne doit pas remplacer l'erreur primaire — c'est elle qu'il faut lire en
   * premier. L'appelant reçoit `ok: false` et `error`, et décide.
   */
  if (commandClass !== COMMAND_CLASS.CRITICAL) {
    return { ...resultat, error: { code: erreur.code, message: erreur.message } };
  }
  throw erreur;
}

/**
 * UNE COMMANDE COMPOSÉE QUI S'ARRÊTE À LA PREMIÈRE ERREUR.
 *
 * ══ POURQUOI CET ENROBAGE EST NÉCESSAIRE ════════════════════════════════════
 *
 * `cmd1 && cmd2` propage bien l'échec de `cmd1`. Mais `cmd1; cmd2` rend le code
 * du DERNIER, et `a | b` celui de `b` : un `tar` qui échoue en amont d'un pipe
 * disparaît derrière un `head` parfaitement satisfait. Le pipeline en contient.
 *
 * `set -euo pipefail` rétablit la seule sémantique défendable : la première
 * commande qui échoue arrête l'ensemble, une variable non définie est une
 * erreur, et le code d'un pipe est celui du premier maillon rompu.
 */
export function strictShell(script) {
  return `set -euo pipefail; ${script}`;
}

export default runRemoteCommand;

/**
 * UNE SONDE — raccourci pour le cas le plus fréquent du moteur.
 *
 * ══ POURQUOI LES SONDES MÉRITENT LEUR PROPRE PORTE ══════════════════════════
 *
 * La majorité des commandes du moteur POSENT UNE QUESTION : ce binaire
 * existe-t-il, ce port est-il pris, ce certificat est-il là, que répond ce
 * service ? Leur code de sortie est une RÉPONSE, pas un incident — `test -f`
 * qui rend 1 dit « non », et transformer ce « non » en erreur technique
 * rendrait le moteur inutilisable.
 *
 * Elles restent pourtant soumises au contrat, et cela change deux choses :
 * elles portent un identifiant stable dans les rapports, et elles sont
 * BORNÉES. Une commande n'a pas besoin d'être critique pour bloquer un
 * déploiement pendant vingt minutes.
 *
 * ── CE QUE LA SONDE NE PROTÈGE PAS, ET C'EST VOULU ─────────────────────────
 *
 * Elle ne distingue pas, à elle seule, « le port est occupé » de « je n'ai pas
 * pu interroger les ports » : elle rend `ok`, `exitCode`, `connectionLost` et
 * `timedOut`, et c'est l'appelant qui doit lire la différence. Le contrat lui
 * en donne les moyens ; il ne peut pas décider à sa place ce que la réponse
 * signifie.
 */
export function sonde(transport, commandId, command, { timeoutMs = TIMEOUTS.QUICK, step = null } = {}) {
  return runRemoteCommand(transport, {
    commandId,
    command,
    commandClass: COMMAND_CLASS.PROBE,
    timeoutMs,
    step,
  });
}
