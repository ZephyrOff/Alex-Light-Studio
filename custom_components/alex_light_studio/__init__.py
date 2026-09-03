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
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from homeassistant.util import slugify

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
    SIGNAL_LIGHT_ZONES_UPDATED,
    SIGNAL_STRIPS_UPDATED,
    STORAGE_KEY_GRADIENT_SCENES,
    STORAGE_KEY_LIGHT_ZONES,
    STORAGE_KEY_ROOMS,
    STORAGE_KEY_STRIPS,
    STORAGE_VERSION,
)
from .gradient import colors_to_stops, hex_to_rgb_obj, resample_stops
from .zones import compute_zone_colors

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor", "light"]


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
    # Palette extraite d'une image par l'utilisateur (points places a la
    # main) -- liste de [teinte, saturation], prioritaire sur mood/base_hue.
    vol.Optional("image_palette"): [vol.All([vol.Coerce(float)], vol.Length(min=2, max=2))],
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
# === Registre partage des bandeaux (vue Gradient ET vue LightZone) =========
# =============================================================================
STRIP_SCHEMA = {
    vol.Required("entity"): cv.entity_id,
    vol.Required("device_type"): vol.In([DEVICE_TYPE_AQARA, "hue"]),
    vol.Optional("friendly_name", default=""): str,
    vol.Optional("length_entity", default=""): str,
    vol.Optional("segments"): vol.All(vol.Coerce(int), vol.Range(min=2, max=MAX_SEGMENTS)),
    vol.Optional("name", default=""): str,
}

GET_STRIPS_SCHEMA = {vol.Required("type"): f"{DOMAIN}/get_strips"}

SAVE_STRIP_SCHEMA = {
    vol.Required("type"): f"{DOMAIN}/save_strip",
    vol.Optional("strip_id"): str,  # absent = nouveau bandeau
    **STRIP_SCHEMA,
}

DELETE_STRIP_SCHEMA = {vol.Required("type"): f"{DOMAIN}/delete_strip", vol.Required("strip_id"): str}


# =============================================================================
# === Zones de segments (vue LightZone) ======================================
# =============================================================================
GET_LIGHT_ZONES_SCHEMA = {vol.Required("type"): f"{DOMAIN}/get_light_zones"}

SAVE_LIGHT_ZONE_SCHEMA = {
    vol.Required("type"): f"{DOMAIN}/save_light_zone",
    vol.Optional("zone_id"): str,  # absent = nouvelle zone
    vol.Required("strip_id"): str,
    vol.Required("name"): str,
    vol.Required("segments"): vol.All(cv.ensure_list, [vol.All(vol.Coerce(int), vol.Range(min=0))]),
}

DELETE_LIGHT_ZONE_SCHEMA = {vol.Required("type"): f"{DOMAIN}/delete_light_zone", vol.Required("zone_id"): str}


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
    """Initialise l'integration : stockages, commandes websocket, services
    de degrade, capteur, plateforme light (zones), et panel."""
    rooms_store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_ROOMS)
    rooms_data = await rooms_store.async_load() or {"rooms": {}}

    gradient_store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_GRADIENT_SCENES)
    gradient_data = await gradient_store.async_load() or {"scenes": {}}

    strips_store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_STRIPS)
    strips_data = await strips_store.async_load() or {"strips": {}}

    light_zones_store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_LIGHT_ZONES)
    light_zones_data = await light_zones_store.async_load() or {"zones": {}}

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "rooms_store": rooms_store,
        "rooms": rooms_data.get("rooms", {}),
        "gradient_store": gradient_store,
        "gradient_scenes": gradient_data.get("scenes", {}),
        "strips_store": strips_store,
        "strips": strips_data.get("strips", {}),
        "light_zones_store": light_zones_store,
        "light_zones": light_zones_data.get("zones", {}),
        # Peuple par light.py a l'initialisation de la plateforme ; utilise
        # par websocket_save_light_zone pour ajouter une entite a la volee
        # et par les entites elles-memes pour retrouver leurs consoeurs
        # (voir AlexLightStudioZoneLight.async_added_to_hass).
        "zone_entities": {},
        "recompute_strip": lambda strip_id: _async_recompute_strip(hass, entry.entry_id, strip_id),
        "sync_strip_brightness": lambda strip_id, brightness, source_zone_id: _async_sync_strip_brightness(
            hass, entry.entry_id, strip_id, brightness, source_zone_id
        ),
    }

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    if not hass.data[DOMAIN].get("ws_registered"):
        websocket_api.async_register_command(hass, websocket_get_rooms)
        websocket_api.async_register_command(hass, websocket_save_room)
        websocket_api.async_register_command(hass, websocket_delete_room)
        websocket_api.async_register_command(hass, websocket_compute_scene)
        websocket_api.async_register_command(hass, websocket_apply_scene)
        websocket_api.async_register_command(hass, websocket_save_as_ha_scene)
        websocket_api.async_register_command(hass, websocket_get_strips)
        websocket_api.async_register_command(hass, websocket_save_strip)
        websocket_api.async_register_command(hass, websocket_delete_strip)
        websocket_api.async_register_command(hass, websocket_get_light_zones)
        websocket_api.async_register_command(hass, websocket_save_light_zone)
        websocket_api.async_register_command(hass, websocket_delete_light_zone)
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


