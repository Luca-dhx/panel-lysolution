// DÉPLOYER LE PANEL PAR SA PROPRE SURFACE — sans interface graphique.
//
//   node tools/deployPanel.js --environment TEST [--observe]
//
// ══ POURQUOI PASSER PAR L'API PLUTÔT QUE PAR LE SERVICE ════════════════════
//
// Le service de déploiement est appelable directement. Le faire sauterait tout
// ce que le contrôleur vérifie AVANT d'ouvrir une session SSH :
//
//   · la destination est-elle déployable, ou en cours de retrait ?
//   · une exécution est-elle déjà en cours sur cet hôte ?
//   · PROD exige-t-il sa confirmation explicite ?
//   · l'arbre de sources est-il COMMITÉ ?
//
// Ce dernier point est le plus important pour une campagne : il garantit que ce
// qui part sur le serveur correspond à un commit, et non à un état de travail
// qu'on ne saura pas reproduire. Contourner le contrôleur reviendrait à
// désactiver la seule chose qui rende un déploiement traçable.
//
// ══ CE QUE CE SCRIPT AJOUTE ════════════════════════════════════════════════
//
// Rien à la logique de déploiement. Il démarre le backend local, s'authentifie,
// appelle la route, suit l'exécution, et s'arrête. C'est un opérateur sans
// souris — pas un second moteur.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RACINE = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BACKEND = path.join(RACINE, 'backend');

const arg = (nom, defaut = null) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i === -1 ? defaut : process.argv[i + 1];
};
const ENVIRONNEMENT = String(arg('environment', 'TEST')).toUpperCase();
const OBSERVER = process.argv.includes('--observe');

const journal = (...a) => console.log(...a);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * LE MOT DE PASSE N'EST NI DEMANDÉ NI ÉCRIT — il transite, et c'est tout.
 *
 * Il vient de l'environnement du poste (le même `.env` que l'assistant en ligne
 * de commande lit déjà), il part dans le corps d'UNE requête locale, et il
 * n'apparaît dans aucune sortie. Le Panel, lui, n'en conserve rien : il le
 * redemande à chaque opération, par conception.
 */
const MOT_DE_PASSE = process.env.VPS_PASS ?? '';
const IDENTIFIANT = process.env.SEED_DEV_EMAIL ?? '';
const SECRET_COMPTE = process.env.SEED_DEV_PASSWORD ?? '';

if (!MOT_DE_PASSE || !IDENTIFIANT || !SECRET_COMPTE) {
  // On charge le `.env` du backend comme le fait le Panel lui-même, plutôt que
  // d'exiger de l'exploitant qu'il exporte trois variables à la main.
  /**
   * UN CHEMIN WINDOWS N'EST PAS UNE URL.
   *
   * `import('C:\...')` echoue avec `ERR_UNSUPPORTED_ESM_URL_SCHEME` : le
   * chargeur y lit un protocole `c:`. La conversion est explicite plutot que
   * de se souvenir, chaque fois, que ce cas existe.
   */
  const { config: charger } = await import(
    pathToFileURL(path.join(BACKEND, 'node_modules', 'dotenv', 'lib', 'main.js')).href
  );
  charger({ path: path.join(BACKEND, '.env') });
}

const identifiants = {
  email: process.env.SEED_DEV_EMAIL,
  motDePasse: process.env.SEED_DEV_PASSWORD,
  ssh: process.env.VPS_PASS,
};
if (!identifiants.email || !identifiants.motDePasse || !identifiants.ssh) {
  console.error('Identifiants introuvables : SEED_DEV_EMAIL, SEED_DEV_PASSWORD et VPS_PASS sont requis.');
  process.exit(1);
}

/**
 * UN PORT DEDIE AU PILOTE, DIFFERENT DE CELUI DU DEVELOPPEMENT.
 *
 * Le port du `.env` est celui du backend qu'un developpeur fait tourner. Le
 * reprendre ferait echouer le deploiement pour la pire raison possible -- « port
 * occupe » -- ou, si le port etait libre, ferait croire ensuite que l'instance
 * de developpement est morte. Le pilote prend le sien.
 */
const PORT = Number(arg('port', '') || 4177);
const BASE = `http://127.0.0.1:${PORT}`;

/* -------------------------------------------------------------------------- */

let backend = null;

async function attendreDisponible(limiteMs = 90_000) {
  const debut = Date.now();
  while (Date.now() - debut < limiteMs) {
    try {
      /**
       * `/readyz` dit « pret a servir », `/health` dit « vivant ». On veut le
       * premier : un port ouvert avant l'amorcage repondrait « vivant » alors
       * que les routes metier refusent encore en 503.
       */
      const r = await fetch(`${BASE}/readyz`);
      if (r.ok) return true;
    } catch { /* pas encore levé */ }
    await dormir(1500);
  }
  return false;
}

