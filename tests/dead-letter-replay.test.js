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
    /cursorSeq/.test(code) && /newSeq: \{ \$lte: cursorSeq \}/.test(code));
  check('…et n’écrit rien chez le projet', !/updateOne|deleteOne|deleteMany/.test(code));
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

finish();
