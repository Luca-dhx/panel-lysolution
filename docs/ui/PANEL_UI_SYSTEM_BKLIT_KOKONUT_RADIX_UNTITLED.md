# Le système d'interface du Panel

> Quatre écosystèmes, **une** identité visuelle. Ce document dit qui fait quoi,
> pourquoi, et ce qu'il ne faut jamais faire.

---

## 1. La règle qui gouverne tout

`frontend/src/tokens.css` est la **seule** source de couleur. Quatre valeurs
réglables à l'exécution par l'écran « Thème du Panel » :

```css
--p-background   --p-foreground   --p-primary   --p-accent
```

Tout le reste — surfaces, bordures, texte atténué, états, palette de
graphiques — en **dérive** par `color-mix`. Les librairies importées arrivent
chacune avec sa propre palette ; trois fichiers de **pont** les traduisent dans
ce vocabulaire :

| Pont | Traduit | Pour |
|---|---|---|
| `styles/bridge.css` | `--color-neutral-*`, `--color-brand-*`, `--color-utility-*` | Untitled UI |
| `styles/registry.css` | variables shadcn + `--chart-*` + `--legend-*` | Bklit, Kokonut UI |
| `styles/radix-scope.css` | `--gray-1..12`, `--accent-1..12`, surfaces | Radix Themes |

**Aucun code hexadécimal dans un pont.** Un test le vérifie
(`tests/panel-ui-refonte.test.js`, section 2). Une teinte écrite en dur serait
figée sur le thème du jour, et le composant deviendrait le seul élément de
l'écran à ignorer les couleurs choisies.

---

## 2. Qui fait quoi

### Untitled UI React — l'**application**

Tables, en-têtes de carte, badges, avatars, menus déroulants, infobulles,
cases à cocher. Composants **copiés** dans `src/components/base` et
`src/components/application` (ce ne sont pas des paquets).

Ce qu'on lui prend surtout : **React Aria**. Le tri au clavier, l'annonce des
colonnes triables, le focus visible par cellule, les menus navigables — écrits à
la main, c'est ce qu'on oublie.

### Bklit — la **data visualization**

Registre `@bklit`, bâti sur **visx** + **motion** + **@number-flow/react**.
C'est notre bibliothèque **prioritaire** pour tout graphique.
Sources dans `src/components/charts` (installées, pas écrites).

### Radix Themes — cinq **primitives** que nous n'avions pas

`ScrollArea`, `DataList`, `SegmentedControl`, `Skeleton`, `Callout`.

Pas les dialogues, pas les menus, pas les infobulles : React Aria les fournit
déjà et la `Modale` maison piège le focus. En réinstaller une seconde série
aurait été de la duplication pure.

### Kokonut UI — les **micro-interactions**, avec parcimonie

Le catalogue est majoritairement décoratif (`glitch-text`, `beams-background`,
`particle-button`, `matrix-text`). **Une seule chose** a été retenue : la
**mécanique** de `smooth-tab` — l'indicateur partagé par `layoutId` de
`motion` —, reprise dans `ui-kit/SmoothTabs`.

Le composant d'origine embarquait ses onglets en dur, une palette figée
(`bg-amber-500`, `bg-blue-500`, `bg-purple-500`), des dégradés de texte et
`lucide-react`. C'est une vitrine, pas une primitive : posé tel quel, il aurait
apporté une quatrième palette et un troisième jeu d'icônes.

`use-mobile` a été installé puis **retiré** : le seul endroit qui en aurait eu
besoin — la bascule du tableau des mouvements en fiches — le fait déjà par une
*container query* CSS, qui suit la largeur du CONTENEUR et non celle de la
fenêtre. Un hook qui aurait mesuré l'écran s'y serait trompé dans un panneau
latéral.

### Le kit maison — `src/components/ui-kit`

**Un écran refondu importe d'ici, jamais des quatre librairies directement.**

