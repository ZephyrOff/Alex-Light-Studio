"""Algorithme d'harmonie pour Alex Scene Studio (v3).

Reecrit a partir d'un guide de reference detaille (fourni par l'utilisateur)
sur les moteurs de lumiere spatiale, et compare a de vraies scenes Philips
Hue. Le document recommande explicitement de commencer par un "noyau
minimal" plutot que d'implementer toutes ses sections d'un coup (section 28)
-- cette version couvre :

  - Espace de couleur PERCEPTUEL (OKLCH, section 4.5/4.6) pour tout melange
    de plusieurs contributions chromatiques -- une simple moyenne RGB/HSV
    produit des couleurs "sales" (gris/brun) que le document identifie
    explicitement comme un piege.
  - ROLES PONDERES, pas rigides (section 10) : une lumiere peut etre 70%
    ambiance / 30% accent, plutot qu'une seule categorie fixe.
  - ZONES nommees et positionnees (section 6.4), avec une influence qui
    decroit avec la distance (falloff lineaire, section 7.1) -- permet par
    exemple "chaud pres de la TV, froid pres de la fenetre" simultanement,
    pas seulement un degrade a un seul axe.
  - PUISSANCE relative des luminaires (section 9.1) : une bande LED
    puissante et une petite ampoule ne devraient pas recevoir la meme
    consigne pour un rendu equivalent.
  - Degrade spatial par hauteur (herite de la version precedente) comme
    couche de base, combinee a l'influence des zones.

Explicitement PAS encore construit dans cette version, le document les
classant comme avances/a ajouter plus tard (sections 15.3, 16-19, 26) :
orientation/angle de faisceau pour les spots, lissage par graphe de
voisinage, metriques de score d'harmonie, adaptation a la lumiere
naturelle/au contexte temporel, calibration par appareil reel.

Module volontairement independant de Home Assistant (aucun import hass).
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

ROLES = ("primary", "accent", "ambient")
POSITIONS = ("ceiling", "wall", "desk", "furniture", "floor")

# ---------------------------------------------------------------------------
# Conversion de couleur perceptuelle (OKLCH), formules de Bjorn Ottosson
# (2020) -- teste isolement (round-trip exact sur les couleurs de reference)
# avant integration ici. Utilise UNIQUEMENT pour melanger plusieurs
# contributions chromatiques (base + zones) sans produire de couleurs
# "sales" -- la conversion finale vers hue/saturation HA se fait a la toute
# fin (section 4.5 du document : calculer dans un espace perceptuel, puis
# convertir vers ce qu'attend la lampe seulement a la fin).
# ---------------------------------------------------------------------------
def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(c: float) -> float:
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def _rgb_to_oklch(r: float, g: float, b: float) -> tuple[float, float, float]:
    """r,g,b dans [0,255] -> (L, C, H) ; H en degres 0-360."""
    r, g, b = _srgb_to_linear(r / 255), _srgb_to_linear(g / 255), _srgb_to_linear(b / 255)

    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

    l_ = math.copysign(abs(l) ** (1 / 3), l)
    m_ = math.copysign(abs(m) ** (1 / 3), m)
    s_ = math.copysign(abs(s) ** (1 / 3), s)

    big_l = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b2 = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_

    c = math.sqrt(a * a + b2 * b2)
    h = math.degrees(math.atan2(b2, a)) % 360
    return big_l, c, h


def _oklch_to_rgb(big_l: float, c: float, h: float) -> tuple[int, int, int]:
    """(L, C, H en degres) -> r,g,b entiers dans [0,255]."""
    a = c * math.cos(math.radians(h))
    b2 = c * math.sin(math.radians(h))

    l_ = big_l + 0.3963377774 * a + 0.2158037573 * b2
    m_ = big_l - 0.1055613458 * a - 0.0638541728 * b2
    s_ = big_l - 0.0894841775 * a - 1.2914855480 * b2

    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3

    r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    b3 = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

    r, g, b3 = _linear_to_srgb(r), _linear_to_srgb(g), _linear_to_srgb(b3)
    return (
        max(0, min(255, round(r * 255))),
        max(0, min(255, round(g * 255))),
        max(0, min(255, round(b3 * 255))),
    )


def _hsv_to_rgb(h: float, s: float, v: float) -> tuple[int, int, int]:
    """h: 0-360, s,v: 0-100 -> r,g,b entiers dans [0,255]."""
    h = h % 360
    s, v = s / 100, v / 100
    c = v * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = v - c
    if h < 60:
        r, g, b = c, x, 0.0
    elif h < 120:
        r, g, b = x, c, 0.0
    elif h < 180:
        r, g, b = 0.0, c, x
    elif h < 240:
        r, g, b = 0.0, x, c
    elif h < 300:
        r, g, b = x, 0.0, c
    else:
        r, g, b = c, 0.0, x
    return (round((r + m) * 255), round((g + m) * 255), round((b + m) * 255))


def _rgb_to_hsv(r: float, g: float, b: float) -> tuple[float, float, float]:
    """r,g,b: 0-255 -> h: 0-360, s,v: 0-100."""
    r, g, b = r / 255, g / 255, b / 255
    mx, mn = max(r, g, b), min(r, g, b)
    diff = mx - mn
    if diff == 0:
        h = 0.0
    elif mx == r:
        h = (60 * ((g - b) / diff) + 360) % 360
    elif mx == g:
        h = (60 * ((b - r) / diff) + 120) % 360
    else:
        h = (60 * ((r - g) / diff) + 240) % 360
    s = 0.0 if mx == 0 else diff / mx
    return (h, s * 100, mx * 100)


def _circular_weighted_hue(hues_weights: list[tuple[float, float]]) -> float:
    """Moyenne ponderee de plusieurs teintes, en tenant compte du caractere
    circulaire de la roue chromatique (moyenner lineairement 350 et 10
    donnerait a tort 180 -- il faut une moyenne vectorielle)."""
    x = sum(w * math.cos(math.radians(h)) for h, w in hues_weights)
    y = sum(w * math.sin(math.radians(h)) for h, w in hues_weights)
    if x == 0 and y == 0:
        return hues_weights[0][0] if hues_weights else 0.0
    return math.degrees(math.atan2(y, x)) % 360


# Plage de luminosite (0-255) par role, avant application du contraste, de
# l'intensite globale, de l'importance individuelle et de la puissance.
ROLE_BRIGHTNESS_RANGE = {
    "primary": (153, 204),  # 60-80% de 255
    "accent": (77, 128),  # 30-50%
    "ambient": (26, 77),  # 10-30%
}

# Saturation de reference par role.
ROLE_BASE_SATURATION = {"primary": 20, "accent": 75, "ambient": 55}

# Decalage de temperature (kelvin) par role autour de la base de la scene.
ROLE_KELVIN_OFFSET = {"primary": 0, "accent": -150, "ambient": -300}

INDIRECT_SATURATION_FACTOR = 0.65

# Role fonctionnel PONDERE (pas rigide, section 10 du document : "une
# lumiere peut etre 70% ambient et 30% accent") selon la position physique
# et la direction -- remplace l'ancienne table a une seule categorie par
# combinaison.
_ROLE_WEIGHTS_FROM_POSITION_DIRECTION = {
    ("ceiling", "direct"): {"primary": 0.85, "accent": 0.15},
    ("ceiling", "indirect"): {"ambient": 0.8, "primary": 0.2},
    ("wall", "direct"): {"accent": 0.75, "primary": 0.25},
    ("wall", "indirect"): {"ambient": 0.85, "accent": 0.15},
    ("desk", "direct"): {"primary": 0.8, "accent": 0.2},
    ("desk", "indirect"): {"ambient": 0.9, "primary": 0.1},
    ("furniture", "direct"): {"accent": 0.7, "primary": 0.3},
    ("furniture", "indirect"): {"ambient": 0.85, "accent": 0.15},
    ("floor", "direct"): {"accent": 0.6, "ambient": 0.4},
    ("floor", "indirect"): {"ambient": 0.9, "accent": 0.1},
}


def derive_role_weights(position: str, direction: str) -> dict[str, float]:
    """Renvoie une distribution de poids sur les roles (somme = 1), plutot
    qu'un role unique -- section 10 du document."""
    return dict(_ROLE_WEIGHTS_FROM_POSITION_DIRECTION.get((position, direction), {"primary": 1.0}))


