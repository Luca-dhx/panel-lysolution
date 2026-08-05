/**
 * MATRICE DOCUMENTAIRE — quatre axes, et aucun ne se déduit d'un autre.
 *
 * ── LE DÉFAUT QU'ELLE VERROUILLE ────────────────────────────────────────────
 * La carte contrat décidait dans son JSX :
 *
 *     downloadAvailable && joignable ? <bouton/>
 *       : document.available        ? « le lien avec le projet est rompu »
 *       :                             « aucun document »
 *
 * Le repli accusait la CONNEXION dès que le téléchargement n'était pas
 * possible. Sur un projet en ligne — dernier contact à l'instant — dont le
 * fichier manquait sur le stockage, l'écran affirmait donc « connecté » ET
 * « lien rompu ». Deux axes indépendants avaient été fondus en un seul test.
 *
 * Lancement : npm run test:contract-document
 */
import assert from 'node:assert';

let pass = 0;
let fail = 0;
const check = (nom, ok) => {
  if (ok) { pass += 1; console.log(`  ✓ ${nom}`); } else { fail += 1; console.error(`  ✗ ${nom}`); }
};
const section = (t) => console.log(`\n${t}`);

const { getContractDocumentPresentation } = await import(
  '../frontend/src/lib/contractDocument.ts'
);

/* ── Fabriques ────────────────────────────────────────────────────────────── */

const fraicheur = (over = {}) => ({
  connection: 'ONLINE',
  projectionEnvironment: 'PROD',
  runtimeEnvironment: 'PROD',
  isEnvironmentMismatch: false,
  isGenerationMismatch: false,
  isBusinessDataFresh: true,
  lastContactAt: new Date().toISOString(),
  lastFullSyncAt: new Date().toISOString(),
  ...over,
});

const document = (over = {}) => ({
  available: true,
  status: 'SIGNED',
  downloadAvailable: true,
  filename: 'contrat.pdf',
  pages: 4,
  signatureRequired: true,
  signatureStatus: 'DONE',
  ...over,
});

const presenter = (over = {}) => getContractDocumentPresentation({
  document: document(),
  contract: { status: 'ACTIVE' },
  freshness: fraicheur(),
  paired: true,
  ...over,
});

/** Tout le texte présenté — c'est là qu'une contradiction se voit. */
const texte = (p) => [p.title, p.message, p.downloadDisabledReason]
  .filter(Boolean).join(' • ').toLowerCase();

/* ────────────────────────────────────────────────────────────────────────── */
section('CAS 1 — projet ONLINE + document téléchargeable');
{
  const p = presenter();
  check('état = téléchargeable', p.state === 'DOWNLOADABLE');
  check('le bouton est proposé', p.showDownload === true);
  check('aucun empêchement à expliquer', p.downloadDisabledReason === null);
  check('aucun message parasite', p.message === '');
  check('l’état documentaire est celui du document', p.title === 'Signé');
  check('les actions distantes restent possibles', p.showRemoteActions === true);
  check('ce n’est pas de l’histoire', p.isHistorical === false);
}

section('CAS 2 — projet ONLINE + aucun document');
{
  const p = presenter({ document: document({ status: 'NONE', available: false, downloadAvailable: false }) });
  check('état = aucun document', p.state === 'NONE');
  check('libellé « Non généré »', p.title === 'Non généré');
  check('aucun bouton', p.showDownload === false);
  check('AUCUNE phrase de rupture de connexion', !/rompu|injoignable|retour du site/.test(texte(p)));
  check('…et rien qui prétende que le document existe', !/le document existe/.test(texte(p)));
}

