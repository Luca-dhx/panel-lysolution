# 64. LA FACTURE LÉGALE — identité, ventilation, mentions

## 1. Le point de départ : une facture réellement émise

```text
Facture QWSK7ZZY-0004 · 21 août 2026

Facturer à :   CTR-2026-0002
               luca.duhoux@icloud.com

Montant        95,99 €
Sous-total     95,99 €
Total          95,99 €
```

Sept manques, tous vérifiables :

1. « Facturer à » porte un **numéro de contrat** à la place d'une raison sociale ;
2. aucune raison sociale ;
3. aucune adresse légale du client ;
4. aucun SIREN ;
5. aucun numéro de TVA du client ;
6. aucune ventilation HT / TVA / TTC ;
7. aucun montant de TVA.

Les causes sont **deux**, et elles sont indépendantes.

## 2. Cause n° 1 — le Panel ne savait pas qui était le client

Voir [63_CLIENT_COMPANY.md](63_CLIENT_COMPANY.md). Faute de personne morale, le
seul nom disponible au moment de créer le client Stripe était la référence du
contrat.

### Ce que Stripe reçoit désormais

`stripeCustomerAuthority.buildParams()` — depuis `PanelClientCompany`, et de
nulle part ailleurs :

| Champ Stripe | Source | Ce qu'il imprime |
|---|---|---|
| `name` | `legalName` | la **raison sociale**, en tête de « Facturer à » |
| `email` | `billingEmail` | le destinataire de la facture |
| `address[*]` | adresse de facturation **effective** | sous la raison sociale |
| `phone` | `phone` | facultatif |
| `tax_ids[]` | `vatNumber` | le seul emplacement où Stripe imprime la TVA de l'acheteur |
| `metadata.clientSiren` | `siren` | corroboratif — voir §5 pour l'affichage |
| `metadata.contractReference` | référence du contrat | **référence commerciale**, jamais une identité |

Le nom commercial (`tradingName`) n'y figure **pas** : « SB Auto 06 » peut être
l'enseigne d'une « SARL DUPONT AUTOMOBILES », et c'est la seconde qui engage.

### `customer.ensure` fait désormais CONVERGER

Le verbe s'appelle « ensure » : il doit garantir que le client **EST** ce que le
Panel dit, pas seulement qu'il existe.

Avant, le client était créé une fois et jamais relu en écriture. Conséquences
directes : une entreprise rattachée APRÈS l'ouverture du contrat gardait chez
Stripe le client anonyme du premier jour, et un déménagement n'atteignait jamais
le fournisseur.

La mise à jour est **conditionnée à un écart réel** — comparer l'état relu à
l'état voulu évite un appel fournisseur par ouverture de paiement pour ne rien
changer. L'adresse est comparée champ par champ : Stripe rend toujours les cinq
clés, à `null` pour celles qu'on n'a pas envoyées, et une comparaison
structurelle conclurait à un écart permanent.

**L'historique ne bouge pas.** Une facture Stripe déjà émise porte une COPIE de
l'identité au moment de l'émission : modifier le client aujourd'hui ne réécrit
aucune facture d'hier.

### Le paiement unique référence lui aussi son client

`mode: payment` ouvrait une session **sans** client : Stripe en créait un à la
volée depuis ce que l'acheteur saisissait dans le formulaire. La facture portait
donc l'adresse tapée par la personne devant l'écran.

Les frais de lancement et l'abonnement d'un même contrat référencent maintenant
le MÊME client : même raison sociale, même adresse, même numéro de TVA, même
historique de facturation.

Les **prestations ponctuelles** font exception, et c'est cohérent : elles n'ont
pas de contrat (`intent.contractId === null`), donc pas de client dérivable — le
client Stripe est lié au CONTRAT, c'est la doctrine de L6.2D.

## 3. Cause n° 2 — la ventilation n'existait nulle part

### La doctrine tarifaire, telle qu'elle est

Auditée, pas supposée :

```text
Contract.pricing.launchFee     amountExcludingTax · taxRate · taxAmount · amountIncludingTax
Contract.pricing.subscription  idem
Contract.taxRate               le taux PAR DÉFAUT du contrat
```

Le projet calcule déjà les quatre. **Il ne les publiait pas** : la projection ne
transportait que `amountIncludingTax`, et le Panel ne connaissait donc que le
TTC. Il ne pouvait produire qu'un document muet sur la taxe.

L'autorité fiscale est le **contrat**, et elle le reste. Le Panel ne détient
aucune fiscalité propre, et ce chantier ne lui en donne pas : il n'y a ni taux
par défaut, ni table de taux, ni moteur fiscal.

### Ce qui a changé

Contrat de pont **1.10.0** (additif) :

