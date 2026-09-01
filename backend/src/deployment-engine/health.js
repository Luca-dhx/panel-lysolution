/**
 * Health check post-déploiement.
 *
 * On interroge l'endpoint /health du backend, DEPUIS le VPS (via curl sur le
 * transport) pour valider la chaîne Nginx -> PM2 -> app, ET, quand c'est
 * possible, depuis le backend local via l'URL publique (validation externe).
 *
 * Le déploiement n'est « validé » que si le health check répond 200 avec le bon
 * ENV. Sinon on considère le déploiement en échec (pas de demi-succès).
 */
import crypto from 'node:crypto';
import { PUBLIC_MEDIA_PROBE_PATH } from './config/project.profile.js';
import { TIMEOUTS, sonde } from './remoteCommand.js';

/**
 * Diagnostic d'un backend qui NE RÉPOND PAS : statut PM2 + dernières lignes de
 * log. Sans cela, le rapport ne montre que « connexion refusée » sans la VRAIE
 * cause (erreur Mongo/Atlas, variable d'env manquante, exception au démarrage).
 * Les commandes passent par le transport enregistré : elles apparaissent donc
 * dans le rapport (section services.verify).
 * @returns {Promise<{status:string|null, restarts:number|null, logTail:string}>}
 */
export async function collectBackendDiagnostics(transport, { name } = {}) {
  const out = { status: null, restarts: null, logTail: '' };
  try {
    const jlist = await sonde(transport, 'health.probe_pm2', `pm2 jlist 2>/dev/null || echo '[]'`);
    const app = JSON.parse(jlist.stdout || '[]').find((p) => p.name === name);
    if (app) {
      out.status = app.pm2_env?.status ?? null;
      out.restarts = app.pm2_env?.restart_time ?? null;
    }
  } catch {
    /* jlist illisible : on tente quand même les logs */
  }
  // Dernières lignes de log PM2 (out + err) : contiennent la cause réelle de la
  // sortie du process (ex. échec de connexion MongoDB, MONGODB_URI manquant…).
  const logs = await sonde(transport, 'health.probe_pm2_logs', `pm2 logs ${name} --lines 40 --nostream 2>&1 | tail -n 60`, { timeoutMs: 15_000 })
    .catch(() => ({ stdout: '', stderr: '' }));
  out.logTail = `${logs.stdout || ''}${logs.stderr || ''}`.trim().slice(-1800);
  return out;
}

/** Vérifie le /health local (via le port PM2) sur le VPS. */
export async function checkLocalHealth(transport, port, { retries = 8, delayMs = 2000 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    const res = await sonde(transport, 'health.probe_local', `curl -fsS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health || echo 000`, { timeoutMs: TIMEOUTS.HEALTH });
    const codeStr = res.stdout.trim().slice(-3);
    if (codeStr === '200') return { ok: true, httpCode: 200, attempts: i + 1 };
    if (i < retries - 1) await sleep(delayMs);
  }
  return { ok: false, httpCode: 0, attempts: retries };
}

/** Vérifie le /health public (HTTPS via l'hôte) sur le VPS. */
export async function checkPublicHealth(transport, host, { retries = 5, delayMs = 2000 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    const res = await sonde(transport, 'health.probe_public',
      `curl -fsS -m 8 -w '\n%{http_code}' https://${host}/health || echo '\n000'`, { timeoutMs: TIMEOUTS.HEALTH });
    const lines = res.stdout.trim().split('\n');
    const codeStr = lines[lines.length - 1].trim();
    const body = lines.slice(0, -1).join('\n');
    if (codeStr === '200') {
      let env = null;
      try {
        env = JSON.parse(body)?.data?.env ?? null;
      } catch {
        /* corps non-JSON */
      }
      return { ok: true, httpCode: 200, env, attempts: i + 1 };
    }
    if (i < retries - 1) await sleep(delayMs);
  }
  return { ok: false, httpCode: 0, env: null, attempts: retries };
}