| Composant | Rôle |
|---|---|
| `PageHeader` | retour, avatar, titre, pastilles, actions — un seul gabarit pour cinq écrans |
| `Metric` / `MetricRow` | un indicateur : valeur, période, tendance, et les trois états |
| `Panel` | le cadre d'un bloc : titre, badge, description, actions, pied, mode `flush` |
| `SkeletonRows` / `EmptyPanel` / `ErrorState` / `NoticeState` | les trois états |
| `PeriodPicker` | le choix de période, en contrôle segmenté |
| `SmoothTabs` | les onglets d'une fiche, avec rôles ARIA et flèches |

Le jour où une primitive change de fournisseur, un seul fichier bouge.

---

## 3. Les règles anti-« UI soup »

1. **Un seul moteur de fusion de classes.** `@/utils/cx` (étendu avec l'échelle
   typographique d'Untitled UI) ; `@/lib/utils` réexporte `cn` **par-dessus la
   même instance**. Deux instances de `tailwind-merge` = deux caches et deux
   configurations, et un conflit de classes résolu différemment selon le
   composant. `shadcn add --overwrite` réécrit `lib/utils.ts` : **le rétablir**
   est la seule chose à refaire après une installation.

2. **Un seul système d'espacement : Tailwind.** C'est pourquoi `utilities.css`
   et `layout.css` de Radix ne sont pas importés, et pourquoi `Box`/`Flex`/
   `Grid` de Radix ne sont pas utilisés.

3. **Un seul jeu d'icônes par contexte.** `Icon` (bootstrap-icons) pour les
   écrans maison ; `@untitledui/icons` **dans** les composants Untitled UI. Pas
   de troisième.

4. **Pas de `<Theme>` global.** Voir §4.

5. **Le préflight de Tailwind reste dehors.** Voir §5.

6. **Les noms d'utilitaires en conflit ne sont pas redéclarés.** `bg-primary` et
   `text-primary` appartiennent à Untitled UI dans ce Panel, avec un sens
   **différent** de shadcn (une surface de carte, un texte principal — pas la
   couleur de marque). `registry.css` ne déclare donc que les familles
   réellement écrites par Bklit, listées explicitement.

---

## 4. Radix : scopé, allégé, chargé à la demande

`components/radix/RadixScope.tsx` est la **seule** porte d'entrée.

* **Pas de conteneur racine.** La racine porte déjà 190 ko de CSS maison ; un
  cinquième système revendiquant `background`, `color`, la police et le rayon
  sur `<body>` aurait repeint les quinze écrans hors périmètre.
* **`hasBackground={false}`** — le conteneur est posé dans une carte qui a déjà
  sa surface.
* **L'apparence est déduite**, pas choisie : on mesure la luminance du
  `--p-background` réellement calculé et on en tire `color-scheme`. Un
  `MutationObserver` la recalcule quand le thème change sans rechargement.
* **`min-height` neutralisée.** Radix pose `min-height: 100dvh` sur tout
  conteneur qu'il croit racine. Nos conteneurs sont locaux et n'ont aucun
  `Theme` parent : chacun se déclarait racine. Constaté : **450 px de vide**
  dans le bloc des filtres de la page Finances.
* **480 ko chargés à la demande.** La feuille n'est atteinte que depuis des
  écrans paresseux : Vite en fait un fragment CSS séparé.

La remise à zéro de Radix est écrite `.rt-reset:where(…)` — vérifié en lisant
la feuille : elle ne touche que ce que Radix rend lui-même.

---

## 5. Tailwind : pas de préflight

```css
@import "tailwindcss/theme.css" layer(theme);   /* les variables */
@import "tailwindcss/utilities.css";            /* les classes, HORS couche */
```

* **Pas `@import "tailwindcss"`** : il embarque le préflight, qui réécrit `h1`,
  `ul`, `button`, `input`, `img`, `table` pour le document **entier**.
* **Les utilitaires ne sont pas dans une couche.** Une règle hors `@layer`
  l'emporte sur toute règle en couche : en `@layer utilities`, elles auraient
  perdu contre le moindre sélecteur de `styles.css` — et une classe Tailwind
  « qui ne s'applique pas » est le pire genre de bogue, parce qu'on la voit
  dans le HTML.
* **Une remise à zéro locale sous `.uui`**, écrite en `:where()` donc de
  spécificité nulle : `.btn`, `.card`, `.badge` gagnent toujours à l'intérieur.

---

## 6. Choisir un graphique

`donnée métier → question de l'utilisateur → forme`

| Question | Forme | Pourquoi |
|---|---|---|
| Est-ce que ça monte, et est-ce que ça tient ? | **Composed** — barres + courbes | Une dépense est un événement daté (barre) ; un encaissement se lit par sa forme (courbe) ; le net croise zéro. |
| Qui rapporte le plus ? | **Bar horizontal** | Les étiquettes sont des **noms** ; l'œil compare des longueurs alignées mieux que des angles ; le nombre de lignes n'est pas borné. |
| Quelle part d'un tout **connu** ? | Ring | Et **seulement** là. Ce n'est pas la question de la répartition par projet. |
| Un entonnoir métier réel ? | Funnel | Uniquement si les étapes en sont vraiment un. |

**Sankey, Radar, Gauge, Choropleth : non**, tant qu'aucune donnée du Panel ne
les appelle. Un graphique doit répondre immédiatement à une question métier.

### Les couleurs sont des **rangs**, pas des teintes

```
--chart-1  mesure principale (encaissements)   --chart-4  secondaire (remboursements)
--chart-2  mesure opposée   (sorties)          --chart-5  le reste
--chart-3  synthèse         (net)
```

C'est ce qui garantit que « encaissements » a la même couleur sur la courbe,
dans la répartition et dans la légende.

### Ce qu'un graphique doit gérer

`loading` · `ready` · **0 point** (période sans mouvement → des mots) ·
**1 point** (une courbe d'un point est un pixel → le chiffre) · valeurs
négatives · `prefers-reduced-motion` · petit écran.

### L'accessibilité n'est pas optionnelle

Un graphique de librairie est un canevas dont les valeurs n'existent qu'au
survol — geste sans équivalent au clavier. `FinanceEvolutionChart` pose donc
`role="img"` avec une description, **et** rend un `<table className="sr-only">`
portant chaque seau et ses trois montants.

---

## 7. Les données

* **Aucun total reconstitué côté navigateur.** La liste est bornée par `limit` :
  additionner ses lignes donnerait un total plausible et faux. Tout vient de
  `/api/finances/summary` et `/api/finances/by-project`.
* **Les centimes restent des centimes** jusqu'à l'affichage. Seule exception,
  documentée : la conversion en euros pour l'axe d'un graphique, faite **après**
  toute addition.
* **Les transformations sont pures**, dans `lib/financeAnalytics.ts`, et
  testées (`tests/finance-analytics.test.js`).
* **Aucune tendance inventée.** Pas de période précédente (« depuis toujours »)
  ou période précédente à zéro → `null`, et l'écran n'affiche rien.
* **Attention au vocabulaire des dates.** L'API *rend* des instants ISO
  (`[startsAt, endsAt[`) mais *attend*, pour `CUSTOM`, deux dates civiles
  `AAAA-MM-JJ` dont la seconde est **INCLUSE**. Les confondre produit un `400`
  et la tendance disparaît **silencieusement**. C'est arrivé.
* **Aucune donnée de démonstration.** Les exemples des registres vivent sur des
  jeux fictifs ; un test vérifie qu'aucun n'a survécu.

---

## 8. Le responsive : les paliers suivent le **contenu**

La barre latérale reprend **250 px dès 900 px** de fenêtre. Il y a donc **moins
de place utile à 900 px (≈ 570 px) qu'à 768 px**, où elle est encore un tiroir.

> Un palier posé au réflexe `md:` fait déborder le tableau **juste après** le
> seuil du tiroir — sur la seule largeur où personne ne pense à regarder.

Les colonnes sortent donc à `sm`, `lg`, `xl` ou `2xl`. **`md:table-cell` est
interdit** dans les tableaux ; un test le vérifie.

Largeurs contrôlées : 1440, 1280, 1024, 768, 430, 390, 375, 320.

---

## 9. Ajouter quelque chose

### Un composant de registre

```bash
cd frontend
npx shadcn@latest add @bklit/<chart>       # ou @kokonutui/<composant>
```

Puis, systématiquement :

1. **rétablir `src/lib/utils.ts`** si la CLI l'a écrasé (voir §3.1) ;
2. **relire ce qui a été copié** — le badge à drapeaux d'Untitled UI appelait un
   serveur tiers à chaque affichage ; les composants Bklit sont écrits pour les
   types React 19 (`RefObject<T | null>`) et demandent une adaptation ;
3. **mettre à jour la liste close** des dépendances du frontend dans
   `tests/panel-meetings-ui.test.js` — elle est énumérée exprès ;
4. **vérifier les classes de couleur** utilisées et, si une famille nouvelle
   apparaît, l'ajouter au pont plutôt que d'accepter sa palette d'origine.

Ce que la CLI dépose en variables CSS va dans `styles/registry-generated.css`,
**importé avant** `styles/registry.css` : notre traduction gagne par cascade,
sans fusion manuelle.

### Un composant Untitled UI

```bash
npx untitledui@latest add <composant> -y
```

### Explorer les catalogues depuis Claude Code

`Panel/.mcp.json` déclare deux serveurs, sans aucun secret :

```json
{
  "mcpServers": {
    "shadcn":     { "command": "npx", "args": ["-y", "shadcn@latest", "mcp", "--cwd", "frontend"] },
    "untitledui": { "type": "http", "url": "https://www.untitledui.com/react/api/mcp" }
  }
}
```

* **shadcn** — chercher, lire et installer un composant Bklit ou Kokonut.
* **untitledui** — `list_components`, `get_component`, `search_components`,
  `get_page_templates`, `search_icons`, `get_component_bundle`. Les composants
  **free** ne demandent aucune authentification ; les **PRO** passent par OAuth,
  géré par le client. **Ne jamais écrire de clef ici.**

Le **skill Bklit** est installé dans `.claude/skills/` (cinq skills : `bklit-ui`,
`bklit-playground`, `bklit-studio`, `bklit-studio-chart-performance`,
`bklit-ship`). Il lit `npx shadcn info --json` pour connaître le projet, et
porte le catalogue et les règles de composition.

`npx skills add bklit/bklit-ui` les dépose dans `.agents/skills/` avec des liens
symboliques **absolus** vers ce poste, plus cinq skills sans rapport
(`pr-open`, `turborepo`, `unit-tests`, `wiki-llms-txt`, `add-x-tweet`). Ils ont
donc été **copiés** en dossiers réels dans `.claude/skills/`, les autres retirés,
et `skills-lock.json` supprimé : un fichier de verrouillage qui décrit dix skills
à des chemins inexistants est pire que pas de fichier du tout. Une réinstallation
future est une installation neuve, ce qui est le comportement voulu.

---

## 10. Ce que la refonte a touché

| Écran | Ce qui a changé |
|---|---|
| **Finances** | en-tête commun ; indicateurs avec période et tendance ; graphique composé Bklit ; répartition = graphique + tableau empilable ; filtres en contrôle segmenté |
| **Projets** | grille de cartes → tableau trié, recherche, filtre d'état, menu par ligne |
| **Fiche projet** | en-tête commun ; onglets `SmoothTabs` ; le bloc Finances hérite du nouveau tableau de bord |
| **Clients** | liste d'items → tableau trié ; outils dans l'en-tête du tableau |
| **Fiche client** | en-tête commun ; « Modifier » redevient l'action principale |

Les quinze autres écrans n'ont **pas** été touchés : ils continuent de vivre sur
`styles.css` et `components.css`. C'est ce que « refonte progressive » veut
dire, et c'est ce que le refus du préflight rend possible.