async def _async_persist_strips(hass: HomeAssistant) -> None:
    entry_data = _entry_data(hass)
    await entry_data["strips_store"].async_save({"strips": entry_data["strips"]})
    async_dispatcher_send(hass, SIGNAL_STRIPS_UPDATED)


async def _async_persist_light_zones(hass: HomeAssistant) -> None:
    entry_data = _entry_data(hass)
    await entry_data["light_zones_store"].async_save({"zones": entry_data["light_zones"]})
    async_dispatcher_send(hass, SIGNAL_LIGHT_ZONES_UPDATED)


def _unique_zone_slug(existing_zones: dict, name: str) -> str:
    """Genere un slug lisible et unique a partir du nom d'une zone (ex.
    "Porte 1" -> "porte_1"), pour un entity_id du type
    light.alex_light_studio_zone_<slug> plutot qu'un identifiant opaque.
    Suffixe numerique en cas de collision (meme convention que HA pour ses
    propres entity_id auto-generes). Genere UNE SEULE FOIS a la creation de
    la zone -- jamais regenere sur un renommage ulterieur, pour ne pas
    changer l'entity_id d'une zone deja utilisee dans un tableau de bord ou
    une automatisation."""
    base = slugify(name) or "zone"
    used = {z.get("slug") for z in existing_zones.values() if z.get("slug")}
    if base not in used:
        return base
    n = 2
    while f"{base}_{n}" in used:
        n += 1
    return f"{base}_{n}"


def _resolve_strip_segments(hass: HomeAssistant, strip: dict) -> int:
    """Meme logique de resolution que _handle_load_gradient_scene (Aqara :
    detection via l'entite longueur si disponible, repli sur le champ
    manuel sinon ; Hue : toujours le champ manuel, aucune detection
    possible cote Z2M)."""
    entity_id = strip["entity"]
    object_id = entity_id.split(".", 1)[1] if "." in entity_id else entity_id
    segments = strip.get("segments")
    if strip.get("device_type") == DEVICE_TYPE_AQARA:
        length_entity = strip.get("length_entity") or f"number.{object_id}_length"
        length_state = hass.states.get(length_entity)
        if length_state is not None:
            try:
                computed = round(float(length_state.state) * 5)
                if computed > 0:
                    segments = min(MAX_SEGMENTS, computed)
            except (TypeError, ValueError):
                _LOGGER.debug("Etat non numerique pour %s, repli sur la valeur manuelle", length_entity)
    if not segments:
        segments = DEFAULT_SEGMENTS
    return segments