/** Récupère (HEAD) une ressource : { code, mime } via curl. */
async function headResource(transport, url) {
  const res = await sonde(transport, 'health.probe_asset', `curl -fsSL -m 8 -o /dev/null -w '%{http_code} %{content_type}' '${url}' || echo '000 none'`, { timeoutMs: TIMEOUTS.HEALTH });
  const [code, ...rest] = (res.stdout || '000 none').trim().split(/\s+/);
  return { code: Number(code) || 0, mime: (rest.join(' ') || '').split(';')[0] || '' };
}

/**
 * Test FONCTIONNEL EXHAUSTIF des médias (LOT 12 renforcé).
 * 1) récupère la sonde publique DÉCLARÉE AU PROFIL et REFUSE toute URL d'upload
 *    locale/non sûre ;
 * 2) vérifie que CHAQUE média RÉELLEMENT EXPOSÉ par la projection se télécharge
 *    (HTTP 200 + type MIME image).
 * Un simple « pas de localhost » ne suffit pas : un fichier absent (404) rend un
 * logo cassé tout en passant l'ancien contrôle.
 *
 * ══ CE CONTRÔLE NE RECONSTRUIT PLUS D'ADRESSE ═══════════════════════════════
 *
 * Il extrayait `/uploads/…` de la sonde — y compris le CHEMIN d'une adresse
 * absolue — puis recomposait cette adresse contre chaque origine servie. Une
 * image légitimement hébergée ailleurs devenait donc :
 *
 *     exposée :  https://panel.ly-solution.com/uploads/7dda…webp   (200)
 *     testée  :  https://<client>/uploads/7dda…webp                (404)
 *
 * … et le déploiement échouait sur un média parfaitement sain. Le contrôle
 * inventait une adresse que rien n'avait publiée.
 *
 * L'invariant est désormais :
 *
 *     URL affichée par l'application === URL testée par le healthcheck
 *
 *   · une adresse ABSOLUE est testée TELLE QUELLE, sur son propre hôte ;
 *   · un chemin RELATIF est testé contre chaque origine servie — c'est bien
 *     ainsi qu'un navigateur le chargerait.
 *
 * @returns {Promise<{ok, probed, reachable, localHits, checked, brokenCount}>}
 */
