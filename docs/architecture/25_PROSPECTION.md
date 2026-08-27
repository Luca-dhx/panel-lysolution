# 25 — La prospection

> Le carnet des affaires qui ne sont **pas encore** des clients, et le premier
> écran de la refonte progressive de l'interface.

---

## 1. Ce qu'un prospect n'est pas

Le Panel connaissait déjà deux voisins immédiats, et les confondre coûte cher :

| Entité | Ce qu'elle est |
|---|---|
| `PanelProject` | une **instance technique** appairée : elle tourne, elle a une adresse, un pont, une version. |
| `PanelClientCompany` | une **personne morale** à qui l'on facture : SIREN, adresse, signataire. |
| `PanelProspect` | **ni l'un ni l'autre** : souvent un nom, un numéro, une note. |

Ranger un prospect dans l'une des deux collections existantes aurait obligé à
inventer des champs vides — un SIREN qu'on ne connaît pas, un projet qui
n'existe pas — puis à filtrer partout pour ne pas facturer quelqu'un qui n'a
jamais rien signé.

**Le seul champ obligatoire est le nom.** On note un prospect au moment où on
l'apprend, pas quand le dossier est complet : exiger un e-mail valide dès la
création aurait fait perdre exactement les affaires qu'on veut suivre.

## 2. Le statut ne bouge que par une décision humaine

| Code | Libellé | Couleur |
|---|---|---|
| `WAITING` | En attente | gris |
| `IN_PROGRESS` | En cours | orange |
| `PLANNED` | Planifié | bleu |
| `SIGNED` | Signé | vert |
| `LOST` | Perdu | rouge |

Aucune règle ne fait avancer un prospect toute seule. Ni le temps, ni une
réunion tenue, ni un e-mail envoyé : c'est un jugement commercial, et il
appartient à la personne qui suit l'affaire. Un automatisme se tromperait
silencieusement — et ferait croire l'affaire vivante alors qu'elle est morte
depuis six semaines.

**Toutes les transitions sont permises**, retours en arrière compris. Une
affaire perdue se rouvre ; un « signé » cliqué par erreur se corrige.
L'interdire ne rendrait pas le pipeline plus vrai : cela pousserait à créer un
doublon pour dire le contraire. Ce qui protège l'information n'est donc pas
l'interdiction mais la **trace** : `statusHistory` consigne l'avant, l'après,
l'auteur, la date et le motif éventuel.

## 2 bis. La nature de l'affaire — un second axe

| Code | Libellé | Ce que ça veut dire |
|---|---|---|
| `CREATION` | Conception | il n'a pas de site : on en crée un. |
| `REDESIGN` | Refonte | il en a déjà un : on le refait. |

`status` répond à **où en est-on ?** — il bouge, c'est tout son intérêt. `type`
répond à **que fait-on ?** — il ne bouge presque jamais. Les fondre en une
seule liste aurait produit dix états (« refonte en cours », « conception en
cours », …) : compter les affaires en cours aurait demandé d'additionner deux
colonnes.

Le type ne produit **aucune entrée d'historique** : ce n'est pas une étape du
pipeline, c'est une caractéristique de l'affaire. Il passe donc par le `PATCH`
général, là où le statut a sa route à lui.

**Deux teintes que le thème ne possède pas.** Le statut occupe déjà les cinq
intentions du Panel (gris, orange, bleu, rouge, vert) et le thème n'a que
quatre couleurs réglables : il n'y avait pas de violet à emprunter. Les deux
teintes du type sont donc **synthétisées par mélange** dans `bridge.css` —
primaire × accent, primaire × danger. Elles restent dérivées du thème et le
suivent, sans coller à aucun statut. Elles empruntent les noms `indigo` et
`purple` parce que ce sont ceux que les badges de la librairie connaissent.

Et une **forme** différente, parce que la couleur ne suffit jamais : le statut
est une pastille à puce, le type une pastille à icône.

**Compatibilité.** Les fiches créées avant ce champ ne le portent pas, et
`.lean()` n'applique aucun défaut de schéma. Le filtre `type=CREATION` demande
donc « ce n'est pas une refonte » (`$ne`), et l'interface retombe explicitement
sur `CREATION` (`prospectType()`). Même précaution que `subjectType`, pour la
même raison : pas de migration.

## 3. Le suivi n'est pas un second agenda

Un rendez-vous de prospection est un rendez-vous : même agenda, même imminence,
même conversion « à confirmer » à l'échéance, mêmes participants. Lui donner sa
propre collection aurait dupliqué l'ordonnanceur, la machine à états et trois
écrans — pour finir avec deux agendas qui divergent.

`PanelMeeting` et `PanelProjectEvent` portent donc un discriminant :

```text
projectId    l'identifiant du SUJET, quel qu'il soit
subjectType  'PROJECT' (défaut) | 'PROSPECT'
```

Le champ `projectId` n'a **pas** été renommé : des milliers de documents le
portent déjà, et une migration de renommage aurait été un risque pris pour un
confort de vocabulaire.

### L'invariant de lecture — et pourquoi il est le vrai risque du lot

Les documents écrits **avant** ce lot n'ont pas le champ du tout. Une requête
`{ subjectType: 'PROJECT' }` ne les trouverait donc pas : l'agenda de tous les
clients se serait vidé le jour du déploiement, sans erreur et sans trace.

> Les lectures demandent l'**absence de prospect** (`{ $ne: 'PROSPECT' }`),
> jamais la présence de projet.

C'est ce qui permet d'ajouter ce champ **sans migration**. Une recette dédiée
(`tests/prospection.test.js`, section 4) fabrique un document « à l'ancienne »
et vérifie qu'il reste visible.