async def _async_recompute_strip(hass: HomeAssistant, entry_id: str, strip_id: str) -> None:
    """Recalcule et publie l'etat combine d'un bandeau a partir de l'etat
    courant de TOUTES ses zones (front montant OU descendant sur n'importe
    laquelle d'entre elles) -- appele par AlexLightStudioZoneLight a chaque
    allumage/extinction. Aucune scene precalculee : c'est justement le
    mecanisme qui evite l'explosion combinatoire d'une scene par
    combinaison d'etats possibles."""
    entry_data = hass.data[DOMAIN][entry_id]
    strip = entry_data["strips"].get(strip_id)
    if strip is None:
        _LOGGER.warning("Recalcul demande pour un bandeau inconnu: %s", strip_id)
        return

    zone_entities = entry_data.get("zone_entities", {})
    zones_for_strip = [
        {
            "segments": cfg.get("segments", []),
            "is_on": bool(zone_entities.get(zid)) and zone_entities[zid].is_on,
            "color": zone_entities[zid].rgb_color_hex if zid in zone_entities else "#000000",
        }
        for zid, cfg in entry_data["light_zones"].items()
        if cfg.get("strip_id") == strip_id
    ]

    entity_id = strip["entity"]
    any_active = any(z["is_on"] for z in zones_for_strip)

    if not any_active:
        # Reponse a la question "aucune zone active" : le bandeau s'eteint
        # completement plutot que de rester allume a zero ou de repasser
        # sur un degrade de base.
        await hass.services.async_call("light", "turn_off", {"entity_id": entity_id}, blocking=True)
        return

    device_type = strip["device_type"]
    object_id = entity_id.split(".", 1)[1] if "." in entity_id else entity_id
    entity_state = hass.states.get(entity_id)
    attr_friendly_name = entity_state.attributes.get("friendly_name") if entity_state else None
    friendly_name = strip.get("friendly_name") or attr_friendly_name or object_id

    segments = _resolve_strip_segments(hass, strip)
    colors = compute_zone_colors(zones_for_strip, segments)

    # "state": "ON" dans le meme payload -- force l'allumage du bandeau
    # physique en meme temps que les couleurs, au cas ou il etait deja
    # eteint cote appareil (sinon la plupart des appareils Zigbee
    # n'affichent rien malgre des couleurs recues). Pas de champ
    # `brightness` ici : chaque couleur de zone porte deja sa propre
    # luminosite "cuite" (voir zones.hsv_to_hex) -- un brightness partage
    # assombrirait tout une seconde fois.
    if device_type == DEVICE_TYPE_AQARA:
        payload = {
            "state": "ON",
            "segment_colors": [{"segment": i + 1, "color": hex_to_rgb_obj(c)} for i, c in enumerate(colors)],
        }
    else:
        payload = {"state": "ON", "gradient": colors}

    await hass.services.async_call(
        "mqtt",
        "publish",
        {"topic": f"zigbee2mqtt/{friendly_name}/set", "payload": json.dumps(payload)},
        blocking=True,
    )
    _LOGGER.debug(
        "Zones recalculees pour %s (%d segments, %s) : %d zone(s) active(s)",
        entity_id,
        segments,
        device_type,
        sum(1 for z in zones_for_strip if z["is_on"]),
    )


async def _async_sync_strip_brightness(
    hass: HomeAssistant, entry_id: str, strip_id: str, brightness: int, source_zone_id: str
) -> None:
    """Aligne la luminosite de toutes les AUTRES zones actives d'un meme
    bandeau sur celle qui vient de changer -- pallie un artefact materiel
    observe sur certains bandeaux Aqara ou des segments a des niveaux de
    luminosite tres eloignes affichent une teinte perceptiblement decalee
    (comportement non lineaire des LED a bas courant, pas un bug de
    conversion : hsv_to_hex/kelvin_to_hex ne deplacent jamais la teinte
    quand seule la valeur change). Mise a jour directe des entites soeurs
    (pas de passage par async_turn_on, qui redeclencherait chacune sa propre
    synchronisation et son propre recalcul en boucle) ; le recalcul du
    bandeau lui-meme n'a lieu qu'une fois, juste apres, cote appelant."""
    entry_data = hass.data[DOMAIN][entry_id]
    zone_entities = entry_data.get("zone_entities", {})
    for zid, cfg in entry_data["light_zones"].items():
        if zid == source_zone_id or cfg.get("strip_id") != strip_id:
            continue
        entity = zone_entities.get(zid)
        if entity is not None and entity.is_on:
            entity.sync_brightness(brightness)


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

    image_palette_raw = msg.get("image_palette")
    image_palette = [(p[0], p[1]) for p in image_palette_raw] if image_palette_raw else None

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
            image_palette=image_palette,
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


# =============================================================================
# === Registre partage des bandeaux ==========================================
# =============================================================================
@websocket_api.websocket_command(GET_STRIPS_SCHEMA)
@websocket_api.async_response
async def websocket_get_strips(hass: HomeAssistant, connection, msg) -> None:
    connection.send_result(msg["id"], {"strips": _entry_data(hass)["strips"]})


@websocket_api.websocket_command(SAVE_STRIP_SCHEMA)
@websocket_api.async_response
async def websocket_save_strip(hass: HomeAssistant, connection, msg) -> None:
    """Cree un nouveau bandeau (pas de `strip_id` fourni) ou met a jour un
    bandeau existant (upsert par id) -- registre partage entre la vue
    Gradient et la vue LightZone."""
    strips = _entry_data(hass)["strips"]
    strip_id = msg.get("strip_id") or str(uuid.uuid4())
    strips[strip_id] = {
        "id": strip_id,
        "entity": msg["entity"],
        "device_type": msg["device_type"],
        "friendly_name": msg.get("friendly_name", ""),
        "length_entity": msg.get("length_entity", ""),
        "segments": msg.get("segments"),
        "name": msg.get("name", ""),
    }
    await _async_persist_strips(hass)
    connection.send_result(msg["id"], {"strip": strips[strip_id]})