export async function checkPublicMedia(transport, host, { origins: originSpec, path = PUBLIC_MEDIA_PROBE_PATH, maxAssets = 8 } = {}) {
  // Le chemin de sonde est une donnée de PROJET (le profil le déclare). Un projet
  // qui n'expose aucun catalogue public de médias n'a pas de sonde : on le DIT
  // (`probed: false`) au lieu de retourner « ok » sans avoir rien vérifié.
  if (!path) return { ok: true, probed: false, reachable: false, localHits: [], checked: [], brokenCount: 0 };
  const res = await sonde(transport, 'health.probe_page', `curl -fsS -m 8 https://${host}${path} || echo __ERR__`, { timeoutMs: TIMEOUTS.HEALTH });
  const body = res.stdout || '';
  if (!body.trim() || body.includes('__ERR__')) return { ok: true, probed: true, reachable: false, localHits: [], checked: [], brokenCount: 0 };

  // (1) URLs d'upload locales/non sûres encore stockées → cassées en HTTPS.
  const localHits = [...new Set([
    ...(body.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/uploads\/[^\s"'\\]*/gi) || []),
    ...(body.match(/http:\/\/[^\s"'\\]*\/uploads\/[^\s"'\\]*/gi) || []),
  ])].slice(0, 5);

  /**
   * (2) LES MÉDIAS TELS QUE LA PROJECTION LES EXPOSE.
   *
   * Deux formes, deux façons de les charger — et on ne convertit jamais l'une
   * en l'autre :
   *
   *   · ABSOLUE — l'application a publié un hôte. C'est CET hôte qui sert le
   *     fichier ; le tester ailleurs testerait une adresse que personne
   *     n'affiche. On retire ces adresses du corps avant de chercher les
   *     chemins relatifs, sinon leur `/uploads/…` serait compté deux fois — et
   *     la seconde fois contre le mauvais domaine.
   *
   *   · RELATIVE — le navigateur la résout contre l'origine qui l'a servie. On
   *     la contrôle donc depuis CHAQUE origine du profil.
   */
  const ABSOLUE = /https?:\/\/[^\s"'\\<>]+\/uploads\/[^\s"'\\?<>]+/gi;
  const absolues = [...new Set(body.match(ABSOLUE) || [])].slice(0, maxAssets);
  const corpsSansAbsolues = body.replace(ABSOLUE, ' ');
  const paths = [...new Set((corpsSansAbsolues.match(/\/uploads\/[^\s"'\\?<>]+/g) || []))].slice(0, maxAssets);

  // Origines à contrôler : fournies par la TOPOLOGIE (une par application
  // servie). À défaut, l'hôte principal seul.
  const origins = (originSpec?.length ? originSpec : [{ label: 'site', host }])
    .map((o) => ({ label: o.label, base: `https://${o.host}` }));

  const checked = [];
  let brokenCount = 0;

  for (const p of paths) {
    const perOrigin = {};
    let assetOk = true;
    for (const o of origins) {
      const r = await headResource(transport, `${o.base}${p}`);
      const ok = r.code === 200 && /^image\//i.test(r.mime);
      perOrigin[o.label] = { code: r.code, mime: r.mime, ok };
      if (!ok) assetOk = false;
    }
    if (!assetOk) brokenCount += 1;
    checked.push({ path: p, absolute: false, origins: perOrigin, ok: assetOk });
  }

  for (const url of absolues) {
    // Une seule sonde, sur l'hôte que la projection a réellement publié. Le
    // libellé porte cet hôte : un rapport qui dirait « site » pour une adresse
    // servie ailleurs ferait chercher la panne au mauvais endroit.
    let libelle = 'externe';
    try { libelle = new URL(url).hostname; } catch { /* libellé par défaut */ }
    const r = await headResource(transport, url);
    const ok = r.code === 200 && /^image\//i.test(r.mime);
    if (!ok) brokenCount += 1;
    checked.push({ path: url, absolute: true, origins: { [libelle]: { code: r.code, mime: r.mime, ok } }, ok });
  }

  const ok = localHits.length === 0 && brokenCount === 0;
  return { ok, probed: true, reachable: true, localHits, checked, brokenCount };
}

/**
 * Healthcheck du DOMAINE API DÉDIÉ (`https://api.<host>/api/health`) : confirme
 * DNS + certificat + proxy vers le backend, code HTTP 200, ENV attendu, absence
 * de 502. Non sensible (aucun secret ni nom de base). @returns {{reachable,code,ok,env}}
 */
export async function checkApiHealth(transport, apiHost, { expectedEnv } = {}) {
  // Route canonique = /health (servie à la racine par le backend ; le domaine API
  // proxifie tout `/` vers le backend). PAS /api/health (inexistante → 404).
  const res = await sonde(transport, 'health.probe_api', `curl -fsSL -m 8 -w '\\n%{http_code}' https://${apiHost}/health || echo '\\n000'`, { timeoutMs: TIMEOUTS.HEALTH });
  const lines = (res.stdout || '').trim().split('\n');
  const code = Number(lines[lines.length - 1]?.trim()) || 0;
  const body = lines.slice(0, -1).join('\n');
  let env = null;
  try { env = JSON.parse(body)?.data?.env ?? null; } catch { /* corps non-JSON */ }
  const envOk = !expectedEnv || !env || env === expectedEnv;
  return { reachable: code !== 0, code, ok: code === 200 && envOk, env, proxyError: code === 502 || code === 504, envMismatch: Boolean(expectedEnv && env && env !== expectedEnv) };
}

/** Récupère le CORPS d'une ressource via curl (null si injoignable). */
async function fetchBody(transport, url) {
  const res = await sonde(transport, 'health.probe_url', `curl -fsSL -m 10 '${url}' || echo __ERR__`, { timeoutMs: TIMEOUTS.HEALTH });
  const body = res.stdout ?? '';
  if (body.includes('__ERR__') || !body.length) return null;
  return body;
}

function sha256(str) {
  return crypto.createHash('sha256').update(Buffer.from(str, 'utf8')).digest('hex');
}

/**
 * Contrôle que le SPA RÉELLEMENT SERVI correspond à l'artefact construit.
 *
 * Motif : un déploiement peut réussir côté serveur alors que le navigateur reçoit
 * encore une ANCIENNE version (index.html mal remplacé, cache, mauvais dossier).
 * On compare donc, depuis l'extérieur (curl → Nginx) :
 *   - sha256(index.html distant)      == sha256(index.html construit) ;
 *   - le JS d'entrée référencé + son sha == celui construit (nom Vite = hash contenu) ;
 *   - le commit de /version.json servi  == le commit du manifeste construit
 *     (si `expected.commitHash` est fourni). Un version.json ABSENT à distance
 *     compte comme divergent : seule une vieille version ne l'embarque pas.
 *
 * @returns {Promise<{ok, reachable, indexMatch, jsMatch, versionMatch, label, remoteIndexHash, expectedIndexHash}>}
 */
export async function checkWebsiteArtifact(transport, host, expected, { label = 'site' } = {}) {
  if (!expected?.indexHash) return { ok: true, reachable: true, skipped: true, label };
  const remoteIndex = await fetchBody(transport, `https://${host}/`);
  if (remoteIndex == null) return { ok: false, reachable: false, indexMatch: false, jsMatch: false, versionMatch: false, label };

  const remoteIndexHash = sha256(remoteIndex);
  const indexMatch = remoteIndexHash === expected.indexHash;

  let jsMatch = true;
  let remoteMainJsHash = null;
  if (expected.mainJs?.name && expected.mainJs?.hash) {
    const referenced = remoteIndex.includes(`/assets/${expected.mainJs.name}`);
    const js = await fetchBody(transport, `https://${host}/assets/${expected.mainJs.name}`);
    remoteMainJsHash = js != null ? sha256(js) : null;
    jsMatch = referenced && remoteMainJsHash === expected.mainJs.hash;
  }

  let versionMatch = true;
  let remoteCommit = null;
  if (expected.commitHash) {
    const vjson = await fetchBody(transport, `https://${host}/version.json`);
    try { remoteCommit = vjson ? (JSON.parse(vjson)?.commitHash ?? null) : null; } catch { remoteCommit = null; }
    versionMatch = remoteCommit === expected.commitHash;
  }

  return {
    ok: indexMatch && jsMatch && versionMatch, reachable: true, indexMatch, jsMatch, versionMatch, label,
    remoteIndexHash, expectedIndexHash: expected.indexHash,
    expectedJs: expected.mainJs?.name || null, remoteMainJsHash,
    expectedCommit: expected.commitHash || null, remoteCommit,
  };
}

/**
 * LES MODULES `.mjs` SONT-ILS SERVIS COMME DU JAVASCRIPT ? — sur le LIVE.
 *
 * ══ POURQUOI CETTE SONDE EXISTE ═════════════════════════════════════════════
 *
 * Un déploiement a pu s'achever en `deployment.succeeded` alors que le serveur
 * répondait encore `application/octet-stream` sur le worker de PDF.js. Rien ne
 * mentait : chaque étape avait bien réussi. Simplement, AUCUNE n'avait posé la
 * question qui comptait — « le fichier est-il servi avec le bon type ? ».
 *
 * Le générateur pouvait donc être corrigé, la suite de tests verte, la
 * configuration écrite… et le navigateur continuer d'échouer. Une chaîne de
 * preuves qui ne touche jamais la réponse HTTP finale ne prouve pas la réponse
 * HTTP finale.
 *
 * ══ CE QU'ELLE VÉRIFIE, ET SUR QUOI ════════════════════════════════════════
 *
 * Sur un module RÉELLEMENT présent dans le bundle déployé — jamais un fichier
 * témoin fabriqué pour l'occasion, qui prouverait seulement qu'une règle
 * existe pour un nom qui n'existe pas.
 *
 * Le contrôle du navigateur porte sur la famille `javascript` : `text/javascript`
 * comme `application/javascript` conviennent. Tout le reste — au premier chef
 * `application/octet-stream` — fait échouer les scripts de module.
 *
 * ══ ABSENCE DE MODULE N'EST PAS ÉCHEC ══════════════════════════════════════
 *
 * Un bundle sans `.mjs` rend `probed: false`. On le DIT, plutôt que de rendre
 * un « ok » qui n'a rien constaté.
 */
const MIME_JAVASCRIPT = /(?:application|text)\/javascript/i;

export async function checkModuleMimeType(transport, host, { maxModules = 3 } = {}) {
  const vide = { ok: true, probed: false, host, modules: [] };

  /**
   * On demande au SERVEUR la liste de ses modules : le pipeline connaît le
   * dossier publié, et c'est le seul endroit où l'on sait ce qui a réellement
   * atterri. Déduire le nom depuis l'artefact local supposerait que l'upload
   * s'est bien passé — précisément ce qu'on cherche à vérifier.
   */
  const liste = await sonde(
    transport,
    'health.module_mime.list',
    `ls -1 /var/www/${host}/assets/*.mjs 2>/dev/null | head -${maxModules} || true`,
    { timeoutMs: TIMEOUTS.HEALTH },
  );
  const chemins = (liste.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (chemins.length === 0) return vide;

  const modules = [];
  for (const chemin of chemins) {
    const nom = chemin.split('/').pop();

    /**
     * DEUX FORMES, ET LA SECONDE EST CELLE QUE L'APPLICATION DEMANDE.
     *
     * Depuis que l'URL du worker porte l'identité de la release
     * (`?build=<revision>`), c'est cette forme-là que le navigateur réclame.
     * Ne sonder que l'URL nue laisserait passer une configuration qui casse dès
     * qu'une chaîne de requête est présente — et le contrôle serait vert sur
     * une adresse que personne n'appelle.
     */
    for (const suffixe of ['', '?build=sonde']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await sonde(
        transport,
        'health.module_mime.head',
        `curl -sS -o /dev/null -m 10 -w '%{http_code} %{content_type}' 'https://${host}/assets/${nom}${suffixe}' || echo '000 __ERR__'`,
        { timeoutMs: TIMEOUTS.HEALTH },
      );
      const [statut, ...reste] = (res.stdout || '').trim().split(/\s+/);
      const contentType = reste.join(' ');
      modules.push({
        name: nom + suffixe,
        status: Number(statut) || 0,
        contentType: contentType || null,
        ok: Number(statut) === 200 && MIME_JAVASCRIPT.test(contentType || ''),
      });
    }
  }

  return { ok: modules.every((m) => m.ok), probed: true, host, modules };
}

/**
 * LE PLAN DU SITE ET LE FICHIER ROBOTS — vérifiés SUR L'HÔTE PUBLIC, en ligne.
 *
 * ══ L'INCIDENT QUI A PRODUIT CE CONTRÔLE ════════════════════════════════════
 *
 * Google Search Console a refusé le plan du site d'une vitrine déployée :
 *
 *     « Le sitemap peut être lu, mais contient des erreurs.
 *       Le sitemap est un fichier HTML. »
 *
 * Le plan existait dans le code, la route répondait, les tests passaient. Mais
 * à l'adresse `/sitemap.xml` — la seule qu'on soumette à un moteur — nginx ne
 * trouvait pas de fichier et appliquait le repli d'application à page unique :
 * il rendait `index.html` en `text/html`, avec un code 200.
 *
 * Aucun test de code ne pouvait le voir : le défaut n'existe QU'UNE FOIS
 * ASSEMBLÉ, entre une configuration de serveur et une route d'application.
 *
 * ══ POURQUOI IL BLOQUE LE DÉPLOIEMENT ══════════════════════════════════════
 *
 * Un plan de site cassé ne se remarque pas. Le site fonctionne, les pages
 * s'affichent, rien n'est en erreur — la seule trace est un message dans une
 * console que personne n'ouvre avant des semaines. C'est exactement le genre
 * de défaut qu'il faut refuser à la porte plutôt que découvrir en production.
 *
 * ══ CE QU'IL VÉRIFIE, ET CE QU'IL NE VÉRIFIE PAS ═══════════════════════════
 *
 * Il vérifie la FORME — code, type de contenu, racine XML — et pas le contenu :
 * quelles adresses figurent au plan est une décision du projet, pas du moteur
 * de déploiement. Un projet sans plan du tout n'est pas en faute : c'est un
 * plan qui MENT sur sa nature qui l'est.
 */
export async function checkSeoEndpoints(transport, host, { retries = 5, delayMs = 3000 } = {}) {
  const uneFois = async (chemin) => {
    const res = await sonde(
      transport,
      'health.seo',
      `curl -sS -m 10 -o /tmp/ly-seo-probe -w '%{http_code} %{content_type}' 'https://${host}${chemin}' || echo '000 __ERR__'; echo; head -c 200 /tmp/ly-seo-probe 2>/dev/null || true`,
      { timeoutMs: TIMEOUTS.HEALTH },
    );
    const lignes = (res.stdout || '').split('\n');
    const [statut, ...reste] = (lignes[0] || '').trim().split(/\s+/);
    return {
      path: chemin,
      url: `https://${host}${chemin}`,
      status: Number(statut) || 0,
      contentType: reste.join(' ') || null,
      head: lignes.slice(1).join('\n'),
    };
  };

  /**
   * ══ ON RÉESSAIE TANT QUE LE SERVICE DÉMARRE ═══════════════════════════════
   *
   * ── LE DÉFAUT QUE CECI FERME ──────────────────────────────────────────────
   *
   * Une première version ne sondait qu'une fois. Sur un déploiement réel, le
   * backend venait d'être relancé et son garde de disponibilité répondait :
   *
   *     HTTP 503 · {"success":false,"message":"Le service démarre…"}
   *
   * Le contrôle n'a rien refusé — un code autre que 200 était traité comme
   * « aucun plan publié », cas légitime — et le rapport a imprimé « ✓ plan du
   * site et fichier robots conformes ». Il certifiait une réponse qu'il
   * n'avait jamais lue.
   *
   * Un contrôle qui rassure sans avoir vérifié est pire qu'un contrôle absent :
   * il fait croire que la question a été posée.
   *
   * ── LA DISTINCTION QUI MANQUAIT ───────────────────────────────────────────
   *
   * « Ce projet ne publie pas de plan » (404) et « le service n'a pas pu
   * répondre » (5xx, connexion perdue) ne sont pas la même chose. La première
   * est une décision de projet, la seconde est un échec de mesure. On réessaie
   * donc sur la seconde, et si elle persiste, on refuse.
   */
  const sonder = async (chemin) => {
    let derniere = null;
    for (let essai = 0; essai <= retries; essai += 1) {
      // eslint-disable-next-line no-await-in-loop
      derniere = await uneFois(chemin);
      derniere.attempts = essai + 1;
      const transitoire = derniere.status === 0 || derniere.status >= 500;
      if (!transitoire) return derniere;
      // eslint-disable-next-line no-await-in-loop
      if (essai < retries) await sleep(delayMs);
    }
    return derniere;
  };

  const sitemap = await sonder('/sitemap.xml');
  const robots = await sonder('/robots.txt');

  /**
   * UN PLAN ABSENT EST TOLÉRÉ, UN PLAN EN HTML NE L'EST PAS.
   *
   * Tous les projets du parc n'exposent pas de plan du site. En refuser le
   * déploiement les bloquerait tous pour une exigence qu'ils n'ont pas prise.
   * En revanche, dès qu'une adresse RÉPOND 200, elle doit répondre du XML :
   * c'est précisément l'état intermédiaire — 200 porteur de HTML — qui trompe
   * les moteurs et qu'aucun projet ne doit pouvoir mettre en ligne.
   */
  const sitemapHtml = sitemap.status === 200
    && (/text\/html/i.test(sitemap.contentType || '') || /<!doctype html|<html/i.test(sitemap.head || ''));
  const sitemapXml = sitemap.status === 200
    && /xml/i.test(sitemap.contentType || '')
    && /<\?xml|<urlset|<sitemapindex/i.test(sitemap.head || '');

  const robotsHtml = robots.status === 200
    && (/text\/html/i.test(robots.contentType || '') || /<!doctype html|<html/i.test(robots.head || ''));

  const problemes = [];
  if (sitemapHtml) problemes.push('/sitemap.xml répond 200 avec du HTML : un moteur de recherche le refusera.');
  if (sitemap.status === 200 && !sitemapXml && !sitemapHtml) {
    problemes.push(`/sitemap.xml répond 200 mais n'est pas du XML (type « ${sitemap.contentType} »).`);
  }
  if (robotsHtml) problemes.push('/robots.txt répond 200 avec du HTML au lieu de texte brut.');

  /**
   * UNE RÉPONSE QU'ON N'A PAS PU LIRE N'EST PAS UNE RÉPONSE CONFORME.
   *
   * Après les réessais, un 5xx ou une connexion perdue signifie que le service
   * ne sert pas ces adresses — pas qu'il a choisi de ne pas les publier. Le
   * dire est le minimum ; le taire ferait imprimer « conforme » sur une mesure
   * qui n'a pas eu lieu.
   */
  for (const p of [sitemap, robots]) {
    if (p.status === 0) {
      problemes.push(`${p.path} : aucune réponse après ${p.attempts} tentative(s) — l'hôte est injoignable.`);
    } else if (p.status >= 500) {
      problemes.push(`${p.path} répond ${p.status} après ${p.attempts} tentative(s) : le service ne sert pas cette adresse.`);
    }
  }

  /**
   * CE QUE LE CONTRÔLE A CONSTATÉ, EN TOUTES LETTRES.
   *
   * « conformes » ne doit se lire que lorsqu'un plan a RÉELLEMENT été servi et
   * validé. Un projet qui n'en publie pas est en règle, et son rapport doit le
   * dire autrement — sans quoi la même phrase couvrirait deux réalités.
   */
  const verdict = problemes.length > 0
    ? 'contrôle en échec'
    : sitemapXml
      ? 'plan du site et fichier robots conformes'
      : `aucun plan du site publié (HTTP ${sitemap.status}) — toléré ; fichier robots conforme`;

  /**
   * ══ LE DÉBUT DU CORPS EST CONSERVÉ, ET C'EST DÉLIBÉRÉ ═══════════════════
   *
   * Une version antérieure le jetait (`head: undefined`) : le contrôle rendait
   * un verdict sans jamais montrer CE QU'IL AVAIT LU. En cas de refus, il
   * fallait rouvrir un terminal et refaire la requête à la main pour savoir si
   * l'on avait reçu une page d'accueil, une page d'erreur ou autre chose.
   *
   * Les 200 premiers octets tiennent dans un rapport, ne peuvent pas contenir
   * de secret (ce sont deux documents publics par nature), et transforment le
   * verdict en PREUVE : le rapport de déploiement montre la réponse.
   */
  return {
    ok: problemes.length === 0,
    probed: true,
    host,
    sitemap: { ...sitemap, isXml: sitemapXml, isHtml: sitemapHtml },
    robots: { ...robots, isHtml: robotsHtml },
    problems: problemes,
    verdict,
    /**
     * Une ligne par sonde, prête à lire. Le rapport n'a ainsi rien à
     * recomposer, et le journal du déploiement dit la même chose que lui.
     */
    lines: [sitemap, robots].map((p) => {
      const corps = String(p.head ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return `${p.url} → HTTP ${p.status} · ${p.contentType || 'type inconnu'}${corps ? ` · « ${corps} »` : ''}`;
    }),
  };
}

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

export default {
  checkLocalHealth, checkPublicHealth, collectBackendDiagnostics,
  checkPublicMedia, checkApiHealth, checkWebsiteArtifact, checkModuleMimeType,
  checkSeoEndpoints,
};