def derive_role(position: str, direction: str) -> str:
    """Le role dominant (poids le plus eleve) -- pour l'affichage cote
    panel uniquement, le calcul reel utilise derive_role_weights."""
    weights = derive_role_weights(position, direction)
    return max(weights, key=weights.get)


GRADIENT_STOPS = 6
SCHEME_ARC_WIDTH = {"analogous": 90, "complementary": 150, "triadic": 220}


def _hue_scheme(base_hue: float, scheme: str, direction: int = 1) -> list[float]:
    base_hue = base_hue % 360
    width = SCHEME_ARC_WIDTH.get(scheme, 90) * (1 if direction >= 0 else -1)
    if GRADIENT_STOPS <= 1:
        return [base_hue]
    return [(base_hue + width * i / (GRADIENT_STOPS - 1)) % 360 for i in range(GRADIENT_STOPS)]


def _lerp_hue(h1: float, h2: float, t: float) -> float:
    diff = ((h2 - h1 + 180) % 360) - 180
    return (h1 + diff * t) % 360


def _spatial_hue(normalized_height: float, hue_slots: list[float]) -> float:
    n = len(hue_slots)
    if n == 1:
        return hue_slots[0]
    scaled = max(0.0, min(1.0, normalized_height)) * (n - 1)
    lo = int(scaled)
    hi = min(n - 1, lo + 1)
    local_t = scaled - lo
    return _lerp_hue(hue_slots[lo], hue_slots[hi], local_t)


