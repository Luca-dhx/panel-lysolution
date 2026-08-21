# Finances du Panel — alignement, responsive, fenêtre de détail, accessibilité

**Environnement de recette** : TEST · base `panel_test` · `https://panel.ly-solution.com`
**Commits** : `c27f005` (interface Finances), `4e5e5a4` (contact public)
**Branche** : `feat/generic-deployment-engine`

---

## 1 · Méthode — mesurer, pas regarder

Une capture d'écran montre qu'une chose est de travers ; elle ne dit pas
pourquoi, et corriger d'après elle produit des décalages compensatoires justes
sur une largeur et faux sur toutes les autres.

L'audit a donc lu les **rectangles** : position et largeur de chaque entête,
position et largeur de chaque cellule, `display` et `vertical-align` calculés,
décalage vertical du premier enfant, largeur de défilement du document. Sur six
largeurs (390 / 430 / 768 / 1024 / 1280 / 1680 px) et cinq hauteurs pour la
fenêtre de détail.

Ce sont ces mesures qui ont désigné les causes — trois défauts structurels, tous
antérieurs au lot, aucun visible dans le code sans les chiffres.

---

## 2 · Défaut A — l'entête numérique ne surplombait plus ses valeurs

### Ce qui était observé

Dans « Répartition par projet », `REVENUS`, `COÛTS`, `NET` et `MOUVEMENTS`
apparaissaient calés à gauche de leur colonne pendant que `443,99 €`, `0,00 €`,
`+443,99 €` et `2` se rangeaient à droite. Même chose pour `MONTANT` dans
« Mouvements ». Le lecteur devait chercher à quelle colonne appartenait un
montant.

### La cause

Une collision de spécificité, dans deux feuilles différentes :

```css
/* styles.css */      .data-table th        { text-align: left; }   /* (0,1,1) */
/* components.css */  .finance-cell-amount  { text-align: right; }  /* (0,1,0) */
```

`.data-table th` combine une classe et un élément ; `.finance-cell-amount` n'a
qu'une classe. La première l'emporte, quel que soit l'ordre des fichiers. Les
cellules du corps, elles, n'étaient concurrencées par rien et partaient bien à
droite.

### La correction

Égaliser la spécificité en nommant l'entête :

```css
.finance-cell-amount,
.data-table th.finance-cell-amount {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
```

Aucune marge, aucun décalage. Mesure après correction, à 1280 px :

```text
entêtes  : Rattachement[315→553] Revenus[553→706] Coûts[706→830] Net[830→997] Mouvements[997→1215]
ligne 0  : [0] 315→553 sous son entête
           [1] 553→706 sous son entête
           [2] 706→830 sous son entête
           [3] 830→997 sous son entête
           [4] 997→1215 sous son entête
```

---

## 3 · Défaut B — la cellule d'actions n'était plus une cellule

### Ce qui était observé

« Rembourser » et « Voir les détails » flottaient près du bord supérieur de leur
ligne, à côté d'une date et d'un montant centrés. Sur une ligne haute — un
mouvement Stripe portant sa période, son origine et son état de remboursement,
soit 262 px — la ligne se lisait comme deux lignes distinctes, et le filet de
séparation semblait traverser le bloc de boutons.

### La cause

```jsx
<td className="row-actions">     /* .row-actions { display: flex; … } */
```

Un `<td>` en `display: flex` **cesse d'être une cellule de tableau**. Le
navigateur l'enveloppe dans une cellule anonyme ; le conteneur flex se cale en
haut de celle-ci, et le `vertical-align: middle` qui gouverne les cellules
voisines ne s'applique plus à lui.

La mesure le disait sans ambiguïté — dans une ligne de 262 px :

```text
[0] display=table-cell  contenu à +0px    « 21/08/2026 »
[3] display=table-cell  contenu à +0px    « +95,99 € »
[5] display=flex        contenu à +10px   « RembourserVoir les détai »
```

### La correction

La cellule redevient une cellule ; le flex descend d'un cran, dans un conteneur
qui a le droit d'en être un :

