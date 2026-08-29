"""Logique d'interpolation de degrade, independante de tout appareil precis.

Un degrade est stocke sous forme de points d'ancrage (position 0.0-1.0,
couleur hex) plutot qu'un nombre fixe de couleurs -- exactement le principe
d'un degrade CSS -- pour rester reutilisable sur n'importe quel bandeau,
quel que soit son nombre reel de segments. `resample_stops` reechantillonne
ces points d'ancrage pour produire N couleurs par interpolation lineaire au
moment de l'application, sur l'appareil cible.

Module volontairement independant de Home Assistant (aucun import hass) :
la logique se teste et se relit isolement.
"""
from __future__ import annotations


def colors_to_stops(colors: list[str]) -> list[dict]:
    """Convertit une liste de N couleurs (supposees egalement espacees le
    long du bandeau d'origine) en points d'ancrage {position, color}."""
    n = len(colors)
    if n == 0:
        return []
    if n == 1:
        return [{"position": 0.0, "color": colors[0]}]
    return [{"position": i / (n - 1), "color": color} for i, color in enumerate(colors)]


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = (hex_color or "#ffffff").lstrip("#")
    if len(h) != 6:
        return (255, 255, 255)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    r, g, b = (max(0, min(255, round(c))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def _lerp_color(c1: str, c2: str, t: float) -> str:
    r1, g1, b1 = _hex_to_rgb(c1)
    r2, g2, b2 = _hex_to_rgb(c2)
    return _rgb_to_hex((r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t))


def resample_stops(stops: list[dict], segments: int) -> list[str]:
    """Reechantillonne des points d'ancrage pour produire exactement
    `segments` couleurs hex par interpolation lineaire -- le meme principe
    qu'un degrade CSS rendu a une resolution donnee. Les points d'ancrage
    n'ont pas besoin d'etre pre-tries ni de couvrir exactement [0,1]."""
    if segments <= 0:
        return []
    if not stops:
        return ["#ffffff"] * segments

    sorted_stops = sorted(stops, key=lambda s: s["position"])
    if len(sorted_stops) == 1:
        return [sorted_stops[0]["color"]] * segments

    result: list[str] = []
    for i in range(segments):
        pos = i / (segments - 1) if segments > 1 else 0.0
        lo, hi = sorted_stops[0], sorted_stops[-1]
        for j in range(len(sorted_stops) - 1):
            if sorted_stops[j]["position"] <= pos <= sorted_stops[j + 1]["position"]:
                lo, hi = sorted_stops[j], sorted_stops[j + 1]
                break
        span = hi["position"] - lo["position"]
        t = 0.0 if span <= 0 else (pos - lo["position"]) / span
        result.append(_lerp_color(lo["color"], hi["color"], t))
    return result


def hex_to_rgb_obj(hex_color: str) -> dict:
    """Conversion hex -> {r,g,b}, pour le format de payload Aqara
    (segment_colors), distinct du simple tableau de hex utilise par Hue."""
    r, g, b = _hex_to_rgb(hex_color)
    return {"r": r, "g": g, "b": b}
