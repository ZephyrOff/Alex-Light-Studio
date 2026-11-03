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

import math

from .gradient import _lerp_color


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


def kelvin_to_hex(kelvin: float, value: float = 1.0) -> str:
    """Approximation RGB d'une temperature de couleur (algorithme de Tanner
    Helland, 1000-40000K) -- suffisant pour un rendu visuel sur bandeau LED,
    pas une reproduction spectrale exacte. `value` (0-1) joue le meme role
    que dans hsv_to_hex : la luminosite de la zone, cuite dans la couleur
    finale plutot que comptee sur le champ brightness partage du payload."""
    temp = max(1000.0, min(40000.0, kelvin)) / 100.0

    if temp <= 66:
        red = 255.0
    else:
        red = 329.698727446 * ((temp - 60) ** -0.1332047592)

    if temp <= 66:
        green = 99.4708025861 * math.log(temp) - 161.1195681661
    else:
        green = 288.1221695283 * ((temp - 60) ** -0.0755148492)

    if temp >= 66:
        blue = 255.0
    elif temp <= 19:
        blue = 0.0
    else:
        blue = 138.5177312231 * math.log(temp - 10) - 305.0447927307

    value = max(0.0, min(1.0, value))
    rgb = (
        max(0.0, min(255.0, red)) * value,
        max(0.0, min(255.0, green)) * value,
        max(0.0, min(255.0, blue)) * value,
    )
    return "#" + "".join(f"{max(0, min(255, round(c))):02x}" for c in rgb)


def compute_zone_colors(
    zones: list[dict], segment_count: int, idle_color: str = "#000000", blend: float = 0.0
) -> list[str]:
    """Combine l'etat courant de toutes les zones d'un bandeau en un tableau
    de `segment_count` couleurs.

    Chaque zone de `zones` est un dict {"segments": [int, ...], "is_on":
    bool, "color": "#rrggbb"}. Une zone inactive (is_on=False) laisse ses
    segments a `idle_color`. Chevauchement entre deux zones actives sur un
    meme segment : la derniere de la liste l'emporte (dernier-applique
    gagne) -- l'appelant est responsable de l'ordre si ca compte.

    `blend` (0-100) adoucit la frontiere entre deux zones ACTIVES voisines de
    couleurs differentes (voir blend_zone_edges) ; 0 = coupure nette."""
    colors = [idle_color] * max(0, segment_count)
    active = [False] * max(0, segment_count)
    for zone in zones:
        if not zone.get("is_on"):
            continue
        color = zone.get("color") or idle_color
        for seg in zone.get("segments", []):
            if 0 <= seg < segment_count:
                colors[seg] = color
                active[seg] = True
    if blend > 0:
        colors = blend_zone_edges(colors, active, blend)
    return colors


def blend_zone_edges(colors: list[str], active: list[bool], blend: float) -> list[str]:
    """Fondu a la frontiere de deux plages actives adjacentes de couleurs
    differentes. Une plage = segments actifs consecutifs de meme couleur ; la
    zone de fondu est centree sur la frontiere et fait `blend`% de la plus
    petite des deux plages (donc ne deborde jamais sur le coeur d'une plage).
    Un segment eteint n'est jamais touche : une zone allumee a cote d'une zone
    eteinte garde un bord net, sinon la lumiere deborderait sur la zone eteinte."""
    n = len(colors)
    runs: list[tuple[int, int]] = []  # (debut, fin exclue)
    i = 0
    while i < n:
        if not active[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and active[j + 1] and colors[j + 1] == colors[i]:
            j += 1
        runs.append((i, j + 1))
        i = j + 1

    w = max(0.0, min(1.0, blend / 100.0))
    out = list(colors)
    for (s1, e1), (s2, e2) in zip(runs, runs[1:]):
        if e1 != s2:  # separees par un segment eteint/inactif
            continue
        half = w * min(e1 - s1, e2 - s2) / 2
        if half <= 0:
            continue
        for seg in range(max(s1, int(e1 - half) - 1), min(e2, int(e1 + half) + 2)):
            centre = seg + 0.5
            if centre < e1 - half or centre > e1 + half:
                continue
            t = (centre - (e1 - half)) / (2 * half)
            out[seg] = _lerp_color(colors[s1], colors[s2], t)
    return out
