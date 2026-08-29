"""L'integration Alex Light Studio.

Fusion d'Alex Scene Studio et d'Alex Gradient Studio en un seul projet
coherent, avec trois vues dans le meme panel : Gradient / Pieces / Scenes.

--- Volet "Pieces"/"Scenes" (ex-Alex Scene Studio) ---
Modele de donnees + stockage des pieces (contour polygonal + lumieres
positionnees + zones), et calcul d'une proposition de scene harmonieuse
(harmony.py) a partir d'une piece, avec lecture EN DIRECT des capacites
reelles de chaque lumiere (jamais mise en cache) ; application aux vraies
lumieres seulement sur demande explicite ; sauvegarde optionnelle en tant
que vraie scene HA (service natif scene.create).

--- Volet "Gradient" (ex-Alex Gradient Studio) ---
Sauvegarde/rejoue des degrades de bandeaux LED a segments (Philips Hue
Gradient / Aqara LED Strip T1, via Zigbee2MQTT) sous forme de scenes
reutilisables entre appareils differents (nombre de segments quelconque) --
appelables depuis une carte (alex-gradient-card / alex-gradient-scene-card),
une automatisation (via les services enregistres ici), ou le panel.

Stockage : DEUX bibliotheques Store natives HA distinctes (.storage/) --
les pieces et les scenes de degrade ont des formes de donnees trop
differentes pour partager un seul fichier, mais vivent sous le meme domaine.

Cartes Lovelace compagnes (alex-gradient-card / alex-gradient-scene-card) :
servies directement par cette integration (dossier www/, meme mecanisme de
chemin statique HTTP que le panel) -- pas de depot HACS separe necessaire.
Ajouter /alex_light_studio_cards/alex-light-studio-cards.js comme ressource
de tableau de bord une fois l'integration installee.
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
import uuid
from dataclasses import asdict, dataclass, field

import voluptuous as vol
from homeassistant.components import panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from . import harmony
from .const import (
    DEFAULT_SEGMENTS,
    DEVICE_TYPE_AQARA,
    DIRECTION_TYPES,
    DOMAIN,
    MAX_SEGMENTS,
    MOUNT_TYPES,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    SERVICE_DELETE_GRADIENT_SCENE,
    SERVICE_LOAD_GRADIENT_SCENE,
    SERVICE_SAVE_GRADIENT_SCENE,
    SIGNAL_GRADIENT_SCENES_UPDATED,
    STORAGE_KEY_GRADIENT_SCENES,
    STORAGE_KEY_ROOMS,
    STORAGE_VERSION,
)
from .gradient import colors_to_stops, hex_to_rgb_obj, resample_stops

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]


# =============================================================================
# === Volet Pieces/Scenes -- modele de donnees (ex-Alex Scene Studio) ========
# =============================================================================
@dataclass
class LightPosition:
    entity_id: str
    x: float
    y: float
    mount_type: str  # "ceiling" | "wall" | "desk" -- position physique
    height: float = 2.2  # metres
    direction: str = "direct"  # "direct" | "indirect"
    importance: float = 0.7  # 0-1
    power: float = 1.0  # puissance/capacite relative -- 1.0 = reference


@dataclass
class Zone:
    """Une zone nommee et positionnee -- ancrage chromatique local qui
    influence les lumieres proches selon la distance."""

    name: str
    x: float
    y: float
    hue: float
    saturation: float = 70.0
    influence_radius: float = 150.0


@dataclass
class Room:
    id: str
    name: str
    points: list[dict]  # [{"x": .., "y": ..}, ...] -- contour polygonal, ordre = trace
    lights: list[dict] = field(default_factory=list)  # liste de LightPosition serialisees
    zones: list[dict] = field(default_factory=list)  # liste de Zone serialisees


POINT_SCHEMA = {vol.Required("x"): vol.Coerce(float), vol.Required("y"): vol.Coerce(float)}

LIGHT_SCHEMA = {
    vol.Required("entity_id"): str,
    vol.Required("x"): vol.Coerce(float),
    vol.Required("y"): vol.Coerce(float),
    vol.Required("mount_type"): vol.In(MOUNT_TYPES),
    vol.Optional("height", default=2.2): vol.Coerce(float),
    vol.Optional("direction", default="direct"): vol.In(DIRECTION_TYPES),
    vol.Optional("importance", default=0.7): vol.All(vol.Coerce(float), vol.Range(min=0, max=1)),
    # Choix EXPLICITE de l'utilisateur plutot qu'une detection automatique
    # via supported_color_modes -- cette derniere s'est averee peu fiable en
    # pratique (des lumieres RGB confirmees ne recevaient jamais de
    # couleur). Source de verite unique desormais.
    vol.Optional("light_type", default="color"): vol.In(("color", "white")),
    # Puissance/capacite relative : une bande LED puissante et une petite
    # ampoule ne devraient pas recevoir la meme consigne pour un rendu
    # equivalent.
    vol.Optional("power", default=1.0): vol.All(vol.Coerce(float), vol.Range(min=0.1, max=10)),
}

ZONE_SCHEMA = {
    vol.Required("name"): str,
    vol.Required("x"): vol.Coerce(float),
    vol.Required("y"): vol.Coerce(float),
    vol.Required("hue"): vol.Coerce(float),
    vol.Optional("saturation", default=70.0): vol.Coerce(float),
    vol.Optional("influence_radius", default=150.0): vol.Coerce(float),
}

SAVE_ROOM_SCHEMA = {
    vol.Required("type"): f"{DOMAIN}/save_room",
    vol.Optional("room_id"): str,  # absent = nouvelle piece
    vol.Required("name"): str,
    vol.Required("points"): [POINT_SCHEMA],
    vol.Optional("lights", default=list): [LIGHT_SCHEMA],
    vol.Optional("zones", default=list): [ZONE_SCHEMA],
}

DELETE_ROOM_SCHEMA = {vol.Required("type"): f"{DOMAIN}/delete_room", vol.Required("room_id"): str}

GET_ROOMS_SCHEMA = {vol.Required("type"): f"{DOMAIN}/get_rooms"}

COMPUTE_SCENE_SCHEMA = {
    vol.Required("type"): f"{DOMAIN}/compute_scene",
    vol.Required("lights"): [LIGHT_SCHEMA],
    vol.Optional("zones", default=list): [ZONE_SCHEMA],
    vol.Required("scheme"): vol.In(["complementary", "analogous", "triadic"]),
    vol.Optional("mood"): vol.In(list(harmony.MOOD_PRESETS)),
    vol.Optional("base_hue"): vol.Coerce(float),
    vol.Optional("saturation"): vol.Coerce(float),
    vol.Optional("global_intensity"): vol.Coerce(float),
    vol.Optional("contrast"): vol.All(vol.Coerce(float), vol.Range(min=0, max=1)),
    vol.Optional("white_temperature"): vol.Coerce(float),
    vol.Optional("generation_style", default="normal"): vol.In(list(harmony.GENERATION_STYLES)),
}

SUGGESTION_SCHEMA = {
    vol.Required("entity_id"): str,
    vol.Required("hue"): vol.Coerce(float),
    vol.Required("saturation"): vol.Coerce(float),
    vol.Required("brightness"): vol.Coerce(int),
    # vol.Optional rend la CLE optionnelle (absente autorisee), mais
    # n'autorise pas a elle seule la valeur None quand la cle EST presente --
    # or dataclasses.asdict() inclut toujours color_temp_kelvin, meme a None
    # (lumieres RGB qui n'ont pas besoin d'une conversion en kelvin). Sans
    # vol.Any(None, ...), cette valeur explicitement None se fait rejeter
    # par vol.Coerce(int) des l'aller-retour Appliquer.
    vol.Optional("color_temp_kelvin"): vol.Any(None, vol.Coerce(int)),
}

APPLY_SCENE_SCHEMA = {
    vol.Required("type"): f"{DOMAIN}/apply_scene",
    vol.Required("suggestions"): [SUGGESTION_SCHEMA],
}

SAVE_AS_HA_SCENE_SCHEMA = {
    vol.Required("type"): f"{DOMAIN}/save_as_ha_scene",
    vol.Required("scene_name"): str,
    vol.Required("entity_ids"): [str],
}


# =============================================================================
# === Volet Gradient -- schemas de services (ex-Alex Gradient Studio) ========
# =============================================================================
SAVE_GRADIENT_SCENE_SCHEMA = vol.Schema(
    {
        vol.Required("name"): cv.string,
        vol.Required("colors"): vol.All(cv.ensure_list, [cv.string]),
    }
)

LOAD_GRADIENT_SCENE_SCHEMA = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("name"): cv.string,
        vol.Required("device_type"): vol.In([DEVICE_TYPE_AQARA, "hue"]),
        vol.Optional("friendly_name"): cv.string,
        vol.Optional("length_entity"): cv.entity_id,
        vol.Optional("segments"): vol.All(vol.Coerce(int), vol.Range(min=2, max=MAX_SEGMENTS)),
    }
)

DELETE_GRADIENT_SCENE_SCHEMA = vol.Schema({vol.Required("name"): cv.string})


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Initialise l'integration : deux stockages, commandes websocket,
    services de degrade, capteur, et panel."""
    rooms_store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_ROOMS)
    rooms_data = await rooms_store.async_load() or {"rooms": {}}

    gradient_store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_GRADIENT_SCENES)
    gradient_data = await gradient_store.async_load() or {"scenes": {}}

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "rooms_store": rooms_store,
        "rooms": rooms_data.get("rooms", {}),
        "gradient_store": gradient_store,
        "gradient_scenes": gradient_data.get("scenes", {}),
    }

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    if not hass.data[DOMAIN].get("ws_registered"):
        websocket_api.async_register_command(hass, websocket_get_rooms)
        websocket_api.async_register_command(hass, websocket_save_room)
        websocket_api.async_register_command(hass, websocket_delete_room)
        websocket_api.async_register_command(hass, websocket_compute_scene)
        websocket_api.async_register_command(hass, websocket_apply_scene)
        websocket_api.async_register_command(hass, websocket_save_as_ha_scene)
        hass.data[DOMAIN]["ws_registered"] = True

    # L'entry_id courant, pour que les commandes websocket (qui n'ont pas
    # acces a `entry` directement) sachent ou lire/ecrire.
    hass.data[DOMAIN]["active_entry_id"] = entry.entry_id

    async def _async_persist_gradient_scenes() -> None:
        """Ecrit la bibliotheque de degrades courante sur disque et notifie
        le capteur."""
        await gradient_store.async_save({"scenes": hass.data[DOMAIN][entry.entry_id]["gradient_scenes"]})
        async_dispatcher_send(hass, SIGNAL_GRADIENT_SCENES_UPDATED)

    async def _handle_save_gradient_scene(call: ServiceCall) -> None:
        name = call.data["name"]
        colors = call.data["colors"]
        stops = colors_to_stops(colors)
        hass.data[DOMAIN][entry.entry_id]["gradient_scenes"][name] = {"stops": stops}
        _LOGGER.debug("Scene de degrade enregistree: %s (%d points)", name, len(stops))
        await _async_persist_gradient_scenes()

    async def _handle_delete_gradient_scene(call: ServiceCall) -> None:
        name = call.data["name"]
        removed = hass.data[DOMAIN][entry.entry_id]["gradient_scenes"].pop(name, None)
        if removed is None:
            _LOGGER.warning("Suppression demandee pour une scene de degrade inconnue: %s", name)
            return
        await _async_persist_gradient_scenes()

    async def _handle_load_gradient_scene(call: ServiceCall) -> None:
        entity_id = call.data["entity_id"]
        name = call.data["name"]
        device_type = call.data["device_type"]

        scenes = hass.data[DOMAIN][entry.entry_id]["gradient_scenes"]
        scene = scenes.get(name)
        if scene is None:
            _LOGGER.warning("Scene de degrade inconnue: %s", name)
            return

        object_id = entity_id.split(".", 1)[1] if "." in entity_id else entity_id
        # Priorite : champ explicite > attribut friendly_name de l'entite
        # (HA le copie tel quel depuis la decouverte MQTT Z2M, casse
        # d'origine comprise) > dernier segment de l'entity_id, "slugifie"
        # par HA (minuscules) et donc parfois divergent du vrai nom Z2M des
        # que celui-ci contient de la casse mixte.
        entity_state = hass.states.get(entity_id)
        attr_friendly_name = entity_state.attributes.get("friendly_name") if entity_state else None
        friendly_name = call.data.get("friendly_name") or attr_friendly_name or object_id

        segments = call.data.get("segments")
        if segments is None and device_type == DEVICE_TYPE_AQARA:
            length_entity = call.data.get("length_entity") or f"number.{object_id}_length"
            length_state = hass.states.get(length_entity)
            if length_state is not None:
                try:
                    computed = round(float(length_state.state) * 5)
                    if computed > 0:
                        segments = min(MAX_SEGMENTS, computed)
                except (TypeError, ValueError):
                    _LOGGER.debug(
                        "Etat non numerique pour %s, repli sur la valeur par defaut", length_entity
                    )
        if segments is None:
            segments = DEFAULT_SEGMENTS

        colors = resample_stops(scene["stops"], segments)

        if device_type == DEVICE_TYPE_AQARA:
            payload = {
                "segment_colors": [
                    {"segment": i + 1, "color": hex_to_rgb_obj(color)} for i, color in enumerate(colors)
                ]
            }
        else:
            payload = {"gradient": colors}

        await hass.services.async_call(
            "mqtt",
            "publish",
            {"topic": f"zigbee2mqtt/{friendly_name}/set", "payload": json.dumps(payload)},
            blocking=True,
        )
        _LOGGER.debug(
            "Scene de degrade '%s' appliquee sur %s (%d segments, %s)", name, entity_id, segments, device_type
        )

    hass.services.async_register(
        DOMAIN, SERVICE_SAVE_GRADIENT_SCENE, _handle_save_gradient_scene, schema=SAVE_GRADIENT_SCENE_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_LOAD_GRADIENT_SCENE, _handle_load_gradient_scene, schema=LOAD_GRADIENT_SCENE_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_DELETE_GRADIENT_SCENE, _handle_delete_gradient_scene, schema=DELETE_GRADIENT_SCENE_SCHEMA
    )

    await _async_register_panel(hass)

    return True


