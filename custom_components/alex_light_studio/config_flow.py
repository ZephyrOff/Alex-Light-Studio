"""Flux de configuration pour Alex Light Studio.

Instance unique, sans champ a saisir -- l'integration n'a besoin d'aucune
information de connexion, elle lit/ecrit uniquement son propre stockage,
les entites deja presentes dans cette instance HA, et publie sur MQTT
(deja configure separement) pour la partie degrades.
"""
from __future__ import annotations

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN


class AlexLightStudioConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Gere la configuration d'Alex Light Studio."""

    VERSION = 1

    async def async_step_user(self, user_input: dict | None = None) -> FlowResult:
        """Etape unique : confirmation, instance unique forcee."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="Alex Light Studio", data={})

        return self.async_show_form(step_id="user")