L'agenda **global**, lui, ne filtre rien : l'équipe n'a qu'un seul agenda, et un
rendez-vous de prospection absent de « Réunions à venir » serait un rendez-vous
manqué. C'est le bouton de fin de ligne qui s'adapte — il mène à
`/prospection/:id` ou à `/projects/:id` selon le sujet.

## 4. Qui peut quoi

| Surface | Lecture | Écriture |
|---|---|---|
| `/api/prospects` | tout compte du Panel | **tout compte du Panel** |
| `/api/client-companies` | tout compte du Panel | comptes DEV uniquement |

La différence est assumée. Ce qui s'écrit sur une entreprise cliente décide de
l'identité portée par des **factures** et des **contrats signés** : une erreur
s'y voit chez un tiers, sur une pièce comptable. Un prospect n'engage rien — il
ne facture pas, ne signe pas, ne s'affiche nulle part. C'est le carnet de
l'équipe commerciale, comme l'agenda, ouvert pour la même raison.

**Rien ne sort du Panel.** Aucune route du pont n'expose les prospects et la
synchronisation ne transporte pas cette entité.

### Les images

`POST /api/prospects/images` reçoit les images des fiches. La **mécanique** est
strictement celle des médias de marque — validation sur les octets, relais vers
l'autorité média, réencodage unique en WebP — et elle n'est pas dupliquée : les
deux routes montent `services/upload/imageEndpoint.js`. Seule la **garde**
diffère, parce qu'une photo de devanture ne s'affiche sur aucun site client.

Le relais vise `/api/prospects/images` chez l'autorité, et non
`/api/uploads/image` : cette dernière est gardée par `requirePanelDev`, et un
compte de gestion aurait vu son import réussir en local puis échouer en ligne.

La fiche ne conserve qu'un **chemin relatif** (`/uploads/…`) : l'identité d'un
média ne dépend pas du domaine depuis lequel on le regarde.

## 5. La refonte progressive de l'interface

Le tableau de prospection est le premier écran bâti sur **Untitled UI** (React
Aria + Tailwind v4). Ses composants sont **copiés** dans le dépôt
(`frontend/src/components/base`, `components/application`) — ce ne sont pas des
paquets ; seules leurs quatre dépendances d'exécution entrent au
`package.json`.

Trois décisions gouvernent l'intégration :

1. **Aucun préflight.** `styles/uui.css` importe le thème et les utilitaires de
   Tailwind, jamais la remise à zéro globale : elle aurait réécrit `h1`, `ul`,
   `button`, `input`, `table` pour le document entier et cassé d'un coup les
   190 ko de CSS écrits à la main. Une remise à zéro **locale**, sous `.uui`,
   la remplace — et elle est écrite en `:where(…)`, donc de spécificité nulle :
   `.btn` et `.card` gagnent toujours à l'intérieur d'un écran refondu.
2. **Les utilitaires ne sont pas dans une couche.** Une règle hors `@layer`
   l'emporte sur toute règle en couche : mises en `@layer utilities`, les
   classes Tailwind auraient perdu contre le moindre sélecteur de `styles.css`.
3. **La palette est branchée sur le thème du Panel.** `styles/bridge.css`
   redéfinit les deux échelles dont Untitled UI dérive toute sa sémantique
   (`--color-neutral-*`, `--color-brand-*`) à partir des quatre couleurs de
   `tokens.css`. `neutral-25` est le **fond**, `neutral-950` le **texte** : sur
   un thème sombre l'échelle s'inverse toute seule. Sans ce pont, une carte
   blanche se serait posée sur un fond sombre — et pas une couleur n'est écrite
   en dur.

**Les paliers responsive se calent sur la largeur du CONTENU, pas de la
fenêtre.** La barre latérale reprend 250 px dès 900 px : il y a donc moins de
place à 900 px (≈ 570 px utiles) qu'à 768 px (≈ 736 px, la barre étant encore un
tiroir). Un palier posé à `md` — le réflexe — fait déborder le tableau juste
après le seuil du tiroir, sur la seule largeur où personne ne pense à regarder.

Le reste de la page (filtres, formulaire, boutons) demeure sur le style maison.
C'est ce que « progressif » veut dire : un écran passe à la librairie quand on
le refait.

### Ajouter un composant de la librairie

```bash
cd frontend
npx untitledui@latest add <composant> -y   # ex. : add table, add modal
```

La CLI **copie** le composant et ses dépendances internes dans
`src/components/…` puis installe ce qui manque au `package.json`. Trois
vérifications après coup, apprises sur le premier lot :

- **relire le composant copié** — celui des badges chargeait ses drapeaux
  depuis un `<img>` pointant vers le site de la librairie, soit une requête
  vers un serveur tiers depuis un outil interne à chaque affichage. Le contrôle
  d'architecture le refuse, et il a raison ;
- **mettre à jour la liste fermée** des dépendances du frontend dans
  `tests/panel-meetings-ui.test.js` — elle est énumérée exprès, pour qu'une
  dépendance de plus soit une décision ;
- **passer les couleurs par `bridge.css`** si le composant en introduit de
  nouvelles, plutôt que d'accepter la palette claire d'origine.

## 6. Fichiers

```text
backend/src/models/PanelProspect.model.js
backend/src/services/prospection/prospects.service.js
backend/src/controllers/prospects.controller.js
backend/src/routes/prospects.routes.js
backend/src/services/upload/imageEndpoint.js      partagé avec /api/uploads

frontend/src/pages/ProspectionPage.tsx
frontend/src/pages/ProspectDetailPage.tsx
frontend/src/components/prospection/              tableau, formulaire, statut
frontend/src/styles/                              uui.css, theme.css, bridge.css

tests/prospection.test.js
```