```jsx
<td className="cell-actions">
  <div className="row-actions">…</div>
</td>
```

Appliqué aux trois tables financières qui portaient le défaut : le livret des
mouvements, les demandes de paiement, les règles récurrentes. `.row-actions`
n'est pas modifiée — elle était juste posée sur le mauvais élément.

Mesure après correction, ligne de 202 px à 768 px :

```text
[4] display=table-cell  valign=middle  contenu à +59px   « Télécharger⋮ »
[5] display=table-cell  valign=middle  contenu à +58px   « RembourserVoir les détai »
```

Les deux blocs sont désormais centrés verticalement, comme la date et le
montant : **la ligne se comporte comme une seule ligne.**

---

## 4 · Défaut C — six colonnes ne rentrent pas dans 390 px

### Ce qui était observé

```text
════ 390 px ════
  débordement horizontal : OUI (557 > 390)
```

Ce n'est pas le tableau qui débordait de son conteneur : c'est **la page
entière**, barre latérale et cartes comprises. Le `.table-scroll` censé absorber
la largeur ne défilait pas (`scrollWidth === clientWidth`), et l'utilisateur
devait balayer tout l'écran horizontalement pour lire un montant — en perdant la
date de la ligne en chemin.

Élargir le conteneur n'aurait rien réglé : une colonne « Mouvement » de 60 px
coupe un libellé au deuxième mot.

### La correction : une pile de fiches, sans rien masquer

Sous une certaine largeur, chaque ligne devient une fiche et **chaque cellule
garde le nom de sa colonne** via `data-label` :

```text
DATE           21/08/2026
MOUVEMENT      1 × Abonnement — CTR-2026-0002 (at €95.99 / month)
               Période du 21 août 2026 au 21 septembre 2026
               Encaissé via Stripe  TEST
RATTACHEMENT   Swash auto 06
MONTANT        +95,99 €
JUSTIFICATIF   [Télécharger] [⋮]
               [Rembourser] [Voir les détails]
```

Aucune colonne n'est « dépriorisée » en silence, aucune n'est masquée. Le
tableau reste un `<table>` : l'ordre de lecture, les entêtes `scope="col"` et
l'annonce aux technologies d'assistance ne changent pas — seule la présentation
change. L'entête visuelle est retirée par `clip-path`, jamais par
`display: none`, précisément pour que la sémantique survive.

### Pourquoi une requête de CONTENEUR et non d'écran

La mesure a montré que la largeur d'écran ne décrit pas la place disponible :

| Fenêtre | Largeur réelle du tableau |
|---|---|
| 768 px | **686 px** |
| 1024 px | **684 px** |
| 1280 px | 900 px |

Entre 768 et 1024, la barre latérale réapparaît et reprend exactement ce que la
fenêtre a gagné. Une règle `@media` aurait donc empilé les fiches à 768 et rendu
le tableau serré à 1024, pour une place identique.

```css
.table-scroll:has(.finance-table-stackable) { container-type: inline-size; }
@container (max-width: 46rem) { … }
```

Le tableau s'empile quand **sa colonne** est trop étroite, et retrouve sa forme
tabulaire dès qu'il a la place — y compris dans un panneau latéral ou une fiche
projet.

### Résultat mesuré

| Largeur | Régime | Débordement |
|---|---|---|
| 390 px | fiches | **non** |
| 430 px | fiches | **non** |
| 768 px | fiches | **non** |
| 1024 px | fiches | **non** |
| 1280 px | tableau, toutes cellules sous leur entête | **non** |
| 1680 px | tableau, toutes cellules sous leur entête | **non** |

---

## 5 · Défaut D — la fenêtre de détail perdait son titre, partout

### Ce qui était observé

C'est le défaut le plus grave du lot, et le seul qu'aucune capture n'aurait
révélé : il fallait mesurer.

```text
── bureau (1280×900) ──
  boîte : 1291px (max-height=none) — de -195 à 1095 pour 900px de vue
  haut atteignable : NON — le titre est inaccessible
```

