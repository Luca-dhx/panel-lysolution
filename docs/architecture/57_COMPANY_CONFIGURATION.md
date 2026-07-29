# 57 — L'entreprise et sa configuration

> **Référence officielle.** Phase 4, LOTS 2, 3 et 4.
> Code : `backend/src/services/company/`, `models/PanelCompany*.model.js`.

---

## 1. Pourquoi une entreprise

Jusqu'à la Phase 4, le Panel ne connaissait que des projets et lui-même. Il
supervisait sans savoir **au nom de qui**.

L'entreprise est le propriétaire des projets et la source de leur identité
publique. Sans elle, chaque projet porterait son logo, ses mentions légales
et ses coordonnées en propre — et une adresse qui change devrait être
corrigée autant de fois qu'il y a de sites.

## 2. Multi-tenant par le modèle, mono-tenant par la résolution

`companyId` et `slug` sont des identifiants de premier ordre. Aucun schéma,
aucune projection, aucun payload de synchronisation ne suppose qu'il n'y a
qu'une entreprise.

**Un seul point du code le suppose** :

```js
export async function getActiveCompany() {
  return PanelCompany.findOne({ active: true }).lean();
}
```

Le jour où un second tenant apparaît, c'est cette fonction qui change — en
lisant un en-tête, un sous-domaine ou l'appartenance de l'utilisateur. Ni le
modèle, ni les projections, ni le pont ne bougent.

C'est le même raisonnement que pour les moteurs : la divergence doit passer
par un point unique et nommé.

## 3. Saisir n'est pas publier

C'est la distinction qui structure tout le reste.

| Acte | Effet | Diffusion |
|---|---|---|
| `PATCH /api/company` | modifie le **brouillon** | aucune |
| `POST /api/company/publish` | fige une **version** immuable | tout le parc appairé |

Sans cette séparation :

- corriger une faute de frappe dans une adresse déclencherait une
  synchronisation vers tous les projets ;
- un opérateur à mi-chemin d'une refonte de marque diffuserait un état
  incohérent — moitié anciennes couleurs, moitié nouvelles.

**Conséquence assumée** : un projet peut afficher une configuration plus
ancienne que ce que montre l'écran d'administration. C'est visible — la
version publiée, la date et un bandeau « modifications non publiées » sont
affichés en permanence — et c'est préférable à une diffusion continue non
maîtrisée.

## 4. Une version est un instantané immuable

On ne modifie pas une version : on en publie une nouvelle.

```text
PanelCompanyVersion
├── version        entier monotone par entreprise, jamais réattribué
├── payload        l'instantané COMPLET (dénormalisé à dessein)
├── reason         pourquoi cette version existe — EXIGÉ
├── changes[]      le différentiel, calculé À LA PUBLICATION
└── publishedAt / publishedBy
```

Trois choix méritent leur justification :

**Le payload est dénormalisé.** Une version doit rester lisible même si le
modèle évolue, et se relire sans reconstruire quoi que ce soit à partir d'un
différentiel.

**La raison est exigée.** Une version sans raison ne se relit pas dans six
mois. Le refus est explicite : *« Publication refusée parce qu'aucune raison
n'a été fournie. »*

**Le différentiel est figé à la publication.** Le recalculer plus tard
donnerait le résultat du code du jour, pas ce qui s'est réellement passé.

Publier une configuration identique à la précédente est refusé : cela
créerait une version vide, et enverrait au parc un travail inutile.

## 5. Restaurer, c'est publier

Revenir à une version antérieure **publie une version neuve** portant
l'ancien contenu. Le compteur reste monotone, l'historique reste linéaire, et
le retour en arrière est lui-même tracé.

Effacer une version pour « revenir » serait une perte d'audit : on ne
saurait plus que la configuration fautive a existé, ni combien de temps elle
a été appliquée.

## 6. Ce qu'un projet reçoit

`companyPublicProfile()` — et rien d'autre :

```text
companyId · slug · environment · version
identity   { name, legalName, tagline, description }
branding   { logos, couleurs, police }
domains    { primaryDomain, websiteUrl, wildcardBases }
contacts   { email, téléphone, support, adresse }
legal      { forme, SIRET, TVA, RCS, représentant, hébergeur, URLs }
settings   { locale, timezone, currency }
```

Tout y est destiné à être **affiché publiquement** par un site vitrine.
Aucun secret n'y transite : les identifiants d'API ont leur propre canal,
nominatif (§8).