section('CAS 3 — projet ONLINE + document non téléchargeable pour raison métier');
{
  const enPreparation = presenter({
    document: document({ status: 'GENERATED', downloadAvailable: false, signatureStatus: 'NONE' }),
  });
  check('état = pas encore disponible', enPreparation.state === 'NOT_YET_AVAILABLE');
  check('le texte est métier', /n’est pas encore disponible au téléchargement/.test(enPreparation.message));
  check('aucun bouton', enPreparation.showDownload === false);
  check('JAMAIS « lien rompu »', !/rompu/.test(texte(enPreparation)));
  check('JAMAIS « projet injoignable »', !/injoignable/.test(texte(enPreparation)));

  const enSignature = presenter({
    document: document({ status: 'PENDING_SIGNATURE', downloadAvailable: false }),
  });
  check('signature en cours reconnue', enSignature.state === 'PENDING_SIGNATURE');
  check('…et dite comme telle', /en cours de signature/.test(enSignature.message));
  check('…sans accuser le réseau', !/rompu|injoignable/.test(texte(enSignature)));
}

section('CAS 4 — projet ONLINE + fichier absent (LE CAS OBSERVÉ)');
{
  // Charge utile RÉELLE de SB Auto quand la base référence un document que le
  // stockage n'a pas : `available: true`, `downloadAvailable: false`.
  const p = presenter({
    document: document({ status: 'UNAVAILABLE', available: true, downloadAvailable: false }),
  });
  check('état = fichier manquant', p.state === 'FILE_MISSING');
  check('libellé sans ambiguïté', p.title === 'Fichier indisponible');
  check('le message parle du FICHIER, pas du lien',
    p.message === 'Le document contractuel est référencé, mais le fichier est actuellement indisponible sur le projet.');
  check('aucun bouton', p.showDownload === false);
  check('la raison est de stockage', /introuvable sur le stockage/.test(p.downloadDisabledReason));
  check('JAMAIS « le lien avec le projet est rompu »', !/lien.*rompu/.test(texte(p)));
  check('JAMAIS « retour du site »', !/retour du site/.test(texte(p)));
  check('les actions contractuelles restent possibles (le projet répond)',
    p.showRemoteActions === true);
  check('…et ce n’est pas présenté comme de l’histoire', p.isHistorical === false);
}

section('CAS 5 — projet OFFLINE / STALE + dernier document connu');
{
  for (const connection of ['OFFLINE', 'STALE']) {
    const p = presenter({ freshness: fraicheur({ connection, isBusinessDataFresh: false }) });
    check(`${connection} → dernier état connu`, p.state === 'LAST_KNOWN_OFFLINE');
    check(`${connection} → le libellé le préfixe`, p.title.startsWith('Dernier état connu :'));
    check(`${connection} → ICI, l’injoignabilité est légitime`, /injoignable/.test(p.message));
    check(`${connection} → téléchargement masqué`, p.showDownload === false);
    check(`${connection} → actions distantes masquées`, p.showRemoteActions === false);
    check(`${connection} → c’est de l’histoire`, p.isHistorical === true);
  }

  const nonRelie = presenter({ paired: false, freshness: fraicheur({ connection: 'OFFLINE' }) });
  check('projet non relié → le dit sans parler de panne', /n’est pas relié/.test(nonRelie.message));
}

section('CAS 6 — environnement / génération précédents');
{
  const env = presenter({ freshness: fraicheur({ isEnvironmentMismatch: true, runtimeEnvironment: 'TEST', isBusinessDataFresh: false }) });
  check('environnement divergent reconnu', env.state === 'LAST_KNOWN_PREVIOUS_GENERATION');
  check('…annoncé comme tel', /environnement précédent/.test(env.message));
  check('…aucun bouton distant', env.showDownload === false && env.showRemoteActions === false);
  check('…présenté comme dernier état connu', env.isHistorical === true && env.title.startsWith('Dernier état connu'));

  const gen = presenter({ freshness: fraicheur({ isGenerationMismatch: true, isBusinessDataFresh: false }) });
  check('génération divergente reconnue', gen.state === 'LAST_KNOWN_PREVIOUS_GENERATION');
  check('…annoncée comme telle', /génération précédente/.test(gen.message));
  check('…et prime même si le projet répond', gen.showRemoteActions === false);
}

