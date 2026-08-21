// LE RETRAIT DE L'ANCIEN FOURNISSEUR — prouvé par l'ABSENCE et par le REFUS.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md, lot 8.
//
// ══ CE QU'UNE SUITE PEUT PROUVER ICI, ET CE QU'ELLE NE PEUT PAS ═════════════
//
// Elle ne peut pas prouver que personne n'appellera jamais l'ancien
// fournisseur : il n'y a plus de code pour ça, et l'absence d'un fichier ne
// s'éprouve qu'en la CHERCHANT. C'est exactement ce que fait cette suite.
//
// Elle défend trois choses, dans cet ordre d'importance :
//
//   1. Plus une ligne du Panel ne parle HTTP à l'ancien fournisseur. Pas de
//      transport, pas d'hôte, pas de lecture de sa clé dans un adaptateur.
//   2. Le domaine reste COMPLET : chaque acte est servi par chaque exécutant,
//      sinon une demande de 2025 lèverait une exception nue au pire moment.
//   3. Le refus est LISIBLE et dit où regarder — parce qu'un contrat signé
//      chez lui existe toujours, et que quelqu'un le cherchera.
//
// Aucun réseau, aucune base.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const RACINE = path.resolve(fileURLToPath(new URL('../backend/src/', import.meta.url)));
const lire = (rel) => readFileSync(path.join(RACINE, rel), 'utf8');

const retire = await import('../backend/src/services/integratedApi/signature/retiredSignatureProvider.js');
const adaptateurs = await import('../backend/src/services/capabilities/providerAdapters.js');
const registre = await import('../backend/src/services/capabilities/capabilityRegistry.js');

/* ══════════════════════════════════════════════════════════════════════════ */
section('1 · LE CHEMIN D’EXÉCUTION N’EXISTE PLUS');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  /**
   * On cherche les FICHIERS, pas le mot. Un transport supprimé puis rétabli
   * « le temps de dépanner » est exactement le mode de retour qu'on redoute :
   * il n'a l'air de rien, et il ramène la clé avec lui.
   */
  for (const disparu of [
    'services/integratedApi/yousign/yousignTransport.js',
    'services/integratedApi/yousign/yousignAdapters.js',
  ]) {
    check(`${disparu.split('/').pop()} n’existe plus`, !existsSync(path.join(RACINE, disparu)));
  }

  const dossier = path.join(RACINE, 'services/integratedApi/yousign');
  const restes = existsSync(dossier) ? readdirSync(dossier) : [];
  check('…et le dossier ne contient plus aucun exécutant',
    restes.filter((f) => f.endsWith('.js')).length === 0);

  /**
   * AUCUN HÔTE DU FOURNISSEUR DANS UN CHEMIN D'EXÉCUTION.
   *
   * Le registre des fournisseurs en porte encore — c'est sa raison d'être, et
   * le lot suivant s'en occupe. Ce qui ne doit plus exister, c'est un hôte
   * dans du code qui APPELLE.
   */
  const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const executants = [
    'services/capabilities/providerAdapters.js',
    'services/integratedApi/signature/retiredSignatureProvider.js',
    'services/integratedApi/opensign/openSignTransport.js',
    'services/integratedApi/opensign/openSignAdapters.js',
  ];
  const fautifs = executants.filter((rel) => /yousign\.(app|com)/i.test(sansCommentaires(lire(rel))));
  check('aucun hôte du fournisseur dans un exécutant', fautifs.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2 · LE DOMAINE RESTE COMPLET — chaque acte, chaque exécutant');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const actes = registre.listCapabilityDefinitions()
    .map((d) => d.code)
    .filter((c) => c.startsWith('signature.'));

  check('les six actes de signature sont déclarés', actes.length === 6);
  check('le fournisseur retiré les sert TOUS',
    actes.every((c) => typeof retire.RETIRED_SIGNATURE_ADAPTERS[c] === 'function'));
  check('…et rien de plus', Object.keys(retire.RETIRED_SIGNATURE_ADAPTERS).length === actes.length);
  check('la passerelle sert chaque acte', actes.every((c) => adaptateurs.hasAdapter(c)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3 · IL RÉPOND, ET IL RÉPOND NON');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const attendus = {
    'signature.request.open': /relancez/i,
    'signature.request.retrieve': /état enregistré/i,
    'signature.signer.retrieve': /expiré/i,
    'signature.document.download': /archivé dans le projet/i,
    'signature.certificate.download': /espace de son compte/i,
    'signature.request.cancel': /close depuis son espace/i,
  };

  for (const [code, attendu] of Object.entries(attendus)) {
    let refus = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      await retire.RETIRED_SIGNATURE_ADAPTERS[code]({ input: { signatureRequestId: 'ancienne-000001' } });
    } catch (e) { refus = e; }
    check(`« ${code} » refuse`, refus !== null);
    check('…avec un motif stable', refus?.details?.reason === 'SIGNATURE_PROVIDER_RETIRED');
    check('…et un conseil propre à l’acte', attendu.test(String(refus?.message ?? '')));
    /**
     * LE REFUS PORTE L'IDENTIFIANT DEMANDÉ.
     *
     * Sans lui, un exploitant qui reçoit ce message ne sait pas DE QUELLE
     * demande on parle — et le seul endroit où la retrouver est justement ce
     * qu'il cherchait.
     */
    check('…et l’identifiant de la demande concernée',
      refus?.details?.signatureRequestId === 'ancienne-000001');
  }

  /**
   * AUCUNE CREDENTIAL N'EST LUE — c'est ce qui distingue un retrait d'un
   * sursis. On appelle SANS en fournir : si un adaptateur en attendait une, il
   * lèverait autre chose que le refus attendu.
   */
  let sansCredential = null;
  try {
    await retire.RETIRED_SIGNATURE_ADAPTERS['signature.request.open']({});
  } catch (e) { sansCredential = e; }
  check('il refuse même sans credential — il n’en lit aucune',
    sansCredential?.details?.reason === 'SIGNATURE_PROVIDER_RETIRED');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4 · UNE NOUVELLE DEMANDE NE PEUT PAS TOMBER SUR LUI');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const ouverture = registre.getCapabilityDefinition('signature.request.open');
  check('l’ouverture est servie par le fournisseur ACTIF', ouverture.provider === 'OPENSIGN');
  /**
   * ET ELLE N'A AUCUN AIGUILLAGE. Une nouvelle demande n'a pas d'histoire :
   * elle part chez l'actif, et nulle part ailleurs. Un `resolveProvider` ici
   * laisserait croire le contraire — et rendrait pensable qu'elle parte chez
   * un fournisseur qui n'existe plus.
   */
  check('…sans aiguillage possible', ouverture.resolveProvider === null);

  const routage = await import('../backend/src/services/integratedApi/signature/signatureProviderRouting.js');
  check('le fournisseur actif reste OPENSIGN', routage.ACTIVE_SIGNATURE_PROVIDER === 'OPENSIGN');
  check('…et le retiré est bien celui que l’aiguilleur nomme « historique »',
    routage.LEGACY_SIGNATURE_PROVIDER === retire.RETIRED_SIGNATURE_PROVIDER);
}

finish();