def _entry_data(hass: HomeAssistant) -> dict:
    entry_id = hass.data[DOMAIN]["active_entry_id"]
    return hass.data[DOMAIN][entry_id]


async def _async_persist_rooms(hass: HomeAssistant) -> None:
    entry_data = _entry_data(hass)
    await entry_data["rooms_store"].async_save({"rooms": entry_data["rooms"]})


@websocket_api.websocket_command(GET_ROOMS_SCHEMA)
@websocket_api.async_response
async def websocket_get_rooms(hass: HomeAssistant, connection, msg) -> None:
    connection.send_result(msg["id"], {"rooms": list(_entry_data(hass)["rooms"].values())})


@websocket_api.websocket_command(SAVE_ROOM_SCHEMA)
@websocket_api.async_response
async def websocket_save_room(hass: HomeAssistant, connection, msg) -> None:
    """Cree une nouvelle piece (pas de `id` fourni) ou met a jour une piece
    existante (upsert par id)."""
    rooms = _entry_data(hass)["rooms"]
    room_id = msg.get("room_id") or str(uuid.uuid4())
    room = Room(
        id=room_id,
        name=msg["name"],
        points=msg["points"],
        lights=msg.get("lights", []),
        zones=msg.get("zones", []),
    )
    rooms[room_id] = asdict(room)
    await _async_persist_rooms(hass)
    connection.send_result(msg["id"], {"room": rooms[room_id]})