Sur **toutes** les tailles mesurées — jusqu'au bureau en 1280×900 — le haut de
la fenêtre sortait de l'écran et **aucun défilement ne permettait d'y revenir**.
Le titre du mouvement, le montant et les premières lignes du détail étaient
définitivement hors de portée.

| Écran | Hauteur de la boîte | Titre atteignable |
|---|---|---|
| 390×640 | 1997 px | **NON** |
| 390×844 | 1997 px | **NON** |
| 768×700 | 1316 px | **NON** |
| 1280×620 | 1291 px | **NON** |
| 1280×900 | 1291 px | **NON** |

### La cause

```css
.modal-backdrop { display: flex; align-items: center; overflow-y: auto; }
.modal          { /* aucune max-height, aucun overflow */ }
```

Un enfant **centré** plus haut que son conteneur défilant déborde par les deux
extrémités. Le débordement du bas est atteignable ; celui du haut ne l'est pas,
parce que le défilement ne remonte jamais au-dessus de son origine. C'est un
comportement connu de la centration flex, et il ne se manifeste que lorsque le
contenu devient grand — ce qui arrive dès qu'un mouvement Stripe porte son
historique de remboursements.

### La correction : trois zones, et la vue comme borne

```css
.modal-backdrop { overflow: hidden; }        /* le fond ne défile plus */
.modal {
  max-height: min(100%, calc(100dvh - 2rem));
  display: flex; flex-direction: column; min-height: 0;
}
.modal-head { flex: 0 0 auto; }              /* en-tête FIXE */
.modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.modal-body > .action-buttons { position: sticky; bottom: 0; }  /* pied FIXE */
```

`dvh` et non `vh` : sur mobile, `vh` se fige sur la vue **sans** la barre
d'outils du navigateur, si bien qu'une boîte de `100vh` passe dessous — et c'est
le pied, « Fermer » et « Supprimer », qui disparaît derrière elle.

`min-height: 0` sur le corps est la clef : sans lui, un enfant flex refuse de
descendre sous la taille de son contenu, et le débordement remonte sur la boîte
entière.

Le pied n'a pas été déplacé dans une propriété dédiée : il est déjà, dans les
**onze** appelants, le dernier bloc `.action-buttons`. Une position collante
suffit, et aucun appel n'a été réécrit.

### Résultat mesuré

| Écran | Hauteur de la boîte | Dépasse la vue | Haut | Bas | Page figée |
|---|---|---|---|---|---|
| 390×640 | 608 px | non | ✓ | ✓ | ✓ |
| 390×844 | 812 px | non | ✓ | ✓ | ✓ |
| 768×700 | 668 px | non | ✓ | ✓ | ✓ |
| 1280×620 | 588 px | non | ✓ | ✓ | ✓ |
| 1280×900 | 868 px | non | ✓ | ✓ | ✓ |

Marges latérales constantes de 16 px à toutes les largeurs ; la boîte ne touche
jamais le bord, et sa largeur ne dépasse jamais la vue.

---

## 6 · Le menu « ⋮ »

Une ligne portait **cinq commandes de front** : Télécharger, Remplacer, Retirer,
Rembourser, Voir les détails. Sur un écran étroit, cette file poussait la ligne
au-delà de la vue et ne laissait plus de place à la colonne suivante. Le tableau
devenait illisible non pas parce qu'il contenait trop d'information, mais trop
de commandes.

