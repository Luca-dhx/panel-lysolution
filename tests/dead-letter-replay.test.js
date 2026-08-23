// REJOUER UNE ÉCRITURE GARÉE — la republication contrôlée, de bout en bout.
//
// ══ CE QUE CE LOT A OUVERT, ET QUE CETTE RECETTE FERME ═══════════════════════
//
// Le lot précédent a rendu le curseur honnête : il ne dépasse plus une écriture
// non appliquée, et après N tentatives l'écriture est GARÉE — le flux repart,
// et le renoncement est déclaré au Panel.
//
// Mais une écriture garée y restait POUR TOUJOURS. Le commentaire le disait :
// « seule une nouvelle publication la ramènera ». Autrement dit, réparer le
// code ne suffisait pas — il fallait qu'un fait métier soit republié par
// hasard. Un opérateur n'avait aucun geste.
//
// ══ CE QUE LE REJEU N'EST PAS ═══════════════════════════════════════════════
//
//   · pas un retour en arrière du curseur — cela relivrerait tout ce qui suit ;
//   · pas un chemin qui contourne les applicateurs — il ne prouverait rien ;
//   · pas une suppression de la lettre morte — elle n'est résolue qu'APRÈS
//     application réelle.
//
// ══ CE QU'ON MONTE ══════════════════════════════════════════════════════════
//
// Un vrai Panel, sa vraie base, son vrai journal. Le PROJET est un double HTTP
// minimal : ce qu'on éprouve ici est la REPUBLICATION et sa causalité, pas le
// tirage — qui a sa propre recette, côté SB Auto, sur sa propre base.
import http from 'node:http';

