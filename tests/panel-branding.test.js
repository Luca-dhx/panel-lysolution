/**
 * MARQUE DU PANEL — logo, sinon nom, sinon « Panel ».
 *
 * ══ CE QU'IL Y AVAIT ════════════════════════════════════════════════════════
 *
 * `<h1 className="sidebar-title">Panel L.Y Solution</h1>` — écrit en dur. Le
 * nom de l'agence se saisit pourtant dans « Mon entreprise », son logo s'y
 * téléverse, se résout contre la destination active et part sur le pont vers
 * chaque projet. L'écran qui représente le plus cette agence — sa propre barre
 * latérale — n'en lisait rien.
 *
 * Un produit qui affiche une marque codée en dur ne peut pas être livré à une
 * autre agence.
 *
 * ══ CE QUI EST VÉRIFIÉ ══════════════════════════════════════════════════════
 *
 * La règle de repli, exécutée telle quelle (fonction pure), et le câblage de
 * l'écran : aucune seconde source de branding, aucune adresse fabriquée à la
 * main, aucun retour du « logo sombre » retiré du produit.
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section, setTestEnv } from './helpers/harness.js';

register('./helpers/frontendLoader.mjs', import.meta.url);
setTestEnv();

const { panelTitleFor } = await import('@/lib/usePanelBranding');

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

const layout = lire('frontend/src/components/Layout.tsx');
const branding = lire('frontend/src/lib/usePanelBranding.ts');

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA RÈGLE DE REPLI — trois cas, et le troisième n’est pas « Panel null »');
{
  check('entreprise connue → « Panel <nom> »',
    panelTitleFor('L.Y Solution') === 'Panel L.Y Solution');
  check('nom entouré d’espaces → nettoyé', panelTitleFor('  Garage Nord  ') === 'Panel Garage Nord');
  check('aucune entreprise → « Panel »', panelTitleFor(null) === 'Panel');
  check('chaîne vide → « Panel »', panelTitleFor('') === 'Panel');
  check('chaîne d’espaces → « Panel »', panelTitleFor('   ') === 'Panel');
  check('valeur absente → « Panel »', panelTitleFor(undefined) === 'Panel');
  check('jamais « Panel null » ni « Panel undefined »',
    !panelTitleFor(null).includes('null') && !panelTitleFor(undefined).includes('undefined'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ÉCRAN — le logo REMPLACE le titre, il ne s’y ajoute pas');
{
  check('la barre latérale lit la marque, elle ne l’écrit plus en dur',
    /usePanelBranding\(\)/.test(layout));
  check('…et le titre écrit en dur a disparu',
    !layout.includes('>Panel L.Y Solution<'));
  check('le logo est rendu quand il existe', /branding\.logoUrl \?/.test(layout));
  check('…sinon le titre textuel', /titrePanel/.test(layout));

  /**
   * AUCUN `<img src="">` : une source vide déclenche une seconde requête vers
   * la page courante dans plusieurs navigateurs, et affiche une icône cassée.
   * Le rendu est CONDITIONNÉ à la présence de l'adresse, pas à une chaîne vide.
   */
  check('aucune image sans source', !/<img[^>]*src=\{?["']{2}/.test(layout));
  check('…le rendu est conditionné à l’adresse', /branding\.logoUrl \? \(/.test(layout));
  check('le logo porte un texte alternatif utile', /alt=\{titrePanel\}/.test(layout));
  check('le titre de page survit au logo', /<h1 className="sidebar-title">/.test(layout));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE SEULE SOURCE DE MARQUE, ET AUCUNE ADRESSE FABRIQUÉE');
{
  check('la marque vient de la fiche entreprise', /company\.current\(\)/.test(branding));
  check('…par l’aperçu que le SERVEUR a résolu',
    /media\?\.\['branding\.logo'\]/.test(branding));
  check('…avec l’URL publiée en repli', /branding\?\.logoUrl/.test(branding));
  check('aucune adresse composée à la main dans le module',
    !/`\$\{[^}]*\}\/uploads/.test(branding));
  check('un chemin de stockage nu n’est jamais affiché',
    /\^https\?:/.test(branding));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE « LOGO SOMBRE » NE REVIENT PAS PAR LA BANDE');
{
  check('aucune référence au logo sombre dans la marque',
    !/logoDark|logoSombre/i.test(branding));
  check('…ni dans la coquille de l’application',
    !/logoDark|logoSombre/i.test(layout));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE FAVICON N’EST PAS TOUCHÉ');
{
  const favicon = lire('frontend/src/lib/useFavicon.ts');
  check('le favicon garde son propre module', favicon.includes('branding.favicon'));
  check('…et la marque ne s’en mêle pas', !branding.includes('branding.favicon'));
  check('les deux lisent la même fiche, sans se dupliquer',
    favicon.includes('company.current()') && branding.includes('company.current()'));
}

finish();