@websocket_api.websocket_command(DELETE_ROOM_SCHEMA)
@websocket_api.async_response
async def websocket_delete_room(hass: HomeAssistant, connection, msg) -> None:
    rooms = _entry_data(hass)["rooms"]
    removed = rooms.pop(msg["room_id"], None)
    if removed is not None:
        await _async_persist_rooms(hass)
    connection.send_result(msg["id"], {"deleted": removed is not None})


@websocket_api.websocket_command(COMPUTE_SCENE_SCHEMA)
@websocket_api.async_response
async def websocket_compute_scene(hass: HomeAssistant, connection, msg) -> None:
    """Calcule une proposition -- ne touche a AUCUNE lumiere reelle, se
    contente de renvoyer les valeurs suggerees pour apercu/ajustement."""
    light_inputs = []
    for l in msg["lights"]:
        is_color = l.get("light_type", "color") == "color"
        light_inputs.append(
            harmony.LightInput(
                entity_id=l["entity_id"],
                x=l["x"],
                y=l["y"],
                position=l["mount_type"],
                direction=l.get("direction", "direct"),
                importance=l.get("importance", 0.7),
                height=l.get("height", 2.2),
                power=l.get("power", 1.0),
                supports_color=is_color,
                supports_color_temp=not is_color,
            )
        )

    zone_inputs = [
        harmony.ZoneInput(
            name=z["name"],
            x=z["x"],
            y=z["y"],
            hue=z["hue"],
            saturation=z.get("saturation", 70.0),
            influence_radius=z.get("influence_radius", 150.0),
        )
        for z in msg.get("zones", [])
    ]

    try:
        suggestions = harmony.compute_scene(
            light_inputs,
            scheme=msg["scheme"],
            mood=msg.get("mood"),
            base_hue=msg.get("base_hue"),
            saturation=msg.get("saturation"),
            global_intensity=msg.get("global_intensity"),
            contrast=msg.get("contrast"),
            white_temperature=msg.get("white_temperature"),
            generation_style=msg.get("generation_style", "normal"),
            zones=zone_inputs,
            rng=random.Random(),
        )
    except ValueError as exc:
        connection.send_error(msg["id"], "invalid_params", str(exc))
        return

    connection.send_result(msg["id"], {"suggestions": [asdict(s) for s in suggestions]})


