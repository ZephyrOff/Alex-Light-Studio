"""Calcul des couleurs par zone de segments -- independant de Home Assistant.

Une "zone" represente un groupe d'un ou plusieurs segments d'un bandeau,
associee a une lumiere virtuelle (`light.*`) activable independamment --
evite d'avoir a creer une scene par combinaison d'etats (ex. un bandeau
au-dessus d'un placard a N portes, un segment par porte : sans ce
mecanisme, gerer toutes les combinaisons de portes ouvertes demanderait 2^N
scenes). Contrairement au degrade (gradient.py), les zones referencent des
index de segments concrets, pas des positions fractionnaires 0-1 -- le
bandeau et son nombre de segments sont choisis explicitement au moment de
definir les zones (registre partage, voir STORAGE_KEY_STRIPS dans
const.py), pas rejoues sur un appareil inconnu a l'avance comme un degrade.

Module volontairement independant de Home Assistant (aucun import hass) :
la logique se teste et se relit isolement, meme principe que gradient.py.
"""
from __future__ import annotations


def hsv_to_hex(hue: float, saturation: float, value: float) -> str:
    """Teinte (0-360), saturation (0-1), valeur (0-1) -> couleur hex.

    La valeur porte ici la luminosite de la zone elle-meme : le champ
    `brightness` partage d'un payload MQTT gradient/segment_colors s'applique
    a tout le bandeau d'un coup, Zigbee2MQTT n'a pas de notion de luminosite
    par segment individuel -- il faut donc "cuire" la luminosite de chaque
    zone directement dans sa couleur RVB plutot que de compter sur un champ
    brightness partage (memes principe et raison que le correctif applique
    sur Alex Gradient Popup Card, juste dans l'autre sens : la, c'est parce
    qu'on veut justement une luminosite par zone qu'on ne peut plus passer
    par le champ partage)."""
    hue = hue % 360
    saturation = max(0.0, min(1.0, saturation))
    value = max(0.0, min(1.0, value))
    c = value * saturation
    x = c * (1 - abs((hue / 60) % 2 - 1))
    m = value - c
    if hue < 60:
        r, g, b = c, x, 0.0
    elif hue < 120:
        r, g, b = x, c, 0.0
    elif hue < 180:
        r, g, b = 0.0, c, x
    elif hue < 240:
        r, g, b = 0.0, x, c
    elif hue < 300:
        r, g, b = x, 0.0, c
    else:
        r, g, b = c, 0.0, x
    return "#" + "".join(f"{max(0, min(255, round((v + m) * 255))):02x}" for v in (r, g, b))


def compute_zone_colors(zones: list[dict], segment_count: int, idle_color: str = "#000000") -> list[str]:
    """Combine l'etat courant de toutes les zones d'un bandeau en un tableau
    de `segment_count` couleurs.

    Chaque zone de `zones` est un dict {"segments": [int, ...], "is_on":
    bool, "color": "#rrggbb"}. Une zone inactive (is_on=False) laisse ses
    segments a `idle_color`. Chevauchement entre deux zones actives sur un
    meme segment : la derniere de la liste l'emporte (dernier-applique
    gagne) -- l'appelant est responsable de l'ordre si ca compte."""
    colors = [idle_color] * max(0, segment_count)
    for zone in zones:
        if not zone.get("is_on"):
            continue
        color = zone.get("color") or idle_color
        for seg in zone.get("segments", []):
            if 0 <= seg < segment_count:
                colors[seg] = color
    return colors