```text
Contract.pricing.*.amountExcludingTax   le HT, en centimes
Contract.pricing.*.taxAmount            la TVA, en centimes
Contract.pricing.*.taxRate              le taux de CETTE ligne, en pourcentage
```

**Transporté, jamais déduit.** `HT = round(TTC / (1 + taux/100))` semble
suffire ; elle ne rend pas toujours le centime que le CONTRAT a calculé. Le
projet part du HT et arrondit la TVA ; la déduction part du TTC et arrondit le
HT. Sur 95,99 € à 20 %, les deux chemins peuvent différer d'un centime — et cet
écart apparaîtrait entre le contrat signé et la facture émise.

### Ce qui est VÉRIFIÉ avant toute facture

`contractFiscalLine.readFiscalLine()` — deux égalités, toutes deux exigées :

```text
HT + TVA = TTC              la ligne s'additionne
TVA = round(HT × taux)      la TVA est bien celle du taux annoncé
```

La seconde n'est pas redondante : une ligne cohérente en somme mais dont le taux
affiché ne correspond pas au montant — 79,99 € HT, 16,00 € de TVA, « taux :
5,5 % » — passerait, et la facture mentionnerait un taux faux à côté d'un montant
juste.

On **refuse** plutôt que de corriger : corriger reviendrait à décider, à la place
du contrat, lequel des trois nombres a tort.

Sans ventilation du tout (projection antérieure à 1.10.0), le refus est NOMMÉ —
`CONTRACT_TAX_BREAKDOWN_ABSENT` — et il dit quoi faire : redéployer le projet.
Jamais un taux supposé. C'est le même arbitrage que `resolveTaxRate` pour les
prestations ponctuelles : « il aurait été facile d'écrire `?? 20` », et cette
ligne aurait facturé un taux que personne n'a décidé.

## 4. La stratégie fiscale chez Stripe

### Ce qui est retenu : un `TaxRate` explicite, EXCLUSIF

```text
unit_amount   = le HORS TAXE
tax_rates[]   = un TaxRate {percentage, inclusive: false, country: 'FR', tax_type: 'vat'}
```

Stripe imprime alors :

```text
Sous-total          79,99 €
TVA (20 %)          16,00 €
Total               95,99 €
```

### Pourquoi pas `automatic_tax`

`automatic_tax` délègue à Stripe Tax le CALCUL du taux à partir de l'adresse du
client. C'est un produit payant, il exige une adresse validée et des
inscriptions fiscales déclarées par juridiction — et surtout, **il décide du
taux**.

Or le taux est déjà décidé : il est écrit dans le contrat, il a été accepté par
le client, il figure dans le PDF qu'il a signé. Laisser un tiers le recalculer,
c'est accepter qu'il en trouve un autre.

### Pourquoi pas `inclusive: true` sur le TTC

Un taux inclusif appliqué au TTC afficherait « Total 95,99 € dont 16,00 € de
TVA » — lisible, mais le sous-total imprimé resterait le TTC. La ventilation
attendue par une facture française sépare le HT du total.

### Le pays d'imposition est celui du VENDEUR

`country: 'FR'` — L.Y Solution. Pas celui de l'acheteur : c'est le régime de TVA
française sur des prestations rendues à un client français, tel que le contrat
l'établit. Le déduire de l'adresse du client ferait dépendre le taux d'un champ
de fiche, et changerait la fiscalité d'un contrat déjà signé au premier
déménagement.

### La convergence du catalogue

`stripeTaxRateAuthority.ensureTaxRate()` LIT `GET /v1/tax_rates` et ne crée que
si le taux manque. Stripe ne déduplique rien : sans cette lecture, chaque
paiement ajouterait un « TVA 20 % » de plus, et le tableau de bord comptable
deviendrait illisible en quelques semaines.

Un `TaxRate` est **immuable** sur ses termes — une mémoire de processus est donc
sûre, et il n'y a aucune invalidation à prévoir. Elle n'est pas persistée : une
base partagée entre TEST et un compte Stripe changé ferait resservir un
identifiant qui n'existe plus.

**Ce verbe n'est pas une capacité.** Aucun projet ne peut le demander : il
pourrait peupler le catalogue fiscal du compte.

### L'abonnement

Le `Price` porte le HT et déclare `tax_behavior: 'exclusive'` ; le taux
s'applique à l'ABONNEMENT (`subscription_data.default_tax_rates`), donc à
**chaque facture qu'il émettra** — y compris celles de l'an prochain, qu'aucun
code ne repassera composer.

`tax_behavior` est écrit explicitement bien que `unspecified` donne aujourd'hui
le bon résultat : « le bon résultat par défaut » est exactement ce qu'il ne faut
pas facturer. Le jour où ce défaut change, ou le jour où quelqu'un active Stripe
Tax sur le compte, un abonnement à 79,99 € HT deviendrait un abonnement à
79,99 € TTC — et il manquerait seize euros à chaque prélèvement.

### Effet sur les tarifs existants

Le montant entre dans `priceOperationId`. Passer du TTC au HT change la clé : un
contrat qui ouvre un NOUVEL abonnement obtient un NOUVEAU `Price`. C'est
exactement ce qu'on veut — ce sont deux tarifs différents.

Les abonnements **déjà souscrits** ne bougent pas : ils référencent leur `Price`
d'origine, immuable, et continuent de prélever exactement la même somme.

## 4 bis. L’AUTORITÉ DU CLIENT STRIPE : l’entreprise, pas le contrat

### La cardinalité, avant

Un client Stripe par **CONTRAT** — clé `stripe-customer:<monde>:<contractId>`.
C’était fidèle à un monde où l’acheteur n’existait pas comme entité : le
contrat était le seul porteur disponible.

Trois conséquences, toutes constatées :

```text
deux contrats successifs du même client → deux clients Stripe,
                                           historique de facturation scindé
deux projets du même client             → deux clients Stripe
une prestation ponctuelle (sans contrat) → AUCUN client, donc une facture
                                           sans destinataire juridique
```

Le troisième était le plus grave, et le plus discret : le verbe
`billing.customer.ensure` n’était tout simplement **pas appelé** pour une
prestation. Une session de paiement réellement ouverte portait
`customer: null`.

### La cardinalité, maintenant

```text
stripe-customer:<monde>:company:<clientCompanyId>
```

Un client Stripe par **ENTREPRISE CLIENTE** et par **MONDE**. C’est le seul
niveau où « Facturer à » a un sens : on facture une personne morale, pas un
engagement ni une instance technique.

| Dans la clé | Pourquoi |
|---|---|
| l’entreprise cliente | c’est elle qu’on facture |
| le monde | `TEST` et `PROD` sont deux comptes Stripe |
| ~~le projet~~ | déjà porté par le registre de liens |
| ~~le contrat~~ | facultatif — une prestation n’en a pas |

### Une entreprise, plusieurs projets — l’arbitrage

La question mérite d’être posée : faut-il **un seul** client Stripe pour une
entreprise qui possède trois sites ?

Non — et ce n’est pas un compromis, c’est le registre d’appartenance qui le
tranche. Son unicité est `(monde, type, ressource)` : **une ressource a
exactement un projet propriétaire**. Partager un `cus_…` entre deux projets
rendrait cette ressource possédée par deux projets à la fois, et chacun
pourrait alors lire les factures de l’autre.

La cardinalité retenue est donc **une entreprise cliente × un projet → un
client Stripe**. Elle supprime la duplication par contrat et par prestation —
celle qui existait réellement — sans démonter la garantie d’isolement.

Aller plus loin exigerait de remplacer le propriétaire par un ensemble de
lecteurs autorisés. C’est un autre modèle de sécurité, pas un réglage.

### La migration : adopter, jamais recréer ni supprimer

Les liens écrits avant ce lot portent l’ancienne clé. Trois issues, deux
mauvaises :

| Issue | Effet |
|---|---|
| ignorer l’ancien lien | un SECOND client pour la même personne morale |
| supprimer l’ancien lien | l’abonnement en cours devient illisible par ses propres capacités |
| **le renommer** | la ressource ne bouge pas, son propriétaire non plus — seule la question à laquelle il répond change |

C’est la troisième. `adoptBindingOperation` met à jour
`createdByOperationId` sur la ligne existante — l’unicité de la ressource
l’impose d’ailleurs : il ne peut pas exister deux lignes pour un même `cus_…`.

La cascade est **partagée** entre celui qui garantit le client
(`customerEnsure`) et celui qui le lit pour servir factures et portail
(`ownedCustomerOfContract`). Si seul le premier savait adopter, une simple
consultation de factures refuserait un client que le prochain paiement
retrouverait très bien — deux réponses différentes à la même question.

Un lien **révoqué** n’est jamais adopté : on ne réhabilite pas d’office une
appartenance qu’un humain a retirée.

### L’identité d’acte est LUE, plus déduite

La passerelle dérivait l’identité d’acte de façon **pure**, depuis la charge
utile. Elle ne pouvait donc nommer que le contrat.

La bonne identité vit désormais en base, sur le rattachement du projet — et
elle **ne doit pas** venir de la charge utile : un projet qui pourrait la
désigner pourrait réclamer le client d’un autre. La dérivation est donc
devenue asynchrone.

Ce n’est pas un détail d’implémentation. Rester pure aurait produit
`…:company:undefined` pour **tout le parc** — une seule identité d’acte
partagée par tous les projets, donc un seul client Stripe pour tout le monde.
La garde qui refuse un identifiant vide existe pour que cette panne-là ne
puisse jamais être silencieuse.

### Le contrat reste, à sa place

```text
contrat  →  RÉFÉRENCE COMMERCIALE   description, champ personnalisé, metadata
contrat  →  ❌ identité du client    plus jamais
contrat  →  ❌ clé d’appartenance    plus jamais
```

Quand il existe, son appartenance est **vérifiée** exactement comme avant :
une référence qui n’est pas celle du projet reste refusée. Le rendre
facultatif distingue « pas de contrat » de « pas le bon contrat » — deux
situations différentes que le refus unique confondait.

## 5. Ce que Stripe sait porter, et ce qu'il ne sait pas

| Mention | Emplacement | Imprimée ? |
|---|---|---|
| Raison sociale du client | `customer.name` | **oui**, en tête de « Facturer à » |
| Adresse du client | `customer.address` | **oui**, sous la raison sociale |
| N° de TVA du client | `customer.tax_ids[]` | **oui** — seul emplacement possible |
| Identité du vendeur | réglages du compte Stripe | **oui** — configurée une fois, hors de ce code |
| Référence de contrat | `invoice_data.custom_fields[]` | **oui**, en tête de facture, comme un numéro de commande |
| HT / taux / TVA / TTC | ligne + `tax_rates` | **oui** |
| **SIREN du client** | `customer.metadata.clientSiren` | **non — limite du fournisseur** |

### La limite du SIREN, documentée

Stripe n'offre **aucun champ imprimé** pour un identifiant national d'entreprise
distinct du numéro de TVA. Les `metadata` ne figurent sur aucun document rendu au
client.

Trois voies existent, et deux sont refusées :

| Voie | Verdict |
|---|---|
| l'écrire dans `address[line2]` | **refusé** — un SIREN n'est pas une ligne d'adresse ; le courrier deviendrait faux |
| l'accoler à `customer.name` | **refusé** — « SARL X 732829320 » cesse d'être une raison sociale |
| un `custom_field` de facture | **possible**, et retenu le jour où l'e-facture l'exigera |

Stripe borne les `custom_fields` d'une facture à **quatre** entrées. La référence
de contrat en occupe une aujourd'hui ; le SIREN en occupera une seconde le jour
où la mention deviendra obligatoire — c'est-à-dire au 1er septembre 2026, dans le
cadre du chantier e-facture (§6), qui décidera aussi de la voie de transmission.

La donnée, elle, est **déjà là** : structurée, validée, et transportée en
`metadata` — rien ne manquera au moment de la porter.

## 6. Facturation électronique — ce qui est PRÉPARÉ, et ce qui ne l'est pas

À compter du **1er septembre 2026**, le SIREN du client compte parmi les mentions
obligatoires de la facture électronique française, aux côtés des mentions
existantes (identité des parties, adresses, numéro de TVA, ventilation par taux).

**Ce chantier ne construit aucune plateforme de dématérialisation** (PA/PDP), et
n'en préjuge pas.

Ce qu'il garantit, c'est que la donnée **structurée** nécessaire existe :

```text
SIREN            séparé du SIRET, validé (9 chiffres + clé de Luhn)
SIRET            validé, et cohérent avec le SIREN
TVA intracom.    validée, et cohérente avec le SIREN pour la France
adresse          DÉCOMPOSÉE — voie, complément, code postal, ville, pays ISO
ventilation      HT · taux · TVA · TTC, en centimes entiers, vérifiés
identité vendeur PanelCompany.legal (forme, SIRET, TVA, RCS, capital)
```

Aucune de ces valeurs n'est une chaîne libre à redécouper le jour venu. C'était
le seul vrai risque : une adresse recollée est une heuristique qui marche sur
« 12 rue des Lilas, 06000 Nice » et échoue sur la première adresse à lieu-dit.

## 7. Les factures historiques ne sont pas retouchées

Aucune facture Stripe existante n'est modifiée, régénérée ou réémise.

Les transactions historiques restent lisibles, leurs justificatifs archivés
restent téléchargeables, et leur identité de facturation reste celle du jour de
l'émission. C'est la même règle que l'instantané légal, appliquée au fournisseur.

## 8. L'archivage du PDF, inchangé

```text
invoice.paid → invoice_pdf → téléchargement → média PRIVÉ → transaction Panel
```

Le mécanisme livré en L10.3 n'est pas touché. Ce qui change est le **contenu** du
PDF archivé : il porte désormais l'identité juridique du client et la ventilation
fiscale.