**Ce qui reste visible** : « Télécharger » (le geste courant, qui ne détruit
rien), « Rembourser » (le geste qui déplace de l'argent) et « Voir les détails »
(la seule porte vers le reste). Aucune action importante n'a été rangée hors de
vue.

**Ce qui passe derrière le menu** : « Remplacer le justificatif » et « Retirer le
justificatif ». Deux gestes rares, dont l'un efface une pièce comptable — les
rendre moins faciles à déclencher par inadvertance est ici une qualité.

Le retrait garde son traitement destructif jusque dans le menu
(`conn-menu-item-danger`).

Au clavier : `aria-haspopup="menu"`, `aria-expanded`, le focus entre sur le
premier élément à l'ouverture, `Escape` referme et **rend le focus au
déclencheur** — sans quoi la tabulation repartirait du début du document et
l'utilisateur perdrait sa ligne.

---

## 7 · Accessibilité

Recette automatisée sur l'écran réel, avec une session ouverte :

```text
1 · CHAQUE COMMANDE A UN NOM
  ok  aucun contrôle sans nom accessible

2 · LE MENU « ⋮ » ANNONCE SON ÉTAT ET S'UTILISE AU CLAVIER
  ok  fermé : aria-expanded=false
  ok  le déclencheur a un nom — « Autres actions sur le justificatif de … »
  ok  ouvert : aria-expanded=true
  ok  le focus entre dans le menu
  ok  Échap referme le menu
  ok  le focus revient au déclencheur

3 · LA FENÊTRE DE DÉTAIL PIÈGE LE FOCUS ET LE REND
  ok  la fenêtre est un dialogue modal
  ok  un bouton de fermeture visible existe
  ok  il porte un nom — « Fermer la fenêtre »
  ok  la tabulation ne sort jamais de la fenêtre    (20 tabulations)
  ok  Échap ferme la fenêtre
  ok  le focus retourne au bouton qui l'a ouverte

4 · LE FOCUS SE VOIT
  ok  chaque bouton montre son focus

5 · LES ENTÊTES DE COLONNE SONT DÉCLARÉES
  ok  toutes les entêtes portent scope="col"

RECETTE A11Y : OK
```

Trois corrections ont été nécessaires pour y arriver.

**Le focus n'était pas piégé.** `aria-modal` *annonce* l'isolement aux
technologies d'assistance ; il ne le produit pas. Sans piège, la tabulation
quittait la fenêtre au dernier bouton et parcourait la page derrière — une page
que l'utilisateur ne voit pas et ne peut pas atteindre, puisque la fenêtre est
toujours ouverte.

**Il n'y avait aucun bouton de fermeture visible.** `Escape` fonctionnait, mais
sur un téléphone il n'y a pas de touche d'échappement, et toucher le fond n'est
ni annoncé ni découvrable. Une croix nommée, de 40 px de côté — la cible tactile
minimale —, a été ajoutée au même endroit dans les onze fenêtres.

**Un contrôle fantôme s'annonçait sur chaque ligne.** Le champ de fichier caché
du justificatif était en `.sr-only` : invisible à l'œil, présent dans l'arbre
d'accessibilité, il s'annonçait « bouton Parcourir » sans nom, entre deux
commandes nommées. Il n'est jamais cliqué — ce sont les boutons qui le
déclenchent —, donc `tabIndex={-1}` le retire du parcours clavier, ce qui rend
`aria-hidden` légitime : on ne masque pas quelque chose d'atteignable.

---

## 8 · Aucune modification métier

Ce lot est de l'interface. N'ont été touchés **ni** les calculs de revenus,
**ni** ceux de coûts, **ni** le net, **ni** le remboursement Stripe, **ni** la
bascule TEST/PROD, **ni** les pièces justificatives, **ni** le rattachement aux
projets, **ni** l'historique des transactions.

Les montants visibles dans les captures — `443,99 €`, `+95,99 €`, `+348,00 €` —
proviennent de la base `panel_test` et n'ont été recopiés dans aucun fichier.

La preuve la plus directe : les 187 contrôles préexistants de `finance-ui.test.js`
— qui couvrent le signe des montants, l'échelle du graphique, le partage du
moteur entre la fiche projet et la page globale, les filtres, la confirmation de
suppression et la doctrine du document privé — passent inchangés.

---

## 9 · Tests

### 9.1 Section de non-régression ajoutée

`finance-ui.test.js` § 21 — **40 contrôles**, un par défaut corrigé :

- le sélecteur d'entête numérique est nommé à la même spécificité, et la règle
  aligne bien à droite ;
- aucune des trois tables n'applique plus le flex directement sur la cellule, et
  toutes l'enveloppent ;
- la bascule est une requête de conteneur, pas d'écran ;
- les deux tables sont empilables, chaque cellule porte son `data-label`, et
  **aucune colonne n'est masquée en silence** ;
- le fond ne défile plus, la boîte est bornée en `dvh`, le corps défile,
  l'en-tête est fixe, le pied est collant ;
- une croix nommée existe, le focus est piégé et rendu ;
- le menu annonce son état, `Escape` le referme, le retrait garde sa couleur ;
- « Rembourser », « Voir les détails » et « Télécharger » restent des boutons
  visibles ;
- le champ de fichier est hors de l'arbre d'accessibilité.

Les contrôles portent sur les **sélecteurs et la structure**, pas sur des
valeurs de pixels : c'est la règle qui était fausse, et c'est elle qu'on
verrouille.

`finance-ui.test.js` : **227 réussis / 0 échoué** (187 avant, 40 ajoutés).

### 9.2 Suites voisines

| Suite | Résultat |
|---|---|
| `panel-ui` | 79 / 0 |
| `panel-meetings-ui` | 112 / 0 |
| `panel-timeline-ui` | 83 / 0 |
| `panel-users-ui` | 73 / 0 |
| `password-reset-ui` | 24 / 0 |
| `template-editor-ui` | 23 / 0 |
| `project-connections` | 61 / 0 |
| `company-onboarding` | 65 / 0 |
| `architecture` | 31 / 0 |
| `public-contact-email` *(nouvelle)* | 32 / 0 |

**Chaîne complète** : `node tests/run-all.js` — **145 / 145 fichiers OK**,
exit 0.

### 9.3 Build

`tsc -b` ✓ · `vite build` ✓.

---

## 10 · LOT ADDITIONNEL — centralisation de l'e-mail de contact public

### 10.1 Recherche globale de `luca.duhoux@lycarz.com`

| Emplacement | Occurrences | Classement |
|---|---|---|
| `Panel/docs/architecture/FINANCES_L12_…REPORT.md:557` | 1 | **DOC ATTENDU** — note de risque résiduel du lot précédent |
| `SB Auto 06/docs/Brevo/RX_BREVO_*.md` | 8 | **DOC ATTENDU** — post-mortems, décrivant l'EXPÉDITEUR |
| `SB Auto 06/backend/logs/email-diagnostic-*.json` | 8 | **ARTEFACT DE DIAGNOSTIC** — journaux datés |
| **Code exécutable** | **0** | — |
| **Base `panel_test`** (recherche sur tous les documents) | **0** littéral | — |
| **Base `sbauto06_test`** | **0** | — |

**Aucune occurrence RUNTIME À MIGRER.** L'adresse n'a jamais été codée en dur.

### 10.2 Le vrai défaut : elle était DÉDUITE

Elle vivait dans `panel_test.panelcompanies`, à trois endroits :

```json
"contacts": { "email": "luca.duhoux@lycarz.com",
              "supportEmail": "luca.duhoux@lycarz.com" },
"references": [ { "type":"LINK", "name":"Support",
                  "value":"luca.duhoux@lycarz.com", "order":0 } ]
```

Le chemin qui atteignait le pied des e-mails était le troisième :
`supportEmailFromReferences()` balayait `references[]` — la liste de liens de
l'agence — et retenait **la première valeur qui ressemblait à une adresse**.

Le contact de tous les clients dépendait donc de l'**ordre** d'une liste
hétéroclite — site, LinkedIn, téléphone, e-mail — que l'opérateur réorganise
pour des raisons d'affichage. Glisser un lien en tête n'aurait rien changé ; y
glisser une seconde adresse aurait tout changé, et aucun écran ne l'annonçait.

**Une donnée que personne ne peut ni voir ni choisir n'est pas une
configuration : c'est un effet de bord.**

### 10.3 L'autorité choisie, et pourquoi

Aucune seconde source de vérité n'a été créée.

| Candidat | Retenu ? | Raison |
|---|---|---|
| `PanelCompany.contacts` | **oui** | c'est l'autorité d'identité, déjà publiée aux projets par `DEV_COMPANY` |
| configuration d'expéditeur | non | le lot interdit explicitement que l'expéditeur porte le contact |
| `contacts.supportEmail` | non | c'est l'adresse Let's Encrypt — sémantique différente |
| nouveau modèle dédié | non | une variable de plus est une variable qu'on oublie |

Le champ est `contacts.publicContactEmail`. Il **voyage par le canal existant** :
`companyPublicProfile()` publie déjà `contacts` en entier. Conséquences directes
et vérifiées — aucun `templateCode` nouveau, aucun provisionnement par projet,
et un projet fraîchement appairé le reçoit du premier coup.

### 10.4 L'écran

Le champ est sur la page **« Expéditeur e-mail »**, sous la carte de
l'expéditeur — parce que c'est là qu'on les confond. « Adresse d'expédition
(From / support) » se lit comme l'adresse de contact ; ce sont deux choses, et
l'une peut très bien n'être relevée par personne.

La carte explique la différence, affiche l'état (« Configurée » / « À
renseigner ») et, quand elle est vide, **ce que ça change** :

