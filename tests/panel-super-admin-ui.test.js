/**
 * L'ÉCRAN SOUVERAIN — LOT SUPER_ADMIN.
 *
 * ══ CE QUE CETTE SUITE GARDE, ET POURQUOI CE N'EST PAS DU DÉCOR ═════════════
 *
 * Un écran ne protège rien : le serveur décide, et la suite `panel-super-admin`
 * le prouve. Ce qui se garde ici est l'ACCORD entre les deux, et il a deux
 * façons de se rompre — chacune coûteuse à sa manière :
 *
 *   · un bouton VISIBLE que l'API refuse → une promesse non tenue, et un
 *     utilisateur qui croit à une panne ;
 *   · une page INVISIBLE que l'API autorise → un droit inutilisable, et
 *     personne pour s'en apercevoir. C'est le défaut exact qu'un troisième
 *     rôle introduit : `role === 'DEV'` n'est plus une hiérarchie, et le rôle
 *     le PLUS élevé se retrouve devant une application vide.
 *
 * Les contrôles de source sont ici les bons outils : ce qu'il faut vérifier est
 * qu'AUCUNE comparaison de rôle ne subsiste hors de l'échelle, et c'est une
 * propriété du texte, pas du comportement. L'échelle elle-même, elle, est
 * EXÉCUTÉE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

import { check, finish, section } from './helpers/harness.js';

register('./helpers/frontendLoader.mjs', import.meta.url);

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (relatif) => fs.readFileSync(path.join(racine, relatif), 'utf8');

const page = lire('frontend/src/pages/PanelUsersPage.tsx');
const modal = lire('frontend/src/components/Modal.tsx');
const garde = lire('frontend/src/auth/RequireDev.tsx');
const nav = lire('frontend/src/config/nav.ts');
const types = lire('frontend/src/types.ts');
const api = lire('frontend/src/lib/api.ts');
const app = lire('frontend/src/App.tsx');

/* ══════════════════════════════════════════════════════════════════════════
   1. L'ÉCHELLE, EXÉCUTÉE.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Le frontend porte la MÊME échelle que le serveur');
{
  const roles = await import('@/auth/roles');
  const serveur = await import('../backend/src/services/auth/panelRoles.js');

  for (const role of serveur.PANEL_ROLE_VALUES) {
    check(`« ${role} » — capacités développeur identiques des deux côtés`,
      roles.isPanelDeveloper(role) === serveur.isPanelDeveloper(role));
    check(`« ${role} » — souveraineté identique des deux côtés`,
      roles.administersPanelUsers(role) === serveur.administersPanelUsers(role));
  }

  check('le type Role connaît les trois valeurs',
    serveur.PANEL_ROLE_VALUES.every((r) => types.includes(`'${r}'`)));
  check('…et chacun a un libellé lisible',
    serveur.PANEL_ROLE_VALUES.every((r) => Boolean(roles.ROLE_LABEL[r])));
  check('SUPER_ADMIN s’écrit « Super Admin » à l’écran',
    roles.ROLE_LABEL.SUPER_ADMIN === 'Super Admin');
  check('…et l’ordre proposé décrit une échelle, pas un alphabet',
    roles.ROLE_ORDER[0] === 'SUPER_ADMIN' && roles.ROLE_ORDER.at(-1) === 'ADMIN');
  check('chaque rôle explique ce qu’il DONNE',
    serveur.PANEL_ROLE_VALUES.every((r) => (roles.ROLE_HINT[r] ?? '').length > 40));
}

/* ══════════════════════════════════════════════════════════════════════════
   2. PLUS AUCUNE COMPARAISON DE RÔLE ÉGARÉE.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · L’échelle n’est comparée qu’à un seul endroit');
{
  /**
   * LE BALAYAGE EXHAUSTIF QUE LE LOT RÉCLAME.
   *
   * On cherche les comparaisons directes au rôle DEV — `role === 'DEV'`,
   * `role !== 'DEV'` — partout dans le frontend. Ce sont EXACTEMENT celles qui
   * cassent en silence à l'arrivée d'un troisième rôle : elles excluent
   * SUPER_ADMIN sans erreur, sans message, sans rien à voir dans un journal.
   * Elles sont TOLÉRÉES dans `auth/roles.ts`, qui EST l'échelle.
   *
   * ── DEUX PRÉCISIONS QUI ÉVITENT DE FAUSSES ALERTES ─────────────────────────
   *
   * · les COMMENTAIRES sont retirés avant l'examen — plusieurs expliquent
   *   précisément la comparaison qu'on vient de supprimer, et une garde qui
   *   punirait sa propre documentation pousserait à ne plus rien expliquer ;
   * · seul `'DEV'` est traqué. Une comparaison à `'SUPER_ADMIN'` peut être
   *   parfaitement légitime — choisir la couleur d'un badge n'est pas décider
   *   d'une capacité, et l'interdire n'apporterait rien.
   */
  const sansCommentaires = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const sources = [];
  const parcourir = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) parcourir(complet);
      else if (/\.tsx?$/.test(entree.name)) sources.push(complet);
    }
  };
  parcourir(path.join(racine, 'frontend/src'));

  const echelle = path.join(racine, 'frontend/src/auth/roles.ts');
  const egares = sources
    .filter((f) => f !== echelle)
    .filter((f) => /role\s*[!=]==\s*'DEV'/.test(sansCommentaires(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(racine, f));

  check(`aucune comparaison de rôle hors de l’échelle${egares.length ? ` — ${egares.join(', ')}` : ''}`,
    egares.length === 0);

  check('la garde de route consulte l’échelle',
    garde.includes("from '@/auth/roles'") && garde.includes('isPanelDeveloper(user?.role)'));
  check('…et n’est plus binaire',
    !/user\?\.role\s*!==\s*'DEV'/.test(sansCommentaires(garde)));
  check('le menu consulte l’échelle',
    nav.includes('isPanelDeveloper(role)')
    && !/role\s*===\s*'DEV'/.test(sansCommentaires(nav)));
  check('une garde souveraine existe pour les surfaces à venir',
    garde.includes('export function RequireSuperAdmin'));

  /**
   * SUPER_ADMIN VOIT TOUT CE QUE VOIT UN DEV — vérifié sur la vraie fonction,
   * et non sur sa source : c'est la seule façon de savoir qu'aucune entrée
   * n'est perdue en route.
   */
  const { navItemsFor, NAV_ITEMS } = await import('@/config/nav');
  const vusParDev = navItemsFor('DEV').map((i) => i.to);
  const vusParSuper = navItemsFor('SUPER_ADMIN').map((i) => i.to);
  const vusParAdmin = navItemsFor('ADMIN').map((i) => i.to);
  check('un SUPER_ADMIN voit TOUTES les entrées', vusParSuper.length === NAV_ITEMS.length);
  check('…y compris toutes celles d’un DEV', vusParDev.every((to) => vusParSuper.includes(to)));
  check('un ADMIN n’en voit AUCUNE technique',
    vusParAdmin.every((to) => !NAV_ITEMS.find((i) => i.to === to)?.devOnly));
  check('…et l’écran des comptes reste une surface technique',
    vusParSuper.includes('/panel-users') && !vusParAdmin.includes('/panel-users'));
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LA CRÉATION — et ce qu'elle ne demande jamais.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Créer un utilisateur, sans jamais toucher à un mot de passe');
{
  check('l’écran porte l’action', page.includes('Créer un utilisateur'));
  check('…réservée au souverain',
    page.includes('const souverain = administersPanelUsers(moi?.role)')
    && page.includes('souverain ? (\n          <button'));

  check('le formulaire demande nom, adresse et rôle',
    page.includes('Nom affiché') && page.includes('Adresse e-mail') && page.includes('ChoixRole'));

  /**
   * AUCUN CHAMP DE MOT DE PASSE, ET AUCUNE VALEUR AFFICHÉE.
   *
   * Les trois raccourcis habituels — mot de passe universel, temporaire
   * affiché, ou semé — font tous transiter un secret par un humain. Le
   * contrôle est par la NÉGATIVE parce que c'est la seule forme qui tienne :
   * on ne peut pas prouver qu'un écran est sûr, on peut prouver qu'il ne
   * contient pas la chose dangereuse.
   */
  check('aucun champ de mot de passe',
    !/type="password"/.test(page) && !/\bpassword\b/i.test(page));
  check('…et l’écran dit d’où viendra le mot de passe',
    page.includes('lien d’activation') && page.includes('choisira le sien'));
  check('le client n’envoie jamais de mot de passe à la création',
    api.includes('createPanelUser') && !/createPanelUser[\s\S]{0,240}password/i.test(api));

  check('un échec d’envoi est DIT, pas avalé',
    page.includes('invitation?.sent') && page.includes('n’est pas parti'));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LA MODIFICATION.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Modifier : quatre champs, et l’adresse en lecture seule');
{
  check('l’édition ouvre une modale', page.includes('Modifier ${edition.displayName}'));
  check('…qui porte les quatre champs administrables',
    page.includes('brouillon.displayName') && page.includes('brouillon.role')
    && page.includes('brouillon.enabled') && page.includes('brouillon.mode'));

  check('l’adresse est en LECTURE SEULE',
    page.includes('value={edition.email} readOnly disabled'));
  check('…et l’écran dit POURQUOI',
    page.includes('identifiant de connexion') && page.includes('parcours de vérification'));

  check('le mot de passe ne s’édite pas, il se re-délègue',
    page.includes('Envoyer un lien de réinitialisation')
    && page.includes('Renvoyer le lien d’activation'));

  /**
   * ON N'ENVOIE QUE CE QUI A CHANGÉ.
   *
   * Renvoyer l'objet entier réécrirait `grantedAt`/`grantedBy` à chaque
   * enregistrement : la trace « qui a ouvert ce client » désignerait alors la
   * dernière correction de nom.
   */
  check('seul le delta part au serveur',
    page.includes('const patch: Parameters<typeof api.updatePanelUser>[1] = {}')
    && page.includes('if (Object.keys(patch).length === 0)'));

  check('se modifier soi-même relit la session',
    page.includes('if (edition.userId === moi?.userId) await refresh()'));
  check('…et l’écran prévient que l’effet est immédiat',
    page.includes('Ceci est votre compte'));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LA SUPPRESSION — la confirmation EST la protection.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Supprimer demande une confirmation qui nomme la conséquence');
{
  check('aucune suppression sur simple clic',
    page.includes('onClick={() => setSuppression(user)}')
    && page.includes('Supprimer définitivement cet utilisateur ?'));
  check('la modale montre nom, adresse et rôle',
    page.includes('suppression.displayName') && page.includes('suppression.email')
    && page.includes('ROLE_LABEL[suppression.role]'));
  check('le CTA est destructif et explicite',
    page.includes('Supprimer l’utilisateur') && page.includes('btn btn-danger'));
  check('…et la modale se distingue visuellement', page.includes('<Modal\n          danger'));

  /** Le message exact que le lot réclame pour un souverain. */
  check('supprimer un Super Admin annonce la révocation immédiate',
    page.includes('Ce compte est Super Admin. Sa suppression révoquera immédiatement son')
    && page.includes('accès au Panel et aux projets fédérés'));
  check('…et prévient si c’est le DERNIER',
    page.includes('restantsSouverains <= 1')
    && page.includes('peut retirer le dernier Super Admin'));
  check('…sans jamais bloquer le geste',
    !page.includes('disabled={restantsSouverains') && !/CANNOT_EDIT_SUPER_ADMIN/.test(page));

  check('supprimer SON propre compte est annoncé comme tel',
    page.includes('C’est VOTRE compte'));
  check('…et déconnecte réellement',
    page.includes('if (r.selfDeletion)') && page.includes('logout();')
    && page.includes("navigate('/login', { replace: true })"));

  check('l’écran dit ce que la suppression ne touche PAS',
    page.includes('comptes locaux des projets ne sont pas touchés')
    && page.includes('journal d’audit conserve ses actes'));
}

/* ══════════════════════════════════════════════════════════════════════════
   6. LA LISTE.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · La liste dit qui est qui, et ce que chacun peut');
{
  check('chaque ligne porte nom, adresse, rôle, état et accès',
    page.includes('user.displayName') && page.includes('user.email')
    && page.includes('ROLE_LABEL[user.role]') && page.includes('Compte actif')
    && page.includes('resumeAcces(user, projets)'));
  check('le rôle souverain se distingue',
    page.includes('ROLE_BADGE[user.role]'));
  check('un compte jamais activé se voit',
    page.includes('user.activated === false') && page.includes('Activation en attente'));
  check('la trace d’octroi reste affichée',
    page.includes('Accordé le') && page.includes('user.grantedBy'));

  /**
   * LE COMPTE COURANT N'EST PAS UN CAS PARTICULIER.
   *
   * Les actions sont actives sur sa propre ligne — c'est la doctrine du lot.
   * Ce qui change, c'est seulement qu'on le RECONNAÎT.
   */
  check('sa propre ligne porte les mêmes actions',
    !page.includes('disabled={estMoi}') && page.includes('— vous'));

  check('un accès posé sur un rôle qui ne fédère pas est annoncé sans effet',
    page.includes('n’ouvre aucun projet'));
}

/* ══════════════════════════════════════════════════════════════════════════
   7. LA MODALE, ET LE PROFIL.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Une coquille de modale correcte, un seul formulaire de profil');
{
  check('Escape ferme', modal.includes("e.key === 'Escape'"));
  check('le focus entre et revient',
    modal.includes('boite.current?.focus()') && modal.includes('rendreLeFocus.current?.focus?.()'));
  check('le fond ne défile pas', modal.includes("classList.add('no-scroll')"));
  check('la modale est annoncée aux lecteurs d’écran',
    modal.includes('role="dialog"') && modal.includes('aria-modal="true"')
    && modal.includes('aria-labelledby'));

  /**
   * PAS DEUX FORMULAIRES DE PROFIL.
   *
   * « Mon profil » reste la surface personnelle, et l'administration reste
   * celle des comptes. L'écran des comptes ne réimplémente pas le premier — il
   * y RENVOIE quand le compte courant n'est pas souverain.
   */
  check('l’écran des comptes ne réimplémente pas « Mon profil »',
    !page.includes('PanelUserProfileEditor') && !page.includes('patchOwnProfile'));
  check('…et y renvoie quand on n’est pas souverain',
    page.includes('to="/mon-profil"') && page.includes('Modifier mon profil'));
  check('la route « Mon profil » existe toujours', app.includes('/mon-profil'));
}

finish();