async function api(chemin, { method = 'GET', body = null, jeton = null } = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jeton ? { authorization: `Bearer ${jeton}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texte = await r.text();
  let corps;
  try { corps = JSON.parse(texte); } catch { corps = { raw: texte.slice(0, 400) }; }
  return { status: r.status, corps };
}

try {
  journal(`\n=== DÉPLOIEMENT DU PANEL — destination ${ENVIRONNEMENT} ===\n`);

  /**
   * LE BACKEND LOCAL EST LE PILOTE, PAS LA CIBLE.
   *
   * Le moteur construit l'artefact depuis les SOURCES de cette machine : c'est
   * donc forcément d'ici que l'opération part. Le Panel déployé, lui, ne
   * détient que son `dist` — il ne pourrait pas se reconstruire.
   */
  journal('démarrage du backend local…');
  backend = spawn(process.execPath, [path.join(BACKEND, 'src', 'server.js')], {
    cwd: BACKEND,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => {
    const ligne = String(d).trim();
    if (/erreur|error|échec/i.test(ligne)) journal(`  [backend] ${ligne.slice(0, 200)}`);
  });
  backend.stderr.on('data', (d) => journal(`  [backend:err] ${String(d).trim().slice(0, 200)}`));

  if (!await attendreDisponible()) throw new Error('Le backend local n’est pas devenu disponible.');
  journal('backend local prêt.');

  const connexion = await api('/api/auth/login', {
    method: 'POST',
    body: { email: identifiants.email, password: identifiants.motDePasse },
  });
  const jeton = connexion.corps?.data?.token ?? connexion.corps?.token ?? null;
  if (!jeton) throw new Error(`Authentification refusée (${connexion.status}) : ${JSON.stringify(connexion.corps).slice(0, 300)}`);
  journal('authentifié.');

  const liste = await api('/api/deployment', { jeton });
  const cibles = liste.corps?.data?.targets ?? liste.corps?.data?.items ?? [];
  const cible = cibles.find((t) => String(t.environment).toUpperCase() === ENVIRONNEMENT);
  if (!cible) throw new Error(`Aucune destination ${ENVIRONNEMENT} (${cibles.length} destination(s) connue(s)).`);
  journal(`destination : « ${cible.name} » → ${cible.url ?? cible.host}`);

  /**
   * LE PRÉFLIGHT D'ABORD, TOUJOURS.
   *
   * Il dit ce qui manque AVANT que quoi que ce soit ne bouge : sources non
   * commitées, outils absents, hôte injoignable. Un déploiement qui échoue au
   * préflight n'a rien commencé — c'est le seul échec gratuit du parcours.
   */
  const pre = await api(`/api/deployment/targets/${cible.targetId}/preflight`, {
    method: 'POST', jeton, body: { sshPassword: identifiants.ssh },
  });
  journal(`\npréflight (${pre.status}) :`);
  /**
   * ON ATTEND QUE LE PREFLIGHT SOIT FINI AVANT DE DEPLOYER.
   *
   * Le preflight est une EXECUTION, pas une reponse synchrone -- et le Panel
   * n'autorise qu'une execution a la fois par destination, precisement pour que
   * deux operations ne se marchent pas dessus sur les memes chemins et le meme
   * service. Enchainer sans attendre produit un `409 ALREADY_RUNNING` qui a
   * l'air d'une erreur alors que c'est la garantie qui fonctionne.
   */
  const runPreflight = pre.corps?.data?.runId ?? null;
  if (runPreflight) {
    const limite = Date.now() + 5 * 60 * 1000;
    let etat = null;
    while (Date.now() < limite) {
      // eslint-disable-next-line no-await-in-loop
      const vue = await api(`/api/deployment/runs/${runPreflight}`, { jeton });
      etat = vue.corps?.data?.run ?? vue.corps?.data ?? {};
      if (['ok', 'error', 'success', 'failed'].includes(String(etat.status))) break;
      // eslint-disable-next-line no-await-in-loop
      await dormir(3000);
    }
    for (const e of etat?.steps ?? []) {
      journal(`   ${e.status === 'ok' ? '\u2713' : e.status === 'error' ? '\u2717' : '\u00b7'} ${e.id ?? ''} ${e.label ?? ''}`
        + `${e.status === 'error' && e.message ? ` \u2014 ${String(e.message).slice(0, 160)}` : ''}`);
    }
    journal(`   issue du preflight : ${etat?.status ?? 'indeterminee'}`);
  }

  if (OBSERVER) {
    journal('\n--observe : aucun déploiement lancé.');
  } else {
    const lancement = await api(`/api/deployment/targets/${cible.targetId}/deploy`, {
      method: 'POST', jeton, body: { sshPassword: identifiants.ssh },
    });
    if (lancement.status !== 202) {
      throw new Error(`Déploiement refusé (${lancement.status}) : ${JSON.stringify(lancement.corps).slice(0, 600)}`);
    }
    const runId = lancement.corps.data.runId;
    journal(`\nexécution ${runId} acceptée — suivi :\n`);

    let dernier = 0;
    let fini = null;
    const limite = Date.now() + 20 * 60 * 1000;
    while (Date.now() < limite) {
      // eslint-disable-next-line no-await-in-loop
      const vue = await api(`/api/deployment/runs/${runId}`, { jeton });
      const run = vue.corps?.data?.run ?? vue.corps?.data ?? {};
      const etapes = run.steps ?? [];
      for (const e of etapes.slice(dernier)) {
        journal(`   ${e.status === 'ok' ? '✓' : e.status === 'error' ? '✗' : '·'} ${e.id ?? ''} ${e.label ?? ''}`
          + `${e.message ? ` — ${String(e.message).slice(0, 180)}` : ''}`);
      }
      dernier = etapes.length;
      if (['ok', 'error', 'success', 'failed'].includes(String(run.status))) { fini = run; break; }
      // eslint-disable-next-line no-await-in-loop
      await dormir(4000);
    }

    journal(`\nissue : ${fini?.status ?? 'INDÉTERMINÉE (délai dépassé)'}`);
    if (fini?.summary) journal(`résumé : ${fini.summary}`);
    if (fini?.error) journal(`erreur : ${JSON.stringify(fini.error).slice(0, 500)}`);
    if (!fini || !['ok', 'success'].includes(String(fini.status))) process.exitCode = 1;
  }
} catch (error) {
  journal(`\nÉCHEC : ${error.message}`);
  process.exitCode = 1;
} finally {
  if (backend) {
    backend.kill();
    await dormir(1200);
  }
}