> Tant qu'elle est vide, les e-mails clients qui l'exigent sont REFUSÉS à
> l'envoi plutôt qu'expédiés sans adresse de réponse.

La route d'écriture (`PUT /api/email-sender/public-contact`, DEV uniquement)
**n'écrit pas en base** : elle appelle `saveCompany`, qui valide la fiche entière
puis publie une version. Une écriture directe aurait laissé les projets servir
l'ancienne adresse jusqu'à la prochaine sauvegarde de l'écran « Mon entreprise »
— c'est-à-dire peut-être jamais.

### 10.5 Validation

Réutilise la règle existante de la fiche entreprise : format contrôlé, valeur
normalisée (espaces retirés, minuscules), **chaîne vide transformée en `null`**.

Un défaut préexistant a dû être corrigé pour que la dernière clause fonctionne :
l'union validait le format **avant** de transformer, si bien que `''` échouait au
contrôle e-mail et n'atteignait jamais la normalisation. Vider `contacts.email`,
`contacts.supportEmail` ou un domaine était donc **impossible** — le seul
contournement était de laisser publiée une adresse périmée.

### 10.6 Répliques interdites — vérifiées une par une

Aucune de ces adresses ne sert de repli au contact public :

| Adresse | Vérifié par |
|---|---|
| variable d'environnement de SB Auto | aucun `process.env` dans le résolveur |
| adresse codée en dur | recette § 5, grep sur tout `backend/src` |
| réglage local d'un projet | l'identité vient exclusivement du pont |
| `contacts.supportEmail` (Let's Encrypt) | recette SB Auto § 17bis |
| adresse d'un compte SUPER_ADMIN | 4 contrôles nommant `SOVEREIGN_BOOTSTRAP_EMAIL` |
| expéditeur du parc | recette de bout en bout § 5 |
| `contacts.email` (administratif) | recette SB Auto § 17bis |

Un repli existant a été **retiré** : `identite?.supportEmail || identite?.email`
visait un champ que cette identité n'expose pas. Il valait toujours `undefined`,
donc il ne servait à rien — mais il se lisait comme une seconde autorité, et la
prochaine main aurait pu le faire pointer sur `contacts.email`.

### 10.7 Comportement en l'absence de valeur — fail-closed

`developer.supportEmail` est déclaré **requis** dans le registre de modèles. Le
résolveur rend `null`, et `billingVariableResolver` **refuse l'envoi** avec un
message qui nomme l'écran à remplir :

> Aucune adresse de contact public n'est publiée par le Panel (écran
> « Expéditeur e-mail » → « E-mail de contact public ») : ce message inviterait
> le client à répondre à une adresse vide, il ne partira pas.

