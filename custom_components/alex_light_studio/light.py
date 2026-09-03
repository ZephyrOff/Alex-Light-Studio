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

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_HS_COLOR,
    ColorMode,
    LightEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import DOMAIN
from .zones import hsv_to_hex, kelvin_to_hex

_LOGGER = logging.getLogger(__name__)

# Etat par defaut d'une zone jamais encore allumee (pas de RestoreEntity a
# lire) -- ambre chaud plutot que blanc pur, plus flatteur comme premiere
# impression sur un bandeau de nuance chaude. Mode couleur par defaut : HS
# (coherent avec cette teinte de depart).
_DEFAULT_HS_COLOR = (30.0, 80.0)
_DEFAULT_BRIGHTNESS = 200
_DEFAULT_COLOR_TEMP_KELVIN = 3000


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
    pilotable comme une lumiere HS + temperature de couleur classique. La
    couleur/luminosite controle directement ce qui est envoye pour les
    segments de cette zone au prochain recalcul du bandeau parent -- pas de
    materiel propre, tout l'etat vit dans cette entite (d'ou RestoreEntity).

    Les deux modes (HS et temperature) sont proposes ; le mode COURANT
    (`_attr_color_mode`) bascule sur celui utilise en dernier -- HA n'admet
    qu'un seul mode actif a la fois, meme si plusieurs sont "supportes"."""

    _attr_should_poll = False
    _attr_supported_color_modes = {ColorMode.HS, ColorMode.COLOR_TEMP}

    def __init__(self, hass: HomeAssistant, entry_id: str, zone_id: str) -> None:
        self.hass = hass
        self._entry_id = entry_id
        self._zone_id = zone_id
        zone = hass.data[DOMAIN][entry_id]["light_zones"].get(zone_id, {})
        self._attr_name = zone.get("name") or "Zone"
        self._attr_unique_id = f"{entry_id}_zone_{zone_id}"
        # Entity_id derive du slug stocke sur la zone (genere une seule fois
        # a la creation, voir _unique_zone_slug dans __init__.py) plutot que
        # du zone_id brut -- lisible ("light.chambre_bled_seg1" plutot qu'un
        # UUID), tout en restant stable si la zone est renommee plus tard
        # (le slug, lui, ne change jamais retroactivement). Pas de prefixe
        # de namespace : _unique_zone_slug verifie deja les collisions
        # contre les entites HA existantes au moment de la creation, pas
        # seulement entre zones. Repli sur le zone_id si une zone plus
        # ancienne n'a pas encore de slug enregistre (retrocompatibilite,
        # avant l'ajout de ce champ).
        slug = zone.get("slug") or zone_id.replace("-", "")
        self.entity_id = f"light.{slug}"
        self._attr_is_on = False
        self._attr_color_mode = ColorMode.HS
        self._attr_hs_color = _DEFAULT_HS_COLOR
        self._attr_color_temp_kelvin = _DEFAULT_COLOR_TEMP_KELVIN
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
            color_temp = last_state.attributes.get("color_temp_kelvin")
            if color_temp is not None:
                self._attr_color_temp_kelvin = color_temp
            restored_mode = last_state.attributes.get("color_mode")
            if restored_mode in (ColorMode.HS, ColorMode.COLOR_TEMP):
                self._attr_color_mode = restored_mode
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
        __init__._async_recompute_strip). #000000 si eteinte. Suit le mode
        courant : conversion HS ou temperature selon le dernier reglage."""
        if not self._attr_is_on:
            return "#000000"
        value = (self._attr_brightness or 255) / 255
        if self._attr_color_mode == ColorMode.COLOR_TEMP:
            return kelvin_to_hex(self._attr_color_temp_kelvin or _DEFAULT_COLOR_TEMP_KELVIN, value)
        hue, sat = self._attr_hs_color
        return hsv_to_hex(hue, sat / 100, value)

    async def async_turn_on(self, **kwargs) -> None:
        if ATTR_HS_COLOR in kwargs:
            self._attr_hs_color = kwargs[ATTR_HS_COLOR]
            self._attr_color_mode = ColorMode.HS
        elif ATTR_COLOR_TEMP_KELVIN in kwargs:
            self._attr_color_temp_kelvin = kwargs[ATTR_COLOR_TEMP_KELVIN]
            self._attr_color_mode = ColorMode.COLOR_TEMP

        brightness_changed = ATTR_BRIGHTNESS in kwargs
        if brightness_changed:
            self._attr_brightness = kwargs[ATTR_BRIGHTNESS]
        elif not self._attr_is_on:
            # Premier allumage de cette zone, sans luminosite explicite :
            # rejoint la luminosite courante du bandeau si une autre zone y
            # est deja active, plutot que de reintroduire un ecart entre
            # segments (voir _async_sync_sibling_brightness).
            sibling_brightness = self._sibling_active_brightness()
            if sibling_brightness is not None:
                self._attr_brightness = sibling_brightness

        self._attr_is_on = True
        self.async_write_ha_state()

        if brightness_changed:
            await self._async_sync_sibling_brightness()

        await self._async_recompute_parent_strip()

    def sync_brightness(self, brightness: int) -> None:
        """Appele par _async_sync_strip_brightness (cote __init__.py) pour
        aligner cette zone sur la luminosite d'une autre zone du meme
        bandeau. Mise a jour directe, pas d'appel a async_turn_on -- cette
        zone est deja allumee, et on ne veut pas redeclencher sa propre
        propagation ni un recalcul redondant du bandeau (celui de la zone a
        l'origine du changement suffit, il a lieu juste apres)."""
        if self._attr_brightness == brightness:
            return
        self._attr_brightness = brightness
        self.async_write_ha_state()

    def _sibling_active_brightness(self) -> int | None:
        """Luminosite d'une zone deja active sur le meme bandeau, s'il y en
        a une -- pour qu'une zone qui s'allume rejoigne le niveau courant
        plutot que d'introduire un ecart des le depart."""
        zone = self._zone
        if zone is None:
            return None
        entry_data = self.hass.data[DOMAIN][self._entry_id]
        zone_entities = entry_data.get("zone_entities", {})
        for zid, cfg in entry_data["light_zones"].items():
            if zid == self._zone_id or cfg.get("strip_id") != zone["strip_id"]:
                continue
            entity = zone_entities.get(zid)
            if entity is not None and entity.is_on:
                return entity.brightness
        return None

    async def _async_sync_sibling_brightness(self) -> None:
        zone = self._zone
        if zone is None:
            return
        sync = self.hass.data[DOMAIN][self._entry_id].get("sync_strip_brightness")
        if sync is None:
            return
        await sync(zone["strip_id"], self._attr_brightness, self._zone_id)

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