@websocket_api.websocket_command(APPLY_SCENE_SCHEMA)
@websocket_api.async_response
async def websocket_apply_scene(hass: HomeAssistant, connection, msg) -> None:
    """Envoie les valeurs (potentiellement ajustees par l'utilisateur apres
    apercu) aux vraies lumieres. Jamais appele automatiquement -- seulement
    sur action explicite depuis le panel."""
    for s in msg["suggestions"]:
        data = {"entity_id": s["entity_id"], "brightness": s["brightness"]}
        if s.get("color_temp_kelvin") is not None:
            data["color_temp_kelvin"] = s["color_temp_kelvin"]
        else:
            data["hs_color"] = [s["hue"], s["saturation"]]
        await hass.services.async_call("light", "turn_on", data, blocking=True)
    connection.send_result(msg["id"], {"applied": len(msg["suggestions"])})


@websocket_api.websocket_command(SAVE_AS_HA_SCENE_SCHEMA)
@websocket_api.async_response
async def websocket_save_as_ha_scene(hass: HomeAssistant, connection, msg) -> None:
    """Cree une vraie scene HA (service natif scene.create) a partir des
    etats ACTUELS des lumieres listees -- suppose que apply_scene a deja ete
    appele juste avant."""
    scene_id = re.sub(r"[^a-z0-9]+", "_", msg["scene_name"].lower()).strip("_") or "alex_light_studio_scene"
    await hass.services.async_call(
        "scene",
        "create",
        {"scene_id": scene_id, "snapshot_entities": msg["entity_ids"]},
        blocking=True,
    )
    connection.send_result(msg["id"], {"scene_entity_id": f"scene.{scene_id}"})