section('CAS 7 — l’état du CONTRAT n’écrase jamais l’état du DOCUMENT');
{
  const statuts = ['DRAFT', 'INACTIVE', 'ACTIVATION_IN_PROGRESS', 'ACTIVE',
    'CANCEL_AT_PERIOD_END', 'ENDED', 'CANCELLED', 'FAILED'];
  const documents = [
    document(),
    document({ status: 'NONE', available: false, downloadAvailable: false }),
    document({ status: 'UNAVAILABLE', downloadAvailable: false }),
    document({ status: 'PENDING_SIGNATURE', downloadAvailable: false }),
    document({ signatureRequired: false, signatureStatus: 'NOT_REQUIRED' }),
  ];
  let identique = true;
  for (const d of documents) {
    const reference = getContractDocumentPresentation({
      document: d, contract: { status: statuts[0] }, freshness: fraicheur(), paired: true,
    });
    for (const s of statuts.slice(1)) {
      const autre = getContractDocumentPresentation({
        document: d, contract: { status: s }, freshness: fraicheur(), paired: true,
      });
      try { assert.deepStrictEqual(autre, reference); } catch { identique = false; }
    }
  }
  check('les 8 statuts de contrat × 5 documents → présentation inchangée', identique);

  // Activation en cours + frais dus + document signé : les deux coexistent.
  const activation = presenter({ contract: { status: 'ACTIVATION_IN_PROGRESS' } });
  check('activation en cours + document signé → téléchargeable', activation.showDownload === true);
  check('…et le document reste « Signé »', activation.title === 'Signé');

  // Activation en cours + aucun document : pas de contradiction non plus.
  const sansDoc = presenter({
    contract: { status: 'ACTIVATION_IN_PROGRESS' },
    document: document({ status: 'NONE', available: false, downloadAvailable: false }),
  });
  check('activation en cours + aucun document → « Non généré »', sansDoc.title === 'Non généré');
  check('…sans phrase de connexion', !/rompu|injoignable/.test(texte(sansDoc)));
}

section('CAS 8 — signature non requise');
{
  const p = presenter({ document: document({ status: 'GENERATED', signatureRequired: false, signatureStatus: 'NOT_REQUIRED' }) });
  check('libellé « Signature non requise »', p.title === 'Signature non requise');
  check('téléchargeable', p.showDownload === true);
  check('ton positif', p.badgeTone === 'ok');
  check('JAMAIS « en attente de signature »', !/attente de signature/.test(texte(p)));
}

