"""Capteur exposant la bibliotheque de scenes de degrade (vue Gradient).

L'etat est le nombre de scenes enregistrees (utile d'un coup d'oeil) ; les
attributs portent la bibliotheque complete -- c'est ce que lisent le panel
et la carte alex-gradient-scene-card pour lister les scenes disponibles.
"""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_GRADIENT_SCENES_UPDATED


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Cree l'entite capteur de scenes de degrade pour cette entree."""
    async_add_entities([AlexLightStudioGradientScenesSensor(hass, entry)])


class AlexLightStudioGradientScenesSensor(SensorEntity):
    """Expose la bibliotheque de scenes de degrade en attribut."""

    _attr_name = "Alex Light Studio - Scènes de dégradé"
    _attr_icon = "mdi:gradient-horizontal"
    _attr_should_poll = False

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_gradient_scenes"
        # Entity_id fixe explicitement (plutot que laisse a la slugification
        # automatique du nom, peu previsible) -- la carte
        # alex-gradient-scene-card et le panel lisent cette entite par un nom
        # connu a l'avance, pas via une recherche dynamique.
        self.entity_id = "sensor.alex_light_studio_gradient_scenes"

    @property
    def _scenes(self) -> dict:
        return self.hass.data[DOMAIN][self._entry.entry_id]["gradient_scenes"]

    @property
    def native_value(self) -> int:
        return len(self._scenes)

    @property
    def extra_state_attributes(self) -> dict:
        return {"scenes": self._scenes}

    async def async_added_to_hass(self) -> None:
        """Se reabonne aux mises a jour de la bibliotheque a l'ajout de l'entite."""
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_GRADIENT_SCENES_UPDATED, self._handle_update)
        )

    @callback
    def _handle_update(self) -> None:
        self.async_write_ha_state()
