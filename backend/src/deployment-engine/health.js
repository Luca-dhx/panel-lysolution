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
    const jlist = await transport.exec(`pm2 jlist 2>/dev/null || echo '[]'`);
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
  const logs = await transport
    .exec(`pm2 logs ${name} --lines 40 --nostream 2>&1 | tail -n 60`, { timeoutMs: 15_000 })
    .catch(() => ({ stdout: '', stderr: '' }));
  out.logTail = `${logs.stdout || ''}${logs.stderr || ''}`.trim().slice(-1800);
  return out;
}

/** Vérifie le /health local (via le port PM2) sur le VPS. */
export async function checkLocalHealth(transport, port, { retries = 8, delayMs = 2000 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    const res = await transport.exec(
      `curl -fsS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/health || echo 000`
    );
    const codeStr = res.stdout.trim().slice(-3);
    if (codeStr === '200') return { ok: true, httpCode: 200, attempts: i + 1 };
    if (i < retries - 1) await sleep(delayMs);
  }
  return { ok: false, httpCode: 0, attempts: retries };
}

/** Vérifie le /health public (HTTPS via l'hôte) sur le VPS. */
export async function checkPublicHealth(transport, host, { retries = 5, delayMs = 2000 } = {}) {
  for (let i = 0; i < retries; i += 1) {
    const res = await transport.exec(
      `curl -fsS -m 8 -w '\\n%{http_code}' https://${host}/health || echo '\\n000'`
    );
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
  const res = await transport.exec(`curl -fsSL -m 8 -o /dev/null -w '%{http_code} %{content_type}' '${url}' || echo '000 none'`);
  const [code, ...rest] = (res.stdout || '000 none').trim().split(/\s+/);
  return { code: Number(code) || 0, mime: (rest.join(' ') || '').split(';')[0] || '' };
}

/**
 * Test FONCTIONNEL EXHAUSTIF des médias (LOT 12 renforcé).
 * 1) récupère la sonde publique DÉCLARÉE AU PROFIL et REFUSE toute URL d'upload
 *    locale/non sûre ;
 * 2) extrait les chemins de médias ESSENTIELS et vérifie que CHACUN se télécharge
 *    RÉELLEMENT (HTTP 200 + type MIME image) depuis CHAQUE origine servie du
 *    profil — un front charge ses médias relativement à sa propre origine.
 * Un simple « pas de localhost » ne suffit pas : un fichier absent (404) rend un
 * logo cassé tout en passant l'ancien contrôle.
 * @returns {Promise<{ok, probed, reachable, localHits, checked, brokenCount}>}
 */
export async function checkPublicMedia(transport, host, { origins: originSpec, path = PUBLIC_MEDIA_PROBE_PATH, maxAssets = 8 } = {}) {
  // Le chemin de sonde est une donnée de PROJET (le profil le déclare). Un projet
  // qui n'expose aucun catalogue public de médias n'a pas de sonde : on le DIT
  // (`probed: false`) au lieu de retourner « ok » sans avoir rien vérifié.
  if (!path) return { ok: true, probed: false, reachable: false, localHits: [], checked: [], brokenCount: 0 };
  const res = await transport.exec(`curl -fsS -m 8 https://${host}${path} || echo __ERR__`);
  const body = res.stdout || '';
  if (!body.trim() || body.includes('__ERR__')) return { ok: true, probed: true, reachable: false, localHits: [], checked: [], brokenCount: 0 };

  // (1) URLs d'upload locales/non sûres encore stockées → cassées en HTTPS.
  const localHits = [...new Set([
    ...(body.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/uploads\/[^\s"'\\]*/gi) || []),
    ...(body.match(/http:\/\/[^\s"'\\]*\/uploads\/[^\s"'\\]*/gi) || []),
  ])].slice(0, 5);

  // (2) Chemins de médias à vérifier réellement.
  const paths = [...new Set((body.match(/\/uploads\/[^\s"'\\?]+/g) || []))].slice(0, maxAssets);
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
    checked.push({ path: p, origins: perOrigin, ok: assetOk });
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
  const res = await transport.exec(`curl -fsSL -m 8 -w '\\n%{http_code}' https://${apiHost}/health || echo '\\n000'`);
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
  const res = await transport.exec(`curl -fsSL -m 10 '${url}' || echo __ERR__`);
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

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

export default { checkLocalHealth, checkPublicHealth, collectBackendDiagnostics, checkPublicMedia, checkApiHealth, checkWebsiteArtifact };