async def _async_register_panel(hass: HomeAssistant) -> None:
    """Enregistre le panel dans la barre laterale, et sert le fichier de
    cartes Lovelace compagnes (alex-gradient-card / alex-gradient-scene-card)
    -- une seule fois, meme mecanisme de chemin statique HTTP pour les deux,
    pas besoin d'un depot HACS separe pour les cartes."""
    registered_key = f"{DOMAIN}_panel_registered"
    if hass.data.get(registered_key):
        return
    hass.data[registered_key] = True

    panel_dir = os.path.join(os.path.dirname(__file__), "panel")
    panel_static_url = f"/{DOMAIN}_panel"
    cards_dir = os.path.join(os.path.dirname(__file__), "www")
    cards_static_url = f"/{DOMAIN}_cards"

    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(panel_static_url, panel_dir, cache_headers=False),
            StaticPathConfig(cards_static_url, cards_dir, cache_headers=False),
        ]
    )

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name="alex-light-studio-panel",
        frontend_url_path=PANEL_URL_PATH,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{panel_static_url}/alex-light-studio-panel.js",
        embed_iframe=False,
        require_admin=True,
    )


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Decharge l'entree de configuration (plateformes uniquement -- les
    services et le panel restent enregistres, HA ne demande pas de les
    retirer explicitement au dechargement d'une simple entree)."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok
