"""Constantes pour Alex Light Studio (fusion de Alex Scene Studio et
Alex Gradient Studio)."""

DOMAIN = "alex_light_studio"

# Stockage -- deux bibliotheques distinctes en interne (pieces/lumieres
# positionnees vs scenes de degrade : formes de donnees trop differentes
# pour un seul fichier), mais sous le meme domaine.
STORAGE_VERSION = 1
STORAGE_KEY_ROOMS = f"{DOMAIN}.rooms"
STORAGE_KEY_GRADIENT_SCENES = f"{DOMAIN}.gradient_scenes"

SIGNAL_GRADIENT_SCENES_UPDATED = f"{DOMAIN}_gradient_scenes_updated"

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