def _linear_falloff(distance: float, radius: float) -> float:
    """Influence lineaire (section 7.1 du document) : 1 a distance nulle,
    decroit jusqu'a 0 au rayon indique."""
    if radius <= 0:
        return 0.0
    return max(0.0, 1.0 - distance / radius)


# ---------------------------------------------------------------------------
# Ambiances predefinies
# ---------------------------------------------------------------------------
MOOD_PRESETS = {
    "energique": {"hue_range": (180, 260), "saturation": 75, "global_intensity": 1.05, "scheme": "complementary", "contrast": 0.75, "white_temperature": 4000},
    "detente": {"hue_range": (15, 45), "saturation": 55, "global_intensity": 0.75, "scheme": "analogous", "contrast": 0.55, "white_temperature": 2700},
    "concentration": {"hue_range": (190, 210), "saturation": 25, "global_intensity": 1.1, "scheme": "analogous", "contrast": 0.3, "white_temperature": 4500},
    "lecture": {"hue_range": (35, 50), "saturation": 35, "global_intensity": 0.95, "scheme": "analogous", "contrast": 0.4, "white_temperature": 3000},
    "quotidien": {"hue_range": (190, 210), "saturation": 15, "global_intensity": 1.0, "scheme": "analogous", "contrast": 0.25, "white_temperature": 4000, "role_multiplier": {"primary": 1.0, "accent": 0.8, "ambient": 0.6}},
    "cinema": {"hue_range": (220, 260), "saturation": 50, "global_intensity": 0.5, "scheme": "analogous", "contrast": 0.9, "white_temperature": 2400, "role_multiplier": {"primary": 0.15, "accent": 0.5, "ambient": 1.4}},
    "soiree": {"hue_range": (280, 340), "saturation": 80, "global_intensity": 0.85, "scheme": "triadic", "contrast": 0.7, "white_temperature": 2700, "role_multiplier": {"primary": 0.7, "accent": 1.3, "ambient": 1.1}},
    "nuit": {"hue_range": (10, 25), "saturation": 60, "global_intensity": 0.25, "scheme": "analogous", "contrast": 0.3, "white_temperature": 2200, "role_multiplier": {"primary": 0.5, "accent": 0.7, "ambient": 1.0}},
}

# Style de generation -- independant de l'ambiance/des parametres manuels,
# permet de pousser vers plus de douceur ou plus de punch sans changer de
# teinte/ambiance. Reponse directe au retour "toujours fade et pas assez
# lumineux" : les ambiances/parametres manuels fixent la DIRECTION (quelle
# teinte, quel contraste de hierarchie), ce style en fixe l'INTENSITE
# chromatique et lumineuse globale, applique en plus, pas a la place.
GENERATION_STYLES = {
    "doux": {"saturation_mult": 0.65, "intensity_mult": 0.85},
    "normal": {"saturation_mult": 1.0, "intensity_mult": 1.0},
    "dynamique": {"saturation_mult": 1.3, "intensity_mult": 1.15},
    "explosif": {"saturation_mult": 1.6, "intensity_mult": 1.3},
}


@dataclass
class ZoneInput:
    """Une zone nommee et positionnee (section 6.4 du document) -- ancrage
    chromatique local qui influence les lumieres proches selon la distance."""

    name: str
    x: float
    y: float
    hue: float
    saturation: float = 70.0
    influence_radius: float = 150.0  # unites du plan (meme espace que les positions des lumieres)


