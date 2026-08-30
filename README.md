# Alex Light Studio

Intégration Home Assistant fusionnant **Alex Scene Studio** et **Alex
Gradient Studio** en un seul projet cohérent, avec un panel à trois vues,
et deux cartes Lovelace compagnes servies directement par l'intégration
(pas de dépôt séparé à installer).

- **Gradient** (ex-Alex Gradient Studio) — éditeur de dégradés pour bandeaux
  LED à segments (Philips Hue Gradient / Aqara LED Strip T1, via
  Zigbee2MQTT), test en direct, et bibliothèque de scènes de dégradé
  réutilisables entre appareils différents (nombre de segments quelconque).
- **Pièces** (ex-Alex Scene Studio) — dessine le contour d'une pièce,
  positionne des lumières et des zones à influence chromatique.
- **Scènes** (ex-Alex Scene Studio) — génère une proposition de couleurs
  harmonieuses pour les lumières d'une pièce déjà configurée, en aperçu
  ajustable avant application.

## Pourquoi la fusion

Les deux projets partageaient déjà la même patte (structure de panel avec
navigation, stockage `.storage/` natif HA, calcul de couleur indépendant de
HA et testé isolément) sans jamais se chevaucher fonctionnellement — les
réunir sous un seul domaine évite deux entrées de configuration séparées
pour ce qui est, du point de vue de l'utilisateur, un seul et même
« studio lumière ».

## Ce qui a changé par rapport aux deux projets d'origine

- **Domaine** : `alex_gradient_studio` et `alex_scene_studio` deviennent
  tous les deux `alex_light_studio`.
- **Services de dégradé** : `save_scene`/`load_scene`/`delete_scene`
  gardent exactement les mêmes noms d'action (seul le domaine change,
  `alex_light_studio.load_scene` au lieu de
  `alex_gradient_studio.load_scene`) — pense à mettre à jour tes
  automatisations existantes qui les appellent.
- **Capteur de scènes de dégradé** : renommé de
  `sensor.alex_gradient_studio_scenes` vers
  `sensor.alex_light_studio_gradient_scenes`.
- **Stockage** : deux bibliothèques séparées en interne (`rooms` et
  `gradient_scenes` — formes de données trop différentes pour un seul
  fichier), mais sous le même domaine. Tes pièces et tes scènes de dégradé
  existantes ne sont **pas** migrées automatiquement (nouveaux fichiers de
  stockage) — à recréer une fois après la mise à jour.
- **Cartes Lovelace** : `alex-gradient-card` et `alex-gradient-scene-card`
  ont déménagé du bundle `alex-cards` — elles sont désormais **servies
  directement par cette intégration** (dossier `www/`, même mécanisme de
  chemin statique HTTP que le panel), pas besoin d'un dépôt HACS séparé.
  `alex-gradient-scene-card` a été mise à jour pour appeler le nouveau
  domaine/capteur.

## Installation

Via HACS (dépôt personnalisé), puis Paramètres → Appareils et services →
Ajouter une intégration → Alex Light Studio (instance unique, aucun champ à
saisir). Le panel apparaît automatiquement dans la barre latérale.

Pour utiliser les cartes, ajoute ensuite manuellement la ressource de
tableau de bord (Paramètres → Tableaux de bord → Ressources → Ajouter une
ressource) :

```
URL : /alex_light_studio_cards/alex-light-studio-cards.js
Type : Module JavaScript
```

## Stockage

Fichier JSON dans `.storage/` (mécanisme `Store` natif de Home Assistant),
deux bibliothèques distinctes :

- `alex_light_studio.rooms` — pièces (contour, lumières positionnées,
  zones).
- `alex_light_studio.gradient_scenes` — scènes de dégradé (points d'ancrage
  position/couleur, indépendants du nombre de segments réel du bandeau).

## Création de scènes

- **Aperçu modifiable** — après génération, chaque lumière garde son propre
  sélecteur de couleur (ou curseur de température pour les lumières
  blanches) et son curseur de luminosité, directement dans la liste
  d'aperçu. La proposition automatique est un point de départ, pas un
  résultat figé. Le « Rendu en direct » s'applique aussi à ces
  ajustements individuels (seule la lumière modifiée est réappliquée, pas
  toute la scène à chaque geste).
- **Génération depuis une image** — troisième mode de génération, à côté de
  « Ambiance prédéfinie » et « Teinte libre » : glisse une image (ou
  clique pour en choisir une), puis place 2 à 8 points directement dessus
  pour échantillonner les couleurs à ces endroits précis. Chaque lumière
  s'accroche à l'une des couleurs pointées (jamais un mélange moyen entre
  plusieurs) — compatible avec le style de génération et les zones à
  influence chromatique.
- **Position horizontale prise en compte** — deux lumières qui partagent
  exactement les mêmes propriétés (hauteur, type de montage, direction)
  reçoivent désormais des teintes différentes si elles sont éloignées
  l'une de l'autre dans la pièce, plutôt que la même teinte automatiquement
  du seul fait de propriétés identiques.

## Cartes Lovelace

### `alex-gradient-card`

Pilotage en direct des segments de couleur d'un bandeau LED via
Zigbee2MQTT — appel direct à `mqtt.publish`, aucune dépendance au reste de
l'intégration.

```yaml
type: custom:alex-gradient-card
entity: light.chambre_bled
device_type: hue # ou "aqara"
segments: 5
name: Bandeau chambre
icon: mdi:led-strip-variant
```

### `alex-gradient-scene-card`

Liste et applique les scènes de dégradé enregistrées via la vue Gradient,
sur une lumière précise.

```yaml
type: custom:alex-gradient-scene-card
entity: light.chambre_bled
device_type: hue # ou "aqara"
name: Scènes
icon: mdi:palette-swatch
```

Les deux cartes ont un éditeur visuel complet (Home Assistant → carte →
crayon) — les exemples YAML ci-dessus sont indicatifs, pas obligatoires à
écrire à la main.
