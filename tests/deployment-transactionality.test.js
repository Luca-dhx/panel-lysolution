/**
 * TRANSACTIONNALITÉ DU DÉPLOIEMENT — publier vient APRÈS valider.
 *
 * ── LE DÉFAUT QU'IL VERROUILLE ──────────────────────────────────────────────
 * `runtime_config` écrit la configuration réseau CANONIQUE du projet, dans la
 * base de la destination. Cette étape s'exécutait AVANT les contrôles publics.
 *
 * Un déploiement qui échouait ensuite avait donc déjà réécrit cette
 * configuration — partagée avec les destinations précédentes du même projet.
 * Constaté en production : l'ancienne vitrine, restée saine, s'est mise à
 * pointer vers le nouveau backend d'un déploiement qui n'a jamais abouti.
 *
 * Écrire une configuration canonique est un acte de PUBLICATION. Il ne peut
 * venir qu'après avoir constaté que la nouvelle destination est saine.
 */
let pass = 0;
let fail = 0;
const check = (nom, ok) => {
  if (ok) { pass += 1; console.log(`  ✓ ${nom}`); } else { fail += 1; console.error(`  ✗ ${nom}`); }
};
const section = (t) => console.log(`\n${t}`);

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../backend');
const pipeline = await fs.readFile(path.join(racine, 'src/deployment-engine/pipeline.js'), 'utf8');

/** Position de la déclaration d'une étape dans le pipeline. */
const positionEtape = (id) => pipeline.indexOf(`await step('${id}'`);

/* ────────────────────────────────────────────────────────────────────────── */
section('1. L’ORDRE — publier ne peut plus précéder valider');
{
  const validate = positionEtape('validate');
  const runtime = positionEtape('runtime_config');

  check('l’étape de validation existe', validate > 0);
  check('l’étape de configuration réseau existe', runtime > 0);
  check('runtime_config vient APRÈS validate', runtime > validate);

  // L'ordre complet, tel qu'il doit rester.
  const attendu = ['upload', 'dirs', 'nginx', 'certbot', 'reload', 'pm2', 'health', 'validate', 'runtime_config'];
  const positions = attendu.map((id) => ({ id, at: positionEtape(id) }));
  check('toutes les étapes sont déclarées', positions.every((p) => p.at > 0));
  check('…et dans cet ordre exact',
    positions.every((p, i) => i === 0 || p.at > positions[i - 1].at));

  // Le contrôle des médias vit DANS validate : il précède donc la publication.
  const media = pipeline.indexOf('checkPublicMedia(');
  check('le contrôle des médias précède la configuration réseau', media > 0 && media < runtime);
  check('…et il est bien dans l’étape de validation', media > validate && media < runtime);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. UN ÉCHEC DE VALIDATION N’ÉCRIT RIEN');
{
  const { runPipeline } = await import('../backend/src/deployment-engine/pipeline.js');
  const { parseTargetUrl } = await import('../backend/src/deployment-engine/url.js');

  const cible = parseTargetUrl('https://demo.exemple.com', { wildcardBases: [] });

  /**
   * VPS sain, mais un média référencé manque — exactement le cas observé :
   * la base a bougé de destination, `shared/uploads` est vide.
   */
  const vps = ({ mediaOk }) => ({
    kind: 'ssh',
    async exec(cmd) {
      if (cmd.includes('id -un')) return { code: 0, stdout: 'root\n', stderr: '' };
      if (cmd.includes('command -v')) return { code: 0, stdout: 'OK\n', stderr: '' };
      if (cmd.includes('echo WRITABLE')) return { code: 0, stdout: 'WRITABLE\n', stderr: '' };
      if (cmd.includes('df -Pk')) return { code: 0, stdout: `${10 * 1024 * 1024}\n`, stderr: '' };
      if (cmd.includes('fullchain.pem')) return { code: 0, stdout: 'OK\n', stderr: '' };
      // Sonde média : 404 quand le fichier manque, 200 sinon.
      if (cmd.includes('/uploads/')) {
        return mediaOk
          ? { code: 0, stdout: '200 image/webp\n', stderr: '' }
          : { code: 0, stdout: '404 application/json\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    writeFile: async () => {}, readFile: async () => '',
    uploadDir: async () => ({ files: 0, bytes: 0 }), close: async () => {},
  });

  // On observe si la configuration canonique a été écrite.
  let ecritures = 0;
  const runtimeConfigSync = async () => { ecritures += 1; return { ok: true }; };

  const echec = await runPipeline({
    transport: vps({ mediaOk: false }),
    target: cible,
    artifact: { dists: {}, backendDir: '/tmp/b', uploadsDir: null },
    version: 'v1',
    options: {
      backendPort: 5001,
      runtimeConfigSync,
      remoteEnv: { MONGODB_URI: 'mongodb://x', DB_TEST: 'd', DB_PROD: 'p' },
      health: { retries: 1, delayMs: 1 },
    },
  }).catch((err) => ({ ok: false, thrown: err }));

  check('le déploiement échoue', echec.ok === false);
  check('AUCUNE configuration canonique n’a été écrite', ecritures === 0);
  check('…donc l’ancienne destination reste intacte', ecritures === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. LE MOTEUR EST MIRRORÉ — la règle vaut des deux côtés');
{
  const autre = path.resolve(racine, "../../SB Auto 06/backend/src/deployment-engine/pipeline.js");
  let miroir = null;
  try { miroir = await fs.readFile(autre, 'utf8'); } catch { /* dépôt voisin absent */ }

  if (miroir === null) {
    check('dépôt voisin absent — contrôle ignoré (atelier)', true);
  } else {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    check('les deux pipelines sont identiques', norm(miroir) === norm(pipeline));
    const vPos = miroir.indexOf("await step('validate'");
    const rPos = miroir.indexOf("await step('runtime_config'");
    check('…et le miroir respecte le même ordre', rPos > vPos);
  }
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