Le `version` voyage avec la charge utile. C'est lui qui permet au projet de
savoir s'il est à jour, et au Panel de constater qu'il ne l'est pas.

## 7. La validation est la dernière barrière

Ce qui est accepté ici finit sur les sites publics. La validation refuse donc
ce qui casserait un rendu :

| Règle | Ce qu'elle évite |
|---|---|
| couleur hexadécimale stricte | une feuille de style cassée par une chaîne arbitraire |
| **https exigé** (http toléré sur localhost seul) | un logo bloqué par le navigateur sur une page https, sans erreur remontée |
| SIRET à 14 chiffres, TVA intracommunautaire | des mentions légales invalides |
| slug en minuscules, chiffres et tirets | une clé de synchronisation illisible |
| `settings` a des défauts appliqués | un projet qui ne saurait ni sa langue ni sa devise |

Chaque refus **nomme le champ et la contrainte**, jamais « données
invalides ».

## 8. Les API intégrées

Le Panel est le coffre des accès tiers de l'entreprise. Quatre règles, toutes
vérifiées par test :

### 8.1 Chiffré au repos

AES-256-GCM avec la clé du Panel, comme les `bridgeToken`.

### 8.2 Jamais rendu par `/api`

L'administration voit le fournisseur, le mode, **le nom des clés** et une
**empreinte courte** — jamais une valeur. L'empreinte suffit à répondre à la
seule question utile sans lire le secret : *ai-je bien remplacé cette clé ?*

### 8.3 Autorisation nominative, et effective

Une API ne part vers un projet que si elle lui est **nommément accordée**, par
une écriture de journal qui porte **son identifiant en destinataire**
(`audience`).

C'est ce qui rend l'autorisation effective plutôt que déclarative : avant la
Phase 4, un projet tirait tout le journal — donc les identifiants destinés à
un autre. Le filtre ne pouvait pas être appliqué à la lecture par le projet ;
il devait être porté par l'écriture, côté Panel.

La restriction par clé permet d'accorder la clé publique d'un fournisseur de
paiement sans la clé secrète.

### 8.4 Le mode suit le projet

Un projet en TEST reçoit les identifiants **TEST**, quel que soit le mode
affiché côté Panel. Le projet vérifie une **seconde fois** à réception et
refuse une charge utile dont le mode ne correspond pas au sien.

Deux barrières pour la même erreur, parce que c'est exactement le genre
d'accident — une clé de production livrée à une recette — qu'on ne veut
découvrir qu'une fois.

### 8.5 Une valeur vide n'efface pas

Piège classique des formulaires qui masquent les secrets : enregistrer
effacerait toutes les clés non ressaisies. Ici, une valeur vide **conserve**
la clé ; la retirer se demande explicitement.

## 9. Surface HTTP

`/api/company` — lecture par tout utilisateur, **écriture réservée aux DEV**.

| Méthode | Route | Effet |
|---|---|---|
| GET | `/` | l'entreprise et sa version publiée |
| PATCH | `/` | modifie le brouillon |
| POST | `/publish` | fige une version et la diffuse |
| GET | `/versions` | historique |
| POST | `/versions/:v/restore` | republie une version antérieure |
| GET | `/integrated-apis` | inventaire, sans aucune valeur |
| PUT | `/integrated-apis/:id/credentials/:mode` | enregistre des identifiants |
| POST | `/integrated-apis/:id/grants` | accorde l'accès à un projet |
| DELETE | `/integrated-apis/:id/grants/:projectId` | révoque |

La restriction aux DEV n'est pas hiérarchique : ces routes portent les accès
aux services tiers et l'identité publique de **tous** les sites. Une erreur
ici se voit sur l'ensemble du parc.

## 10. Limites connues

- **Un seul tenant actif.** Créer une seconde entreprise active est refusé
  explicitement, plutôt que de désactiver silencieusement l'existante.
- **Pas de validation des URLs distantes.** Un logo en `https` bien formé
  mais introuvable sera diffusé tel quel : le Panel ne va pas chercher les
  ressources qu'il annonce.
- **Pas de rétention sur les versions.** L'historique croît indéfiniment.
- **Pas de test de connexion aux API.** Le Panel range des identifiants ; il
  ne vérifie pas qu'ils fonctionnent chez le fournisseur.
