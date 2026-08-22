// LE FORÇAGE DE LA CONNEXION EST-IL RÉELLEMENT RALENTI ?
//
// ══ LA QUESTION À LAQUELLE CE FICHIER RÉPOND ════════════════════════════════
//
// Avant ce lot, `POST /api/auth/login` acceptait autant de tentatives que le
// réseau en portait. Rien ne les comptait. Une liste de mots de passe courants
// et quelques minutes suffisaient — et rien, nulle part, n'en aurait gardé la
// trace.
//
// On éprouve donc le comportement RÉEL, en HTTP, à travers l'application
// complète : c'est le seul niveau où un middleware oublié sur une route se
// voit. Éprouver la fonction seule prouverait qu'elle compte bien, jamais
// qu'elle est branchée.
//
// ══ CE QUI EST VÉRIFIÉ, ET POURQUOI CHACUN COMPTE ═══════════════════════════
//
//   · le seau d'IDENTITÉ se ferme le premier (8 < 20) ;
//   · il rend 429, PAS 401 — un 401 dirait « identifiants invalides » à
//     quelqu'un qui a peut-être tapé les bons ;
//   · la réponse porte `Retry-After` ET une durée dans le corps ;
//   · elle n'apprend rien sur le compte — ni existence, ni essais restants ;
//   · une AUTRE identité passe encore : aucun verrouillage de compte, et
//     aucune contamination d'un compte par un autre ;
//   · une connexion RÉUSSIE efface le seau d'identité ;
//   · le seau d'IP ferme même quand chaque identité reste sous SON plafond —
//     c'est le balayage de comptes, que le seul seau d'identité laisse passer ;
//   · les compteurs SURVIVENT à un redémarrage. C'est le défaut central du
//     limiteur en mémoire qu'il remplace : un attaquant qui obtient un
//     redémarrage remettait le compteur à zéro.
import {
  check, connectTestDatabase, finish, section, setTestEnv, simulateRestart,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();

await startMemoryMongo();
await connectTestDatabase();

const config = (await import('../backend/src/config/env.js')).default;
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const { createApp } = await import('../backend/src/app.js');
const { AUTH_RATE_LIMITS, AUTH_RATE_LIMITED } = await import(
  '../backend/src/middlewares/authRateLimit.middleware.js'
);
const PanelAuthAttempt = (await import('../backend/src/models/PanelAuthAttempt.model.js')).default;

await users.resetUsers();
await users.ensureDevAccount();

/** Repart d'une page blanche : chaque section éprouve UN comportement. */
const viderLesSeaux = () => PanelAuthAttempt.deleteMany({});

/* ══════════════════════════════════════════════════════════════════════════ */
section('Les plafonds sont déclarés, et les deux dimensions existent');
{
  check('une fenêtre est définie', Number.isFinite(AUTH_RATE_LIMITS.windowMs) && AUTH_RATE_LIMITS.windowMs > 0);
  check('…un plafond par IP', Number.isInteger(AUTH_RATE_LIMITS.perIp) && AUTH_RATE_LIMITS.perIp > 0);
  check('…un plafond par IDENTITÉ', Number.isInteger(AUTH_RATE_LIMITS.perIdentity) && AUTH_RATE_LIMITS.perIdentity > 0);
  /**
   * L'ORDRE DES DEUX PLAFONDS N'EST PAS UN DÉTAIL.
   *
   * Si le plafond d'identité était le plus haut, il ne servirait jamais : l'IP
   * fermerait avant, et un attaquant distribué — une identité par adresse —
   * n'aurait rencontré aucune limite d'identité. Le seau le plus contraignant
   * doit être celui qui vise le compte.
   */
  check('…et l’identité est plus contrainte que l’adresse',
    AUTH_RATE_LIMITS.perIdentity < AUTH_RATE_LIMITS.perIp);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Une identité martelée est ralentie — sans être verrouillée');
{
  await viderLesSeaux();
  const { call, close } = await startServer(createApp());
  const cible = config.seedDevEmail;

  let dernier = null;
  let premier429 = null;
  for (let i = 0; i < AUTH_RATE_LIMITS.perIdentity + 2; i += 1) {
    dernier = await call('POST', '/api/auth/login', { body: { email: cible, password: 'mauvais' } });
    if (dernier.status === 429 && premier429 === null) premier429 = i + 1;
  }

  check('le martèlement finit par être refusé', dernier.status === 429);
  check('…au plafond d’IDENTITÉ, pas à celui d’IP',
    premier429 === AUTH_RATE_LIMITS.perIdentity + 1);
  check('…par 429, jamais par 401', dernier.status === 429);
  check('…avec un code métier stable', dernier.json?.code === AUTH_RATE_LIMITED);

  const retryHeader = Number(dernier.headers.get('retry-after'));
  check('…un en-tête Retry-After exploitable', Number.isFinite(retryHeader) && retryHeader > 0);
  check('…et la même durée dans le corps, pour l’écran',
    Number(dernier.json?.details?.retryAfterSeconds) === retryHeader);
  check('…qui ne dépasse jamais la fenêtre annoncée',
    retryHeader <= Math.ceil(AUTH_RATE_LIMITS.windowMs / 1000));

  /**
   * LE MESSAGE NE DOIT RIEN APPRENDRE. Ni que le compte existe, ni combien
   * d'essais restent, ni si le mot de passe était proche. Un attaquant qui
   * apprend « il vous reste 3 essais » apprend surtout que le compte existe.
   */
  const texte = JSON.stringify(dernier.json);
  check('…sans révéler l’existence du compte', !texte.includes(cible));
  check('…sans annoncer d’essais restants', !/restant|remaining|essais? restant/i.test(texte));
  check('…sans jamais parler de blocage définitif', !/verrouill|bloqué définitivement|suspendu/i.test(texte));

  /**
   * AUCUN VERROUILLAGE DE COMPTE. Le seau vise un couple (identité, fenêtre),
   * pas le compte lui-même : une autre identité, depuis la même adresse, doit
   * encore passer tant que le seau d'IP n'est pas plein.
   */
  const autre = await call('POST', '/api/auth/login', {
    body: { email: 'quelqun-dautre@exemple.test', password: 'mauvais' },
  });
  check('une AUTRE identité n’est pas contaminée', autre.status === 401);

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Une connexion réussie efface le seau de cette identité');
{
  await viderLesSeaux();
  const { call, close } = await startServer(createApp());
  const cible = config.seedDevEmail;

  for (let i = 0; i < AUTH_RATE_LIMITS.perIdentity - 1; i += 1) {
    await call('POST', '/api/auth/login', { body: { email: cible, password: 'mauvais' } });
  }

  const reussite = await call('POST', '/api/auth/login', {
    body: { email: cible, password: config.seedDevPassword },
  });
  check('la bonne combinaison passe encore juste avant le plafond', reussite.status === 200);

  /**
   * Quelqu'un qui retrouve son mot de passe au septième essai ne doit pas
   * rester à une tentative du blocage pour le quart d'heure suivant.
   */
  const apres = await call('POST', '/api/auth/login', { body: { email: cible, password: 'mauvais' } });
  check('…et le compteur de cette identité est reparti de zéro', apres.status === 401);

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le seau d’IP ferme le balayage de comptes');
{
  await viderLesSeaux();
  const { call, close } = await startServer(createApp());

  /**
   * CHAQUE identité reste très en dessous de SON plafond — une seule tentative
   * chacune. Seul le seau d'adresse peut voir ce motif, et c'est précisément le
   * cas qu'un limiteur par identité seule laisse passer intégralement.
   */
  let dernier = null;
  for (let i = 0; i < AUTH_RATE_LIMITS.perIp + 1; i += 1) {
    dernier = await call('POST', '/api/auth/login', {
      body: { email: `balayage-${i}@exemple.test`, password: 'mauvais' },
    });
  }
  check('un balayage d’identités depuis une seule adresse est arrêté', dernier.status === 429);
  check('…par le même code métier', dernier.json?.code === AUTH_RATE_LIMITED);

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Les compteurs survivent à un redémarrage');
{
  await viderLesSeaux();
  {
    const { call, close } = await startServer(createApp());
    for (let i = 0; i < AUTH_RATE_LIMITS.perIdentity + 1; i += 1) {
      await call('POST', '/api/auth/login', {
        body: { email: 'persistant@exemple.test', password: 'mauvais' },
      });
    }
    await close();
  }

  /**
   * ══ LE DÉFAUT CENTRAL DU LIMITEUR EN MÉMOIRE ═════════════════════════════
   *
   * Un compteur porté par une `Map` meurt avec le processus. Il suffisait donc
   * d'un redémarrage — un déploiement, un plantage, ou un plantage PROVOQUÉ —
   * pour remettre le compteur à zéro. Ici il vit en base : il ne remarque même
   * pas que le processus a changé.
   */
  await simulateRestart();
  const { call, close } = await startServer(createApp());
  const apres = await call('POST', '/api/auth/login', {
    body: { email: 'persistant@exemple.test', password: 'mauvais' },
  });
  check('le seau est toujours fermé après un redémarrage', apres.status === 429);
  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Ce compteur ne constitue pas un fichier de comptes');
{
  const documents = await PanelAuthAttempt.find({}).lean();
  check('des compteurs existent bien', documents.length > 0);

  const brut = JSON.stringify(documents);
  /**
   * L'IDENTITÉ EST HACHÉE. Ce compteur doit dire « cette identité a trop
   * essayé » sans constituer, au passage, la liste des adresses que l'on tente
   * de forcer — c'est-à-dire exactement la liste qu'un attaquant voudrait.
   */
  check('…mais aucune adresse e-mail en clair', !brut.includes('persistant@exemple.test'));
  check('…aucune adresse de compte réel', !brut.includes(config.seedDevEmail));
  check('…et aucun mot de passe', !brut.includes(config.seedDevPassword) && !brut.includes('mauvais'));

  check('…chaque compteur porte une date d’expiration',
    documents.every((d) => d.expiresAt instanceof Date));
  /**
   * La fenêtre est GLISSANTE et s'expire d'elle-même. Un verrou permanent
   * transformerait une nuisance en déni de service : il suffirait de connaître
   * l'adresse d'un administrateur pour lui fermer la porte.
   */
  check('…qui ne dépasse jamais la fenêtre déclarée',
    documents.every((d) => d.expiresAt.getTime() - Date.now() <= AUTH_RATE_LIMITS.windowMs + 1000));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('La réinitialisation garde sa propre porte');
{
  await viderLesSeaux();
  const { call, close } = await startServer(createApp());

  /**
   * ══ POURQUOI TROIS PORTÉES, ET NON UNE ═══════════════════════════════════
   *
   * Quelqu'un qui a épuisé ses tentatives de connexion a précisément besoin de
   * la réinitialisation. Les faire partager un seau aurait fermé la seule
   * sortie au moment exact où elle devient nécessaire.
   */
  for (let i = 0; i < AUTH_RATE_LIMITS.perIdentity + 1; i += 1) {
    await call('POST', '/api/auth/login', { body: { email: config.seedDevEmail, password: 'mauvais' } });
  }
  const bloque = await call('POST', '/api/auth/login', {
    body: { email: config.seedDevEmail, password: 'mauvais' },
  });
  check('la connexion est bien fermée', bloque.status === 429);

  const oubli = await call('POST', '/api/auth/forgot-password', { body: { email: config.seedDevEmail } });
  check('…la réinitialisation reste ouverte', oubli.status !== 429);

  await close();
}

await stopMemoryMongo();
finish();