import {
  check, connectTestDatabase, finish, section, setTestEnv, startMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { emitChange } = await import('../backend/src/services/sync/syncCore.service.js');
const replay = await import('../backend/src/services/sync/deadLetterReplay.service.js');
const { default: PanelDeadLetterReplay, REPLAY_STATUS } = await import(
  '../backend/src/models/PanelDeadLetterReplay.model.js'
);
const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { configureDeliveryTransport } = await import(
  '../backend/src/services/sync/syncDelivery.service.js'
);

/** La livraison immédiate n'a rien à faire ici : le sujet est le JOURNAL. */
configureDeliveryTransport(() => ({
  deliverChanges: async () => ({ results: [] }),
}));

const PROJET = 'projet-rejeu';
const AUTRE = 'projet-voisin';
const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

await registryStore.insert({
  projectId: PROJET,
  projectKey: 'projet-rejeu',
  projectName: 'Projet de rejeu',
  pairing: { status: 'PAIRED' },
  runtime: { environment: 'TEST' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
await registryStore.insert({
  projectId: AUTRE,
  projectKey: 'projet-voisin',
  projectName: 'Projet voisin',
  pairing: { status: 'PAIRED' },
  runtime: { environment: 'TEST' },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const refuse = async (fn, code) => {
  try { await fn(); return null; } catch (err) { return err?.code === code ? err : err; }
};

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. LE FAIT CANONIQUE EST RELU AU JOURNAL — l’autorité, pas une copie');
let garee;
{
  garee = await emitChange({
    entityType: 'DIAGNOSTIC',
    entityId: uuid(1),
    payload: { recette: 'REJEU', valeur: 'originale' },
    audience: PROJET,
  });
  check('l’écriture d’origine est au journal', Number.isFinite(garee.seq));
  check('…et porte sa charge utile', garee.change.payload?.valeur === 'originale');

  /**
   * LA LETTRE MORTE DU PROJET NE GARDE NI CHARGE UTILE NI SÉQUENCE — c'est un
   * choix de confidentialité assumé. Le rejeu ne peut donc pas partir d'elle :
   * il relit le fait chez celui qui l'a émis.
   */
  const r = await replay.replayDeadLetter({
    projectId: PROJET, writeId: garee.change.writeId, actor: ACTEUR,
  });

  check('la republication porte une NOUVELLE séquence', r.newSeq > garee.seq,
    `${r.newSeq} vs ${garee.seq}`);
  check('…et une NOUVELLE identité technique', r.newWriteId !== garee.change.writeId);
  check('…mais la causalité est conservée', r.replayOfWriteId === garee.change.writeId);
  check('…avec la séquence d’origine', r.replayOfSeq === garee.seq);
  check('…et le compte de tentatives', r.attempt === 1);
  const trace = await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean();
  check('…et qui l’a demandé', trace.requestedBy === 'dev@panel.test', trace.requestedBy);

  const nouvelle = await PanelSyncJournalEntry.findOne({ seq: r.newSeq }).lean();
  check('LE FAIT MÉTIER EST IDENTIQUE — même type, même entité, même charge utile',
    nouvelle.change.entityType === 'DIAGNOSTIC'
    && nouvelle.change.entityId === uuid(1)
    && nouvelle.change.payload?.valeur === 'originale');
  check('…et la MÊME date de modification',
    nouvelle.change.modifiedAt === garee.change.modifiedAt);
  check('…adressée à CE projet, pas au parc', nouvelle.audience === PROJET);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. LE CURSEUR N’EST JAMAIS REMIS EN ARRIÈRE');
{
  /**
   * C'est l'invariant qui distingue un rejeu d'un rattrapage brutal. Reculer le
   * curseur relivrerait TOUT ce qui suit l'écriture garée — des centaines
   * d'applications déjà faites, pour en réparer une.
   *
   * On le prouve par la structure : le service ne touche à aucun curseur, et
   * seul le PROJET en écrit un.
   */
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('backend/src/services/sync/deadLetterReplay.service.js', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /**
   * `settleAcknowledgedReplays` LIT un curseur — celui que le projet déclare —
   * pour savoir si un rejeu a été consommé. Lire n'est pas écrire : ce qu'on
   * vérifie ici est qu'aucun curseur n'est ÉCRIT, jamais reculé.
   */
  check('le service n’ÉCRIT aucun curseur',
    !/recordCursor|pullCursor\s*[:=]|cursor\s*=/.test(code));
  check('…il ne fait que le LIRE pour acquitter',
    /cursorSeq/.test(code) && /newSeq: \{ \$lte: cursorSeq/.test(code));
  /**
   *  et  portent ici sur la TRACE DE REJEU du Panel —
   * la réservation, complétée après l'émission ou retirée si elle échoue. Ce
   * qu'on vérifie est qu'aucune écriture ne vise l'état du PROJET : ni son
   * curseur, ni ses lettres mortes, ni ses compteurs.
   */
  check('…et n’écrit rien de l’état du PROJET',
    !/consumptionStore|deadLetters\s*[:=]|applyFailures/.test(code));
  check('…ses seules écritures visent sa propre trace de rejeu',
    [...code.matchAll(/(?:await\s+)?([A-Za-z]+)\.(?:updateOne|deleteOne|create)\(/g)]
      .every((m) => m[1] === 'PanelDeadLetterReplay'));
  check('il ne fait qu’émettre au journal', /emitChange\(/.test(code));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. DOUBLE CLIC — une seule republication LOGIQUE');
{
  const seconde = await emitChange({
    entityType: 'DIAGNOSTIC', entityId: uuid(2), payload: { v: 1 }, audience: PROJET,
  });

  /** Deux demandes SIMULTANÉES : c'est l'index qui arbitre, pas une lecture. */
  const [a, b] = await Promise.allSettled([
    replay.replayDeadLetter({ projectId: PROJET, writeId: seconde.change.writeId, actor: ACTEUR }),
    replay.replayDeadLetter({ projectId: PROJET, writeId: seconde.change.writeId, actor: ACTEUR }),
  ]);

  const acceptes = [a, b].filter((r) => r.status === 'fulfilled');
  check('une seule demande aboutit', acceptes.length === 1,
    `${acceptes.length} : ${[a, b].map((r) => r.status).join(', ')}`);
  const refusee = [a, b].find((r) => r.status === 'rejected');
  check('…et l’autre est refusée EN NOMMANT la raison',
    refusee?.reason?.code === replay.REPLAY_REFUSAL.ALREADY_IN_FLIGHT,
    refusee?.reason?.code);

  const traces = await PanelDeadLetterReplay.countDocuments({
    projectId: PROJET, replayOfWriteId: seconde.change.writeId,
  });
  check('UNE seule trace de rejeu en base', traces === 1, `${traces}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. LES REFUS — chacun nommé, aucun silencieux');
{
  const inconnue = await refuse(
    () => replay.replayDeadLetter({ projectId: PROJET, writeId: uuid(999), actor: ACTEUR }),
  );
  check('une écriture inconnue du journal est refusée',
    inconnue?.code === replay.REPLAY_REFUSAL.WRITE_UNKNOWN, inconnue?.code);

  const projetInconnu = await refuse(
    () => replay.replayDeadLetter({ projectId: 'nexiste-pas', writeId: garee.change.writeId }),
  );
  check('un projet inconnu est refusé',
    projetInconnu?.code === replay.REPLAY_REFUSAL.PROJECT_UNKNOWN, projetInconnu?.code);

  /**
   * ── LA FUITE QU'ON REND IMPOSSIBLE ────────────────────────────────────────
   *
   * Une écriture NOMMÉE pour un autre projet ne doit jamais être republiée
   * vers celui-ci : ce serait exactement le chemin par lequel un opérateur
   * ferait atterrir la donnée d'un client chez un autre.
   */
  const duVoisin = await emitChange({
    entityType: 'DIAGNOSTIC', entityId: uuid(3), payload: { secret: 'du voisin' }, audience: AUTRE,
  });
  const fuite = await refuse(
    () => replay.replayDeadLetter({ projectId: PROJET, writeId: duVoisin.change.writeId }),
  );
  check('une écriture destinée à un AUTRE projet est refusée',
    fuite?.code === replay.REPLAY_REFUSAL.NOT_FOR_THIS_PROJECT, fuite?.code);

  /** Un projet désappairé n'a pas de destinataire : republier ferait un déchet. */
  const desappaire = await registryStore.getById(AUTRE);
  await registryStore.save({ ...desappaire, pairing: { status: 'REVOKED' } });
  const sansPont = await refuse(
    () => replay.replayDeadLetter({ projectId: AUTRE, writeId: duVoisin.change.writeId }),
  );
  check('un projet désappairé est refusé',
    sansPont?.code === replay.REPLAY_REFUSAL.PROJECT_NOT_PAIRED, sansPont?.code);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. ACQUITTEMENT — le curseur du projet, et rien d’autre');
{
  const enVol = await PanelDeadLetterReplay
    .findOne({ projectId: PROJET, replayOfWriteId: garee.change.writeId }).lean();
  check('le rejeu est REPUBLISHED tant que le projet n’a pas consommé',
    enVol.status === REPLAY_STATUS.REPUBLISHED);

  /** Le curseur n'a pas encore atteint la nouvelle séquence. */
  const tropTot = await replay.settleAcknowledgedReplays({
    projectId: PROJET, cursorSeq: enVol.newSeq - 1,
  });
  check('un curseur EN DEÇÀ n’acquitte rien', tropTot.acknowledged === 0);

  const acquitte = await replay.settleAcknowledgedReplays({
    projectId: PROJET, cursorSeq: enVol.newSeq,
  });
  check('un curseur qui DÉPASSE acquitte le rejeu', acquitte.acknowledged >= 1);

  const apres = await PanelDeadLetterReplay.findOne({ replayId: enVol.replayId }).lean();
  check('…le rejeu est ACKNOWLEDGED', apres.status === REPLAY_STATUS.ACKNOWLEDGED);
  check('…et daté', typeof apres.acknowledgedAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. REJOUER À NOUVEAU — permis une fois le précédent acquitté');
{
  /**
   * Un rejeu peut échouer à son tour et se garer de nouveau. Interdire un
   * second rejeu condamnerait l'écriture pour de bon ; l'autoriser PENDANT
   * qu'un premier est en vol produirait deux republications pour un geste.
   * L'index ne contraint donc que les rejeux ENCORE en vol.
   */
  const second = await replay.replayDeadLetter({
    projectId: PROJET, writeId: garee.change.writeId, actor: ACTEUR,
  });
  check('un second rejeu est accepté après acquittement du premier',
    second.replayOfWriteId === garee.change.writeId);
  check('…et le compte de tentatives monte', second.attempt === 2, `${second.attempt}`);

  const historique = await replay.listReplays({ projectId: PROJET });
  check('L’HISTORIQUE N’EST JAMAIS EFFACÉ — les deux rejeux sont visibles',
    historique.filter((r) => r.replayOfWriteId === garee.change.writeId).length === 2);
  check('…et aucun ne porte de charge utile',
    !JSON.stringify(historique).includes('originale'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. LA PROJECTION D’ÉCRAN NE PORTE RIEN DE SENSIBLE');
{
  const lignes = await replay.listReplays({ projectId: PROJET });
  const champs = new Set(Object.keys(lignes[0] ?? {}));
  check('elle nomme l’écriture, l’entité, l’état et la causalité',
    champs.has('replayOfWriteId') && champs.has('newWriteId') && champs.has('status')
    && champs.has('entityType') && champs.has('attempt'));
  check('…et JAMAIS la charge utile',
    !champs.has('payload') && !champs.has('change'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. LA CONVERGENCE EST AUTONOME — aucune lecture d’écran requise');
{
  /**
   * ══ CE QUE CETTE SECTION VERROUILLE ══════════════════════════════════════
   *
   * `settleAcknowledgedReplays` était appelée à la LECTURE de la fiche projet.
   * Un rejeu ne passait donc `ACKNOWLEDGED` que si quelqu'un ouvrait un écran —
   * et tant que personne ne le faisait, l'index d'unicité interdisait tout
   * nouveau rejeu de la même écriture.
   *
   * Une lecture qui MUTE est un piège de deux façons : l'état dépend de
   * l'attention d'un humain, et la consultation cesse d'être gratuite.
   */
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('backend/src/controllers/projects.controller.js', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('LA ROUTE DE LECTURE N’APPELLE PLUS LA CONVERGENCE',
    !/settleAcknowledgedReplays/.test(code));

  const battement = await import('node:fs/promises')
    .then((fs) => fs.readFile('backend/src/services/registry/projectRegistry.service.js', 'utf8'));
  check('…c’est le BATTEMENT qui la déclenche',
    /settleAcknowledgedReplays|settleReplaysFromHeartbeat/.test(battement));
  const apresSave = battement.indexOf('settleReplaysFromHeartbeat(record)')
    > battement.indexOf('await registryStore.save(record);');
  check('…APRÈS la persistance du curseur — un acquittement sur une valeur non persistée serait effacé par un redémarrage',
    apresSave);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. IDEMPOTENCE — dix battements, une seule transition');
{
  const w = await emitChange({
    entityType: 'DIAGNOSTIC', entityId: uuid(10), payload: { v: 1 }, audience: PROJET,
  });
  const r = await replay.replayDeadLetter({ projectId: PROJET, writeId: w.change.writeId, actor: ACTEUR });

  const premier = await replay.settleAcknowledgedReplays({ projectId: PROJET, cursorSeq: r.newSeq });
  check('le premier passage acquitte', premier.acknowledged >= 1, `${premier.acknowledged}`);
  const trace = await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean();
  const dateInitiale = trace.acknowledgedAt;
  check('…et date l’acquittement', typeof dateInitiale === 'string');

  /** NEUF passages de plus, avec un curseur toujours au-delà. */
  let mutations = 0;
  for (let i = 0; i < 9; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const encore = await replay.settleAcknowledgedReplays({
      projectId: PROJET, cursorSeq: r.newSeq + 100,
    });
    mutations += encore.acknowledged;
  }
  check('NEUF battements de plus ne changent RIEN', mutations === 0, `${mutations}`);

  const apres = await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean();
  check('…la date d’acquittement est INCHANGÉE', apres.acknowledgedAt === dateInitiale);
  check('…et le statut aussi', apres.status === REPLAY_STATUS.ACKNOWLEDGED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. ENLISEMENT — nommé, jamais rejoué tout seul');
{
  const w = await emitChange({
    entityType: 'DIAGNOSTIC', entityId: uuid(11), payload: { v: 1 }, audience: PROJET,
  });
  const r = await replay.replayDeadLetter({ projectId: PROJET, writeId: w.change.writeId, actor: ACTEUR });

  check(`le seuil est configurable (${Math.round(replay.REPLAY_STALL_AFTER_MS / 60_000)} min)`,
    replay.REPLAY_STALL_AFTER_MS === 20 * 60_000, `${replay.REPLAY_STALL_AFTER_MS}`);

  /** Le projet ne consomme pas : curseur en deçà, et le rejeu est encore jeune. */
  const jeune = await replay.settleAcknowledgedReplays({ projectId: PROJET, cursorSeq: r.newSeq - 1 });
  check('un rejeu récent n’est PAS déclaré enlisé', jeune.stalled === 0);
  check('…et reste REPUBLISHED',
    (await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean()).status
      === REPLAY_STATUS.REPUBLISHED);

  /** On avance l'horloge du seuil : le temps est injecté, jamais attendu. */
  const plusTard = Date.now() + replay.REPLAY_STALL_AFTER_MS + 1000;
  const vieux = await replay.settleAcknowledgedReplays({
    projectId: PROJET, cursorSeq: r.newSeq - 1, now: plusTard,
  });
  check('passé le seuil, il est déclaré ENLISÉ', vieux.stalled === 1, `${vieux.stalled}`);

  const enlise = await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean();
  check('…son état le DIT', enlise.status === REPLAY_STATUS.STALLED);
  check('…et l’instant du constat est daté', typeof enlise.stalledAt === 'string');
  check('…il n’a PAS été acquitté au passage', enlise.acknowledgedAt === null);

  /**
   * ── AUCUN REJEU AUTOMATIQUE ─────────────────────────────────────────────
   *
   * Une lettre morte est DÉJÀ un renoncement après plusieurs échecs. La
   * rejouer parce qu'un rejeu a échoué produirait la boucle même que la lettre
   * morte existe pour arrêter.
   */
  const avant = await PanelDeadLetterReplay.countDocuments({ projectId: PROJET });
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await replay.settleAcknowledgedReplays({ projectId: PROJET, cursorSeq: 0, now: plusTard });
  }
  check('CINQ passages de plus ne créent AUCUN rejeu',
    (await PanelDeadLetterReplay.countDocuments({ projectId: PROJET })) === avant);
  check('…et l’enlisement n’est pas redaté à chaque fois',
    (await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean()).stalledAt
      === enlise.stalledAt);

  globalThis.__enlise = { replayId: r.replayId, writeId: w.change.writeId };
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('11. REJOUER APRÈS UN ENLISEMENT — le geste redevient possible');
{
  const { writeId } = globalThis.__enlise;

  /**
   * C'était la doctrine à corriger : une trace `REPUBLISHED` bloquait à VIE
   * tout nouveau rejeu de la même écriture. L'index d'unicité ne contraint que
   * les rejeux EN VOL — passer en `STALLED` rouvre donc le geste, sans rien
   * relâcher tant que le rejeu est encore dans sa fenêtre normale.
   */
  const second = await replay.replayDeadLetter({ projectId: PROJET, writeId, actor: ACTEUR });
  check('un rejeu ENLISÉ peut être relancé', second.replayOfWriteId === writeId);
  check('…et le compte de tentatives monte', second.attempt === 2, `${second.attempt}`);

  const historique = await replay.listReplays({ projectId: PROJET });
  const pour = historique.filter((x) => x.replayOfWriteId === writeId);
  check('L’HISTORIQUE GARDE LES DEUX — la première n’est pas remplacée',
    pour.length === 2, `${pour.length}`);
  check('…la première reste ENLISÉE',
    pour.some((x) => x.status === REPLAY_STATUS.STALLED && x.attempt === 1));
  check('…la seconde est en vol',
    pour.some((x) => x.status === REPLAY_STATUS.REPUBLISHED && x.attempt === 2));

  /** Tant que la seconde est en vol, une troisième est refusée. */
  const troisieme = await refuse(
    () => replay.replayDeadLetter({ projectId: PROJET, writeId, actor: ACTEUR }),
  );
  check('…mais une TROISIÈME est refusée tant que la seconde est en vol',
    troisieme?.code === replay.REPLAY_REFUSAL.ALREADY_IN_FLIGHT, troisieme?.code);

  /** Et la causalité tient : la seconde acquittée, l'historique reste complet. */
  await replay.settleAcknowledgedReplays({ projectId: PROJET, cursorSeq: second.newSeq });
  const apres = (await replay.listReplays({ projectId: PROJET }))
    .filter((x) => x.replayOfWriteId === writeId);
  check('la seconde est ACQUITTÉE', apres.some((x) => x.status === REPLAY_STATUS.ACKNOWLEDGED));
  check('…et la première est TOUJOURS visible, enlisée',
    apres.some((x) => x.status === REPLAY_STATUS.STALLED));
  check('…soit deux traces pour une seule écriture garée', apres.length === 2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('12. UN PROJET ÉTEINT — le silence doit quand même être constaté');
{
  /**
   * ══ CE QUE LA PREUVE SUR L'INFRASTRUCTURE RÉELLE A MONTRÉ ═══════════════
   *
   * L'enlisement se constatait au battement, comme l'acquittement. Mais le
   * battement est celui DU PROJET CONCERNÉ — et le cas qui compte est celui
   * d'un projet qui s'est TU. Un projet éteint ne bat plus, ne déclenchait
   * donc jamais le constat, et son rejeu restait `REPUBLISHED` pour toujours :
   * l'index d'unicité condamnait alors l'écriture à ne plus jamais être
   * rejouable. Le piège refermé d'un côté, rouvert par la porte d'à côté.
   *
   * Le balayage est donc GLOBAL et autonome. Il ne double aucune cadence :
   * aucun message n'annonce un silence.
   */
  const w = await emitChange({
    entityType: 'DIAGNOSTIC', entityId: uuid(12), payload: { v: 1 }, audience: PROJET,
  });
  const r = await replay.replayDeadLetter({ projectId: PROJET, writeId: w.change.writeId, actor: ACTEUR });

  /** Le projet ne bat plus : personne n'appelle `settleAcknowledgedReplays`. */
  const plusTard = Date.now() + replay.REPLAY_STALL_AFTER_MS + 1000;

  const balayage = await replay.sweepStalledReplays({ now: plusTard });
  check('LE BALAYAGE GLOBAL constate l’enlisement SANS battement du projet',
    balayage.stalled >= 1, `${balayage.stalled}`);
  const apres = await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean();
  check('…le rejeu du projet muet est ENLISÉ', apres.status === REPLAY_STATUS.STALLED);
  check('…et daté', typeof apres.stalledAt === 'string');

  /** Idempotent lui aussi : le filtre porte sur l'état de départ. */
  const encore = await replay.sweepStalledReplays({ now: plusTard + 60_000 });
  check('un second balayage ne change plus rien', encore.stalled === 0, `${encore.stalled}`);
  check('…et ne redate pas le constat',
    (await PanelDeadLetterReplay.findOne({ replayId: r.replayId }).lean()).stalledAt
      === apres.stalledAt);

  /** Un rejeu JEUNE n'est jamais emporté par le balayage. */
  const w2 = await emitChange({
    entityType: 'DIAGNOSTIC', entityId: uuid(13), payload: { v: 1 }, audience: PROJET,
  });
  const jeune = await replay.replayDeadLetter({ projectId: PROJET, writeId: w2.change.writeId, actor: ACTEUR });
  const rien = await replay.sweepStalledReplays();
  check('le balayage ne touche PAS un rejeu récent', rien.stalled === 0, `${rien.stalled}`);
  check('…qui reste en vol',
    (await PanelDeadLetterReplay.findOne({ replayId: jeune.replayId }).lean()).status
      === REPLAY_STATUS.REPUBLISHED);

  /** Et il ne rejoue toujours RIEN : il nomme. */
  const avant = await PanelDeadLetterReplay.countDocuments({});
  await replay.sweepStalledReplays({ now: plusTard });
  check('LE VEILLEUR NE REPUBLIE JAMAIS RIEN',
    (await PanelDeadLetterReplay.countDocuments({})) === avant);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('13. LE VEILLEUR EST LANCÉ AU DÉMARRAGE, ET ARRÊTÉ PROPREMENT');
{
  const serveur = await import('node:fs/promises')
    .then((fs) => fs.readFile('backend/src/server.js', 'utf8'));
  check('le balayage des enlisements démarre avec le serveur',
    /startReplayStallScheduler\(\)/.test(serveur));
  check('…et s’arrête avec lui', /stopReplayStallScheduler\(\)/.test(serveur));

  const { runReplayStallCycle, startReplayStallScheduler, stopReplayStallScheduler } =
    await import('../backend/src/services/sync/replayStallScheduler.js');

  const cycle = await runReplayStallCycle();
  check('un cycle rend un compte, jamais une exception',
    typeof cycle?.stalled === 'number' || cycle?.skipped === true);

  const t = startReplayStallScheduler({ intervalMs: 60_000 });
  check('le minuteur démarre', Boolean(t));
  check('…un second appel ne crée PAS un deuxième minuteur',
    startReplayStallScheduler({ intervalMs: 60_000 }) === t);
  check('…il s’arrête', stopReplayStallScheduler() === true);
  check('…et un second arrêt ne fait rien', stopReplayStallScheduler() === false);
}

finish();
