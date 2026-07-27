# 28 — Le `duplication-engine` : moteur de duplication standard

> **Référence officielle de l'écosystème L.Y Solution.** Ce document décrit
> un composant présent, à l'identique, dans TOUS les projets de l'écosystème.
> Code : `backend/src/duplication-engine/`.
> Établi en Phase 2D (standardisation des moteurs).

---

## 1. La règle

> **Tout projet L.Y Solution embarque son propre moteur de duplication.**
> Il n'existe pas de « projet maître » : chaque projet sait se copier
> lui-même.

C'est la conséquence directe du modèle économique de l'écosystème : un projet
livré est complet. Son acheteur peut le dupliquer sans nous, sans réseau vers
un dépôt tiers, sans licence à renouveler.

## 2. La frontière avec le déploiement

> **Le moteur de duplication ne déploie JAMAIS.**

| Moteur | Responsabilité | S'arrête quand |
|---|---|---|
| `duplication-engine` | **créer** un nouveau projet complet et prêt à vivre | la copie existe, ses bases sont initialisées, son `.env` est écrit |
| `deployment-engine` | **mettre en ligne** un projet existant | le service répond publiquement |

La dépendance est **à sens unique** : `duplication-engine` → `deployment-engine`
(il en réutilise des primitives locales). Le moteur de déploiement n'importe
jamais le moteur de duplication.

```text
duplication-engine          deployment-engine
   crée le projet    ─────▶    le met en ligne
   (bases, secrets,           (préflight, build,
    .env, seeds)               Nginx, HTTPS, PM2)
```

## 3. Ce que fait la duplication

| # | Étape | Garantie |
|---|---|---|
| 1 | Test de la connexion Mongo | échec explicite plutôt que copie inutilisable |
| 2 | Création de la base **TEST** | idempotente |
| 3 | Création de la base **PROD** | idempotente |
| 4 | Validation des deux connexions | la copie ne démarre pas sur une base fantôme |
| 5 | **Copie physique** du projet courant | liste d'exclusion (`node_modules`, `.git`, `dist`, …) |
| 6 | **Régénération des secrets** | voir §4 — le point le plus important |
| 7 | Réécriture du `.env` | bases, identité, dépôt cible, compte DEV initial |
| 8 | Seeds | compte DEV et données minimales |

L'initialisation d'une base n'insère jamais de document factice : elle crée
les index réels des modèles et le singleton de configuration système —
exactement ce que ferait l'application à son premier démarrage.

## 4. La régénération des secrets — la correction de la Phase 2D

### Le défaut corrigé

Avant la Phase 2D, la duplication recopiait le `.env` de la source en ne
changeant que les noms de bases. **Une copie héritait donc du `JWT_SECRET` et
des clés de chiffrement de son projet source.**

Conséquence : compromettre un projet revenait à compromettre tous ceux qui en
descendaient — sessions forgeables, secrets déchiffrables. Cela contredisait
frontalement la règle posée en Phase 2C
([24_ENVIRONMENT_AND_DOMAINS.md](24_ENVIRONMENT_AND_DOMAINS.md) §5) :

> « Ne JAMAIS réutiliser le secret d'un autre projet ou d'un autre
>   déploiement : chaque déploiement possède le sien. »

### La règle appliquée

Chaque secret déclaré dans `config/duplication.profile.js` est **régénéré**
aléatoirement (source cryptographique) dans toute copie :

| Projet | Secrets régénérés |
|---|---|
| **Panel** | `JWT_SECRET` (64 octets), `BRIDGE_ENCRYPTION_KEY` (32 octets) |
| **Projet vitrine** | `JWT_SECRET` (64 octets), `INTEGRATED_API_ENCRYPTION_KEY` (32 octets) |

Trois propriétés vérifiées par les tests :

1. le secret de la source n'apparaît **jamais** dans la copie ;
2. deux copies successives reçoivent des secrets **différents** ;
3. les secrets restent **injectables**, pour que les tests soient
   déterministes sans affaiblir le comportement par défaut.

Les valeurs générées ne sont ni journalisées, ni retournées par une API :
elles ne servent qu'à écrire le `.env` de la copie.

## 5. Le profil de duplication

`config/duplication.profile.js` — la seule porte de personnalisation :

| Clé | Rôle |
|---|---|
| `SECRETS_TO_GENERATE` | quels secrets régénérer, sur combien d'octets, et **pourquoi** (la raison est documentée dans le code) |
| `ENV_KEYS` | quelles variables l'assistant impose (bases, identité, dépôt cible, compte DEV) |

Exemple de divergence légitime : le Panel nomme son projet via `PANEL_NAME`
et chiffre avec `BRIDGE_ENCRYPTION_KEY` ; un projet vitrine utilise
`PROJECT_NAME` et `INTEGRATED_API_ENCRYPTION_KEY`. Le cœur, lui, est
identique.

## 6. Validation des entrées

Refus explicite, jamais silencieux :

| Entrée | Règle |
|---|---|
| Nom de projet | 1 à 80 caractères, jeu restreint |
| Nom de dossier | assaini, jamais vide |
| Bases TEST / PROD | format strict, et **obligatoirement différentes** |
| E-mail DEV | format vérifié |
| Mot de passe DEV | longueur minimale |
| Dépôt GitHub cible | normalisé vers la forme canonique — **jamais** celui de la source |
| Dossier cible existant | refusé (aucun écrasement) |

## 7. Versionnement

`engine.manifest.json`, mêmes règles que le moteur de déploiement
([27](27_DEPLOYMENT_ENGINE_STANDARD.md) §7) : le moteur connaît sa version,
un correctif de cœur est porté partout, `lastStandardization` date le dernier
alignement.

## 8. Contrôle de dérive

Couvert par le même `tests/engine-drift.check.mjs` : inventaire identique,
cœur identique, profil personnalisé, versions alignées. Outil d'atelier,
aucune dépendance runtime.

## 9. Limites connues

| Limite | État |
|---|---|
| Duplication d'un Panel réellement exécutée | ⏳ jamais lancée — les primitives sont en place et testées, le scénario complet reste à jouer |
| Préparation de l'appairage de la copie | ⏳ la copie démarre non appairée (état STANDALONE normal) ; l'appairage reste une action explicite |
| Reprise après copie partielle | le moteur refuse un dossier cible existant ; il ne reprend pas une copie interrompue |
| Migration de données entre copies | hors périmètre — une copie part avec des bases neuves |

## 10. Interdits

1. ❌ Déployer depuis le moteur de duplication.
2. ❌ Recopier un secret de la source dans une copie.
3. ❌ Recopier l'URL du dépôt source dans une copie.
4. ❌ Écraser un dossier ou une base existants.
5. ❌ Forker le cœur pour un projet.
6. ❌ Faire dépendre le moteur d'un service du projet hôte.
