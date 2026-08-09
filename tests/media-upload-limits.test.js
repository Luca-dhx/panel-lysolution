/**
 * MEDIA_UPLOAD_LIMITS_DO_NOT_DIVERGE — les couches doivent s'accorder.
 *
 * ══ LE DÉFAUT QUE CE CONTRÔLE FERME ═════════════════════════════════════════
 *
 * Trois couches décidaient de la taille d'un import, sans se connaître :
 *
 *   · `multer`          12 Mo, écrit en dur dans un middleware ;
 *   · le vhost Nginx    RIEN — donc le défaut du serveur, 1 Mo ;
 *   · le frontend       aucune limite.
 *
 * Un logo de 3 Mo passait en local et repartait en **413 derrière Nginx**. Le
 * même fichier, accepté ici, refusé là — et l'écart de 12× n'était écrit nulle
 * part. Aucun test ne pouvait l'attraper : il n'existait aucun endroit où les
 * deux nombres se rencontraient.
 *
 * Ce fichier EST cet endroit.
 */
import { check, finish, section } from './helpers/harness.js';

const politiquePanel = await import('../backend/src/services/upload/mediaPolicy.js');
const profilPanel = await import('../backend/src/deployment-engine/config/project.profile.js');
const nginxPanel = await import('../backend/src/deployment-engine/nginx.js');

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA POLITIQUE EST COHÉRENTE AVEC ELLE-MÊME');
{
  const politiques = Object.entries(politiquePanel.MEDIA_POLICIES);
  check('au moins un rôle est décrit', politiques.length > 0);
  check('chaque rôle borne son entrée',
    politiques.every(([, p]) => Number.isInteger(p.maxInputBytes) && p.maxInputBytes > 0));
  check('le plafond est bien le maximum de la table',
    politiquePanel.MAX_INPUT_BYTES
      === Math.max(...politiques.map(([, p]) => p.maxInputBytes)));

  /**
   * LA MARGE MULTIPART N'EST PAS UN LUXE.
   *
   * Un envoi `multipart/form-data` transporte frontières, en-têtes de partie et
   * nom de fichier en plus du contenu. Sans marge, Nginx refuserait — en 413 nu,
   * sans code métier — un fichier que l'application accepte.
   */
  check('la limite HTTP dépasse le plafond applicatif',
    politiquePanel.HTTP_BODY_LIMIT_BYTES > politiquePanel.MAX_INPUT_BYTES);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MEDIA_UPLOAD_LIMITS_DO_NOT_DIVERGE — Nginx ≥ application');
{
  const nginxMb = profilPanel.HTTP_MAX_BODY_MB;
  const requisMb = politiquePanel.HTTP_BODY_LIMIT_MB;
  console.log(`    politique : ${requisMb} Mo requis · profil Nginx : ${nginxMb} Mo`);

  check(`le vhost laisse passer au moins ce que l’application accepte (${nginxMb} >= ${requisMb})`,
    nginxMb >= requisMb);

  /**
   * ET PAS « ILLIMITÉ ». `client_max_body_size 0` désactive la vérification :
   * n'importe quel corps serait bufferisé avant d'atteindre Node. La borne doit
   * rester une borne.
   */
  check('…sans jamais être illimité', nginxMb > 0 && nginxMb <= 100);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE VHOST GÉNÉRÉ PORTE RÉELLEMENT LA DIRECTIVE');
{
  /**
   * On ne relit pas la constante : on rend le fichier de configuration et on
   * cherche la ligne. C'est le seul contrôle qui prouve que la valeur ARRIVE
   * jusqu'à Nginx — une constante bien définie mais jamais écrite dans le
   * vhost est exactement la situation qu'on répare.
   */
  const target = {
    name: 'Test', host: 'exemple.test', environment: 'PROD',
    domain: 'exemple.test', url: 'https://exemple.test',
  };
  const opts = { backendPort: 4000 };

  let https = '';
  let http = '';
  try { https = nginxPanel.renderNginxConfig(target, opts); } catch { https = ''; }
  try { http = nginxPanel.renderNginxHttpOnly(target, opts); } catch { http = ''; }

  const attendu = `client_max_body_size ${profilPanel.HTTP_MAX_BODY_MB}m;`;
  check('le vhost HTTPS porte la directive', https.includes(attendu));
  check('le vhost HTTP (pré-certificat) la porte aussi', http.includes(attendu));
  check('…et le proxy /api est bien présent dans le vhost HTTPS',
    https.includes('proxy_pass'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PARITÉ AVEC LE PROJET MODÈLE — même forme, mêmes garanties');
{
  /**
   * Les TYPES diffèrent légitimement — le Panel publie l'identité du
   * développeur, un projet celle de son client. Ce qui ne doit PAS diverger,
   * c'est la mécanique : mêmes clés, même plafond de transport, même marge.
   */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const racineSb = path.resolve('..', 'SB Auto 06');

  if (!fs.existsSync(racineSb)) {
    console.log('    SKIP : projet modèle absent du workspace.');
  } else {
    const politiqueSb = await import(
      pathToFileURL(path.join(racineSb, 'backend/src/services/media/mediaPolicy.js')).href
    );
    const profilSb = await import(
      pathToFileURL(path.join(racineSb, 'backend/src/deployment-engine/config/project.profile.js')).href
    );

    check('le projet modèle borne lui aussi son entrée',
      Number.isInteger(politiqueSb.MAX_INPUT_BYTES) && politiqueSb.MAX_INPUT_BYTES > 0);
    check('…et son vhost couvre sa propre politique',
      profilSb.HTTP_MAX_BODY_MB >= politiqueSb.HTTP_BODY_LIMIT_MB);
    check('les deux dépôts appliquent la MÊME marge multipart',
      politiqueSb.HTTP_BODY_LIMIT_BYTES - politiqueSb.MAX_INPUT_BYTES
        === politiquePanel.HTTP_BODY_LIMIT_BYTES - politiquePanel.MAX_INPUT_BYTES);
    check('…et acceptent les mêmes formats d’image',
      JSON.stringify([...politiqueSb.ACCEPTED_IMAGE_FORMATS].sort())
        === JSON.stringify([...politiquePanel.ACCEPTED_IMAGE_FORMATS].sort()));

    /**
     * ── CE QU'ON N'EXIGE PAS, ET POURQUOI ─────────────────────────────────
     *
     * Les deux plafonds n'ont AUCUNE raison d'être égaux. Le relais média ne
     * traverse jamais les dépôts : une instance de Panel relaie vers une autre
     * instance de Panel, un projet vers l'autorité de son propre parc. Les
     * deux chaînes sont donc homogènes par construction.
     *
     * Le Panel plafonne à 12 Mo parce qu'il ne publie que de la marque ; un
     * projet monte à 15 Mo parce qu'il publie des bannières et des galeries
     * photo. Aligner les deux reviendrait à gonfler une limite pour un type de
     * média qui n'existe pas — un chiffre rond qui ne décrirait plus rien.
     *
     * L'invariant RÉEL est vérifié juste au-dessus : dans CHAQUE dépôt, le
     * vhost couvre sa propre politique. C'est cela qui manquait.
     */
    check('chaque dépôt reste cohérent avec LUI-MÊME, sans imposer un chiffre commun',
      profilSb.HTTP_MAX_BODY_MB >= politiqueSb.HTTP_BODY_LIMIT_MB
      && profilPanel.HTTP_MAX_BODY_MB >= politiquePanel.HTTP_BODY_LIMIT_MB);
  }
}

finish();
