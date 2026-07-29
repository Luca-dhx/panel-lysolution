# 58 — Le protocole de bout en bout

> **Référence officielle.** Phase 4, LOT 9.
> Code : `Panel/tests/ecosystem-e2e.test.js`.

---

## 1. Ce qui rend ce test différent de tous les autres

Toutes les suites précédentes éprouvaient **un côté à la fois**, l'autre
étant simulé — client stub côté projet, transport factice côté Panel. Elles
prouvaient que chaque moitié respecte le contrat *tel qu'elle le comprend*.

Ce test fait tourner **les deux backends réels simultanément** :

| | |
|---|---|
| deux processus | le Panel dans le processus de test, le projet dans un enfant |
| deux ports | attribués par le système |
| deux bases MongoDB | deux serveurs distincts en mémoire |
| un seul point de contact | **HTTP** |

- aucun client simulé — le vrai `ProjectBridgeClient`, le vrai `PanelClient` ;
- aucun store en mémoire — deux bases séparées, comme en production ;
- aucune fonction interne appelée d'un côté à l'autre.

**Si le contrat diverge entre les deux dépôts, ce test échoue.** C'est
précisément ce qu'aucun test unilatéral ne peut détecter.

## 2. Pourquoi un processus séparé

Les deux backends déclarent leurs modèles sur le **même registre global** de
Mongoose et lisent `process.env` à l'import de leur configuration. Les
charger côte à côte les ferait se recouvrir — et le test ne prouverait plus
que deux applications distinctes savent se parler, ce qui est son objet.

L'amorce du projet (`tests/helpers/project-e2e-boot.mjs`) exécute le
**bootstrap complet**, pas un raccourci : c'est lui qui branche la
persistance de l'appairage, les applicateurs de configuration et
l'ordonnanceur. Le court-circuiter donnerait un projet qui ne ressemble pas à
celui qui tourne en production.

## 3. Le scénario, dans l'ordre

| # | Étape | Ce qui est prouvé |
|---|---|---|
| 1 | démarrage du Panel | il répond, on s'y connecte |
| 2 | création de l'entreprise | validation, défauts appliqués, refus nommant le champ |
| 3 | publication v1 | raison exigée, republication à vide refusée |
| 4 | création d'une API + identifiants | **les valeurs ne ressortent jamais de `/api`** |
| 5 | déclaration du projet | code à usage unique délivré |
| 6 | sonde d'une adresse morte | un constat, pas une erreur |
| 7 | démarrage du projet | son ProjectBridge répond, non appairé |
| 8 | sonde de l'adresse vivante | contrat lu **dans l'en-tête**, jugé compatible |
| 9 | **appairage réel** | le projet appelle le Panel, reçoit son jeton |
| 10 | découverte descendante | il reçoit l'**entreprise** dès l'appairage, aucune API |
| 11 | heartbeat réel | le Panel le voit **EN LIGNE** |
| 12 | `DISCOVER_PROJECT` | identité, Manifest, **convergence** relevés |
| 13 | autorisation d'une API | livrée en TEST, **restreinte à la clé accordée** |
| 14 | modification du brouillon | le projet **ne bouge pas** — saisir n'est pas publier |
| 15 | publication v2 | différentiel calculé, nommant les chemins |
| 16 | synchronisation | le projet applique la v2 |
| 17 | re-découverte | le Panel **constate** la convergence en v2 |
| 18 | seconde synchronisation | idempotence : rien n'est réappliqué |
| 19 | révocation | le projet **oublie** l'API |
| 20 | extinction du Panel | le projet **ne tombe pas** et garde son identité |
| 21 | redémarrage du Panel | reconnexion **sans ré-appairage** |

75 assertions.

## 4. Les points qui comptent le plus

**Étape 4 — l'étanchéité des secrets.** L'assertion ne vérifie pas qu'un
champ est absent : elle cherche la **chaîne du secret** dans la réponse HTTP
entière. Un secret qui fuirait par un champ imprévu serait détecté.

**Étape 13 — l'autorisation est effective.** Le projet reçoit
`publishableKey` et **pas** `secretKey`, alors que les deux sont enregistrées
côté Panel. C'est la preuve que la restriction par clé n'est pas cosmétique.

**Étape 14 — la séparation saisir/publier.** Après un `PATCH`, le projet
affiche toujours l'ancienne couleur. C'est le comportement voulu, et il est
verrouillé.

**Étapes 20-21 — l'autonomie.** Le Panel est réellement éteint (`server.close`)
puis rouvert sur le même port. Le projet continue de servir, garde
l'entreprise appliquée, et se reconnecte sans ré-appairage : les
`bridgeToken` ont survécu des deux côtés, chiffrés en base.

## 5. Ce que ce test NE prouve pas

Il tourne sur `127.0.0.1`. Il ne prouve donc **rien** sur :

- le DNS et sa propagation ;
- les certificats TLS et leur renouvellement ;
- nginx, son reverse proxy, ses en-têtes ;
- PM2, les redémarrages, les signaux ;
- un pare-feu, des ports fermés, un NAT.

C'est l'objet de la recette VPS (`33_VPS_ACCEPTANCE.md`), qui exige une cible
réelle et **n'a pas été exécutée**.

Ce test prouve le **protocole**. Il le prouve entièrement. Il ne prouve pas
l'**hébergement**.

## 6. Exécution

```bash
cd Panel && node tests/ecosystem-e2e.test.js
```

Il est chaîné dans `npm test` du Panel. S'il ne trouve pas SB Auto 06 à côté,
il **saute proprement** avec un message explicite : les deux dépôts sont
indépendants et peuvent être clonés séparément. Un dépôt seul reste
parfaitement valide.

Compter environ 60 à 90 secondes : deux serveurs MongoDB éphémères démarrent,
et le bootstrap complet du projet s'exécute.

## 7. Que faire quand il échoue

| Symptôme | Cause probable |
|---|---|
| « le projet n'a pas démarré à temps » | dépendances non installées côté projet, ou MongoDB indisponible |
| échec au contrat (409) | les miroirs des deux dépôts ont divergé — comparer les `CONTRACT_VERSION` |
| l'appairage échoue | `PROJECT_NAME` ne produit pas le `projectKey` attendu |
| la convergence reste en v1 | l'applicateur du projet n'est pas branché — vérifier le bootstrap |

Si ce test passe et qu'une installation manuelle échoue, la différence est
dans le `.env`, pas dans le code : c'est précisément à cela qu'il sert.

## 8. Les autres suites, et ce qu'elles gardent

Ce test ne remplace rien. Chaque suite garde un invariant que les autres ne
voient pas :

| Suite | Ce qu'elle verrouille |
|---|---|
| `bridge-conformity` | specs ↔ miroir, exclusivité des imports |
| `architecture` | qui a le droit de parler réseau, de lire l'environnement |
| `execution` | machine à états, politiques, refus expliqués |
| `diagnostic` | déterminisme, aucune horloge implicite |
| `ecosystem-e2e` | **les deux dépôts parlent réellement la même langue** |

Total au terme de la Phase 4 : **1150 assertions** côté Panel (20 fichiers),
**2392** côté SB Auto 06 (53 scripts).
