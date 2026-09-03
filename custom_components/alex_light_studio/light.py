"""Plateforme `light` : une entite virtuelle par zone de segments (vue
LightZone). Voir zones.py pour le principe general.

Cree dynamiquement, pas seulement au demarrage : une nouvelle zone
enregistree via le panel (websocket_save_light_zone dans __init__.py) fait
apparaitre sa lumiere immediatement, sans redemarrage HA -- le callback
`async_add_entities` recu ici est conserve dans hass.data pour cet usage.
Une zone supprimee retire son entite en symetrie (websocket_delete_light_zone).

Chaque lumiere garde son dernier etat (RestoreEntity) -- sans ca, une zone
reviendrait a une couleur/luminosite par defaut a chaque redemarrage HA,
inacceptable pour une lumiere purement virtuelle sans etat materiel propre.
"""
from __future__ import annotations

import logging

from homeassistant.components.light import ATTR_BRIGHTNESS, ATTR_HS_COLOR, ColorMode, LightEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN
from .zones import hsv_to_hex

_LOGGER = logging.getLogger(__name__)

# Etat par defaut d'une zone jamais encore allumee (pas de RestoreEntity a
# lire) -- ambre chaud plutot que blanc pur, plus flatteur comme premiere
# impression sur un bandeau de nuance chaude.
_DEFAULT_HS_COLOR = (30.0, 80.0)
_DEFAULT_BRIGHTNESS = 200


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Cree une entite par zone deja enregistree, et conserve le callback
    d'ajout pour les zones creees plus tard depuis le panel (pas de
    redemarrage HA necessaire pour qu'une nouvelle zone apparaisse)."""
    entry_data = hass.data[DOMAIN][entry.entry_id]
    entry_data["light_add_entities"] = async_add_entities
    entry_data.setdefault("zone_entities", {})

    entities = [
        AlexLightStudioZoneLight(hass, entry.entry_id, zone_id)
        for zone_id in entry_data.get("light_zones", {})
    ]
    async_add_entities(entities)


class AlexLightStudioZoneLight(RestoreEntity, LightEntity):
    """Une zone = un groupe d'un ou plusieurs segments d'un bandeau,
    pilotable comme une lumiere HS classique. La couleur/luminosite
    controle directement ce qui est envoye pour les segments de cette zone
    au prochain recalcul du bandeau parent -- pas de materiel propre, tout
    l'etat vit dans cette entite (d'ou RestoreEntity)."""

    _attr_should_poll = False
    _attr_color_mode = ColorMode.HS
    _attr_supported_color_modes = {ColorMode.HS}

    def __init__(self, hass: HomeAssistant, entry_id: str, zone_id: str) -> None:
        self.hass = hass
        self._entry_id = entry_id
        self._zone_id = zone_id
        zone = hass.data[DOMAIN][entry_id]["light_zones"].get(zone_id, {})
        self._attr_name = zone.get("name") or "Zone"
        self._attr_unique_id = f"{entry_id}_zone_{zone_id}"
        # Entity_id fixe explicitement a partir du zone_id (meme principe que
        # sensor.py) plutot que laisse a la slugification automatique du nom
        # -- le panel doit pouvoir predire cet entity_id des qu'il connait le
        # zone_id (retourne par save_light_zone/get_light_zones), sans
        # dependre d'un nom qui peut changer ou contenir des accents.
        zone_slug = zone_id.replace("-", "")
        self.entity_id = f"light.alex_light_studio_zone_{zone_slug}"
        self._attr_is_on = False
        self._attr_hs_color = _DEFAULT_HS_COLOR
        self._attr_brightness = _DEFAULT_BRIGHTNESS

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.hass.data[DOMAIN][self._entry_id].setdefault("zone_entities", {})[self._zone_id] = self

        last_state = await self.async_get_last_state()
        if last_state is not None:
            self._attr_is_on = last_state.state == "on"
            hs = last_state.attributes.get("hs_color")
            if hs is not None:
                self._attr_hs_color = tuple(hs)
            brightness = last_state.attributes.get("brightness")
            if brightness is not None:
                self._attr_brightness = brightness

    async def async_will_remove_from_hass(self) -> None:
        zone_entities = self.hass.data.get(DOMAIN, {}).get(self._entry_id, {}).get("zone_entities", {})
        zone_entities.pop(self._zone_id, None)

    @property
    def _zone(self) -> dict | None:
        return self.hass.data[DOMAIN][self._entry_id]["light_zones"].get(self._zone_id)

    @property
    def rgb_color_hex(self) -> str:
        """Couleur hex actuelle de cette zone, luminosite comprise --
        consommee par le recalcul du bandeau parent (voir
        __init__._async_recompute_strip). #000000 si eteinte."""
        if not self._attr_is_on:
            return "#000000"
        hue, sat = self._attr_hs_color
        value = (self._attr_brightness or 255) / 255
        return hsv_to_hex(hue, sat / 100, value)

    async def async_turn_on(self, **kwargs) -> None:
        if ATTR_HS_COLOR in kwargs:
            self._attr_hs_color = kwargs[ATTR_HS_COLOR]
        if ATTR_BRIGHTNESS in kwargs:
            self._attr_brightness = kwargs[ATTR_BRIGHTNESS]
        self._attr_is_on = True
        self.async_write_ha_state()
        await self._async_recompute_parent_strip()

    async def async_turn_off(self, **kwargs) -> None:
        self._attr_is_on = False
        self.async_write_ha_state()
        await self._async_recompute_parent_strip()

    async def _async_recompute_parent_strip(self) -> None:
        zone = self._zone
        if zone is None:
            _LOGGER.warning("Zone %s introuvable dans la configuration au moment du recalcul", self._zone_id)
            return
        recompute = self.hass.data[DOMAIN][self._entry_id].get("recompute_strip")
        if recompute is None:
            _LOGGER.warning("Fonction de recalcul de bandeau non enregistree, zone %s ignorée", self._zone_id)
            return
        await recompute(zone["strip_id"])