@websocket_api.websocket_command(DELETE_STRIP_SCHEMA)
@websocket_api.async_response
async def websocket_delete_strip(hass: HomeAssistant, connection, msg) -> None:
    entry_data = _entry_data(hass)
    strip_id = msg["strip_id"]
    still_used = [
        z["name"] for z in entry_data["light_zones"].values() if z.get("strip_id") == strip_id
    ]
    if still_used:
        connection.send_error(
            msg["id"],
            "strip_in_use",
            f"Bandeau encore utilise par {len(still_used)} zone(s) : supprime-les d'abord.",
        )
        return
    removed = entry_data["strips"].pop(strip_id, None)
    if removed is not None:
        await _async_persist_strips(hass)
    connection.send_result(msg["id"], {"deleted": removed is not None})


# =============================================================================
# === Zones de segments =======================================================
# =============================================================================
@websocket_api.websocket_command(GET_LIGHT_ZONES_SCHEMA)
@websocket_api.async_response
async def websocket_get_light_zones(hass: HomeAssistant, connection, msg) -> None:
    connection.send_result(msg["id"], {"zones": _entry_data(hass)["light_zones"]})


@websocket_api.websocket_command(SAVE_LIGHT_ZONE_SCHEMA)
@websocket_api.async_response
async def websocket_save_light_zone(hass: HomeAssistant, connection, msg) -> None:
    """Cree une nouvelle zone (pas de `zone_id` fourni) ou renomme/reassigne
    les segments d'une zone existante (upsert par id). Une zone creee fait
    apparaitre sa lumiere immediatement (pas de redemarrage HA requis) ; une
    zone modifiee ne touche pas a son entite existante -- la lumiere relit
    ses segments/son bandeau depuis la config a chaque recalcul, pas besoin
    de la recreer."""
    entry_id = hass.data[DOMAIN]["active_entry_id"]
    entry_data = hass.data[DOMAIN][entry_id]
    zones = entry_data["light_zones"]

    zone_id = msg.get("zone_id")
    is_new = zone_id is None or zone_id not in zones
    zone_id = zone_id or str(uuid.uuid4())

    existing = zones.get(zone_id)
    slug = existing["slug"] if existing and existing.get("slug") else _unique_zone_slug(zones, msg["name"])

    zones[zone_id] = {
        "id": zone_id,
        "strip_id": msg["strip_id"],
        "name": msg["name"],
        "segments": msg["segments"],
        "slug": slug,
    }
    await _async_persist_light_zones(hass)

    if is_new:
        add_entities = entry_data.get("light_add_entities")
        if add_entities is not None:
            # Import local : evite un import circulaire au chargement du
            # module (light.py n'importe rien depuis __init__.py, mais
            # l'inverse en haut de fichier compliquerait l'ordre de
            # chargement des plateformes).
            from .light import AlexLightStudioZoneLight

            add_entities([AlexLightStudioZoneLight(hass, entry_id, zone_id)])
        else:
            _LOGGER.warning(
                "Zone %s enregistree mais la plateforme light n'est pas encore prete "
                "(sa lumiere apparaitra au prochain redemarrage)",
                zone_id,
            )

    connection.send_result(msg["id"], {"zone": zones[zone_id]})


@websocket_api.websocket_command(DELETE_LIGHT_ZONE_SCHEMA)
@websocket_api.async_response
async def websocket_delete_light_zone(hass: HomeAssistant, connection, msg) -> None:
    entry_id = hass.data[DOMAIN]["active_entry_id"]
    entry_data = hass.data[DOMAIN][entry_id]
    zone_id = msg["zone_id"]

    zone = entry_data["light_zones"].get(zone_id)
    strip_id = zone.get("strip_id") if zone else None

    removed = entry_data["light_zones"].pop(zone_id, None)
    if removed is None:
        connection.send_result(msg["id"], {"deleted": False})
        return
    await _async_persist_light_zones(hass)

    entity = entry_data.get("zone_entities", {}).get(zone_id)
    if entity is not None:
        await entity.async_remove(force_remove=True)
        registry = er.async_get(hass)
        registry_entry = registry.async_get(entity.entity_id)
        if registry_entry is not None:
            registry.async_remove(entity.entity_id)

    # La zone active retiree peut changer l'etat combine du bandeau (ex.
    # c'etait la derniere active) -- recalcul immediat plutot que d'attendre
    # le prochain changement d'une autre zone.
    if strip_id is not None:
        await _async_recompute_strip(hass, entry_id, strip_id)

    connection.send_result(msg["id"], {"deleted": True})


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