Jamais d'`undefined`, jamais de `null`, jamais de `mailto:` vide, jamais
l'ancienne adresse en dur.

**Un repli transitoire subsiste, et il est délibéré.** Un Panel qui ne publie pas
encore le champ — la valeur est `undefined`, pas vide — fait retomber le projet
sur l'ancienne déduction, à l'identique : une plateforme en cours de mise à
niveau ne perd pas l'adresse qu'elle affichait hier. Un champ publié **vide**,
lui, vaut `null` : c'est une décision non prise, pas une donnée manquante, et
retomber sur les références ferait ressurgir une adresse que l'opérateur croit
avoir effacée.

### 10.8 La migration ne décide rien

`npm run migrate:public-contact-email` (`-- --dry-run` pour simuler) reprend la
**première adresse des références** — celle qui servait déjà à cet usage exact.
Ce n'est pas un choix nouveau : c'est le choix existant rendu explicite.

Elle ne recopie ni `contacts.email`, ni `contacts.supportEmail`, ni l'expéditeur,
ni l'adresse d'un compte souverain. Sans référence e-mail, **le champ reste
vide** et l'écran l'annonce « À renseigner » : remplir à la place de l'opérateur
publierait au nom de son entreprise une adresse que personne n'a choisie.

Exécution réelle sur `panel_test`, puis second passage :

