// LE FAIT DE SIGNATURE QUI TRAVERSE LE PONT — sa forme, et pourquoi elle tue.
//
// ══ CE QUE CE FICHIER GARDE ═════════════════════════════════════════════════
//
// `dispatchSignatureEvent` est la charnière du chemin retour : Yousign parle au
// Panel, le Panel parle au projet. Deux détails de FORME décident si le fait
// arrive ou disparaît, et aucun des deux ne produit d'erreur visible quand il
// est faux. C'est précisément pour cela qu'ils méritent un fichier.
//
// ── 1. `entityId` DOIT ÊTRE UN UUID ─────────────────────────────────────────
//
// Le contrat de pont l'impose. Une référence de contrat de projet n'en est pas
// une — c'est un ObjectId de 24 hexadécimaux. L'émettre telle quelle fait
// rejeter la PAGE ENTIÈRE en `BRIDGE_INVALID_PAYLOAD` : aucun événement de
// signature n'atteint jamais le projet, et le Panel croit avoir livré. C'est
// le défaut qu'avait connu Brevo en L8.4, et il ne se voit qu'ici.
//
// ── 2. LE SIGNATAIRE DOIT VOYAGER ───────────────────────────────────────────
//
// Sans `signerId`, le projet apprend qu'« une » signature a eu lieu sans savoir
// laquelle. Il ne peut plus horodater séparément le développeur et le client,
// ni ouvrir le contrat à la contresignature au bon moment : le parcours
// s'arrête à mi-chemin, sans erreur, sans trace.
//
// ══ CE QU'ON N'ÉPROUVE PAS ICI ══════════════════════════════════════════════
//
// L'acheminement complet (appartenance, fermeture du lien, journal durable) vit
// dans les tests de bout en bout. Ce fichier tient les invariants de FORME, qui
// sont les seuls à pouvoir échouer en silence.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const dispatch = await import('../backend/src/services/webhooks/signatureEventDispatch.js');
const { syncChangeSchema } = await import('../backend/src/bridge/bridgeContract.js');

section('1 · Le vocabulaire du fournisseur devient un verbe métier');
{
  const attendus = [
    ['signer.done', 'SIGNATURE_SIGNER_SIGNED'],
    ['signature_request.signer.done', 'SIGNATURE_SIGNER_SIGNED'],
    ['signature_request.done', 'SIGNATURE_COMPLETED'],
    ['signature_request.declined', 'SIGNATURE_FAILED'],
    ['signature_request.expired', 'SIGNATURE_FAILED'],
    ['signature_request.canceled', 'SIGNATURE_FAILED'],
    ['signer.declined', 'SIGNATURE_FAILED'],
  ];
  for (const [brut, verbe] of attendus) {
    check(`« ${brut} » → ${verbe}`, dispatch.toBusinessEvent(brut) === verbe);
  }

  /**
   * UN VERBE INCONNU N'EST PAS PROJETÉ. Le traduire au jugé enverrait au projet
   * un fait qu'il appliquerait sans que personne n'ait décidé de sa sémantique.
   */
  for (const inconnu of ['signature_request.reminded', 'contact.created', '', null]) {
    check(`« ${inconnu} » n’est pas projeté`, dispatch.toBusinessEvent(inconnu) === null);
  }
}

