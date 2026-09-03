"""Constantes pour Alex Light Studio (fusion de Alex Scene Studio et
Alex Gradient Studio)."""

DOMAIN = "alex_light_studio"

# Stockage -- bibliotheques distinctes en interne (formes de donnees trop
# differentes pour un seul fichier), mais sous le meme domaine.
STORAGE_VERSION = 1
STORAGE_KEY_ROOMS = f"{DOMAIN}.rooms"
STORAGE_KEY_GRADIENT_SCENES = f"{DOMAIN}.gradient_scenes"
# Registre partage des bandeaux (vue Gradient ET vue LightZone y refarent
# tous les deux) -- un bandeau (entite, type d'appareil, nom convivial,
# segments/entite longueur) declare une fois, reutilise partout, pour ne
# pas desynchroniser un `friendly_name` change d'un seul cote.
STORAGE_KEY_STRIPS = f"{DOMAIN}.strips"
# Zones de segments (vue LightZone) : groupes d'un ou plusieurs segments
# d'un bandeau, chacun pilotable independamment via sa propre entite
# `light` virtuelle -- evite l'explosion combinatoire de scenes qu'imposerait
# une scene par combinaison d'etats (ex. N portes de placard ouvertes en
# meme temps -> 2^N scenes sans ce mecanisme).
STORAGE_KEY_LIGHT_ZONES = f"{DOMAIN}.light_zones"

SIGNAL_GRADIENT_SCENES_UPDATED = f"{DOMAIN}_gradient_scenes_updated"
SIGNAL_STRIPS_UPDATED = f"{DOMAIN}_strips_updated"
SIGNAL_LIGHT_ZONES_UPDATED = f"{DOMAIN}_light_zones_updated"

# Noms d'action inchanges par rapport a Alex Gradient Studio (seul le
# domaine change) -- pour minimiser la casse cote automatisations
# existantes qui appelaient deja save_scene/load_scene/delete_scene.
SERVICE_SAVE_GRADIENT_SCENE = "save_scene"
SERVICE_LOAD_GRADIENT_SCENE = "load_scene"
SERVICE_DELETE_GRADIENT_SCENE = "delete_scene"

DEVICE_TYPE_HUE = "hue"
DEVICE_TYPE_AQARA = "aqara"

DEFAULT_SEGMENTS = 5
MAX_SEGMENTS = 50

PANEL_URL_PATH = "alex-light-studio"
PANEL_TITLE = "Alex Light Studio"
PANEL_ICON = "mdi:lightbulb-multiple"

# Types de montage possibles pour une lumiere positionnee (vue Pieces) --
# combine a la direction (direct/indirect), determine automatiquement son
# role fonctionnel dans l'algorithme d'harmonie (voir harmony.derive_role).
MOUNT_TYPES = ("ceiling", "wall", "desk")

# Direct = source visible eclairant la piece ; indirect = lumiere rebondie
# sur une surface (corniche, uplighter...) -- avec mount_type, determine le
# role fonctionnel (harmony.derive_role) et influence la saturation calculee.
DIRECTION_TYPES = ("direct", "indirect")