```text
════ CONTACT PUBLIC — APPLIQUÉE ════
entreprises examinées : 1
reprises              : 1
   · L.Y Solution : reprise de la première référence → luca.duhoux@lycarz.com

(second passage)
déjà renseignées      : 1
reprises              : 0
```

### 10.9 Bloc de preuve — recette de bout en bout

Chaîne réelle : Panel → publication → pont → projet → résolution des variables
d'e-mail. Rien n'est simulé.

```text
Valeur initiale : « luca.duhoux@lycarz.com » — elle sera restaurée à l'identique.

1 · L'EXPÉDITEUR ET LE CONTACT SONT DEUX CHOSES
  ok  l'expéditeur est configuré — support@ly-solution.com
  ok  le contact public est configuré — luca.duhoux@lycarz.com
  ok  et ce ne sont PAS la même adresse — la garde tient sur données réelles

2 · LE PROJET LIT LA VALEUR PUBLIÉE
  ok  le projet a reçu l'adresse publiée — luca.duhoux@lycarz.com (v22)
  ok  et c'est elle que les modèles d'e-mail recevront

3 · CHANGEMENT A → B, SANS REDÉPLOIEMENT NI RÉAPPAIRAGE
  ok  le Panel accepte et publie — 200
  ok  le projet reçoit la nouvelle adresse — recette-contact-public@ly-solution.com (v23)
  ok  une NOUVELLE version a été publiée — 22 → 23
  ok  la résolution suit immédiatement

4 · LES REFUS SONT DES REFUS
  ok  une adresse illisible est refusée — 400
  ok  …et rien n'a été publié entre-temps
  ok  effacer est une intention légitime — 200
  ok  …et la valeur devient NULL, jamais une chaîne vide — null
  ok  …l'écran l'annonce « à renseigner »
  ok  …en disant ce que ça change

5 · VIDE, LE PROJET REFUSE — il n'invente aucune adresse
  ok  aucune adresse de repli n'est fabriquée — null
  ok  …surtout pas l'expéditeur
  ok  …ni l'ancienne adresse en dur

6 · RESTAURATION À L'IDENTIQUE
  ok  la valeur initiale est réécrite — 200
  ok  l'écran affiche EXACTEMENT la valeur d'avant la recette — luca.duhoux@lycarz.com
  ok  le projet aussi — luca.duhoux@lycarz.com (v25)

RECETTE CONTACT PUBLIC : OK
```

Les quatre combinaisons expéditeur / contact sont couvertes : les deux
renseignés et différents (§ 1), le contact modifié sans toucher à l'expéditeur
(§ 3), le contact effacé avec l'expéditeur intact (§ 4-5), le contact illisible
refusé sans publication (§ 4).

**La valeur initiale a été restaurée exactement**, dans le Panel comme dans le
projet.

### 10.10 Suites automatisées

`Panel/tests/public-contact-email.test.js` — **32 contrôles**, enregistré dans
`run-all.js` : validation et normalisation, publication par le canal existant
sans clé nouvelle au sommet, trois adresses distinctes qui ne se substituent
pas, migration idempotente qui n'invente rien, aucune adresse de contact codée
en dur, compte souverain jamais utilisé comme repli.