section('2 · L’identité d’entité est un UUID — et le contrat la valide');
{
  /**
   * L'assertion décisive : on soumet l'identité produite au SCHÉMA RÉEL du
   * pont, pas à une expression régulière recopiée. Une garde recopiée dériverait
   * du contrat sans qu'on le sache — et c'est le contrat qui rejette en prod.
   */
  const ref = '6a7ed0ad5e92dbc04dc42e64'; // un ObjectId de projet, cas nominal
  const entityId = dispatch.toBridgeEntityId(ref);

  const ecriture = {
    writeId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    entityType: 'SIGNATURE_EVENT',
    entityId,
    deleted: false,
    payload: { event: 'SIGNATURE_COMPLETED', contractRef: ref },
    modifiedAt: new Date().toISOString(),
    emitter: 'PANEL',
  };
  const verdict = syncChangeSchema.safeParse(ecriture);
  check('l’écriture produite passe le schéma du pont', verdict.success === true);

  /** Et la référence brute, elle, ne passerait PAS : le danger était réel. */
  const brut = syncChangeSchema.safeParse({ ...ecriture, entityId: ref });
  check('…alors que la référence métier brute serait rejetée', brut.success === false);

  /**
   * DÉTERMINISTE. Deux faits concernant la même demande doivent porter la même
   * identité d'entité : c'est ce qui rend cohérents l'anti-écho et l'idempotence
   * côté projet. Un tirage aléatoire par événement en aurait fait des entités
   * distinctes, et un rejeu serait passé pour une nouveauté.
   */
  check('deux appels rendent la même identité', dispatch.toBridgeEntityId(ref) === entityId);
  check('…et deux contrats en rendent deux différentes',
    dispatch.toBridgeEntityId('6a7ed0ad5e92dbc04dc42e65') !== entityId);

  /** La référence métier reste lisible là où l'applicateur la cherche. */
  check('la référence métier n’est pas perdue : elle est dans la charge utile',
    ecriture.payload.contractRef === ref);

  /** Aucune valeur d'entrée ne doit pouvoir produire une identité invalide. */
  for (const graine of ['', 'x', '../../etc/passwd', 'a'.repeat(500), '🙂']) {
    const id = dispatch.toBridgeEntityId(graine);
    const ok = syncChangeSchema.safeParse({ ...ecriture, entityId: id }).success;
    check(`identité valide pour une graine « ${String(graine).slice(0, 12)} »`, ok);
  }
}

section('3 · Le signataire voyage — opaque, et seulement quand il existe');
{
  /**
   * On éprouve l'extraction sur les TROIS formes que Yousign emploie selon la
   * version d'API et le type d'événement. Une seule reconnue aurait suffi à
   * faire passer le test tout en perdant l'attribution en production.
   */
  const formes = [
    { data: { signer: { id: 'sig-1' } } },
    { data: { signer_id: 'sig-1' } },
    { signer: { id: 'sig-1' } },
  ];
  for (const [i, corps] of formes.entries()) {
    check(`forme ${i + 1} reconnue`, dispatch.extractSignerId(corps) === 'sig-1');
  }

  /**
   * ABSENT PLUTÔT QUE VIDE. Un `signerId` valant `''` serait comparé aux
   * identifiants du contrat et n'en désignerait aucun : le projet croirait
   * avoir reçu une attribution, et n'horodaterait personne. `null` dit la
   * vérité — « ce fait ne nomme pas de signataire » — et l'applicateur sait
   * alors avancer le statut sans attribuer.
   */
  for (const vide of [{}, { data: {} }, { data: { signer: {} } }, { data: { signer_id: '  ' } }, null]) {
    check(`absence rendue explicitement (${JSON.stringify(vide)})`,
      dispatch.extractSignerId(vide) === null);
  }

  /**
   * CE QUI NE DOIT PAS VOYAGER. La charge utile projetée est minimale par
   * construction : ni nom, ni adresse, ni document. Les recopier ferait du
   * journal durable du Panel un second exemplaire de données personnelles à
   * protéger, à purger et à justifier.
   */
  const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
    new URL('../backend/src/services/webhooks/signatureEventDispatch.js', import.meta.url),
    'utf8',
  ));
  const charge = source.slice(source.indexOf('payload: {'), source.indexOf('audience:'));
  for (const interdit of ['email', 'firstName', 'lastName', 'phone', 'documentBase64']) {
    check(`« ${interdit} » ne traverse pas le pont`, !charge.includes(interdit));
  }
  check('le signataire, lui, traverse', charge.includes('signerId'));
}

finish();