section('CAS 9 — contrat terminé + document historique');
{
  const p = presenter({ contract: { status: 'ENDED' } });
  check('le document reste téléchargeable', p.showDownload === true);
  check('…et n’est pas requalifié par la fin du contrat', p.title === 'Signé');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('GARDE — aucune contradiction possible, sur AUCUNE combinaison');
{
  /**
   * On énumère la matrice entière et on refuse toute présentation qui parle de
   * connexion rompue alors que la connexion est vivante — et l'inverse.
   */
  const CONNEXIONS = ['ONLINE', 'STALE', 'OFFLINE'];
  const STATUTS_DOC = ['NONE', 'GENERATED', 'PENDING_SIGNATURE', 'SIGNED', 'UNAVAILABLE'];
  const STATUTS_CONTRAT = ['DRAFT', 'INACTIVE', 'ACTIVATION_IN_PROGRESS', 'ACTIVE',
    'CANCEL_AT_PERIOD_END', 'ENDED', 'CANCELLED', 'FAILED'];

  const MOTS_CONNEXION = /rompu|injoignable|retour du site|hors ligne/;
  const contradictions = [];
  let combinaisons = 0;

  for (const connection of CONNEXIONS) {
    for (const statut of STATUTS_DOC) {
      for (const contrat of STATUTS_CONTRAT) {
        for (const telechargeable of [true, false]) {
          for (const envKo of [false, true]) {
            for (const genKo of [false, true]) {
              for (const relie of [true, false]) {
                for (const signature of [true, false]) {
                  combinaisons += 1;
                  const f = fraicheur({
                    connection,
                    isEnvironmentMismatch: envKo,
                    isGenerationMismatch: genKo,
                    isBusinessDataFresh: connection === 'ONLINE' && !envKo && !genKo,
                  });
                  const d = document({
                    status: statut,
                    available: statut !== 'NONE',
                    downloadAvailable: telechargeable && statut !== 'NONE' && statut !== 'UNAVAILABLE',
                    signatureRequired: signature,
                    signatureStatus: signature ? 'PENDING' : 'NOT_REQUIRED',
                  });
                  const p = getContractDocumentPresentation({
                    document: d, contract: { status: contrat }, freshness: f, paired: relie,
                  });
                  const t = texte(p);
                  const vivant = relie && connection === 'ONLINE';
                  const cas = `${connection}/${statut}/${contrat}/dl=${telechargeable}/env=${envKo}/gen=${genKo}/relie=${relie}`;

                  // 1. Projet vivant + données du bon monde : jamais un mot de panne réseau.
                  if (vivant && !envKo && !genKo && MOTS_CONNEXION.test(t)) {
                    contradictions.push(`[connexion vivante mais texte de panne] ${cas} → ${t}`);
                  }
                  // 2. Aucun document : ne jamais prétendre qu'il existe.
                  if (statut === 'NONE' && /le document existe|référencé/.test(t)) {
                    contradictions.push(`[aucun document mais texte d'existence] ${cas} → ${t}`);
                  }
                  // 3. Signature non requise : jamais « en attente de signature ».
                  if (!signature && /attente de signature/.test(t)) {
                    contradictions.push(`[signature non requise mais attente annoncée] ${cas} → ${t}`);
                  }
                  // 4. Bouton proposé UNIQUEMENT si tout concorde.
                  const devraitTelecharger = vivant && !envKo && !genKo
                    && statut !== 'NONE' && statut !== 'UNAVAILABLE' && telechargeable;
                  if (p.showDownload !== devraitTelecharger) {
                    contradictions.push(`[bouton incohérent] ${cas} → showDownload=${p.showDownload}`);
                  }
                  // 5. Actions distantes : jamais sur des données d'un autre monde.
                  if ((envKo || genKo || !vivant) && p.showRemoteActions) {
                    contradictions.push(`[actions distantes sur données douteuses] ${cas}`);
                  }
                  // 6. Un empêchement doit toujours être expliqué (sauf « rien à télécharger »).
                  if (!p.showDownload && statut !== 'NONE' && !p.downloadDisabledReason) {
                    contradictions.push(`[bouton masqué sans raison affichée] ${cas}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  for (const c of contradictions.slice(0, 10)) console.error(`      → ${c}`);
  check(`aucune contradiction sur ${combinaisons} combinaisons`, contradictions.length === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('LA CAPTURE — la réponse API exacte qui a produit l’écran fautif');
{
  // Projet connecté, contact à l'instant, contrat en activation, frais dus,
  // document référencé mais fichier absent du stockage.
  const p = getContractDocumentPresentation({
    document: {
      available: true,
      status: 'UNAVAILABLE',
      downloadAvailable: false,
      filename: 'contrat-CTR-2026-0001.pdf',
      signatureRequired: true,
      signatureStatus: 'NONE',
    },
    contract: { status: 'ACTIVATION_IN_PROGRESS' },
    freshness: fraicheur(),
    paired: true,
  });
  check('l’écran ne parle plus de lien rompu', !/rompu/.test(texte(p)));
  check('…ni de retour du site', !/retour du site/.test(texte(p)));
  check('il nomme la vraie cause', p.state === 'FILE_MISSING');
  check('le texte attendu est celui affiché',
    p.message === 'Le document contractuel est référencé, mais le fichier est actuellement indisponible sur le projet.');
  check('aucun bouton de téléchargement', p.showDownload === false);
  check('les actions contractuelles restent offertes', p.showRemoteActions === true);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