`SB Auto 06/…/developer-identity-bridge.test.js` § 17bis — 6 contrôles : le
champ publié fait foi même contre une référence divergente ; un champ publié
vide ne retombe pas sur les références ; ni l'adresse administrative, ni celle
des certificats ne sont empruntées.

### 10.11 Documentation

| Fichier | Ajout |
|---|---|
| `Panel/docs/PROTOCOL.md` | deux lignes au tableau des autorités, et une section « Trois adresses e-mail, trois métiers » |
| `Panel/docs/architecture/BREVO_CONTROL_PLANE.md` | § 4.1 « Expéditeur ≠ contact public » |
| `SB Auto 06/docs/PROTOCOL.md` | § `developer.supportEmail` — l'adresse publiée, jamais devinée |
| `SB Auto 06/docs/ARCHITECTURE.md` | § Le contact public du prestataire vient du Panel, comme un CHAMP |

---

## 11 · Nettoyage

L'adresse `recette-contact-public@ly-solution.com` a servi le temps de la
recette et n'existe plus nulle part. La valeur initiale a été réécrite par le
même chemin qu'un opérateur emprunterait, et vérifiée des deux côtés du pont.

Aucune donnée financière n'a été créée, modifiée ou supprimée.

---

## 12 · Risques résiduels

**1. `developer-identity.test.js` : 4 contrôles rouges, antérieurs au lot, et
le fichier n'est PAS enregistré dans `run-all.js`.**
Les échecs portent sur les liens symboliques de médias partagés du moteur de
déploiement et sur une limite de taille d'import — sans rapport avec ce lot.
Vérifiés identiques avec les modifications de ce lot mises de côté (`git stash`)
: 96 / 4 dans les deux cas.

Le point qui mérite d'être signalé n'est pas l'échec, c'est l'ABSENCE : la suite
complète annonce « 145/145 fichiers OK » sans jamais exécuter ce fichier. Un
contrôle qui n'est dans aucune chaîne ne protège rien, et son silence se lit
comme un succès. L'enregistrer ferait passer la chaîne au rouge sur des défauts
étrangers à ce lot ; le corriger dépasse son périmètre. Signalé pour décision.

**2. La requête de conteneur exige un navigateur récent.**
`@container` et `:has()` sont disponibles dans toutes les versions courantes des
moteurs. Sur un navigateur antérieur, le tableau resterait tabulaire à toutes
les largeurs — c'est-à-dire l'état d'avant ce lot, pas un état dégradé nouveau.

**3. Les fiches empilées n'ont été éprouvées que sur deux mouvements.**
La base de recette contient deux transactions. Le comportement à cinquante
lignes — hauteur de page, coût de rendu — n'a pas été mesuré.

---

## 13 · La question du lot

> **La page Finances déployée est-elle désormais propre et pleinement
> utilisable, du mobile au bureau : tableaux alignés, actions adaptées, fenêtre
> de détail correctement scrollable ?**

**OUI.**

Les tableaux sont alignés, et pour une raison structurelle : l'entête numérique
partage désormais la spécificité de ses cellules, et la colonne d'actions est
redevenue une cellule de tableau. Mesuré à 1280 et 1680 px, chaque cellule est
sous son entête et chaque bloc d'actions est centré comme ses voisins.

Les actions sont adaptées : cinq commandes de front deviennent trois boutons et
un menu, sans qu'aucune action importante soit masquée, et le retrait garde son
traitement destructif.

Du mobile au bureau, aucune largeur ne déborde plus. Sous 46 rem de place
disponible, chaque ligne devient une fiche qui conserve le nom de toutes ses
colonnes — rien n'est caché, rien n'est déprioritisé.

La fenêtre de détail tient dans la vue sur les cinq formats mesurés, son titre
est atteignable — il ne l'était sur **aucun** auparavant —, son en-tête et son
pied restent visibles, seul son contenu défile, la page derrière ne bouge pas,
et elle se ferme au clavier comme au doigt sans laisser le focus s'échapper.

---

## Verdict

PASS