@dataclass
class LightInput:
    """Ce qu'il faut savoir sur une lumiere positionnee pour lui calculer
    une proposition."""

    entity_id: str
    x: float = 0.0  # position reelle dans la piece -- necessaire pour l'influence des zones
    y: float = 0.0
    position: str = "ceiling"
    direction: str = "direct"
    importance: float = 0.7
    height: float = 2.2
    power: float = 1.0  # puissance/capacite relative (section 9.1) -- 1.0 = reference
    supports_color: bool = True
    supports_color_temp: bool = False


@dataclass
class LightSuggestion:
    entity_id: str
    hue: float
    saturation: float
    brightness: int
    color_temp_kelvin: int | None = None


def compute_scene(
    lights: list[LightInput],
    scheme: str,
    mood: str | None = None,
    base_hue: float | None = None,
    saturation: float | None = None,
    global_intensity: float | None = None,
    contrast: float | None = None,
    white_temperature: float | None = None,
    role_multiplier: dict[str, float] | None = None,
    zones: list[ZoneInput] | None = None,
    generation_style: str = "normal",
    rng: random.Random | None = None,
) -> list[LightSuggestion]:
    """Calcule une proposition pour chaque lumiere, en combinant :
      1. Un degrade de base selon la hauteur (herite de la version
         precedente, sert de "toile de fond" chromatique).
      2. L'influence des zones proches (section 6-7 du document),
         melangee en espace perceptuel OKLCH.
      3. Un role PONDERE (pas rigide) qui determine saturation/luminosite.
      4. La puissance relative de la lumiere (section 9.1).
    """
    rng = rng or random.Random()
    zones = zones or []

    if mood is not None:
        preset = MOOD_PRESETS.get(mood)
        if preset is None:
            raise ValueError(f"Ambiance inconnue: {mood}")
        lo, hi = preset["hue_range"]
        resolved_hue = rng.uniform(lo, hi)
        resolved_sat = preset["saturation"]
        resolved_intensity = preset["global_intensity"]
        resolved_contrast = preset["contrast"]
        resolved_white_temp = preset["white_temperature"]
        resolved_role_mult = preset.get("role_multiplier", {})
        scheme = preset["scheme"]
    else:
        if base_hue is None:
            raise ValueError("base_hue requis si aucune ambiance n'est fournie")
        resolved_hue = base_hue
        resolved_sat = saturation if saturation is not None else 60.0
        resolved_intensity = global_intensity if global_intensity is not None else 1.0
        resolved_contrast = contrast if contrast is not None else 0.6
        resolved_white_temp = white_temperature if white_temperature is not None else 2700.0
        resolved_role_mult = role_multiplier or {}

    # Le style de generation s'applique EN PLUS de l'ambiance/des parametres
    # manuels, pas a leur place. La saturation s'applique tout de suite --
    # mais PAS l'intensite : elle est reportee a la toute fin (apres le
    # compromis saturation/luminosite), sinon un style qui pousse la
    # saturation ET l'intensite en meme temps declenche sa PROPRE penalite
    # de luminosite (saturation elevee -> moins lumineux) qui annule le
    # boost qu'il etait cense apporter -- "explosif" finissait plus sombre
    # que "normal", exactement l'inverse de l'intention.
    style = GENERATION_STYLES.get(generation_style, GENERATION_STYLES["normal"])
    resolved_sat *= style["saturation_mult"]
    style_intensity_mult = style["intensity_mult"]

    direction_sign = rng.choice((1, -1))
    hue_slots = _hue_scheme(resolved_hue, scheme, direction_sign)

    heights = [light.height for light in lights]
    min_height, max_height = (min(heights), max(heights)) if heights else (0.0, 0.0)
    height_span = max_height - min_height

    suggestions: list[LightSuggestion] = []
    for light in lights:
        role_weights = derive_role_weights(light.position, light.direction)

        # --- Teinte : degrade de base par hauteur, puis influence des zones proches ---
        normalized_height = 0.5 if height_span <= 0 else (light.height - min_height) / height_span
        base_hue_val = _spatial_hue(normalized_height, hue_slots)
        base_sat_val = sum(w * ROLE_BASE_SATURATION[r] for r, w in role_weights.items()) * (resolved_sat / 60.0)

        hue, sat = _blend_hue_sat_with_zones(base_hue_val, base_sat_val, light.x, light.y, zones)

        # --- Luminosite : moyenne ponderee sur la distribution de roles ---
        bri = sum(
            w * _role_brightness(r, resolved_contrast, resolved_intensity) * resolved_role_mult.get(r, 1.0)
            for r, w in role_weights.items()
        )

        # Variation par hauteur (+/-15%) : sans ca, plusieurs lumieres
        # partageant le meme role (meme montage+direction) et les memes
        # importance/puissance par defaut recoivent une luminosite
        # STRICTEMENT identique, quelle que soit leur position reelle --
        # signale comme un vrai defaut ("il ne faut pas faire cela",
        # documents fournis). Une lumiere plus haute (plafond) eclaire
        # generalement une zone plus large depuis plus loin et beneficie
        # d'un peu plus de luminosite brute ; une lumiere basse, plus proche
        # de l'observateur, peut rester un peu plus discrete pour un effet
        # percu equivalent.
        bri *= 0.85 + 0.3 * normalized_height

        importance = max(0.0, min(1.0, light.importance))
        bri *= 0.4 + 0.6 * importance

        # Puissance relative (section 9.1) : une lumiere 2x plus puissante
        # recoit une consigne plus faible pour un rendu equivalent -- floor
        # a 0.1 pour eviter une division qui exploserait pour une valeur
        # quasi nulle mal saisie.
        bri /= max(0.1, light.power)

        if light.direction == "indirect":
            sat *= INDIRECT_SATURATION_FACTOR
            # Volontairement pas de reduction de luminosite : l'indirect
            # supporte generalement mieux des niveaux eleves (section 25
            # du document precedent, toujours valable ici).

        sat = max(0.0, min(100.0, sat))
        bri = _saturation_brightness_tradeoff(sat, bri)

        # Boost de style applique EN DERNIER (voir note plus haut) : garantit
        # qu'un style plus intense se traduit toujours par un resultat plus
        # lumineux, jamais annule par la penalite de saturation qu'il
        # declenche lui-meme plus tot dans le calcul.
        bri *= style_intensity_mult

        bri_int = max(1, min(255, round(bri)))

        color_temp_kelvin = None
        if not light.supports_color and light.supports_color_temp:
            dominant_role = max(role_weights, key=role_weights.get)
            color_temp_kelvin = int(max(2000, min(6500, resolved_white_temp + ROLE_KELVIN_OFFSET[dominant_role])))

        suggestions.append(
            LightSuggestion(entity_id=light.entity_id, hue=hue, saturation=sat, brightness=bri_int, color_temp_kelvin=color_temp_kelvin)
        )

    return suggestions


def _role_brightness(role: str, contrast: float, global_intensity: float) -> float:
    lo, hi = ROLE_BRIGHTNESS_RANGE[role]
    role_mid = (lo + hi) / 2
    all_mid = sum((lo2 + hi2) / 2 for lo2, hi2 in ROLE_BRIGHTNESS_RANGE.values()) / len(ROLE_BRIGHTNESS_RANGE)
    value = all_mid + (role_mid - all_mid) * contrast
    return value * global_intensity


def _saturation_brightness_tradeoff(saturation: float, brightness: float) -> float:
    factor = 1 - (saturation / 100) * 0.35
    return brightness * factor


def _blend_hue_sat_with_zones(
    base_hue: float, base_sat: float, light_x: float, light_y: float, zones: list[ZoneInput]
) -> tuple[float, float]:
    """Combine la teinte/saturation de base avec l'influence des zones
    proches, en espace perceptuel OKLCH (section 4.5/4.6 du document) --
    une simple moyenne RGB/HSV produirait des couleurs "sales" des que
    plusieurs contributions se melangent. La base compte pour un poids fixe
    de 1 ; chaque zone contribue selon un falloff lineaire par distance
    (section 7.1). Sans zone proche, renvoie la base inchangee."""
    contributions = [(base_hue, base_sat, 1.0)]
    for zone in zones:
        d = math.hypot(light_x - zone.x, light_y - zone.y)
        w = _linear_falloff(d, zone.influence_radius)
        if w > 0:
            contributions.append((zone.hue, zone.saturation, w))

    if len(contributions) == 1:
        return base_hue, base_sat

    oklch_points = []
    for hue, sat, weight in contributions:
        r, g, b = _hsv_to_rgb(hue, sat, 70)
        big_l, c, h = _rgb_to_oklch(r, g, b)
        oklch_points.append((big_l, c, h, weight))

    total_weight = sum(w for _, _, _, w in oklch_points)
    l_mix = sum(l * w for l, _, _, w in oklch_points) / total_weight
    c_mix = sum(c * w for _, c, _, w in oklch_points) / total_weight
    h_mix = _circular_weighted_hue([(h, w) for _, _, h, w in oklch_points])

    r, g, b = _oklch_to_rgb(l_mix, c_mix, h_mix)
    final_hue, final_sat, _ = _rgb_to_hsv(r, g, b)
    return final_hue, final_sat
