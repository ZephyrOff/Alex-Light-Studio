/* =========================================================================
 * === alex-scene-studio-panel =============================================
 * Editeur de plan de piece (contour polygonal libre, trace au clic) et
 * positionnement des lumieres a l'interieur. Phase 1 : dessiner/sauvegarder/
 * charger des pieces -- l'algorithme d'harmonie et l'application aux
 * vraies lumieres viendront dans une phase ulterieure. Rien n'est envoye a
 * aucune lumiere depuis cet ecran pour l'instant.
 * ========================================================================= */

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// Point-dans-polygone par comptage d'intersections (ray casting) -- fonctionne
// pour n'importe quel contour simple (convexe ou non, formes en L/T/U
// comprises), teste avec ce cas precis avant integration.
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Conversion HSV -> CSS (hue 0-360, saturation 0-100, brightness HA 0-255)
// pour afficher un apercu visuel fidele des propositions -- la luminosite
// HA (0-255) devient la "valeur" HSV (0-1).
function hsvToCss(hue, saturation, brightness) {
  const h = hue / 360;
  const s = saturation / 100;
  const v = brightness / 255;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  const toHex = (c) => Math.round(c * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Approximation Kelvin -> CSS pour l'apercu des lumieres sans RGB (juste
// Conversion RGB (0-255 chacun) -> {hue, saturation} -- partagee entre le
// picker couleur de l'apercu de scene (via hex) et l'echantillonnage de
// pixels sur une image (getImageData renvoie du RGB brut directement).
function rgbToHueSat(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = max === 0 ? 0 : (d / max) * 100;
  return { hue, saturation };
}

// Conversion inverse de hsvToCss -- necessaire quand l'utilisateur choisit
// une nouvelle couleur via <input type="color"> dans l'apercu de scene
// modifiable ; la luminosite (value) n'est pas extraite ici, elle reste
// geree separement par son propre curseur.
function hexToHueSat(hex) {
  const h = (hex || "#ffffff").replace("#", "");
  return rgbToHueSat(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

// color_temp) -- pas une conversion colorimetrique precise, juste de quoi
// distinguer visuellement chaud/neutre/froid dans l'apercu.
function kelvinToCss(kelvin) {
  if (kelvin <= 3000) return "#ffb46b";
  if (kelvin <= 4500) return "#ffd9a8";
  if (kelvin <= 5500) return "#fff2e0";
  return "#cfe4ff";
}

const CLOSE_THRESHOLD = 15; // unites SVG, distance sous laquelle un clic pres du premier point ferme le contour
const VIEWBOX_W = 800;
const VIEWBOX_H = 500;
// Conversion pixels (plan 2D / stockage points-lumieres-zones-meubles) <->
// metres (vue 3D et calcul d'harmonie, qui a besoin d'une distance reelle
// homogene avec la hauteur des lumieres, deja en metres) -- reglable par
// piece via Room.scale_px_per_m (this._scalePxPerM), cette constante n'est
// que la valeur par defaut. Voir _toMeters/_toPx.
const DEFAULT_PX_PER_METER = 80;
const GRID_SIZE = DEFAULT_PX_PER_METER * 0.25; // grille = 25 cm (accroche du contour, snapToGrid)

// Vendee localement (pas de CDN, coherent avec une integration HACS
// autonome) -- servie par le meme mecanisme de chemin statique que ce
// fichier, voir _async_register_panel cote Python. Chargee paresseusement
// (voir _ensureThreeLoaded), seulement a la premiere ouverture de la vue
// 3D, jamais pour les autres vues (Gradient/Zones/Scenes).
const THREE_VENDOR_URL = "/alex_light_studio_panel/vendor/three.min.js";

// Libere geometrie/materiau de chaque objet d'un groupe Three.js avant de
// le retirer de la scene -- sans ca, reconstruire la vue 3D a chaque
// modification (ajout de lumiere/zone/meuble) fuirait de la memoire GPU.
function disposeThreeGroup(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
}

function snapToGrid(v) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

const MOUNT_TYPE_LABELS = { ceiling: "Plafond", wall: "Mur", desk: "Bureau" };
const ROLE_LABELS = { primary: "Principale", accent: "Accentuation", ambient: "Ambiance" };

// Miroir JS de const.FURNITURE_TYPES (Python) -- catalogue des meubles
// placables dans la vue 3D. Dimensions par defaut en metres, categorie
// utilisee uniquement pour la couleur/le rendu cote client (l'influence
// automatique sur l'harmonie est calculee cote serveur, harmony.
// furniture_to_zone_inputs). "defaultElevation" : hauteur de pose par
// defaut au-dessus du sol -- une TV/un moniteur ne reposent pas au sol.
const FURNITURE_TYPES = {
  sofa: { label: "Canapé", width: 1.8, depth: 0.85, height: 0.8, category: "cozy", color: "#6d4c41", defaultElevation: 0 },
  armchair: { label: "Fauteuil", width: 0.8, depth: 0.8, height: 0.85, category: "cozy", color: "#795548", defaultElevation: 0 },
  bed: { label: "Lit", width: 1.6, depth: 2.0, height: 0.55, category: "cozy", color: "#8d6e63", defaultElevation: 0 },
  tv: { label: "Télévision", width: 1.1, depth: 0.08, height: 0.65, category: "screen", color: "#212121", defaultElevation: 0.5 },
  monitor: { label: "Moniteur PC", width: 0.6, depth: 0.2, height: 0.4, category: "screen", color: "#212121", defaultElevation: 0.75 },
  table: { label: "Table", width: 1.2, depth: 0.8, height: 0.75, category: "neutral", color: "#a1887f", defaultElevation: 0 },
  desk: { label: "Bureau", width: 1.2, depth: 0.6, height: 0.75, category: "neutral", color: "#a1887f", defaultElevation: 0 },
  bookshelf: { label: "Bibliothèque", width: 0.9, depth: 0.3, height: 1.8, category: "neutral", color: "#6d4c41", defaultElevation: 0 },
  plant: { label: "Plante", width: 0.4, depth: 0.4, height: 1.2, category: "neutral", color: "#2e7d32", defaultElevation: 0 },
  other: { label: "Autre", width: 0.6, depth: 0.6, height: 0.8, category: "neutral", color: "#616161", defaultElevation: 0 },
};

// Miroir JS de harmony.derive_role (Python) -- uniquement pour l'apercu
// live dans le formulaire de placement. Le calcul qui compte reellement
// pour la scene reste fait cote serveur, dans compute_scene.
const ROLE_FROM_POSITION_DIRECTION = {
  "ceiling|direct": "primary",
  "ceiling|indirect": "ambient",
  "wall|direct": "accent",
  "wall|indirect": "ambient",
  "desk|direct": "primary",
  "desk|indirect": "ambient",
};
function deriveRole(position, direction) {
  return ROLE_FROM_POSITION_DIRECTION[`${position}|${direction}`] || "primary";
}

// Construit explicitement le payload d'une lumiere avec UNIQUEMENT les
// champs attendus par le schema serveur -- jamais un simple `{ ...l }`, qui
// laisserait passer n'importe quel champ perime (ex. l'ancien "role",
// retire du schema mais encore present dans des pieces enregistrees avant
// cette mise a jour) et ferait echouer la validation cote serveur.
function lightPayload(l) {
  return {
    entity_id: l.entity_id,
    x: l.x,
    y: l.y,
    mount_type: l.mount_type,
    height: l.height != null ? l.height : 2.2,
    direction: l.direction || "direct",
    importance: l.importance != null ? l.importance : 0.7,
    light_type: l.light_type || "color",
    power: l.power != null ? l.power : 1.0,
    // Purement visuel (vue 3D/2D) -- represente un bandeau/ruban LED comme
    // un segment oriente plutot qu'un point, sans effet sur le calcul
    // d'harmonie (harmony.py ignore ces trois champs).
    is_strip: !!l.is_strip,
    length: l.length != null ? l.length : 1.2,
    strip_rotation: l.strip_rotation != null ? l.strip_rotation : 0,
  };
}

function zonePayload(z) {
  return {
    name: z.name,
    x: z.x,
    y: z.y,
    hue: z.hue,
    saturation: z.saturation != null ? z.saturation : 70,
    influence_radius: z.influence_radius != null ? z.influence_radius : 150,
    z: z.z != null ? z.z : 1.2,
  };
}

function furniturePayload(f) {
  return {
    id: f.id,
    furniture_type: f.furniture_type,
    x: f.x,
    y: f.y,
    rotation: f.rotation != null ? f.rotation : 0,
    elevation: f.elevation != null ? f.elevation : 0,
    width: f.width,
    depth: f.depth,
    height: f.height,
    label: f.label || "",
  };
}

// --- Vue Gradient : helpers independants du reste du panel ---------------
function gradientHexToRgbObj(hex) {
  const h = (hex || "#ffffff").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

// Meme logique que l'integration : priorite au champ explicite, puis a
// l'attribut friendly_name de l'entite (HA le copie tel quel depuis la
// decouverte MQTT Z2M, casse d'origine comprise) plutot que le dernier
// segment de l'entity_id, qui est "slugifie" par HA (minuscules) et peut
// donc diverger du vrai nom Z2M des que celui-ci contient de la casse mixte.
function gradientFriendlyNameFor(hass, entityId, explicit) {
  if (explicit) return explicit;
  const st = hass && entityId && hass.states[entityId];
  const attrName = st && st.attributes && st.attributes.friendly_name;
  if (attrName) return attrName;
  return entityId ? entityId.split(".")[1] || "" : "";
}
function gradientDefaultLengthEntity(entityId) {
  const objectId = entityId ? entityId.split(".")[1] : null;
  return objectId ? `number.${objectId}_length` : null;
}

const MOUNT_TYPE_ICONS = { ceiling: "\u2B24", wall: "\u25A0", desk: "\u25B2" }; // cercle / carre / triangle plein, distinction visuelle rapide sans dependre d'icones externes

// Cycle de couleurs pour le petit point "deja utilise par une autre zone"
// dans la grille de segments (vue LightZone) -- purement indicatif, sans
// rapport avec la couleur reelle de la zone (qui vient de son entite light).
const LIGHTZONE_PALETTE = ["#03a9f4", "#f4a935", "#66bb6a", "#ab47bc", "#ef5350", "#26c6da"];

class AlexLightStudioPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._built = false;
    this._rooms = [];
    this._loading = false;
    this._error = null;

    // Vue active du panel -- "room" (editer les pieces) ou "scene" (generer
    // des scenes sur une piece deja configuree).
    this._activeView = "room";

    // Piece en cours d'edition (pas encore forcement sauvegardee).
    this._editingRoomId = null; // null = nouvelle piece
    this._roomName = "";
    this._points = []; // contour, ferme des que _closed = true
    this._closed = false;
    // Vue active du contour : true = trace/edite le contour en 2D (vue de
    // dessus, seule facon precise de tracer/ajuster des murs a la souris) ;
    // false = contour valide, la vue 3D prend le relais pour tout le reste
    // (placement lumieres/zones/meubles) -- jamais les deux affichees en
    // meme temps, voir _renderCanvas.
    this._editingOutline = true;
    this._lights = []; // {entity_id, x, y, mount_type, height, direction, importance, light_type, power, is_strip, length, strip_rotation}
    this._zones = []; // {name, x, y, hue, saturation, influence_radius, z}
    this._furniture = []; // {id, furniture_type, x, y, rotation, elevation, width, depth, height, label}
    this._roomHeight = 2.5; // metres sous plafond, vue 3D
    this._scalePxPerM = DEFAULT_PX_PER_METER; // conversion points/x/y (px) <-> metres, reglable par piece

    // Mode de placement au clic (dans la vue 3D) : "light", "zone" ou "furniture".
    this._placementMode = "light";

    // Selections courantes pour le placement de la prochaine lumiere.
    this._pendingEntity = "";
    this._pendingMountType = "ceiling";
    this._pendingHeight = 2.2; // metres, valeur de depart raisonnable (hauteur sous plafond courante)
    this._pendingDirection = "direct";
    this._pendingLightType = "color"; // "color" | "white" -- choix explicite, plus fiable qu'une detection automatique
    this._pendingImportance = 0.7; // 0-1
    this._pendingPower = 1.0; // puissance/capacite relative -- 1.0 = reference
    // Bandeau LED (ruban) plutot qu'une ampoule ponctuelle -- affecte
    // uniquement la representation visuelle (2D/3D), pas le calcul
    // d'harmonie. Choix EXPLICITE (case a cocher), pas de detection
    // automatique depuis l'entite -- meme raisonnement que light_type.
    this._pendingIsStrip = false;
    this._pendingStripLength = 1.2; // metres
    this._pendingStripRotation = 0; // degres, autour de l'axe vertical

    // Selections courantes pour le placement de la prochaine zone.
    this._pendingZoneName = "";
    this._pendingZoneHue = 30;
    this._pendingZoneSaturation = 70;
    this._pendingZoneRadius = 150;
    this._pendingZoneHeight = 1.2; // metres

    // Selections courantes pour le placement du prochain meuble -- les
    // dimensions se pre-remplissent depuis FURNITURE_TYPES au changement de
    // type (voir #furniture-type-select), modifiables ensuite.
    this._pendingFurnitureType = "sofa";
    this._pendingFurnitureWidth = FURNITURE_TYPES.sofa.width;
    this._pendingFurnitureDepth = FURNITURE_TYPES.sofa.depth;
    this._pendingFurnitureHeight = FURNITURE_TYPES.sofa.height;
    this._pendingFurnitureElevation = FURNITURE_TYPES.sofa.defaultElevation;

    // Glisser-depose : point de mur, lumiere, zone ou meuble en cours de
    // deplacement. { kind: "point"|"light"|"zone"|"furniture", index: N,
    // startX, startY } ou null.
    this._dragging = null;

    // Vue 3D (Three.js, vendee dans panel/vendor/, chargee paresseusement --
    // voir _ensureThreeLoaded). Etat du moteur de rendu, distinct de l'etat
    // de donnees ci-dessus (_lights/_zones/_furniture restent la source de
    // verite ; la scene Three.js n'est qu'une projection reconstruite dessus).
    this._three = null; // { renderer, scene, camera, roomGroup, objectsGroup, raycaster, ... }
    this._threeLoadPromise = null;
    // Murs masques dans la vue 3D (indices d'arete du contour, 0 = entre
    // points[0] et points[1], etc.) -- pur confort d'edition (voir/placer
    // plus facilement a l'interieur), jamais persiste avec la piece ni
    // envoye au serveur. Reinitialise a chaque nouvelle/rechargement de
    // piece et a chaque retour a l'edition du contour (les indices n'ont
    // plus de sens si le nombre de murs change).
    this._hiddenWalls = new Set();

    // Section Scene (phase 2) : parametres de generation + derniere
    // proposition calculee (jamais appliquee tant que l'utilisateur n'a pas
    // clique sur Appliquer).
    this._sceneGenMode = "mood"; // "mood" | "manual" | "image"
    this._sceneMood = "energique";
    this._sceneScheme = "analogous";
    this._sceneManualHue = 200;
    this._sceneManualSat = 60;
    this._sceneManualIntensity = 1.0;
    this._sceneManualContrast = 0.6;
    this._sceneManualWhiteTemp = 2700;
    this._sceneGenerationStyle = "normal"; // "doux" | "normal" | "dynamique" | "explosif" -- independant du mode mood/manuel
    this._liveApply = false; // si coche, la generation applique immediatement aux vraies lumieres

    // Generation depuis une image.
    this._sceneImageDataUrl = null; // pour reafficher apres un re-render de la coquille
    this._sceneImagePoints = []; // [{x, y (fractions 0-1 de l'image), hue, saturation}]
    this._suggestions = null; // liste de {entity_id, hue, saturation, brightness, color_temp_kelvin} ou null
    this._previewMode = false;

    // Vue Gradient (ex-Alex Gradient Studio).
    this._gradientBuilt = false; // coquille construite une seule fois, jamais reconstruite (edition en cours preservee)
    this._gradientStops = ["#ff6b35", "#f7c548", "#ffe066", "#c04cfd", "#5e60ce"];
    this._gradientTestEntity = "";
    this._gradientFriendlyNameOverride = "";
    this._gradientDeviceType = "hue";
    this._gradientLastScenesSig = null;

    // Vue LightZone : zones de segments d'un bandeau, chacune sa propre
    // lumiere virtuelle activable independamment (voir light.py cote
    // integration). Le registre de bandeaux (_lightzoneStrips) est PARTAGE
    // avec la vue Gradient cote stockage (meme websocket get_strips), mais
    // mis en cache localement ici pour l'affichage.
    this._lightzoneBuilt = false;
    this._lightzoneStrips = {}; // {strip_id: {...}}, depuis get_strips
    this._lightzoneZones = {}; // {zone_id: {...}}, depuis get_light_zones
    this._lightzoneSelectedStripId = "";
    this._lightzoneShowNewStripForm = false;
    // Brouillon du formulaire "nouveau bandeau" (avant enregistrement).
    this._lightzoneNewStrip = { entity: "", device_type: "hue", friendly_name: "", segments: 5, length_entity: "", name: "" };
    // Segments actuellement selectionnes pour la PROCHAINE zone a creer
    // (pas encore enregistree) -- se vide apres creation.
    this._lightzoneSelectedSegments = [];
    this._lightzoneNewZoneName = "";
    this._lightzoneLastZonesSig = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built && this.isConnected) {
      this._renderShell();
      this._built = true;
      this._loadRooms();
    }
    if (this._gradientBuilt) {
      this._renderGradientSceneList();
    }
    if (this._lightzoneBuilt) {
      this._renderLightZoneList();
    }
  }

  set panel(panel) {
    this._panelConfig = panel && panel.config;
  }

  connectedCallback() {
    if (this._hass && !this._built) {
      this._renderShell();
      this._built = true;
      this._loadRooms();
    }
  }

  // Libere le contexte WebGL de la vue 3D -- les navigateurs plafonnent le
  // nombre de contextes WebGL simultanes (~16), et HA peut deconnecter/
  // reconnecter ce custom element en changeant de panel plusieurs fois dans
  // la meme session.
  disconnectedCallback() {
    this._threeDisposeScene();
  }

  _threeDisposeScene() {
    if (!this._three) return;
    if (this._three.animationFrame) cancelAnimationFrame(this._three.animationFrame);
    if (this._three.resizeObserver) this._three.resizeObserver.disconnect();
    if (this._three.renderer) this._three.renderer.dispose();
    this._three = null;
  }

  async _loadRooms() {
    this._loading = true;
    this._error = null;
    this._renderRoomList();
    try {
      const result = await this._hass.callWS({ type: "alex_light_studio/get_rooms" });
      this._rooms = (result && result.rooms) || [];
    } catch (err) {
      this._error = (err && err.message) || String(err);
      this._rooms = [];
    }
    this._loading = false;
    this._renderRoomList();
  }

  _resetEditor() {
    this._editingRoomId = null;
    this._roomName = "";
    this._points = [];
    this._closed = false;
    this._editingOutline = true;
    this._lights = [];
    this._zones = [];
    this._furniture = [];
    this._roomHeight = 2.5;
    this._scalePxPerM = DEFAULT_PX_PER_METER;
    this._placementMode = "light";
    this._pendingEntity = "";
    this._pendingMountType = "ceiling";
    this._pendingHeight = 2.2;
    this._pendingDirection = "direct";
    this._pendingLightType = "color";
    this._pendingImportance = 0.7;
    this._pendingPower = 1.0;
    this._pendingIsStrip = false;
    this._pendingStripLength = 1.2;
    this._pendingStripRotation = 0;
    this._pendingZoneName = "";
    this._pendingZoneHue = 30;
    this._pendingZoneSaturation = 70;
    this._pendingZoneRadius = 150;
    this._pendingZoneHeight = 1.2;
    this._pendingFurnitureType = "sofa";
    this._pendingFurnitureWidth = FURNITURE_TYPES.sofa.width;
    this._pendingFurnitureDepth = FURNITURE_TYPES.sofa.depth;
    this._pendingFurnitureHeight = FURNITURE_TYPES.sofa.height;
    this._pendingFurnitureElevation = FURNITURE_TYPES.sofa.defaultElevation;
    this._dragging = null;
    this._suggestions = null;
    this._previewMode = false;
    this._hiddenWalls = new Set();
  }

  _loadRoomIntoEditor(room) {
    this._editingRoomId = room.id;
    this._roomName = room.name;
    this._points = room.points.map((p) => ({ x: p.x, y: p.y }));
    this._closed = this._points.length >= 3;
    // Une piece deja tracee s'ouvre directement en vue 3D -- l'edition du
    // contour est une action explicite (bouton "Modifier le contour").
    this._editingOutline = !this._closed;
    this._hiddenWalls = new Set();
    // height/direction/light_type/importance/power/is_strip/... : repli sur
    // des valeurs par defaut pour les pieces enregistrees avant l'ajout de
    // ces champs.
    this._lights = room.lights.map((l) => ({
      height: 2.2,
      direction: "direct",
      light_type: "color",
      importance: 0.7,
      power: 1.0,
      is_strip: false,
      length: 1.2,
      strip_rotation: 0,
      ...l,
    }));
    this._zones = (room.zones || []).map((z) => ({
      saturation: 70,
      influence_radius: 150,
      z: 1.2,
      ...z,
    }));
    // room.height/scale_px_per_m/furniture : absents sur une piece
    // enregistree avant l'ajout de la vue 3D -- repli sur les defauts.
    this._furniture = (room.furniture || []).map((f) => ({ rotation: 0, elevation: 0, label: "", ...f }));
    this._roomHeight = room.height != null ? room.height : 2.5;
    this._scalePxPerM = room.scale_px_per_m != null ? room.scale_px_per_m : DEFAULT_PX_PER_METER;
    // Une proposition generee pour une AUTRE piece n'a plus de sens ici.
    this._suggestions = null;
    this._previewMode = false;
    this._syncEditorInputs();
    this._renderCanvas();
    this._renderLightsList();
    this._renderZonesList();
    this._renderFurnitureList();
    this._renderScenePreviewList();
    this._renderRoomList();
    this._rebuildThreeRoom();
  }

  _syncEditorInputs() {
    const nameInput = this.shadowRoot.querySelector("#room-name");
    if (nameInput) nameInput.value = this._roomName;
    const heightInput = this.shadowRoot.querySelector("#room-height-input");
    if (heightInput) heightInput.value = this._roomHeight;
    const scaleInput = this.shadowRoot.querySelector("#room-scale-input");
    if (scaleInput) scaleInput.value = this._scalePxPerM;
  }

  // -----------------------------------------------------------------------
  // Coquille statique
  // -----------------------------------------------------------------------
  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block; height: 100%; overflow: hidden;
          background: var(--primary-background-color, #111);
          color: var(--primary-text-color, #fff);
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
          box-sizing: border-box;
        }
        * { box-sizing: border-box; }
        .header {
          display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 24px;
          background: var(--app-header-background-color, var(--primary-color, #03a9f4));
        }
        .header button.menu-btn {
          display: none; width: 40px; height: 40px; border-radius: 8px; border: none;
          background: transparent; color: white; cursor: pointer;
          align-items: center; justify-content: center; flex-shrink: 0;
        }
        .header button.menu-btn svg { width: 24px; height: 24px; fill: currentColor; }
        @media (max-width: 870px) { .header button.menu-btn { display: flex; } }
        .header h1 { margin: 0; font-size: 20px; font-weight: 500; color: white; flex: 1; }
        .layout { display: flex; height: calc(100% - 64px); }
        .sidebar {
          width: 300px; flex: 0 0 300px; overflow-y: auto;
          border-right: 1px solid var(--divider-color, #333); padding: 12px;
        }
        .content { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }
        .card {
          background: var(--card-background-color, #1e1e1e); border-radius: 16px; padding: 16px;
        }
        .card h2 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
        .room-row {
          display: flex; align-items: center; gap: 8px; padding: 8px 10px;
          border-radius: 8px; cursor: pointer; margin-bottom: 4px; font-size: 13px;
        }
        .room-row:hover { background: rgba(255,255,255,.06); }
        .room-row.selected { background: rgba(var(--rgb-primary-color,3,169,244),.18); }
        .room-row .del-btn { margin-left: auto; opacity: .6; cursor: pointer; }
        .room-row .del-btn:hover { opacity: 1; }
        .btn {
          padding: 9px 16px; border-radius: 10px; border: none; cursor: pointer;
          font-size: 13px; font-weight: 600;
        }
        .btn-primary { background: var(--primary-color, #03a9f4); color: white; }
        .btn-outline { background: transparent; color: var(--secondary-text-color); border: 1px solid var(--divider-color, #444); }
        .btn:disabled { opacity: .4; cursor: not-allowed; }
        input[type="text"], select {
          padding: 8px 10px; border-radius: 8px; border: 1px solid var(--divider-color, #444);
          background: var(--card-background-color, #1e1e1e); color: var(--primary-text-color, #fff);
          font-size: 13px; width: 100%;
        }
        .row { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
        .row label { flex: 0 0 100px; font-size: 12px; color: var(--secondary-text-color); }
        .row > *:not(label) { flex: 1; min-width: 120px; }
        #canvas-wrap {
          background: var(--card-background-color, #1e1e1e); border-radius: 16px; padding: 10px;
          border: 1px dashed var(--divider-color, #444);
        }
        svg#plan { width: 100%; height: auto; display: block; cursor: crosshair; touch-action: none; }
        .hint { font-size: 12px; color: var(--secondary-text-color); margin-top: 8px; line-height: 1.4; }
        .empty { font-size: 13px; color: var(--secondary-text-color); padding: 8px 0; }
        .error { color: var(--error-color, #db4437); font-size: 13px; }
        .light-item {
          display: flex; align-items: center; gap: 8px; padding: 6px 8px;
          border: 1px solid var(--divider-color, #333); border-radius: 8px; margin-bottom: 6px; font-size: 12px;
        }
        .light-item .del-btn { margin-left: auto; cursor: pointer; opacity: .6; }
        .light-item .del-btn:hover { opacity: 1; }
        .actions { display: flex; gap: 8px; flex-wrap: wrap; }

        /* --- Onglets de placement (Lumière/Zone/Meuble) -- un seul bloc
         * visuel (selecteur + contenu) plutot que plusieurs cartes
         * separees, pour eviter l'impression d'options eparpillees. */
        .seg-tabs { display: flex; gap: 6px; margin-bottom: 16px; }
        .seg-tab {
          flex: 1; padding: 9px 8px; border-radius: 8px; text-align: center;
          font-size: 13px; font-weight: 600; cursor: pointer;
          background: transparent; color: var(--secondary-text-color);
          border: 1px solid var(--divider-color, #444);
        }
        .seg-tab.active { background: var(--primary-color, #03a9f4); color: white; border-color: transparent; }

        /* --- Boutons "mur visible" (vue 3D) -- multi-selection (pas
         * exclusifs comme les onglets de placement), un par mur du contour. */
        .wall-toggle {
          padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;
          background: rgba(var(--rgb-primary-color,3,169,244),.18); color: var(--primary-text-color, #fff);
          border: 1px solid var(--primary-color, #03a9f4);
        }
        .wall-toggle.hidden-wall { background: transparent; color: var(--secondary-text-color); border-color: var(--divider-color, #444); text-decoration: line-through; }

        /* --- Vue Gradient (ex-Alex Gradient Studio) -------------------- */
        .stops-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
        .stop-cell { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .stop-cell input[type="color"] {
          width: 48px; height: 48px; border: none; border-radius: 10px;
          padding: 0; cursor: pointer; -webkit-appearance: none; appearance: none;
        }
        .stops-controls { display: flex; gap: 8px; margin-bottom: 16px; }
        .btn-accent { background: #f4a935; color: #000; }
        .scene-list { display: flex; flex-direction: column; gap: 10px; }
        .scene-row {
          display: flex; align-items: center; gap: 12px;
          border: 1px solid var(--divider-color, #444); border-radius: 12px; padding: 10px 12px;
        }
        .scene-preview { width: 64px; height: 28px; border-radius: 8px; flex: 0 0 auto; }
        .scene-name {
          flex: 1; min-width: 0; font-size: 14px; font-weight: 600;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .scene-row .btn { padding: 6px 10px; font-size: 12px; }

        /* --- Vue LightZone ---------------------------------------------- */
        .segment-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
        .segment-cell {
          width: 42px; height: 42px; border-radius: 8px; border: 1px solid var(--divider-color, #444);
          background: var(--card-background-color, #1e1e1e); color: var(--primary-text-color, #fff);
          display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600;
          cursor: pointer; position: relative; user-select: none;
        }
        .segment-cell.selected { border-color: var(--primary-color, #03a9f4); background: rgba(var(--rgb-primary-color,3,169,244),.25); }
        .segment-cell .used-dot {
          position: absolute; top: 3px; right: 3px; width: 8px; height: 8px; border-radius: 50%;
        }
        .zone-list { display: flex; flex-direction: column; gap: 10px; }
        .zone-row {
          display: flex; align-items: center; gap: 12px;
          border: 1px solid var(--divider-color, #444); border-radius: 12px; padding: 10px 12px;
        }
        .zone-swatch { width: 28px; height: 28px; border-radius: 50%; flex: 0 0 auto; border: 2px solid var(--divider-color, #444); }
        .zone-info { flex: 1; min-width: 0; }
        .zone-name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .zone-segments { font-size: 11px; color: var(--secondary-text-color); }
        .zone-row .btn { padding: 6px 10px; font-size: 12px; }
        .strip-picker-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
        .strip-picker-row select { flex: 1; min-width: 160px; }

        /* --- Mobile (telephone) -------------------------------------------
         * La barre laterale a largeur fixe et les lignes de formulaire
         * cote-a-cote fonctionnent en desktop mais rendent le panel
         * inutilisable sur un ecran etroit : la barre laterale a elle seule
         * peut occuper la quasi-totalite de la largeur disponible. Sous ce
         * seuil, on empile plutot que d'aligner cote a cote. */
        @media (max-width: 780px) {
          :host { overflow-y: auto; }
          .header { padding: 12px 16px; }
          .header h1 { font-size: 16px; }
          .layout { flex-direction: column; height: auto; min-height: calc(100% - 64px); }
          .sidebar {
            width: 100%; flex: none; max-height: 200px;
            border-right: none; border-bottom: 1px solid var(--divider-color, #333);
          }
          .content { padding: 12px; }
          .row { flex-direction: column; align-items: stretch; }
          .row label { flex: none; margin-bottom: 4px; }
          .row > *:not(label) { min-width: 0; }
          .btn, input[type="text"], input[type="number"], select {
            padding: 11px 14px; /* cibles tactiles plus confortables (~44px de haut avec le texte) */
          }
          .scene-row { flex-wrap: wrap; }
          .scene-name { flex: 1 1 100%; order: -1; margin-bottom: 2px; }
          .light-item { flex-wrap: wrap; }
          .stop-cell input[type="color"] { width: 40px; height: 40px; }
          .segment-cell { width: 36px; height: 36px; }
          .zone-row { flex-wrap: wrap; }
          .zone-info { flex: 1 1 100%; order: -1; margin-bottom: 2px; }
        }

        /* --- Generation de scene depuis une image ---------------------- */
        .image-dropzone {
          border: 2px dashed var(--divider-color, #444); border-radius: 12px;
          padding: 32px 16px; text-align: center; cursor: pointer;
          color: var(--secondary-text-color); font-size: 13px;
        }
        .image-dropzone.dragover { border-color: var(--primary-color, #03a9f4); background: rgba(3,169,244,.08); }
        .scene-image-canvas-wrap { position: relative; border-radius: 10px; overflow: hidden; }
        #scene-image-canvas { width: 100%; display: block; cursor: crosshair; }
        .scene-image-point-marker {
          position: absolute; width: 24px; height: 24px; margin-left: -12px; margin-top: -12px;
          border-radius: 50%; border: 2px solid white; cursor: pointer;
          box-shadow: 0 1px 4px rgba(0,0,0,.6);
          display: flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 700; color: white; text-shadow: 0 1px 2px rgba(0,0,0,.9);
        }
        .scene-image-palette-row {
          display: flex; align-items: center; gap: 10px; padding: 6px 8px;
          border: 1px solid var(--divider-color, #333); border-radius: 8px; margin-bottom: 6px; font-size: 12px;
        }
      </style>

      <div class="header">
        <button class="menu-btn" id="menu-btn" title="Menu">
          <svg viewBox="0 0 24 24"><path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z"/></svg>
        </button>
        <h1>Alex Light Studio</h1>
        <div class="actions" style="margin:0 12px;">
          <button class="btn btn-outline" id="nav-gradient-btn">Gradient</button>
          <button class="btn btn-outline" id="nav-lightzone-btn">Zones</button>
          <button class="btn btn-outline" id="nav-room-btn">Pièces</button>
          <button class="btn btn-outline" id="nav-scene-btn">Scènes</button>
        </div>
        <button class="btn btn-outline" id="new-room-btn">+ Nouvelle pièce</button>
      </div>

      <div class="layout">
        <div class="sidebar">
          <h2 style="font-size:13px;margin:4px 0 10px;color:var(--secondary-text-color);">Pièces enregistrées</h2>
          <div class="hint" id="sidebar-hint" style="margin-bottom:10px;"></div>
          <div id="room-list"></div>
        </div>

        <div class="content" id="room-scene-content">
          <div class="card" id="outline-card">
            <h2>Plan de la pièce</h2>
            <div class="row" id="room-name-row">
              <label>Nom</label>
              <input type="text" id="room-name" placeholder="ex. Bureau" />
            </div>
            <div id="canvas-wrap">
              <svg id="plan" viewBox="0 0 ${VIEWBOX_W} ${VIEWBOX_H}" xmlns="http://www.w3.org/2000/svg"></svg>
            </div>
            <div class="hint" id="draw-hint">
              Clique dans le plan pour placer les coins du contour. Clique près du premier point pour refermer.
            </div>
            <div class="actions" style="margin-top:10px;" id="outline-actions">
              <button class="btn btn-outline" id="undo-point-btn">Annuler le dernier point</button>
              <button class="btn btn-outline" id="reset-outline-btn">Recommencer le contour</button>
              <button class="btn btn-primary" id="validate-outline-btn" style="display:none;">Passer à la vue 3D</button>
            </div>
            <div id="rect-generator" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--divider-color,#333);">
              <div class="hint" style="margin:0 0 8px;">Ou indique directement les dimensions d'une pièce carrée/rectangulaire :</div>
              <div class="row">
                <label>Dimensions (m)</label>
                <input type="number" id="rect-width-input" min="0.3" max="30" step="0.05" placeholder="Largeur, ex. 3.15" />
                <input type="number" id="rect-depth-input" min="0.3" max="30" step="0.05" placeholder="Profondeur, ex. 4.0" />
              </div>
              <div class="actions">
                <button class="btn btn-outline" id="generate-rect-btn">Générer le rectangle</button>
              </div>
            </div>
          </div>

          <div class="card" id="view3d-card" style="display:none;margin-top:20px;">
            <h2>Vue 3D</h2>
            <div class="row" id="room-height-row">
              <label>Hauteur plafond (m)</label>
              <input type="number" id="room-height-input" min="1.8" max="6" step="0.05" value="2.5" />
            </div>
            <details id="room-scale-details">
              <summary style="cursor:pointer;font-size:12px;color:var(--secondary-text-color);">Échelle avancée</summary>
              <div class="row" style="margin-top:8px;">
                <label>Pixels / mètre</label>
                <input type="number" id="room-scale-input" min="20" max="400" step="1" value="80" />
              </div>
              <div class="hint">
                À ajuster seulement si la vue 3D paraît disproportionnée pour une pièce créée avant
                l'ajout de la vue 3D (son contour n'avait pas d'échelle réelle) — inutile d'y toucher
                pour une nouvelle pièce.
              </div>
            </details>
            <div class="row" id="wall-toggles-row" style="align-items:flex-start;">
              <label style="margin-top:9px;">Murs visibles</label>
              <div id="wall-toggles" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
            </div>
            <div id="threed-wrap" style="position:relative;border-radius:10px;overflow:hidden;background:#0b0b0f;border:1px solid var(--divider-color,#444);margin-top:10px;">
              <canvas id="threed-canvas" style="display:block;width:100%;height:440px;touch-action:none;"></canvas>
              <div id="threed-loading" class="hint" style="position:absolute;top:8px;left:8px;margin:0;">Chargement…</div>
              <div id="threed-height-readout" style="display:none;position:absolute;top:8px;right:8px;margin:0;padding:4px 10px;border-radius:6px;background:rgba(0,0,0,.7);color:white;font-size:12px;font-weight:600;"></div>
            </div>
            <div class="actions" style="margin-top:10px;">
              <button class="btn btn-outline" id="threed-topview-btn">Vue de dessus</button>
              <button class="btn btn-outline" id="edit-outline-btn">Modifier le contour</button>
            </div>
            <div class="hint" id="threed-hint">
              Glisser : orbiter. Molette : zoom. Glisser avec Maj (Shift) sur du vide : déplacer la vue.
              Clique au sol pour placer l'élément choisi ci-dessous (lumière/zone/meuble) ; glisse un objet
              déjà placé pour le repositionner, ou Maj + glisse-le pour ajuster sa hauteur. Décoche un mur
              ci-dessus pour le masquer et voir/placer plus facilement à l'intérieur.
            </div>
          </div>

          <div id="view-room">

          <div class="card" id="placement-card" style="display:none;margin-top:20px;">
            <h2>Ajouter à la pièce</h2>
            <div class="seg-tabs" id="placement-mode-tabs">
              <button type="button" class="seg-tab" data-mode="light">Lumière</button>
              <button type="button" class="seg-tab" data-mode="zone">Zone</button>
              <button type="button" class="seg-tab" data-mode="furniture">Meuble</button>
            </div>

            <div class="placement-fields" id="fields-light">
              <div class="row">
                <label>Lumière</label>
                <select id="entity-select"></select>
              </div>
              <div class="row">
                <label>Couleur/Blanc</label>
                <select id="light-type-select">
                  <option value="color">Couleur (RGB)</option>
                  <option value="white">Blanc uniquement</option>
                </select>
              </div>
              <div class="row">
                <label>Forme</label>
                <select id="light-shape-select">
                  <option value="bulb">Ampoule</option>
                  <option value="strip">Bandeau LED</option>
                </select>
              </div>
              <div id="strip-fields" style="display:none;">
                <div class="row">
                  <label>Longueur (m)</label>
                  <input type="number" id="strip-length-input" min="0.1" max="10" step="0.1" value="1.2" />
                </div>
                <div class="row">
                  <label>Orientation</label>
                  <input type="range" id="strip-rotation-input" min="0" max="359" step="5" value="0" />
                </div>
              </div>
              <div class="row">
                <label>Type</label>
                <select id="mount-select">
                  <option value="ceiling">Plafond</option>
                  <option value="wall">Mur</option>
                  <option value="desk">Bureau</option>
                </select>
              </div>
              <div class="row">
                <label>Importance</label>
                <input type="range" id="importance-input" min="0" max="1" step="0.1" value="0.7" />
              </div>
              <div class="row">
                <label>Puissance</label>
                <input type="range" id="power-input" min="0.1" max="3" step="0.1" value="1.0" />
              </div>
              <div class="row">
                <label>Hauteur (m)</label>
                <input type="number" id="height-input" min="0" max="10" step="0.1" value="2.2" />
              </div>
              <div class="row">
                <label>Direction</label>
                <select id="direction-select">
                  <option value="direct">Direct</option>
                  <option value="indirect">Indirect</option>
                </select>
              </div>
              <div class="row">
                <label>Rôle calculé</label>
                <span id="derived-role-preview" style="font-weight:600;"></span>
              </div>
              <div class="hint">
                Le <strong>rôle</strong> (principale/accentuation/ambiance) se déduit automatiquement du type
                de montage et de la direction — pas besoin de le choisir toi-même. La <strong>puissance</strong>
                (1.0 = référence) réduit automatiquement la consigne d'une lumière plus capable qu'une autre,
                pour un rendu équivalent. Choisis <strong>Bandeau LED</strong> comme forme pour un ruban/bandeau
                (affiché comme un segment orienté, pas un simple point) plutôt qu'une ampoule. Choisis tes
                réglages ci-dessus, puis clique au sol dans la vue 3D pour placer la lumière ; glisse-la
                ensuite pour la repositionner (Maj + glisser pour ajuster sa hauteur directement dans la
                vue 3D).
              </div>
              <div id="lights-list" style="margin-top:12px;"></div>
            </div>

            <div class="placement-fields" id="fields-zone" style="display:none;">
              <div class="row">
                <label>Nom</label>
                <input type="text" id="zone-name" placeholder="ex. Mur TV, Coin lecture" />
              </div>
              <div class="row">
                <label>Teinte</label>
                <input type="range" id="zone-hue-input" min="0" max="360" value="30" />
              </div>
              <div class="row">
                <label>Saturation</label>
                <input type="range" id="zone-sat-input" min="0" max="100" value="70" />
              </div>
              <div class="row">
                <label>Portée</label>
                <input type="range" id="zone-radius-input" min="20" max="400" value="150" />
              </div>
              <div class="row">
                <label>Hauteur (m)</label>
                <input type="number" id="zone-height-input" min="0" max="6" step="0.1" value="1.2" />
              </div>
              <div class="hint">
                Une zone influence les lumières proches vers sa teinte — l'influence décroît avec la distance
                <strong>3D réelle</strong> (position ET hauteur) et s'annule à la portée choisie. Donne un nom
                à la zone ci-dessus, choisis sa hauteur (ex. hauteur d'écran pour un mur TV), puis clique au
                sol dans la vue 3D pour la placer. Une fois placée, glisse-la pour la repositionner.
              </div>
              <div id="zones-list" style="margin-top:12px;"></div>
            </div>

            <div class="placement-fields" id="fields-furniture" style="display:none;">
              <div class="row">
                <label>Type</label>
                <select id="furniture-type-select"></select>
              </div>
              <div class="row">
                <label>Largeur (m)</label>
                <input type="number" id="furniture-width-input" min="0.1" max="4" step="0.05" />
              </div>
              <div class="row">
                <label>Profondeur (m)</label>
                <input type="number" id="furniture-depth-input" min="0.1" max="4" step="0.05" />
              </div>
              <div class="row">
                <label>Hauteur (m)</label>
                <input type="number" id="furniture-height-input" min="0.1" max="3" step="0.05" />
              </div>
              <div class="row">
                <label>Élévation (m)</label>
                <input type="number" id="furniture-elevation-input" min="0" max="3" step="0.05" />
              </div>
              <div class="hint">
                Choisis un type ci-dessus (les dimensions se pré-remplissent, modifiables), puis clique au sol
                dans la vue 3D pour le placer. Glisse-le pour le repositionner ; rotation et suppression se
                font dans la liste ci-dessous. Un canapé/fauteuil/lit crée automatiquement une ambiance chaude
                à proximité, une TV/un moniteur une lumière tamisée et plus froide (anti-éblouissement) — en
                plus des zones manuelles, jamais à leur place.
              </div>
              <div id="furniture-list" style="margin-top:12px;"></div>
            </div>
          </div>

          <div class="actions" id="save-room-actions">
            <button class="btn btn-primary" id="save-room-btn">Enregistrer la pièce</button>
          </div>

          </div>

          <div id="view-scene">

          <div class="card" id="scene-card" style="display:none;">
            <h2>Scène harmonieuse</h2>
            <div class="row">
              <label>Mode</label>
              <select id="scene-mode-select">
                <option value="mood">Ambiance prédéfinie</option>
                <option value="manual">Teinte libre</option>
                <option value="image">Depuis une image</option>
              </select>
            </div>
            <div class="row">
              <label>Style</label>
              <select id="scene-style-select">
                <option value="doux">Doux</option>
                <option value="normal" selected>Normal</option>
                <option value="dynamique">Dynamique</option>
                <option value="explosif">Explosif</option>
              </select>
            </div>
            <div id="scene-mood-fields">
              <div class="row">
                <label>Ambiance</label>
                <select id="scene-mood-select">
                  <option value="energique">Énergique</option>
                  <option value="detente">Détente</option>
                  <option value="concentration">Concentration</option>
                  <option value="lecture">Lecture</option>
                  <option value="quotidien">Quotidien</option>
                  <option value="cinema">Cinéma</option>
                  <option value="soiree">Soirée</option>
                  <option value="nuit">Nuit</option>
                </select>
              </div>
            </div>
            <div id="scene-manual-fields" style="display:none;">
              <div class="row">
                <label>Teinte de base</label>
                <input type="range" id="scene-hue-input" min="0" max="360" value="200" />
              </div>
              <div class="row">
                <label>Saturation</label>
                <input type="range" id="scene-sat-input" min="0" max="100" value="60" />
              </div>
              <div class="row">
                <label>Intensité globale</label>
                <input type="range" id="scene-intensity-input" min="0.4" max="1.3" step="0.05" value="1.0" />
              </div>
              <div class="row">
                <label>Contraste</label>
                <input type="range" id="scene-contrast-input" min="0" max="1" step="0.05" value="0.6" />
              </div>
              <div class="row">
                <label>Temp. de blanc (K)</label>
                <input type="range" id="scene-white-temp-input" min="2000" max="6500" step="50" value="2700" />
              </div>
              <div class="row">
                <label>Schéma</label>
                <select id="scene-scheme-select">
                  <option value="analogous">Analogue</option>
                  <option value="complementary">Complémentaire</option>
                  <option value="triadic">Triadique</option>
                </select>
              </div>
              <div class="hint">
                Le contraste contrôle l'amplitude de la hiérarchie entre principale/accentuation/ambiance
                (faible = rendu uniforme façon quotidien, élevé = rendu marqué façon soirée). La température
                de blanc sert de base commune pour toutes les lumières sans RGB — chacune s'en écarte
                légèrement selon son rôle, pour rester une famille cohérente plutôt que des écarts abrupts.
              </div>
            </div>
            <div id="scene-image-fields" style="display:none;">
              <div id="scene-image-dropzone" class="image-dropzone">
                <span id="scene-image-dropzone-text">Glisse une image ici, ou clique pour en choisir une</span>
                <input type="file" id="scene-image-file-input" accept="image/*" style="display:none;" />
              </div>
              <div id="scene-image-preview-wrap" style="display:none;margin-top:10px;">
                <div class="scene-image-canvas-wrap" id="scene-image-canvas-wrap">
                  <canvas id="scene-image-canvas"></canvas>
                </div>
                <div class="actions" style="margin-top:8px;">
                  <button class="btn btn-outline" id="scene-image-clear-points-btn">Vider les points</button>
                  <button class="btn btn-outline" id="scene-image-change-btn">Changer d'image</button>
                </div>
                <div class="hint">
                  Clique sur l'image pour placer un point de couleur (2 à 8) — la teinte est échantillonnée
                  directement au pixel cliqué. Clique sur un repère déjà placé pour le retirer.
                </div>
                <div id="scene-image-palette-list" style="margin-top:8px;"></div>
              </div>
            </div>
            <div class="row" style="align-items:center;">
              <label style="flex:0 0 auto;">Rendu en direct</label>
              <input type="checkbox" id="live-apply-checkbox" style="width:auto;flex:0 0 auto;" />
              <span class="hint" style="margin:0;flex:1;">applique immédiatement à la génération, sans passer par « Appliquer »</span>
            </div>
            <div class="actions" style="margin-top:6px;">
              <button class="btn btn-outline" id="generate-scene-btn">Générer une proposition</button>
            </div>
            <div id="scene-preview-list" style="margin-top:12px;"></div>
            <div class="actions" id="scene-apply-actions" style="display:none;margin-top:10px;">
              <button class="btn btn-primary" id="apply-scene-btn">Appliquer aux lumières</button>
              <input type="text" id="ha-scene-name" placeholder="Nom de la scène HA (optionnel)" style="flex:1;min-width:160px;" />
              <button class="btn btn-outline" id="save-ha-scene-btn">Enregistrer comme scène HA</button>
            </div>
            <div class="hint">
              L'aperçu colore les lumières directement dans le plan ci-dessus, sans rien envoyer à aucun appareil.
              Rien n'est allumé/modifié avant que tu cliques sur « Appliquer ».
            </div>
          </div>

          </div>
        </div>

        <div class="content" id="gradient-content" style="display:none;"></div>
        <div class="content" id="lightzone-content" style="display:none;"></div>
      </div>
    `;

    this.shadowRoot.querySelector("#menu-btn").addEventListener("click", () => {
      this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
    });
    this.shadowRoot.querySelector("#nav-gradient-btn").addEventListener("click", () => this._setActiveView("gradient"));
    this.shadowRoot.querySelector("#nav-lightzone-btn").addEventListener("click", () => this._setActiveView("lightzone"));
    this.shadowRoot.querySelector("#nav-room-btn").addEventListener("click", () => this._setActiveView("room"));
    this.shadowRoot.querySelector("#nav-scene-btn").addEventListener("click", () => this._setActiveView("scene"));
    this._setActiveView(this._activeView);
    this.shadowRoot.querySelector("#new-room-btn").addEventListener("click", () => {
      this._resetEditor();
      this._syncEditorInputs();
      this._renderCanvas();
      this._renderLightsList();
      this._renderRoomList();
    });
    this.shadowRoot.querySelector("#room-name").addEventListener("input", (ev) => {
      this._roomName = ev.target.value;
    });
    this.shadowRoot.querySelector("#undo-point-btn").addEventListener("click", () => {
      if (this._closed || this._points.length === 0) return;
      this._points.pop();
      this._renderCanvas();
    });
    this.shadowRoot.querySelector("#reset-outline-btn").addEventListener("click", () => {
      this._points = [];
      this._closed = false;
      this._editingOutline = true;
      this._lights = [];
      this._zones = [];
      this._furniture = [];
      this._hiddenWalls = new Set();
      this._suggestions = null;
      this._previewMode = false;
      this._renderCanvas();
      this._renderLightsList();
      this._renderZonesList();
      this._renderFurnitureList();
      this._renderScenePreviewList();
    });
    this.shadowRoot.querySelector("#generate-rect-btn").addEventListener("click", () => this._generateRectangleOutline());
    this.shadowRoot.querySelector("#entity-select").addEventListener("change", (ev) => {
      this._pendingEntity = ev.target.value;
      // Pre-remplissage indicatif a partir des capacites live de
      // l'entite -- confort, pas une source de verite : le champ reste
      // visible et modifiable juste apres, vu que cette detection s'est
      // averee peu fiable pour decider seule.
      const st = this._hass.states[this._pendingEntity];
      const modes = (st && st.attributes && st.attributes.supported_color_modes) || [];
      const looksColorCapable = modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m));
      this._pendingLightType = looksColorCapable ? "color" : "white";
      const typeSelect = this.shadowRoot.querySelector("#light-type-select");
      if (typeSelect) typeSelect.value = this._pendingLightType;
    });
    this.shadowRoot.querySelector("#light-type-select").addEventListener("change", (ev) => {
      this._pendingLightType = ev.target.value;
    });
    this.shadowRoot.querySelector("#mount-select").addEventListener("change", (ev) => {
      this._pendingMountType = ev.target.value;
      this._updateDerivedRolePreview();
    });
    this.shadowRoot.querySelector("#importance-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingImportance = Number.isFinite(v) ? v : 0.7;
    });
    this.shadowRoot.querySelector("#power-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingPower = Number.isFinite(v) ? v : 1.0;
    });
    this.shadowRoot.querySelector("#height-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingHeight = Number.isFinite(v) ? v : 2.2;
    });
    this.shadowRoot.querySelector("#direction-select").addEventListener("change", (ev) => {
      this._pendingDirection = ev.target.value;
      this._updateDerivedRolePreview();
    });
    this.shadowRoot.querySelectorAll("#placement-mode-tabs .seg-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._placementMode = btn.getAttribute("data-mode");
        this._updatePlacementTabsUI();
      });
    });
    this.shadowRoot.querySelector("#light-shape-select").addEventListener("change", (ev) => {
      this._pendingIsStrip = ev.target.value === "strip";
      this.shadowRoot.querySelector("#strip-fields").style.display = this._pendingIsStrip ? "block" : "none";
    });
    this.shadowRoot.querySelector("#strip-length-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingStripLength = Number.isFinite(v) && v > 0 ? v : 1.2;
    });
    this.shadowRoot.querySelector("#strip-rotation-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingStripRotation = Number.isFinite(v) ? v : 0;
    });
    this.shadowRoot.querySelector("#validate-outline-btn").addEventListener("click", () => {
      this._editingOutline = false;
      this._renderCanvas();
    });
    this.shadowRoot.querySelector("#edit-outline-btn").addEventListener("click", () => {
      this._editingOutline = true;
      // Le nombre/ordre des murs peut changer en reeditant le contour --
      // les indices masques precedemment n'auraient plus de sens garantis.
      this._hiddenWalls = new Set();
      this._renderCanvas();
    });
    this.shadowRoot.querySelector("#zone-name").addEventListener("input", (ev) => {
      this._pendingZoneName = ev.target.value;
    });
    this.shadowRoot.querySelector("#zone-hue-input").addEventListener("input", (ev) => {
      this._pendingZoneHue = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#zone-sat-input").addEventListener("input", (ev) => {
      this._pendingZoneSaturation = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#zone-radius-input").addEventListener("input", (ev) => {
      this._pendingZoneRadius = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#zone-height-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingZoneHeight = Number.isFinite(v) ? v : 1.2;
    });
    this.shadowRoot.querySelector("#room-height-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._roomHeight = Number.isFinite(v) && v > 0 ? v : 2.5;
      this._rebuildThreeRoom();
    });
    this.shadowRoot.querySelector("#room-scale-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._scalePxPerM = Number.isFinite(v) && v > 0 ? v : DEFAULT_PX_PER_METER;
      this._rebuildThreeRoom();
      this._rebuildThreeObjects();
    });
    this._populateFurnitureTypeSelect();
    this.shadowRoot.querySelector("#furniture-type-select").addEventListener("change", (ev) => {
      this._pendingFurnitureType = ev.target.value;
      const catalog = FURNITURE_TYPES[this._pendingFurnitureType] || FURNITURE_TYPES.other;
      this._pendingFurnitureWidth = catalog.width;
      this._pendingFurnitureDepth = catalog.depth;
      this._pendingFurnitureHeight = catalog.height;
      this._pendingFurnitureElevation = catalog.defaultElevation;
      this._syncFurnitureFormInputs();
    });
    this.shadowRoot.querySelector("#furniture-width-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingFurnitureWidth = Number.isFinite(v) && v > 0 ? v : this._pendingFurnitureWidth;
    });
    this.shadowRoot.querySelector("#furniture-depth-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingFurnitureDepth = Number.isFinite(v) && v > 0 ? v : this._pendingFurnitureDepth;
    });
    this.shadowRoot.querySelector("#furniture-height-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingFurnitureHeight = Number.isFinite(v) && v > 0 ? v : this._pendingFurnitureHeight;
    });
    this.shadowRoot.querySelector("#furniture-elevation-input").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      this._pendingFurnitureElevation = Number.isFinite(v) && v >= 0 ? v : 0;
    });
    this.shadowRoot.querySelector("#threed-topview-btn").addEventListener("click", () => this._threeResetCameraTopView());
    this._syncFurnitureFormInputs();
    this._updatePlacementTabsUI();
    this.shadowRoot.querySelector("#save-room-btn").addEventListener("click", () => this._saveRoom());
    this._updateDerivedRolePreview();

    this.shadowRoot.querySelector("#scene-mode-select").addEventListener("change", (ev) => {
      this._sceneGenMode = ev.target.value;
      this.shadowRoot.querySelector("#scene-mood-fields").style.display = this._sceneGenMode === "mood" ? "block" : "none";
      this.shadowRoot.querySelector("#scene-manual-fields").style.display = this._sceneGenMode === "manual" ? "block" : "none";
      this.shadowRoot.querySelector("#scene-image-fields").style.display = this._sceneGenMode === "image" ? "block" : "none";
    });
    this.shadowRoot.querySelector("#scene-mood-select").addEventListener("change", (ev) => {
      this._sceneMood = ev.target.value;
    });
    this.shadowRoot.querySelector("#scene-hue-input").addEventListener("input", (ev) => {
      this._sceneManualHue = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#scene-sat-input").addEventListener("input", (ev) => {
      this._sceneManualSat = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#scene-intensity-input").addEventListener("input", (ev) => {
      this._sceneManualIntensity = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#scene-contrast-input").addEventListener("input", (ev) => {
      this._sceneManualContrast = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#scene-white-temp-input").addEventListener("input", (ev) => {
      this._sceneManualWhiteTemp = parseFloat(ev.target.value);
    });
    this.shadowRoot.querySelector("#scene-scheme-select").addEventListener("change", (ev) => {
      this._sceneScheme = ev.target.value;
    });
    this.shadowRoot.querySelector("#scene-style-select").addEventListener("change", (ev) => {
      this._sceneGenerationStyle = ev.target.value;
    });
    this.shadowRoot.querySelector("#live-apply-checkbox").addEventListener("change", (ev) => {
      this._liveApply = ev.target.checked;
    });
    this.shadowRoot.querySelector("#generate-scene-btn").addEventListener("click", () => this._generateScene());
    this.shadowRoot.querySelector("#apply-scene-btn").addEventListener("click", () => this._applyScene());
    this.shadowRoot.querySelector("#save-ha-scene-btn").addEventListener("click", () => this._saveAsHaScene());
    this._wireSceneImageInputs();

    const svg = this.shadowRoot.querySelector("#plan");
    svg.addEventListener("click", (ev) => this._onCanvasClick(ev));
    svg.addEventListener("pointermove", (ev) => this._onCanvasPointerMove(ev));
    svg.addEventListener("pointerup", () => this._onCanvasPointerUp());
    svg.addEventListener("pointerleave", () => this._onCanvasPointerUp());

    this._populateEntitySelect();
    this._renderCanvas();
  }

  // Affiche, purement a titre indicatif, le role que le serveur deduira
  // reellement (mount_type + direction) -- aucun impact sur les donnees
  // envoyees, juste pour que l'utilisateur voie l'effet de ses choix avant
  // de placer la lumiere.
  // Bascule entre la vue "room" (editer les pieces) et "scene" (generer des
  // scenes sur une piece deja configuree) -- meme etat sous-jacent
  // (_points/_lights/_zones), seule l'interactivite du plan et les cartes
  // visibles changent.
  _setActiveView(view) {
    this._activeView = view;
    const sidebar = this.shadowRoot.querySelector(".sidebar");
    const roomSceneContent = this.shadowRoot.querySelector("#room-scene-content");
    const gradientContent = this.shadowRoot.querySelector("#gradient-content");
    const lightzoneContent = this.shadowRoot.querySelector("#lightzone-content");
    const viewRoom = this.shadowRoot.querySelector("#view-room");
    const viewScene = this.shadowRoot.querySelector("#view-scene");
    const newRoomBtn = this.shadowRoot.querySelector("#new-room-btn");
    const roomNameRow = this.shadowRoot.querySelector("#room-name-row");
    const navGradientBtn = this.shadowRoot.querySelector("#nav-gradient-btn");
    const navLightzoneBtn = this.shadowRoot.querySelector("#nav-lightzone-btn");
    const navRoomBtn = this.shadowRoot.querySelector("#nav-room-btn");
    const navSceneBtn = this.shadowRoot.querySelector("#nav-scene-btn");
    const sidebarHint = this.shadowRoot.querySelector("#sidebar-hint");

    const isRoomOrScene = view === "room" || view === "scene";
    if (sidebar) sidebar.style.display = isRoomOrScene ? "block" : "none";
    if (roomSceneContent) roomSceneContent.style.display = isRoomOrScene ? "flex" : "none";
    if (gradientContent) gradientContent.style.display = view === "gradient" ? "flex" : "none";
    if (lightzoneContent) lightzoneContent.style.display = view === "lightzone" ? "flex" : "none";
    if (viewRoom) viewRoom.style.display = view === "room" ? "block" : "none";
    if (viewScene) viewScene.style.display = view === "scene" ? "block" : "none";
    if (newRoomBtn) newRoomBtn.style.display = view === "room" ? "inline-block" : "none";
    if (roomNameRow) roomNameRow.style.display = view === "room" ? "flex" : "none";
    if (navGradientBtn) navGradientBtn.style.background = view === "gradient" ? "var(--primary-color, #03a9f4)" : "transparent";
    if (navLightzoneBtn) navLightzoneBtn.style.background = view === "lightzone" ? "var(--primary-color, #03a9f4)" : "transparent";
    if (navRoomBtn) navRoomBtn.style.background = view === "room" ? "var(--primary-color, #03a9f4)" : "transparent";
    if (navSceneBtn) navSceneBtn.style.background = view === "scene" ? "var(--primary-color, #03a9f4)" : "transparent";
    if (sidebarHint) {
      sidebarHint.textContent =
        view === "room" ? "Clique sur une pièce pour l'éditer." : "Clique sur une pièce pour générer une scène dessus.";
    }

    if (view === "gradient") {
      if (!this._gradientBuilt) {
        this._renderGradientShell();
        this._gradientBuilt = true;
      }
      this._renderGradientSceneList();
    } else if (view === "lightzone") {
      if (!this._lightzoneBuilt) {
        this._renderLightZoneShell();
        this._lightzoneBuilt = true;
      }
      this._loadLightZoneData();
    } else {
      this._renderCanvas();
    }
  }

  _updateDerivedRolePreview() {
    const el = this.shadowRoot.querySelector("#derived-role-preview");
    if (!el) return;
    const role = deriveRole(this._pendingMountType, this._pendingDirection);
    el.textContent = ROLE_LABELS[role] || role;
  }

  // Un seul bloc "Ajouter à la pièce" avec des onglets (lumière/zone/meuble)
  // plutot que plusieurs cartes independantes -- l'onglet actif determine a
  // la fois le style du bouton et le groupe de champs affiche.
  _updatePlacementTabsUI() {
    this.shadowRoot.querySelectorAll("#placement-mode-tabs .seg-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-mode") === this._placementMode);
    });
    const fieldsLight = this.shadowRoot.querySelector("#fields-light");
    if (fieldsLight) fieldsLight.style.display = this._placementMode === "light" ? "block" : "none";
    const fieldsZone = this.shadowRoot.querySelector("#fields-zone");
    if (fieldsZone) fieldsZone.style.display = this._placementMode === "zone" ? "block" : "none";
    const fieldsFurniture = this.shadowRoot.querySelector("#fields-furniture");
    if (fieldsFurniture) fieldsFurniture.style.display = this._placementMode === "furniture" ? "block" : "none";
  }

  _populateEntitySelect() {
    const sel = this.shadowRoot.querySelector("#entity-select");
    if (!sel || !this._hass) return;
    const lights = Object.keys(this._hass.states)
      .filter((id) => id.startsWith("light."))
      .sort();
    sel.innerHTML = lights
      .map((id) => {
        const name = (this._hass.states[id].attributes && this._hass.states[id].attributes.friendly_name) || id;
        return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
      })
      .join("");
    if (lights.length && !this._pendingEntity) {
      this._pendingEntity = lights[0];
    }
    sel.value = this._pendingEntity;
  }

  // -----------------------------------------------------------------------
  // Canvas SVG : conversion coordonnees ecran -> espace utilisateur SVG,
  // necessaire car le SVG est redimensionne par CSS (width:100%) tout en
  // gardant un viewBox fixe -- un simple clientX/clientY ne suffit pas.
  // -----------------------------------------------------------------------
  _svgPointFromEvent(ev) {
    const svg = this.shadowRoot.querySelector("#plan");
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  // Uniquement le trace/l'edition du CONTOUR -- le placement des lumieres/
  // zones/meubles se fait exclusivement dans la vue 3D (_onThreePointerUp),
  // jamais dans ce plan 2D (voir _editingOutline : les deux vues ne sont
  // jamais affichees en meme temps).
  _onCanvasClick(ev) {
    if (this._activeView !== "room") return;
    if (!this._editingOutline) return;

    // Un clic qui suit immediatement un glisser-depose ne doit pas EN PLUS
    // ajouter un point -- sans ce garde-fou, relacher le glissement
    // declenche aussi un "click" fantome au meme endroit.
    if (this._justDragged) {
      this._justDragged = false;
      return;
    }

    const p = this._svgPointFromEvent(ev);

    if (this._points.length >= 3 && distance(p, this._points[0]) <= CLOSE_THRESHOLD) {
      // Clic pres du premier point -> ferme le contour et bascule sur la
      // vue 3D (seule la premiere fermeture le fait automatiquement ;
      // rouvrir ensuite se fait via le bouton "Modifier le contour").
      this._closed = true;
      this._editingOutline = false;
      this._renderCanvas();
      this._renderLightsList();
      return;
    }
    this._points.push({ x: snapToGrid(p.x), y: snapToGrid(p.y) });
    this._renderCanvas();
  }

  // Alternative au trace au clic : pour une piece carree/rectangulaire,
  // saisir directement ses dimensions reelles genere le contour (et ferme
  // le trace) sans avoir a cliquer les 4 coins. Remplace entierement le
  // contour courant (et, comme "Recommencer le contour", les lumieres/
  // zones/meubles deja places -- ils n'auraient plus de sens sur une
  // nouvelle forme).
  _generateRectangleOutline() {
    const widthInput = this.shadowRoot.querySelector("#rect-width-input");
    const depthInput = this.shadowRoot.querySelector("#rect-depth-input");
    const widthM = parseFloat(widthInput.value);
    const depthM = parseFloat(depthInput.value);
    if (!Number.isFinite(widthM) || !Number.isFinite(depthM) || widthM <= 0 || depthM <= 0) {
      alert("Indique une largeur et une profondeur valides (en mètres, ex. 3.15).");
      return;
    }

    // La piece garde le pas par defaut (80 px/m, memes proportions que le
    // reste du panel) sauf si elle deborderait trop du plan 2D visible
    // (viewBox ${VIEWBOX_W}x${VIEWBOX_H}) -- dans ce cas seul le pas
    // pixels/metre de CETTE piece est reduit (Room.scale_px_per_m), la
    // taille reelle en metres ne change pas : ca ne fait que redessiner le
    // plan 2D plus petit pour qu'il reste entierement visible/cliquable.
    const maxScaleForWidth = (VIEWBOX_W * 0.85) / widthM;
    const maxScaleForDepth = (VIEWBOX_H * 0.85) / depthM;
    this._scalePxPerM = Math.min(DEFAULT_PX_PER_METER, maxScaleForWidth, maxScaleForDepth);

    const widthPx = Math.round(widthM * this._scalePxPerM);
    const depthPx = Math.round(depthM * this._scalePxPerM);
    this._points = [
      { x: 0, y: 0 },
      { x: widthPx, y: 0 },
      { x: widthPx, y: depthPx },
      { x: 0, y: depthPx },
    ];
    this._closed = true;
    this._editingOutline = false;
    this._lights = [];
    this._zones = [];
    this._furniture = [];
    this._hiddenWalls = new Set();
    this._suggestions = null;
    this._previewMode = false;
    this._syncEditorInputs();
    this._renderCanvas();
    this._renderLightsList();
    this._renderZonesList();
    this._renderFurnitureList();
    this._renderScenePreviewList();
  }

  // -----------------------------------------------------------------------
  // Glisser-depose des points de mur (seuls elements encore edites dans le
  // plan 2D -- lumieres/zones/meubles se glissent desormais dans la vue 3D).
  // pointerdown demarre sur le marqueur lui-meme (attache apres chaque
  // rendu, voir _renderCanvas) ; pointermove/pointerup sont sur le SVG
  // entier pour ne pas perdre le geste si le curseur sort brievement du
  // marqueur.
  // -----------------------------------------------------------------------
  _onMarkerPointerDown(ev, kind, index) {
    if (this._activeView !== "room" || !this._editingOutline) return;
    ev.stopPropagation();
    const source = this._points[index];
    this._dragging = { kind, index, startX: source.x, startY: source.y, moved: false };
  }

  _onCanvasPointerMove(ev) {
    if (!this._dragging) return;
    const p = this._svgPointFromEvent(ev);
    this._dragging.moved = true;
    this._points[this._dragging.index] = { x: snapToGrid(p.x), y: snapToGrid(p.y) };
    this._renderCanvas();
  }

  _onCanvasPointerUp() {
    if (!this._dragging) return;
    this._justDragged = this._dragging.moved;
    this._dragging = null;
    this._renderCanvas();
  }

  _renderCanvas() {
    const svg = this.shadowRoot.querySelector("#plan");
    if (!svg) return;

    // Rayon des poignees de mur, adapte a l'echelle REELLE de rendu du plan,
    // pas seulement a la largeur de la fenetre -- le viewBox reste fixe
    // (${VIEWBOX_W}x${VIEWBOX_H}) mais le plan peut s'afficher bien plus
    // compresse sur un telephone qu'en desktop. Sans ca, un rayon de
    // 7-9 unites devient quelques pixels a peine des que le plan est
    // compresse a moins de la moitie de sa largeur de conception, rendant
    // les poignees quasi impossibles a toucher.
    const svgRect = svg.getBoundingClientRect();
    const renderScale = svgRect.width > 0 ? svgRect.width / VIEWBOX_W : 1;
    const wallPointR = Math.max(7, 9 / renderScale);

    // Les deux vues (plan 2D et vue 3D) ne sont JAMAIS affichees en meme
    // temps : le 2D sert exclusivement a tracer/ajuster le contour
    // (_editingOutline), le 3D prend le relais pour tout le reste
    // (positionnement lumieres/zones/meubles) des que le contour est
    // valide -- evite d'avoir deux representations divergentes de la
    // meme piece visibles cote a cote.
    const showOutline2D = !this._closed || this._editingOutline;
    const showThreeD = this._closed && !this._editingOutline;

    const outlineActions = this.shadowRoot.querySelector("#outline-actions");
    const canvasWrap = this.shadowRoot.querySelector("#canvas-wrap");
    const validateOutlineBtn = this.shadowRoot.querySelector("#validate-outline-btn");
    const drawHint = this.shadowRoot.querySelector("#draw-hint");
    const rectGenerator = this.shadowRoot.querySelector("#rect-generator");
    if (canvasWrap) canvasWrap.style.display = showOutline2D ? "block" : "none";
    if (outlineActions) outlineActions.style.display = showOutline2D ? "flex" : "none";
    if (rectGenerator) rectGenerator.style.display = showOutline2D ? "block" : "none";
    if (validateOutlineBtn) validateOutlineBtn.style.display = this._closed && this._editingOutline ? "inline-block" : "none";
    if (drawHint) {
      drawHint.style.display = showOutline2D ? "block" : "none";
      drawHint.textContent = this._closed
        ? "Contour existant. Glisse un point pour l'ajuster, ou « Recommencer le contour » pour tout retracer, puis « Passer à la vue 3D »."
        : "Clique dans le plan pour placer les coins du contour (accroché à la grille). Clique près du premier point pour refermer.";
    }

    const view3dCard = this.shadowRoot.querySelector("#view3d-card");
    if (view3dCard) view3dCard.style.display = showThreeD ? "block" : "none";
    const placementCard = this.shadowRoot.querySelector("#placement-card");
    if (placementCard) placementCard.style.display = showThreeD ? "block" : "none";
    const sceneCard = this.shadowRoot.querySelector("#scene-card");
    if (sceneCard) sceneCard.style.display = this._closed && this._lights.length ? "block" : "none";

    if (showThreeD && this._points.length >= 3) {
      this._ensureThreeLoaded()
        .then(() => {
          this._initThreeScene();
          this._rebuildThreeRoom();
          this._rebuildThreeObjects();
        })
        .catch((err) => {
          console.error("Alex Light Studio - échec du chargement de la vue 3D :", err);
          const loading = this.shadowRoot.querySelector("#threed-loading");
          if (loading) loading.textContent = "Vue 3D indisponible (échec de chargement).";
        });
    } else if (this._three) {
      this._rebuildThreeRoom();
      this._rebuildThreeObjects();
    }

    if (!showOutline2D) return; // rien a dessiner dans le SVG le temps que la vue 3D est active

    const pointsAttr = this._points.map((p) => `${p.x},${p.y}`).join(" ");
    const shapeEl = this._points.length
      ? this._closed
        ? `<polygon points="${pointsAttr}" fill="rgba(3,169,244,0.12)" stroke="var(--primary-color,#03a9f4)" stroke-width="2" />`
        : `<polyline points="${pointsAttr}" fill="none" stroke="var(--primary-color,#03a9f4)" stroke-width="2" />`
      : "";

    const cornerDots = this._points
      .map(
        (p, i) =>
          `<circle class="wall-point" data-point-index="${i}" cx="${p.x}" cy="${p.y}" r="${wallPointR}"
             fill="${i === 0 ? "#f4a935" : "#03a9f4"}" stroke="white" stroke-width="1.5"
             style="cursor:grab;" />`
      )
      .join("");

    // Grille de fond façon papier quadrille -- aide purement visuelle, les
    // points de mur s'accrochent en plus reellement a ce pas (snapToGrid).
    svg.innerHTML = `
      <defs>
        <pattern id="grid" width="${GRID_SIZE}" height="${GRID_SIZE}" patternUnits="userSpaceOnUse">
          <path d="M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="${VIEWBOX_W}" height="${VIEWBOX_H}" fill="rgba(255,255,255,0.02)" />
      <rect x="0" y="0" width="${VIEWBOX_W}" height="${VIEWBOX_H}" fill="url(#grid)" />
      ${shapeEl}
      ${cornerDots}
    `;

    svg.querySelectorAll(".wall-point").forEach((el) => {
      el.addEventListener("pointerdown", (ev) =>
        this._onMarkerPointerDown(ev, "point", parseInt(el.getAttribute("data-point-index"), 10))
      );
    });
  }

  _renderLightsList() {
    const list = this.shadowRoot.querySelector("#lights-list");
    if (!list) return;
    if (!this._lights.length) {
      list.innerHTML = `<div class="empty">Aucune lumière placée pour l'instant.</div>`;
      return;
    }
    list.innerHTML = this._lights
      .map((l, i) => {
        const st = this._hass.states[l.entity_id];
        const name = (st && st.attributes && st.attributes.friendly_name) || l.entity_id;
        const lightType = l.light_type || "color";
        const importance = l.importance != null ? l.importance : 0.7;
        const derivedRole = deriveRole(l.mount_type, l.direction || "direct");
        const stripRotation = l.strip_rotation || 0;
        return `
          <div class="light-item" data-index="${i}" style="flex-wrap:wrap;">
            <span>${l.is_strip ? "▬" : MOUNT_TYPE_ICONS[l.mount_type] || ""}</span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>
            <span style="color:var(--secondary-text-color);">(${MOUNT_TYPE_LABELS[l.mount_type] || l.mount_type} · ${ROLE_LABELS[derivedRole]})</span>
            <select class="light-type" data-index="${i}" style="flex:0 0 90px;" title="Couleur/Blanc">
              <option value="color" ${lightType === "color" ? "selected" : ""}>Couleur</option>
              <option value="white" ${lightType === "white" ? "selected" : ""}>Blanc</option>
            </select>
            <input type="range" class="light-importance" data-index="${i}" min="0" max="1" step="0.1"
                   value="${importance}" style="width:70px;flex:0 0 70px;" title="Importance (${importance})" />
            <input type="number" class="light-height" data-index="${i}" min="0" max="10" step="0.1"
                   value="${l.height != null ? l.height : 2.2}" style="width:56px;flex:0 0 56px;" title="Hauteur (m)" />
            <select class="light-direction" data-index="${i}" style="flex:0 0 90px;" title="Direction">
              <option value="direct" ${l.direction !== "indirect" ? "selected" : ""}>Direct</option>
              <option value="indirect" ${l.direction === "indirect" ? "selected" : ""}>Indirect</option>
            </select>
            ${
              l.is_strip
                ? `<input type="range" class="light-strip-rotation" data-index="${i}" min="0" max="359" step="5"
                     value="${stripRotation}" style="width:90px;flex:0 0 90px;" title="Orientation du bandeau (${Math.round(stripRotation)}°)" />`
                : ""
            }
            <span class="del-btn" data-del-index="${i}">✕</span>
          </div>`;
      })
      .join("");
    list.querySelectorAll(".light-type").forEach((el) => {
      el.addEventListener("change", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        this._lights[idx].light_type = ev.target.value;
      });
    });
    list.querySelectorAll(".light-importance").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        const v = parseFloat(ev.target.value);
        this._lights[idx].importance = Number.isFinite(v) ? v : 0.7;
        el.title = `Importance (${this._lights[idx].importance})`;
      });
    });
    list.querySelectorAll(".light-height").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        const v = parseFloat(ev.target.value);
        this._lights[idx].height = Number.isFinite(v) ? v : 2.2;
        this._rebuildThreeObjects();
      });
    });
    list.querySelectorAll(".light-direction").forEach((el) => {
      el.addEventListener("change", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        this._lights[idx].direction = ev.target.value;
      });
    });
    list.querySelectorAll(".light-strip-rotation").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        const v = parseFloat(ev.target.value);
        this._lights[idx].strip_rotation = Number.isFinite(v) ? v : 0;
        el.title = `Orientation du bandeau (${Math.round(this._lights[idx].strip_rotation)}°)`;
        this._rebuildThreeObjects();
      });
    });
    list.querySelectorAll("[data-del-index]").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.getAttribute("data-del-index"), 10);
        this._lights.splice(idx, 1);
        this._renderCanvas();
        this._renderLightsList();
      });
    });
  }

  _renderZonesList() {
    const list = this.shadowRoot.querySelector("#zones-list");
    if (!list) return;
    if (!this._zones.length) {
      list.innerHTML = `<div class="empty">Aucune zone placée pour l'instant.</div>`;
      return;
    }
    list.innerHTML = this._zones
      .map((z, i) => {
        const swatch = hsvToCss(z.hue, z.saturation, 220);
        return `
          <div class="light-item" data-index="${i}" style="flex-wrap:wrap;">
            <span style="width:14px;height:14px;border-radius:50%;background:${swatch};flex:0 0 14px;"></span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(z.name)}</span>
            <span style="color:var(--secondary-text-color);">portée ${Math.round(z.influence_radius)}</span>
            <input type="number" class="zone-height" data-index="${i}" min="0" max="6" step="0.1"
                   value="${z.z != null ? z.z : 1.2}" style="width:56px;flex:0 0 56px;" title="Hauteur (m)" />
            <span class="del-btn" data-del-zone-index="${i}">✕</span>
          </div>`;
      })
      .join("");
    list.querySelectorAll(".zone-height").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        const v = parseFloat(ev.target.value);
        this._zones[idx].z = Number.isFinite(v) ? v : 1.2;
        this._rebuildThreeObjects();
      });
    });
    list.querySelectorAll("[data-del-zone-index]").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.getAttribute("data-del-zone-index"), 10);
        this._zones.splice(idx, 1);
        this._renderCanvas();
        this._renderZonesList();
      });
    });
  }

  // Place une lumiere/zone a la position (px, py) deja validee (a
  // l'interieur du contour) -- appele depuis un clic au sol dans la vue 3D,
  // voir _onThreePointerUp. Mêmes champs que l'ancien flux de placement 2D,
  // simplement declenches depuis la 3D desormais.
  _addLightAt(px, py) {
    if (!this._pendingEntity) return;
    this._lights.push({
      entity_id: this._pendingEntity,
      x: px,
      y: py,
      mount_type: this._pendingMountType,
      height: this._pendingHeight,
      direction: this._pendingDirection,
      light_type: this._pendingLightType,
      importance: this._pendingImportance,
      power: this._pendingPower,
      is_strip: this._pendingIsStrip,
      length: this._pendingStripLength,
      strip_rotation: this._pendingStripRotation,
    });
    this._rebuildThreeObjects();
    this._renderLightsList();
  }

  _addZoneAt(px, py) {
    if (!this._pendingZoneName.trim()) {
      this.shadowRoot.querySelector("#zone-name").focus();
      return;
    }
    this._zones.push({
      name: this._pendingZoneName.trim(),
      x: px,
      y: py,
      hue: this._pendingZoneHue,
      saturation: this._pendingZoneSaturation,
      influence_radius: this._pendingZoneRadius,
      z: this._pendingZoneHeight,
    });
    this._rebuildThreeObjects();
    this._renderZonesList();
  }

  // -----------------------------------------------------------------------
  // Meubles (vue 3D) -- catalogue, formulaire de placement, liste editable.
  // -----------------------------------------------------------------------
  _populateFurnitureTypeSelect() {
    const sel = this.shadowRoot.querySelector("#furniture-type-select");
    if (!sel) return;
    sel.innerHTML = Object.keys(FURNITURE_TYPES)
      .map((type) => `<option value="${type}">${escapeHtml(FURNITURE_TYPES[type].label)}</option>`)
      .join("");
    sel.value = this._pendingFurnitureType;
  }

  _syncFurnitureFormInputs() {
    const widthInput = this.shadowRoot.querySelector("#furniture-width-input");
    if (widthInput) widthInput.value = this._pendingFurnitureWidth;
    const depthInput = this.shadowRoot.querySelector("#furniture-depth-input");
    if (depthInput) depthInput.value = this._pendingFurnitureDepth;
    const heightInput = this.shadowRoot.querySelector("#furniture-height-input");
    if (heightInput) heightInput.value = this._pendingFurnitureHeight;
    const elevationInput = this.shadowRoot.querySelector("#furniture-elevation-input");
    if (elevationInput) elevationInput.value = this._pendingFurnitureElevation;
  }

  _addFurnitureAt(px, py) {
    this._furniture.push({
      id: `f-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      furniture_type: this._pendingFurnitureType,
      x: px,
      y: py,
      rotation: 0,
      elevation: this._pendingFurnitureElevation,
      width: this._pendingFurnitureWidth,
      depth: this._pendingFurnitureDepth,
      height: this._pendingFurnitureHeight,
      label: "",
    });
    this._rebuildThreeObjects();
    this._renderFurnitureList();
  }

  _renderFurnitureList() {
    const list = this.shadowRoot.querySelector("#furniture-list");
    if (!list) return;
    if (!this._furniture.length) {
      list.innerHTML = `<div class="empty">Aucun meuble placé pour l'instant.</div>`;
      return;
    }
    list.innerHTML = this._furniture
      .map((f, i) => {
        const catalog = FURNITURE_TYPES[f.furniture_type] || FURNITURE_TYPES.other;
        const rotation = f.rotation || 0;
        const elevation = f.elevation || 0;
        return `
          <div class="light-item" data-index="${i}" style="flex-wrap:wrap;">
            <span style="width:14px;height:14px;border-radius:3px;background:${catalog.color};flex:0 0 14px;"></span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(catalog.label)}</span>
            <input type="range" class="furniture-rotation" data-index="${i}" min="0" max="359" step="5"
                   value="${rotation}" style="width:90px;flex:0 0 90px;" title="Rotation (${Math.round(rotation)}°)" />
            <input type="number" class="furniture-elevation" data-index="${i}" min="0" max="3" step="0.05"
                   value="${elevation}" style="width:56px;flex:0 0 56px;" title="Élévation (m)" />
            <span class="del-btn" data-del-furniture-index="${i}">✕</span>
          </div>`;
      })
      .join("");
    list.querySelectorAll(".furniture-rotation").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        const v = parseFloat(ev.target.value);
        this._furniture[idx].rotation = Number.isFinite(v) ? v : 0;
        el.title = `Rotation (${Math.round(this._furniture[idx].rotation)}°)`;
        this._rebuildThreeObjects();
      });
    });
    list.querySelectorAll(".furniture-elevation").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        const v = parseFloat(ev.target.value);
        this._furniture[idx].elevation = Number.isFinite(v) && v >= 0 ? v : 0;
        this._rebuildThreeObjects();
      });
    });
    list.querySelectorAll("[data-del-furniture-index]").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.getAttribute("data-del-furniture-index"), 10);
        this._furniture.splice(idx, 1);
        this._rebuildThreeObjects();
        this._renderFurnitureList();
      });
    });
  }

  // -----------------------------------------------------------------------
  // Vue 3D (Three.js) -- construction paresseuse de la scene (chargement du
  // script vendu au premier besoin), extrusion de la piece depuis le
  // contour 2D, visualisation des lumieres/zones, placement/glisser-depose/
  // rotation des meubles. Camera orbitale/zoom/pan maison (pas d'
  // OrbitControls vendu -- l'arborescence examples/ recente de three.js est
  // module-only et fragile a figer pour un simple besoin d'orbite/zoom/pan).
  // -----------------------------------------------------------------------
  _ensureThreeLoaded() {
    if (window.THREE) return Promise.resolve();
    if (this._threeLoadPromise) return this._threeLoadPromise;
    this._threeLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = THREE_VENDOR_URL;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Échec du chargement de Three.js"));
      document.head.appendChild(script);
    });
    return this._threeLoadPromise;
  }

  _initThreeScene() {
    if (this._three || !window.THREE) return;
    const THREE = window.THREE;
    const canvas = this.shadowRoot.querySelector("#threed-canvas");
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b0f);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    dirLight.position.set(3, 6, 4);
    scene.add(dirLight);

    this._three = {
      renderer,
      scene,
      camera,
      raycaster: new THREE.Raycaster(),
      floorPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      roomGroup: null,
      objectsGroup: null,
      furnitureMeshes: [],
      cameraState: null,
      resizeObserver: null,
      animationFrame: null,
    };

    const resize = () => this._threeResizeRenderer();
    if (window.ResizeObserver) {
      this._three.resizeObserver = new ResizeObserver(resize);
      this._three.resizeObserver.observe(canvas);
    }
    resize();

    canvas.addEventListener("pointerdown", (ev) => this._onThreePointerDown(ev));
    canvas.addEventListener("pointermove", (ev) => this._onThreePointerMove(ev));
    canvas.addEventListener("pointerup", (ev) => this._onThreePointerUp(ev));
    canvas.addEventListener("pointercancel", (ev) => this._onThreePointerUp(ev));
    canvas.addEventListener("wheel", (ev) => this._onThreeWheel(ev), { passive: false });
    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

    const animate = () => {
      if (!this._three) return;
      this._three.renderer.render(this._three.scene, this._three.camera);
      this._three.animationFrame = requestAnimationFrame(animate);
    };
    animate();

    const loading = this.shadowRoot.querySelector("#threed-loading");
    if (loading) loading.style.display = "none";
  }

  _threeResizeRenderer() {
    const t = this._three;
    const canvas = this.shadowRoot.querySelector("#threed-canvas");
    if (!t || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    t.renderer.setSize(rect.width, rect.height, false);
    t.camera.aspect = rect.width / rect.height;
    t.camera.updateProjectionMatrix();
  }

  // px (plan 2D, stockage) <-> metres (monde Three.js, plan XZ au sol).
  _worldFromPx(px, py) {
    const s = this._scalePxPerM || DEFAULT_PX_PER_METER;
    return { x: px / s, z: py / s };
  }

  _pxFromWorld(x, z) {
    const s = this._scalePxPerM || DEFAULT_PX_PER_METER;
    return { x: x * s, y: z * s };
  }

  _rebuildThreeRoom() {
    const t = this._three;
    if (!t || !window.THREE) return;
    const THREE = window.THREE;
    if (t.roomGroup) {
      t.scene.remove(t.roomGroup);
      disposeThreeGroup(t.roomGroup);
    }
    const group = new THREE.Group();
    t.roomGroup = group;
    t.scene.add(group);
    if (this._points.length < 3 || !this._closed) return;

    const worldPoints = this._points.map((p) => this._worldFromPx(p.x, p.y));

    const shape = new THREE.Shape(worldPoints.map((p) => new THREE.Vector2(p.x, p.z)));
    const floorGeom = new THREE.ShapeGeometry(shape);
    floorGeom.rotateX(Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, side: THREE.DoubleSide, roughness: 0.9 });
    group.add(new THREE.Mesh(floorGeom, floorMat));

    const height = this._roomHeight || 2.5;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a3a42, roughness: 0.95, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    for (let i = 0; i < worldPoints.length; i++) {
      if (this._hiddenWalls.has(i)) continue; // mur masque a la demande (voir #wall-toggles) -- degage la vue/le placement
      const a = worldPoints[i];
      const b = worldPoints[(i + 1) % worldPoints.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) continue;
      const wallGeom = new THREE.BoxGeometry(length, height, 0.05);
      const wall = new THREE.Mesh(wallGeom, wallMat);
      wall.position.set((a.x + b.x) / 2, height / 2, (a.z + b.z) / 2);
      wall.rotation.y = -Math.atan2(dz, dx);
      group.add(wall);
    }

    const span = Math.max(2, ...worldPoints.map((p) => Math.max(Math.abs(p.x), Math.abs(p.z)))) * 2.4;
    group.add(new THREE.GridHelper(span, Math.round(span / 0.5), 0x444455, 0x24242c));

    if (!t.cameraState) this._threeFrameRoom(worldPoints);
    this._renderWallToggles();
  }

  // Un bouton par mur (arete du contour) -- multi-selection, permet de
  // masquer un ou plusieurs murs geants qui bloqueraient la vue/le clic de
  // placement a l'interieur de la piece. Purement une aide d'edition (voir
  // _hiddenWalls), jamais persistee.
  _renderWallToggles() {
    const wrap = this.shadowRoot.querySelector("#wall-toggles");
    if (!wrap) return;
    if (this._points.length < 3 || !this._closed) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = this._points
      .map((_, i) => {
        const hidden = this._hiddenWalls.has(i);
        return `<button type="button" class="wall-toggle${hidden ? " hidden-wall" : ""}" data-wall-index="${i}" title="${hidden ? "Mur masqué -- clique pour le réafficher" : "Mur visible -- clique pour le masquer"}">${i + 1}</button>`;
      })
      .join("");
    wrap.querySelectorAll(".wall-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-wall-index"), 10);
        if (this._hiddenWalls.has(idx)) this._hiddenWalls.delete(idx);
        else this._hiddenWalls.add(idx);
        this._rebuildThreeRoom();
      });
    });
  }

  // Reconstruit TOUS les objets interactifs de la piece (lumieres, zones,
  // meubles) -- la vue 3D est desormais la SEULE surface de placement/
  // glisser-depose pour les trois (voir _onThreePointerDown/Up), donc
  // chaque mesh "prenable" est tague dans t.pickableMeshes avec son
  // {kind, index} pour que le raycaster sache quoi deplacer.
  _rebuildThreeObjects() {
    const t = this._three;
    if (!t || !window.THREE) return;
    const THREE = window.THREE;
    if (t.objectsGroup) {
      t.scene.remove(t.objectsGroup);
      disposeThreeGroup(t.objectsGroup);
    }
    const group = new THREE.Group();
    t.objectsGroup = group;
    t.scene.add(group);
    t.pickableMeshes = [];

    // En mode apercu (une proposition de scene vient d'etre generee), les
    // lumieres affichent la couleur SUGGEREE plutot que la couleur par
    // role -- pur affichage, rien n'est envoye a aucune lumiere ici.
    const suggestionByEntity = {};
    if (this._previewMode && this._suggestions) {
      this._suggestions.forEach((s) => {
        suggestionByEntity[s.entity_id] = s;
      });
    }

    // Lumieres -- sphere pour une ampoule ponctuelle, barre allongee et
    // orientable pour un bandeau LED (is_strip) : un bandeau/ruban a une
    // vraie emprise physique dans la piece, pas juste un point, d'autant
    // plus visible/pertinent pour un bandeau gradient (plusieurs couleurs
    // le long du meme bandeau).
    this._lights.forEach((l, i) => {
      const world = this._worldFromPx(l.x, l.y);
      let colorCss = l.mount_type === "ceiling" ? "#f4a935" : l.mount_type === "wall" ? "#4caf50" : "#e91e63";
      const sug = suggestionByEntity[l.entity_id];
      if (sug) {
        colorCss = sug.color_temp_kelvin != null ? kelvinToCss(sug.color_temp_kelvin) : hsvToCss(sug.hue, sug.saturation, sug.brightness);
      }
      const mat = new THREE.MeshStandardMaterial({ color: colorCss, emissive: colorCss, emissiveIntensity: 0.65 });
      const mesh = l.is_strip
        ? new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.1, l.length || 1.2), 0.05, 0.08), mat)
        : new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), mat);
      if (l.is_strip) mesh.rotation.y = -((l.strip_rotation || 0) * Math.PI) / 180;
      mesh.position.set(world.x, l.height != null ? l.height : 2.2, world.z);
      mesh.userData = { kind: "light", index: i };
      group.add(mesh);
      t.pickableMeshes.push(mesh);
    });

    // Zones -- sphere translucide = portee d'influence REELLE (falloff 3D
    // cote harmony.py), rend visible ce que "harmonieux selon la position"
    // veut dire concretement ; le petit point plein central est la poignee
    // de glisser-depose (la grande sphere translucide n'est pas prenable,
    // trop imprecise au clic).
    this._zones.forEach((z, i) => {
      const world = this._worldFromPx(z.x, z.y);
      const color = new THREE.Color(hsvToCss(z.hue, z.saturation, 220));
      const radiusM = Math.max(0.05, this._toMeters(z.influence_radius != null ? z.influence_radius : 150));
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(radiusM, 20, 14),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, depthWrite: false })
      );
      sphere.position.set(world.x, z.z != null ? z.z : 1.2, world.z);
      group.add(sphere);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), new THREE.MeshBasicMaterial({ color }));
      dot.position.copy(sphere.position);
      dot.userData = { kind: "zone", index: i };
      group.add(dot);
      t.pickableMeshes.push(dot);
    });

    // Meubles.
    this._furniture.forEach((f, i) => {
      const world = this._worldFromPx(f.x, f.y);
      const catalog = FURNITURE_TYPES[f.furniture_type] || FURNITURE_TYPES.other;
      const w = f.width || catalog.width;
      const d = f.depth || catalog.depth;
      const h = f.height || catalog.height;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color: catalog.color, roughness: 0.8 })
      );
      mesh.position.set(world.x, (f.elevation || 0) + h / 2, world.z);
      mesh.rotation.y = -((f.rotation || 0) * Math.PI) / 180;
      mesh.userData = { kind: "furniture", index: i };
      group.add(mesh);
      t.pickableMeshes.push(mesh);
    });
  }

  _threeFrameRoom(worldPoints) {
    const t = this._three;
    if (!t) return;
    const THREE = window.THREE;
    const pts = worldPoints && worldPoints.length ? worldPoints : [{ x: 0, z: 0 }];
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(1, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    t.cameraState = { target: new THREE.Vector3(cx, 0, cz), radius: span * 1.3 + 2, theta: Math.PI / 4, phi: 0.85 };
    this._threeUpdateCamera();
  }

  _threeResetCameraTopView() {
    const t = this._three;
    if (!t || !t.cameraState) return;
    t.cameraState.phi = 0.08;
    this._threeUpdateCamera();
  }

  _threeUpdateCamera() {
    const t = this._three;
    if (!t || !t.cameraState) return;
    const { target, radius, theta, phi } = t.cameraState;
    const clampedPhi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, phi));
    const x = target.x + radius * Math.sin(clampedPhi) * Math.sin(theta);
    const y = radius * Math.cos(clampedPhi);
    const z = target.z + radius * Math.sin(clampedPhi) * Math.cos(theta);
    t.camera.position.set(x, y, z);
    t.camera.lookAt(target);
  }

  _threePointerFromEvent(ev) {
    const canvas = this.shadowRoot.querySelector("#threed-canvas");
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    };
  }

  _threeIntersectFloor(ndc) {
    const t = this._three;
    const THREE = window.THREE;
    t.raycaster.setFromCamera(ndc, t.camera);
    const point = new THREE.Vector3();
    const hit = t.raycaster.ray.intersectPlane(t.floorPlane, point);
    return hit ? point : null;
  }

  // Renvoie {kind, index} du premier objet "prenable" (lumiere/zone/meuble)
  // sous le curseur, ou null -- la vue 3D est la SEULE surface de placement/
  // glisser-depose pour les trois types, donc pointerdown doit d'abord
  // determiner si on saisit un objet existant avant de decider si le geste
  // est plutot une orbite/un pan de camera.
  _threePickObject(ndc) {
    const t = this._three;
    if (!t.pickableMeshes || !t.pickableMeshes.length) return null;
    t.raycaster.setFromCamera(ndc, t.camera);
    const hits = t.raycaster.intersectObjects(t.pickableMeshes, false);
    return hits.length ? hits[0].object.userData : null;
  }

  _threeArrayForKind(kind) {
    return kind === "light" ? this._lights : kind === "zone" ? this._zones : this._furniture;
  }

  // Champ qui porte la hauteur de l'objet selon son type -- "height" pour
  // une lumiere, "z" pour l'ancrage d'une zone (voir harmony.ZoneInput),
  // "elevation" pour un meuble (hauteur du BAS du meuble, pas son centre).
  _threeHeightFieldForKind(kind) {
    return kind === "light" ? "height" : kind === "zone" ? "z" : "elevation";
  }

  _threeShowHeightReadout(value) {
    const el = this.shadowRoot.querySelector("#threed-height-readout");
    if (!el) return;
    el.textContent = `Hauteur : ${value.toFixed(2)} m`;
    el.style.display = "block";
  }

  _threeHideHeightReadout() {
    const el = this.shadowRoot.querySelector("#threed-height-readout");
    if (el) el.style.display = "none";
  }

  _onThreePointerDown(ev) {
    if (this._activeView !== "room" && this._activeView !== "scene") return;
    const t = this._three;
    if (!t) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const ndc = this._threePointerFromEvent(ev);
    const picked = this._activeView === "room" ? this._threePickObject(ndc) : null;
    const item = picked ? this._threeArrayForKind(picked.kind)[picked.index] : null;
    // Maj (Shift) + glisser sur un objet DEJA place ajuste sa hauteur plutot
    // que sa position au sol (Maj + glisser sur du vide reste le pan camera
    // existant -- meme touche, comportement different selon la cible).
    const verticalMode = !!item && ev.shiftKey;
    const heightField = item ? this._threeHeightFieldForKind(picked.kind) : null;
    this._threeDrag = {
      mode: verticalMode ? "move-vertical" : item ? "move" : ev.shiftKey ? "pan" : "orbit",
      kind: picked ? picked.kind : null,
      index: picked ? picked.index : null,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      lastClientX: ev.clientX,
      lastClientY: ev.clientY,
      moved: false,
      startX: item ? item.x : 0,
      startY: item ? item.y : 0,
      startHeight: item ? item[heightField] || 0 : 0,
    };
    if (verticalMode) this._threeShowHeightReadout(this._threeDrag.startHeight);
  }

  _onThreePointerMove(ev) {
    const drag = this._threeDrag;
    const t = this._three;
    if (!drag || !t) return;
    const dx = ev.clientX - drag.lastClientX;
    const dy = ev.clientY - drag.lastClientY;
    if (Math.abs(ev.clientX - drag.startClientX) > 3 || Math.abs(ev.clientY - drag.startClientY) > 3) drag.moved = true;
    drag.lastClientX = ev.clientX;
    drag.lastClientY = ev.clientY;

    if (drag.mode === "move-vertical") {
      // Delta total depuis le DEBUT du geste (pas incremental) -- evite
      // toute derive d'arrondi sur un glisser long. Vers le haut de l'ecran
      // (clientY decroissant) = plus haut dans la piece.
      const metersPerPixel = 0.01;
      const maxHeight = (this._roomHeight || 2.5) + 0.5;
      let newHeight = drag.startHeight - (ev.clientY - drag.startClientY) * metersPerPixel;
      newHeight = Math.max(0, Math.min(maxHeight, Math.round(newHeight * 100) / 100));
      const item = this._threeArrayForKind(drag.kind)[drag.index];
      item[this._threeHeightFieldForKind(drag.kind)] = newHeight;
      this._threeShowHeightReadout(newHeight);
      this._rebuildThreeObjects();
      return;
    }

    if (drag.mode === "move") {
      const hit = this._threeIntersectFloor(this._threePointerFromEvent(ev));
      if (hit) {
        const px = this._pxFromWorld(hit.x, hit.z);
        const item = this._threeArrayForKind(drag.kind)[drag.index];
        item.x = px.x;
        item.y = px.y;
        this._rebuildThreeObjects();
      }
      return;
    }

    if (drag.mode === "orbit") {
      t.cameraState.theta -= dx * 0.008;
      t.cameraState.phi -= dy * 0.008;
      this._threeUpdateCamera();
      return;
    }

    if (drag.mode === "pan") {
      const panSpeed = t.cameraState.radius * 0.0018;
      const theta = t.cameraState.theta;
      const rightX = Math.cos(theta);
      const rightZ = -Math.sin(theta);
      const fwdX = Math.sin(theta);
      const fwdZ = Math.cos(theta);
      t.cameraState.target.x -= rightX * dx * panSpeed - fwdX * dy * panSpeed;
      t.cameraState.target.z -= rightZ * dx * panSpeed - fwdZ * dy * panSpeed;
      this._threeUpdateCamera();
    }
  }

  _threeRenderListForKind(kind) {
    if (kind === "light") this._renderLightsList();
    else if (kind === "zone") this._renderZonesList();
    else if (kind === "furniture") this._renderFurnitureList();
  }

  _onThreePointerUp(ev) {
    const drag = this._threeDrag;
    this._threeDrag = null;
    if (!drag) return;
    const canvas = this.shadowRoot.querySelector("#threed-canvas");
    if (canvas) {
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch (e) {
        // deja relachee -- sans consequence
      }
    }

    if (drag.mode === "move-vertical") {
      this._threeHideHeightReadout();
      this._threeRenderListForKind(drag.kind);
      return;
    }

    if (drag.mode === "move") {
      const item = this._threeArrayForKind(drag.kind)[drag.index];
      if (item && drag.moved && !pointInPolygon(item, this._points)) {
        // Un objet depose hors du contour revient a sa position de depart
        // plutot que d'accepter une position invalide.
        item.x = drag.startX;
        item.y = drag.startY;
        this._rebuildThreeObjects();
      }
      this._threeRenderListForKind(drag.kind);
      return;
    }

    if (!drag.moved && this._activeView === "room" && this._closed) {
      const hit = this._threeIntersectFloor(this._threePointerFromEvent(ev));
      if (hit) {
        const px = this._pxFromWorld(hit.x, hit.z);
        if (pointInPolygon(px, this._points)) {
          if (this._placementMode === "furniture") this._addFurnitureAt(px.x, px.y);
          else if (this._placementMode === "zone") this._addZoneAt(px.x, px.y);
          else this._addLightAt(px.x, px.y);
        }
      }
    }
  }

  _onThreeWheel(ev) {
    const t = this._three;
    if (!t || !t.cameraState) return;
    ev.preventDefault();
    const factor = Math.exp(ev.deltaY * 0.0015);
    t.cameraState.radius = Math.max(0.8, Math.min(60, t.cameraState.radius * factor));
    this._threeUpdateCamera();
  }

  _renderRoomList() {
    const list = this.shadowRoot.querySelector("#room-list");
    if (!list) return;
    if (this._loading) {
      list.innerHTML = `<div class="empty">Chargement…</div>`;
      return;
    }
    if (this._error) {
      list.innerHTML = `<div class="error">Erreur : ${escapeHtml(this._error)}</div>`;
      return;
    }
    if (!this._rooms.length) {
      list.innerHTML = `<div class="empty">Aucune pièce enregistrée.</div>`;
      return;
    }
    list.innerHTML = this._rooms
      .map(
        (r) => `
          <div class="room-row ${r.id === this._editingRoomId ? "selected" : ""}" data-room-id="${escapeHtml(r.id)}">
            <span>${escapeHtml(r.name)}</span>
            <span class="del-btn" data-del-room="${escapeHtml(r.id)}">✕</span>
          </div>`
      )
      .join("");
    list.querySelectorAll(".room-row").forEach((row) => {
      row.addEventListener("click", (ev) => {
        if (ev.target.hasAttribute("data-del-room")) return;
        const room = this._rooms.find((r) => r.id === row.getAttribute("data-room-id"));
        if (room) this._loadRoomIntoEditor(room);
      });
    });
    list.querySelectorAll("[data-del-room]").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const roomId = el.getAttribute("data-del-room");
        await this._hass.callWS({ type: "alex_light_studio/delete_room", room_id: roomId });
        if (this._editingRoomId === roomId) {
          this._resetEditor();
          this._syncEditorInputs();
          this._renderCanvas();
          this._renderLightsList();
        }
        this._loadRooms();
      });
    });
  }

  // x/y (points/lumieres/zones/meubles) restent stockes en pixels du plan
  // 2D (aucune migration des pieces existantes, voir DEFAULT_PX_PER_METER) --
  // mais harmony.compute_scene calcule desormais une distance 3D REELLE
  // (metres), homogene avec la hauteur des lumieres/l'altitude des zones,
  // deja en metres. Conversion uniquement ici, a la frontiere de l'appel :
  // le reste du panel (plan 2D, vue 3D d'edition, stockage) continue de
  // raisonner en pixels.
  _toMeters(px) {
    return px / (this._scalePxPerM || DEFAULT_PX_PER_METER);
  }

  _scenePayloadLights() {
    return this._lights.map((l) => {
      const p = lightPayload(l);
      p.x = this._toMeters(p.x);
      p.y = this._toMeters(p.y);
      return p;
    });
  }

  _scenePayloadZones() {
    return this._zones.map((z) => {
      const p = zonePayload(z);
      p.x = this._toMeters(p.x);
      p.y = this._toMeters(p.y);
      p.influence_radius = this._toMeters(p.influence_radius);
      return p;
    });
  }

  _scenePayloadFurniture() {
    return this._furniture.map((f) => {
      const p = furniturePayload(f);
      p.x = this._toMeters(p.x);
      p.y = this._toMeters(p.y);
      return p;
    });
  }

  async _generateScene() {
    if (this._sceneGenMode === "image" && this._sceneImagePoints.length < 1) {
      alert("Place au moins un point de couleur sur l'image avant de générer.");
      return;
    }

    const payload = {
      type: "alex_light_studio/compute_scene",
      lights: this._scenePayloadLights(),
      zones: this._scenePayloadZones(),
      furniture: this._scenePayloadFurniture(),
      scheme: this._sceneGenMode === "manual" ? this._sceneScheme : "analogous", // ignore cote serveur si mood/image fourni
      generation_style: this._sceneGenerationStyle,
    };
    if (this._sceneGenMode === "mood") {
      payload.mood = this._sceneMood;
    } else if (this._sceneGenMode === "image") {
      payload.image_palette = this._sceneImagePoints.map((p) => [p.hue, p.saturation]);
    } else {
      payload.base_hue = this._sceneManualHue;
      payload.saturation = this._sceneManualSat;
      payload.global_intensity = this._sceneManualIntensity;
      payload.contrast = this._sceneManualContrast;
      payload.white_temperature = this._sceneManualWhiteTemp;
    }

    try {
      const result = await this._hass.callWS(payload);
      this._suggestions = (result && result.suggestions) || [];
      if (!this._suggestions.length) {
        alert("Aucune proposition générée -- vérifie qu'il y a bien des lumières placées dans cette pièce.");
      }
    } catch (err) {
      console.error("Alex Scene Studio - échec de compute_scene :", err);
      alert(`Échec de la génération : ${(err && err.message) || err}`);
      this._suggestions = null;
    }
    this._previewMode = !!(this._suggestions && this._suggestions.length);
    this._renderCanvas();
    this._renderScenePreviewList();

    // Rendu en direct : applique immediatement aux vraies lumieres, sans
    // attendre un clic separe sur "Appliquer".
    if (this._liveApply && this._suggestions && this._suggestions.length) {
      await this._applyScene();
    }
  }

  _renderScenePreviewList() {
    const list = this.shadowRoot.querySelector("#scene-preview-list");
    const applyActions = this.shadowRoot.querySelector("#scene-apply-actions");
    if (!list) return;

    // Un tableau vide est "vrai" en JS (seul null/undefined est "faux") --
    // sans ce test explicite sur la longueur, une proposition vide aurait
    // quand meme affiche le bouton Appliquer, qui n'aurait alors rien fait
    // au clic (garde-fou de longueur dans _applyScene) sans aucune
    // explication visible pour l'utilisateur.
    if (!this._suggestions || !this._suggestions.length) {
      list.innerHTML = "";
      if (applyActions) applyActions.style.display = "none";
      return;
    }

    // Chaque ligne reste modifiable individuellement APRES la generation --
    // la proposition automatique est un point de depart, pas un resultat
    // figé : couleur (lumieres RGB) ou temperature (lumieres blanches) et
    // luminosite s'ajustent directement ici, avant d'appliquer ou
    // d'enregistrer en tant que scene HA.
    list.innerHTML = this._suggestions
      .map((s, i) => {
        const st = this._hass.states[s.entity_id];
        const name = (st && st.attributes && st.attributes.friendly_name) || s.entity_id;
        const isColorTemp = s.color_temp_kelvin != null;
        const swatch = isColorTemp ? kelvinToCss(s.color_temp_kelvin) : hsvToCss(s.hue, s.saturation, 255);
        const brightnessPct = Math.round((s.brightness / 255) * 100);

        const colorControl = isColorTemp
          ? `<input type="range" class="scene-kelvin-input" data-index="${i}" min="2000" max="6500" step="50" value="${s.color_temp_kelvin}" style="width:90px;" title="Température (K)" />`
          : `<input type="color" class="scene-color-input" data-index="${i}" value="${swatch}" style="width:32px;height:32px;padding:0;border:none;border-radius:6px;cursor:pointer;flex:0 0 32px;" title="Couleur" />`;

        return `
          <div class="light-item" style="flex-wrap:wrap;">
            ${colorControl}
            <span style="flex:1;min-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>
            <input type="range" class="scene-brightness-input" data-index="${i}" min="1" max="255" value="${s.brightness}" style="flex:1 1 100px;min-width:80px;" title="Luminosité" />
            <span class="scene-brightness-value" style="width:38px;text-align:right;color:var(--secondary-text-color);">${brightnessPct}%</span>
          </div>`;
      })
      .join("");

    list.querySelectorAll(".scene-color-input").forEach((input) => {
      input.addEventListener("input", (ev) => {
        const idx = parseInt(ev.target.getAttribute("data-index"), 10);
        const { hue, saturation } = hexToHueSat(ev.target.value);
        this._suggestions[idx].hue = hue;
        this._suggestions[idx].saturation = saturation;
        this._renderCanvas();
        this._liveApplySingleSuggestion(this._suggestions[idx]);
      });
    });
    list.querySelectorAll(".scene-kelvin-input").forEach((input) => {
      input.addEventListener("input", (ev) => {
        const idx = parseInt(ev.target.getAttribute("data-index"), 10);
        this._suggestions[idx].color_temp_kelvin = parseInt(ev.target.value, 10);
        this._renderCanvas();
        this._liveApplySingleSuggestion(this._suggestions[idx]);
      });
    });
    list.querySelectorAll(".scene-brightness-input").forEach((input) => {
      input.addEventListener("input", (ev) => {
        const idx = parseInt(ev.target.getAttribute("data-index"), 10);
        const value = parseInt(ev.target.value, 10);
        this._suggestions[idx].brightness = value;
        const valueLabel = input.parentElement.querySelector(".scene-brightness-value");
        if (valueLabel) valueLabel.textContent = `${Math.round((value / 255) * 100)}%`;
        this._renderCanvas();
        this._liveApplySingleSuggestion(this._suggestions[idx]);
      });
    });

    if (applyActions) applyActions.style.display = "flex";
  }

  // Applique UNE seule lumiere directement (pas tout _applyScene, qui
  // reappellerait un service pour chaque lumiere de la piece a chaque
  // pixel de glissement d'un curseur) -- seulement quand "Rendu en direct"
  // est coche.
  _liveApplySingleSuggestion(s) {
    if (!this._liveApply) return;
    const data = { entity_id: s.entity_id, brightness: s.brightness };
    if (s.color_temp_kelvin != null) {
      data.color_temp_kelvin = s.color_temp_kelvin;
    } else {
      data.hs_color = [s.hue, s.saturation];
    }
    this._hass.callService("light", "turn_on", data);
  }

  async _applyScene() {
    if (!this._suggestions || !this._suggestions.length) {
      alert("Aucune proposition à appliquer -- génère d'abord une proposition.");
      return;
    }
    const btn = this.shadowRoot.querySelector("#apply-scene-btn");
    if (btn) btn.textContent = "Application en cours…";
    try {
      const result = await this._hass.callWS({ type: "alex_light_studio/apply_scene", suggestions: this._suggestions });
      console.log("Alex Scene Studio - apply_scene résultat :", result);
    } catch (err) {
      console.error("Alex Scene Studio - échec de apply_scene :", err);
      alert(`Échec de l'application : ${(err && err.message) || err}`);
    } finally {
      if (btn) btn.textContent = "Appliquer aux lumières";
    }
  }

  async _saveAsHaScene() {
    if (!this._suggestions || !this._suggestions.length) {
      alert("Aucune proposition à enregistrer -- génère d'abord une proposition.");
      return;
    }
    const nameInput = this.shadowRoot.querySelector("#ha-scene-name");
    const sceneName = (nameInput.value || this._roomName || "Alex Scene Studio").trim();
    try {
      // La sauvegarde capture les etats ACTUELS des lumieres -- s'assurer
      // qu'elles refletent bien la proposition avant de creer la scene.
      await this._applyScene();
      const result = await this._hass.callWS({
        type: "alex_light_studio/save_as_ha_scene",
        scene_name: sceneName,
        entity_ids: this._suggestions.map((s) => s.entity_id),
      });
      if (result && result.scene_entity_id) {
        alert(`Scène enregistrée : ${result.scene_entity_id}`);
      }
    } catch (err) {
      console.error("Alex Scene Studio - échec de save_as_ha_scene :", err);
      alert(`Échec de l'enregistrement : ${(err && err.message) || err}`);
    }
  }

  async _saveRoom() {
    if (!this._roomName.trim()) {
      this.shadowRoot.querySelector("#room-name").focus();
      return;
    }
    if (this._points.length < 3 || !this._closed) {
      alert("Termine d'abord le contour de la pièce (au moins 3 points, refermé).");
      return;
    }
    const payload = {
      type: "alex_light_studio/save_room",
      name: this._roomName.trim(),
      points: this._points.map((p) => ({ x: p.x, y: p.y })),
      lights: this._lights.map(lightPayload),
      zones: this._zones.map(zonePayload),
      height: this._roomHeight,
      scale_px_per_m: this._scalePxPerM,
      furniture: this._furniture.map(furniturePayload),
    };
    if (this._editingRoomId) payload.room_id = this._editingRoomId;

    const result = await this._hass.callWS(payload);
    if (result && result.room) {
      this._editingRoomId = result.room.id;
    }
    await this._loadRooms();
  }

  // ===========================================================================
  // === Vue Gradient (ex-Alex Gradient Studio) ===============================
  // ===========================================================================

  // Fusionne l'etat reel (hass) avec les mises a jour optimistes locales
  // (voir _saveGradientScene/_deleteGradientScene) -- ces dernieres restent
  // affichees tant que hass ne les a pas rattrapees.
  _gradientScenesFromHass() {
    if (!this._hass) return {};
    const st = this._hass.states["sensor.alex_light_studio_gradient_scenes"];
    const base = (st && st.attributes && st.attributes.scenes) || {};
    const merged = Object.assign({}, base, this._gradientLocalSceneOverride || {});
    if (this._gradientLocalSceneDeleted) {
      this._gradientLocalSceneDeleted.forEach((name) => delete merged[name]);
    }
    return merged;
  }

  _gradientStopsFromColors(colors) {
    if (!colors.length) return [];
    if (colors.length === 1) return [{ position: 0, color: colors[0] }];
    return colors.map((color, i) => ({ position: i / (colors.length - 1), color }));
  }

  // Construit la coquille de la vue Gradient une seule fois (jamais
  // reconstruite sur une mise a jour de hass, pour ne pas perdre l'edition
  // en cours) -- seule _renderGradientSceneList se rafraichit reellement en
  // reaction aux changements de hass.
  _renderGradientShell() {
    const el = this.shadowRoot.querySelector("#gradient-content");
    if (!el) return;

    el.innerHTML = `
      <div class="card" id="gradient-target-card">
        <h2>Cible</h2>
        <p class="hint">
          La lumière et le type d'appareil ci-dessous servent à la fois pour
          « Tester » et pour « Charger » une scène existante.
        </p>
        <div class="row">
          <label>Lumière</label>
          <select id="gradient-entity-select"></select>
        </div>
        <div class="row">
          <label>Type d'appareil</label>
          <select id="gradient-device-type-select">
            <option value="hue">Philips Hue Gradient</option>
            <option value="aqara">Aqara LED Strip T1</option>
          </select>
        </div>
        <div class="row">
          <label>Nom convivial Z2M</label>
          <input type="text" id="gradient-friendly-name-input" placeholder="vide = déduit de l'entité" />
        </div>
      </div>

      <div class="card" id="gradient-editor-card">
        <h2>Éditer un dégradé</h2>
        <div class="stops-row" id="gradient-stops-row"></div>
        <div class="stops-controls">
          <button class="btn btn-outline" id="gradient-add-stop">+ Point</button>
          <button class="btn btn-outline" id="gradient-remove-stop">− Point</button>
        </div>
        <div class="actions">
          <button class="btn btn-accent" id="gradient-test-btn">Tester sur la lumière</button>
        </div>
        <div class="row" style="margin-top:16px;">
          <label>Nom de la scène</label>
          <input type="text" id="gradient-scene-name" placeholder="ex. Coucher de soleil" />
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="gradient-save-btn">Enregistrer</button>
        </div>
      </div>

      <div class="card">
        <h2>Scènes enregistrées</h2>
        <div class="scene-list" id="gradient-scene-list"></div>
      </div>
    `;

    this._populateGradientEntitySelect();
    this._renderGradientStops();

    this.shadowRoot.querySelector("#gradient-device-type-select").addEventListener("change", (ev) => {
      this._gradientDeviceType = ev.target.value;
    });
    this.shadowRoot.querySelector("#gradient-friendly-name-input").addEventListener("input", (ev) => {
      this._gradientFriendlyNameOverride = ev.target.value.trim();
    });
    this.shadowRoot.querySelector("#gradient-entity-select").addEventListener("change", (ev) => {
      this._gradientTestEntity = ev.target.value;
    });
    this.shadowRoot.querySelector("#gradient-add-stop").addEventListener("click", () => {
      if (this._gradientStops.length >= 10) return;
      this._gradientStops.push("#ffffff");
      this._renderGradientStops();
    });
    this.shadowRoot.querySelector("#gradient-remove-stop").addEventListener("click", () => {
      if (this._gradientStops.length <= 2) return;
      this._gradientStops.pop();
      this._renderGradientStops();
    });
    this.shadowRoot.querySelector("#gradient-test-btn").addEventListener("click", () => this._testGradient());
    this.shadowRoot.querySelector("#gradient-save-btn").addEventListener("click", () => this._saveGradientScene());
  }

  _populateGradientEntitySelect() {
    const sel = this.shadowRoot.querySelector("#gradient-entity-select");
    if (!sel || !this._hass) return;
    const entities = Object.keys(this._hass.states)
      .filter((id) => id.startsWith("light."))
      .sort();
    sel.innerHTML =
      `<option value="">— choisir —</option>` +
      entities
        .map((id) => {
          const name = (this._hass.states[id].attributes && this._hass.states[id].attributes.friendly_name) || id;
          return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
        })
        .join("");
    sel.value = this._gradientTestEntity;
  }

  _renderGradientStops() {
    const row = this.shadowRoot.querySelector("#gradient-stops-row");
    if (!row) return;
    row.innerHTML = this._gradientStops
      .map(
        (color, i) => `
          <div class="stop-cell">
            <input type="color" class="gradient-stop-input" data-index="${i}" value="${color}" />
          </div>`
      )
      .join("");
    row.querySelectorAll(".gradient-stop-input").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        this._gradientStops[idx] = ev.target.value;
      });
    });
  }

  // Reechantillonnage local (identique a la logique cote integration) pour
  // le "Tester" -- evite un aller-retour service pour un simple apercu.
  _resampleGradientStops(stops, segments) {
    if (segments <= 0) return [];
    if (!stops.length) return new Array(segments).fill("#ffffff");
    const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const rgbToHex = (r, g, b) =>
      "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
    const positioned = stops.map((color, i) => ({ position: stops.length > 1 ? i / (stops.length - 1) : 0, color }));
    if (positioned.length === 1) return new Array(segments).fill(positioned[0].color);

    const out = [];
    for (let i = 0; i < segments; i++) {
      const pos = segments > 1 ? i / (segments - 1) : 0;
      let lo = positioned[0];
      let hi = positioned[positioned.length - 1];
      for (let j = 0; j < positioned.length - 1; j++) {
        if (positioned[j].position <= pos && pos <= positioned[j + 1].position) {
          lo = positioned[j];
          hi = positioned[j + 1];
          break;
        }
      }
      const span = hi.position - lo.position;
      const t = span <= 0 ? 0 : (pos - lo.position) / span;
      const [r1, g1, b1] = hexToRgb(lo.color);
      const [r2, g2, b2] = hexToRgb(hi.color);
      out.push(rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t));
    }
    return out;
  }

  async _resolveGradientSegments(entityId) {
    if (this._gradientDeviceType !== "aqara") return this._gradientStops.length;
    const lengthEntity = gradientDefaultLengthEntity(entityId);
    const st = lengthEntity && this._hass.states[lengthEntity];
    if (st && st.state != null && !Number.isNaN(Number(st.state))) {
      const n = Math.round(Number(st.state) * 5);
      if (n > 0) return Math.min(50, n);
    }
    return this._gradientStops.length;
  }

  async _testGradient() {
    if (!this._gradientTestEntity) return;
    const segments = await this._resolveGradientSegments(this._gradientTestEntity);
    const colors = this._resampleGradientStops(this._gradientStops, segments);
    const friendlyName = gradientFriendlyNameFor(this._hass, this._gradientTestEntity, this._gradientFriendlyNameOverride);
    const payload =
      this._gradientDeviceType === "aqara"
        ? { segment_colors: colors.map((c, i) => ({ segment: i + 1, color: gradientHexToRgbObj(c) })) }
        : { gradient: colors };
    this._hass.callService("mqtt", "publish", {
      topic: `zigbee2mqtt/${friendlyName}/set`,
      payload: JSON.stringify(payload),
    });
  }

  async _saveGradientScene() {
    const nameInput = this.shadowRoot.querySelector("#gradient-scene-name");
    const name = (nameInput.value || "").trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    await this._hass.callService("alex_light_studio", "save_scene", { name, colors: this._gradientStops });
    nameInput.value = "";

    // Mise a jour optimiste immediate : ne pas attendre le prochain
    // rafraichissement de hass.
    this._gradientLocalSceneOverride = this._gradientLocalSceneOverride || {};
    this._gradientLocalSceneOverride[name] = { stops: this._gradientStopsFromColors(this._gradientStops) };
    if (this._gradientLocalSceneDeleted) this._gradientLocalSceneDeleted.delete(name);
    this._gradientLastScenesSig = null;
    this._renderGradientSceneList();
  }

  // Recharge les points d'ancrage d'une scene enregistree dans l'editeur,
  // pour modification -- le nom est pre-rempli, un nouvel "Enregistrer"
  // ecrasera donc la meme scene plutot que d'en creer une nouvelle.
  _editGradientScene(name) {
    const scenes = this._gradientScenesFromHass();
    const scene = scenes[name];
    if (!scene || !scene.stops || !scene.stops.length) return;

    this._gradientStops = scene.stops
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => s.color);
    this._renderGradientStops();

    const nameInput = this.shadowRoot.querySelector("#gradient-scene-name");
    if (nameInput) nameInput.value = name;

    const editorCard = this.shadowRoot.querySelector("#gradient-editor-card");
    if (editorCard) editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async _loadGradientScene(name) {
    if (!this._gradientTestEntity) return;
    const data = { entity_id: this._gradientTestEntity, name, device_type: this._gradientDeviceType };
    if (this._gradientFriendlyNameOverride) data.friendly_name = this._gradientFriendlyNameOverride;
    await this._hass.callService("alex_light_studio", "load_scene", data);
  }

  async _deleteGradientScene(name) {
    await this._hass.callService("alex_light_studio", "delete_scene", { name });

    this._gradientLocalSceneDeleted = this._gradientLocalSceneDeleted || new Set();
    this._gradientLocalSceneDeleted.add(name);
    if (this._gradientLocalSceneOverride) delete this._gradientLocalSceneOverride[name];
    this._gradientLastScenesSig = null;
    this._renderGradientSceneList();
  }

  // Partie reactive : reconstruit uniquement la liste des scenes quand hass
  // change (jamais toute la coquille, pour ne pas perdre l'edition en cours).
  _renderGradientSceneList() {
    if (!this._gradientBuilt || !this.shadowRoot) return;
    const scenes = this._gradientScenesFromHass();
    const sig = JSON.stringify(scenes);
    if (sig === this._gradientLastScenesSig) return;
    this._gradientLastScenesSig = sig;

    this._populateGradientEntitySelect();

    const list = this.shadowRoot.querySelector("#gradient-scene-list");
    if (!list) return;
    const names = Object.keys(scenes);
    if (names.length === 0) {
      list.innerHTML = `<div class="empty">Aucune scène enregistrée pour l'instant.</div>`;
      return;
    }
    list.innerHTML = names
      .map((name) => {
        const stops = (scenes[name] && scenes[name].stops) || [];
        const gradientCss = stops.length
          ? stops
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((s) => `${s.color} ${Math.round(s.position * 100)}%`)
              .join(", ")
          : "#ffffff, #ffffff";
        return `
          <div class="scene-row" data-name="${escapeHtml(name)}">
            <div class="scene-preview" style="background:linear-gradient(90deg, ${gradientCss});"></div>
            <div class="scene-name">${escapeHtml(name)}</div>
            <button class="btn btn-outline gradient-edit-btn">Éditer</button>
            <button class="btn btn-outline gradient-load-btn">Charger</button>
            <button class="btn btn-outline gradient-delete-btn">Supprimer</button>
          </div>`;
      })
      .join("");

    list.querySelectorAll(".gradient-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._editGradientScene(btn.closest(".scene-row").getAttribute("data-name")));
    });
    list.querySelectorAll(".gradient-load-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._loadGradientScene(btn.closest(".scene-row").getAttribute("data-name")));
    });
    list.querySelectorAll(".gradient-delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._deleteGradientScene(btn.closest(".scene-row").getAttribute("data-name")));
    });
  }

  // ===========================================================================
  // === Vue LightZone ==========================================================
  // Zones de segments d'un bandeau (registre de bandeaux PARTAGE avec la vue
  // Gradient, cote stockage) : chaque zone = un groupe d'un ou plusieurs
  // segments, pilotable independamment via sa propre entite light.* (voir
  // light.py). Construite une seule fois comme la vue Gradient (coquille
  // figee, seules les parties dependant de hass/du stockage se rafraichissent).
  // ===========================================================================

  _renderLightZoneShell() {
    const el = this.shadowRoot.querySelector("#lightzone-content");
    if (!el) return;

    el.innerHTML = `
      <div class="card" id="lightzone-strip-card">
        <h2>Bandeau</h2>
        <p class="hint">
          Le registre de bandeaux est partagé avec la vue Gradient : un
          bandeau déclaré ici apparaît aussi là-bas, et inversement.
        </p>
        <div class="strip-picker-row">
          <select id="lightzone-strip-select"></select>
          <button class="btn btn-outline" id="lightzone-new-strip-btn">+ Nouveau bandeau</button>
          <button class="btn btn-outline" id="lightzone-delete-strip-btn">Supprimer ce bandeau</button>
        </div>
        <div class="hint error" id="lightzone-strip-error" style="display:none;"></div>

        <div id="lightzone-new-strip-form" style="display:none;">
          <div class="row">
            <label>Lumière</label>
            <select id="lightzone-strip-entity-select"></select>
          </div>
          <div class="row">
            <label>Type d'appareil</label>
            <select id="lightzone-strip-device-type-select">
              <option value="hue">Philips Hue Gradient</option>
              <option value="aqara">Aqara LED Strip T1</option>
            </select>
          </div>
          <div class="row">
            <label>Nom</label>
            <input type="text" id="lightzone-strip-name-input" placeholder="ex. Placard entrée" />
          </div>
          <div class="row">
            <label>Nom convivial Z2M</label>
            <input type="text" id="lightzone-strip-friendly-name-input" placeholder="vide = déduit de l'entité" />
          </div>
          <div class="row">
            <label>Segments (repli)</label>
            <input type="number" id="lightzone-strip-segments-input" min="2" max="50" value="5" />
          </div>
          <div class="actions">
            <button class="btn btn-primary" id="lightzone-save-strip-btn">Enregistrer le bandeau</button>
          </div>
        </div>
      </div>

      <div class="card" id="lightzone-segments-card" style="display:none;">
        <h2>Segments</h2>
        <p class="hint">
          Clique sur les segments à regrouper dans une nouvelle zone. Un
          point coloré indique qu'un segment appartient déjà à une autre
          zone (chevauchement autorisé — la dernière zone appliquée l'emporte).
        </p>
        <div class="segment-grid" id="lightzone-segment-grid"></div>
        <div class="row">
          <label>Nom de la zone</label>
          <input type="text" id="lightzone-zone-name-input" placeholder="ex. Porte 1" />
        </div>
        <div class="actions">
          <button class="btn btn-outline" id="lightzone-clear-selection-btn">Réinitialiser la sélection</button>
          <button class="btn btn-primary" id="lightzone-create-zone-btn">Créer la zone</button>
        </div>
      </div>

      <div class="card" id="lightzone-list-card" style="display:none;">
        <h2>Zones de ce bandeau</h2>
        <div class="zone-list" id="lightzone-zone-list"></div>
      </div>
    `;

    this._populateLightZoneEntitySelect();

    this.shadowRoot.querySelector("#lightzone-strip-select").addEventListener("change", (ev) => {
      this._lightzoneSelectedStripId = ev.target.value;
      this._lightzoneSelectedSegments = [];
      this._lightzoneLastZonesSig = null;
      this._renderLightZoneStripDependent();
    });
    this.shadowRoot.querySelector("#lightzone-new-strip-btn").addEventListener("click", () => {
      this._lightzoneShowNewStripForm = !this._lightzoneShowNewStripForm;
      this.shadowRoot.querySelector("#lightzone-new-strip-form").style.display =
        this._lightzoneShowNewStripForm ? "block" : "none";
    });
    this.shadowRoot.querySelector("#lightzone-delete-strip-btn").addEventListener("click", () => this._deleteLightZoneStrip());

    this.shadowRoot.querySelector("#lightzone-strip-entity-select").addEventListener("change", (ev) => {
      this._lightzoneNewStrip.entity = ev.target.value;
    });
    this.shadowRoot.querySelector("#lightzone-strip-device-type-select").addEventListener("change", (ev) => {
      this._lightzoneNewStrip.device_type = ev.target.value;
    });
    this.shadowRoot.querySelector("#lightzone-strip-name-input").addEventListener("input", (ev) => {
      this._lightzoneNewStrip.name = ev.target.value;
    });
    this.shadowRoot.querySelector("#lightzone-strip-friendly-name-input").addEventListener("input", (ev) => {
      this._lightzoneNewStrip.friendly_name = ev.target.value;
    });
    this.shadowRoot.querySelector("#lightzone-strip-segments-input").addEventListener("input", (ev) => {
      this._lightzoneNewStrip.segments = parseInt(ev.target.value, 10) || 5;
    });
    this.shadowRoot.querySelector("#lightzone-save-strip-btn").addEventListener("click", () => this._saveLightZoneStrip());

    this.shadowRoot.querySelector("#lightzone-clear-selection-btn").addEventListener("click", () => {
      this._lightzoneSelectedSegments = [];
      this._renderLightZoneGrid();
    });
    this.shadowRoot.querySelector("#lightzone-zone-name-input").addEventListener("input", (ev) => {
      this._lightzoneNewZoneName = ev.target.value;
    });
    this.shadowRoot.querySelector("#lightzone-create-zone-btn").addEventListener("click", () => this._createLightZone());
  }

  _populateLightZoneEntitySelect() {
    const sel = this.shadowRoot.querySelector("#lightzone-strip-entity-select");
    if (!sel || !this._hass) return;
    const entities = Object.keys(this._hass.states)
      .filter((id) => id.startsWith("light."))
      .sort();
    sel.innerHTML =
      `<option value="">— choisir —</option>` +
      entities
        .map((id) => {
          const name = (this._hass.states[id].attributes && this._hass.states[id].attributes.friendly_name) || id;
          return `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`;
        })
        .join("");
    sel.value = this._lightzoneNewStrip.entity;
  }

  async _loadLightZoneData() {
    try {
      const [stripsRes, zonesRes] = await Promise.all([
        this._hass.callWS({ type: "alex_light_studio/get_strips" }),
        this._hass.callWS({ type: "alex_light_studio/get_light_zones" }),
      ]);
      this._lightzoneStrips = (stripsRes && stripsRes.strips) || {};
      this._lightzoneZones = (zonesRes && zonesRes.zones) || {};
    } catch (err) {
      this._lightzoneStrips = {};
      this._lightzoneZones = {};
    }
    this._populateLightZoneStripSelect();
    this._lightzoneLastZonesSig = null;
    this._renderLightZoneStripDependent();
  }

  _populateLightZoneStripSelect() {
    const sel = this.shadowRoot.querySelector("#lightzone-strip-select");
    if (!sel) return;
    const ids = Object.keys(this._lightzoneStrips);
    if (!ids.length) {
      sel.innerHTML = `<option value="">Aucun bandeau — crée-en un</option>`;
      this._lightzoneSelectedStripId = "";
      return;
    }
    sel.innerHTML = ids
      .map((id) => {
        const s = this._lightzoneStrips[id];
        const label = s.name || s.entity;
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      })
      .join("");
    if (!this._lightzoneSelectedStripId || !this._lightzoneStrips[this._lightzoneSelectedStripId]) {
      this._lightzoneSelectedStripId = ids[0];
    }
    sel.value = this._lightzoneSelectedStripId;
  }

  _renderLightZoneStripDependent() {
    const segCard = this.shadowRoot.querySelector("#lightzone-segments-card");
    const listCard = this.shadowRoot.querySelector("#lightzone-list-card");
    const hasStrip = !!this._lightzoneSelectedStripId && !!this._lightzoneStrips[this._lightzoneSelectedStripId];
    if (segCard) segCard.style.display = hasStrip ? "block" : "none";
    if (listCard) listCard.style.display = hasStrip ? "block" : "none";
    if (!hasStrip) return;
    this._renderLightZoneGrid();
    this._renderLightZoneList();
  }

  // Meme logique de resolution que _resolveGradientSegments, appliquee a un
  // bandeau du registre partage plutot qu'a la cible de test du dégradé.
  _resolveLightZoneStripSegments(strip) {
    if (!strip) return 0;
    if (strip.device_type === "aqara") {
      const lengthEntity = strip.length_entity || gradientDefaultLengthEntity(strip.entity);
      const st = lengthEntity && this._hass.states[lengthEntity];
      if (st && st.state != null && !Number.isNaN(Number(st.state))) {
        const n = Math.round(Number(st.state) * 5);
        if (n > 0) return Math.min(50, n);
      }
    }
    return strip.segments || 5;
  }

  _renderLightZoneGrid() {
    const grid = this.shadowRoot.querySelector("#lightzone-segment-grid");
    if (!grid) return;
    const strip = this._lightzoneStrips[this._lightzoneSelectedStripId];
    if (!strip) {
      grid.innerHTML = "";
      return;
    }
    const segmentCount = this._resolveLightZoneStripSegments(strip);

    // Index de segment -> couleur (cyclee) de la zone existante qui le
    // couvre deja, purement indicatif pour reperer un chevauchement avant
    // de creer une nouvelle zone dessus.
    const usedBy = {};
    Object.values(this._lightzoneZones)
      .filter((z) => z.strip_id === this._lightzoneSelectedStripId)
      .forEach((z, i) => {
        const color = LIGHTZONE_PALETTE[i % LIGHTZONE_PALETTE.length];
        (z.segments || []).forEach((seg) => {
          usedBy[seg] = color;
        });
      });

    const cells = [];
    for (let i = 0; i < segmentCount; i++) {
      const selected = this._lightzoneSelectedSegments.includes(i);
      const dot = usedBy[i] ? `<span class="used-dot" style="background:${usedBy[i]};"></span>` : "";
      cells.push(`<div class="segment-cell${selected ? " selected" : ""}" data-index="${i}">${i + 1}${dot}</div>`);
    }
    grid.innerHTML = cells.join("");
    grid.querySelectorAll(".segment-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const idx = parseInt(cell.getAttribute("data-index"), 10);
        const pos = this._lightzoneSelectedSegments.indexOf(idx);
        if (pos === -1) this._lightzoneSelectedSegments.push(idx);
        else this._lightzoneSelectedSegments.splice(pos, 1);
        this._renderLightZoneGrid();
      });
    });
  }

  // Entity_id derive du slug stocke sur la zone (voir _unique_zone_slug
  // cote integration) : lisible ("light.chambre_bled_seg1"), pas de
  // prefixe de namespace -- deja connu localement via
  // get_light_zones/save_light_zone, pas besoin d'un aller-retour serveur.
  // Repli sur le zone_id pour une zone plus ancienne sans slug enregistre
  // (retrocompatibilite).
  _lightzoneEntityIdFor(zone) {
    const slug = (zone && zone.slug) || (zone && zone.id ? zone.id.replace(/-/g, "") : "");
    return `light.${slug}`;
  }

  // Rafraichissement reactif (signature-cachee, comme _renderGradientSceneList)
  // : appele a chaque tick hass pour que l'etat allumee/eteinte et la couleur
  // de chaque zone restent a jour sans reconstruire la liste pour rien.
  _renderLightZoneList() {
    if (!this._lightzoneBuilt || !this.shadowRoot) return;
    const list = this.shadowRoot.querySelector("#lightzone-zone-list");
    if (!list) return;
    const zones = Object.values(this._lightzoneZones).filter((z) => z.strip_id === this._lightzoneSelectedStripId);

    const sig = JSON.stringify(
      zones.map((z) => {
        const st = this._hass.states[this._lightzoneEntityIdFor(z)];
        return [
          z.id,
          z.name,
          z.segments,
          st ? st.state : null,
          st && st.attributes ? st.attributes.hs_color : null,
          st && st.attributes ? st.attributes.brightness : null,
        ];
      })
    );
    if (sig === this._lightzoneLastZonesSig) return;
    this._lightzoneLastZonesSig = sig;

    if (!zones.length) {
      list.innerHTML = `<div class="empty">Aucune zone pour ce bandeau pour l'instant.</div>`;
      return;
    }

    list.innerHTML = zones
      .map((z) => {
        const entityId = this._lightzoneEntityIdFor(z);
        const st = this._hass.states[entityId];
        const isOn = !!st && st.state === "on";
        const color =
          isOn && st.attributes && st.attributes.hs_color
            ? hsvToCss(st.attributes.hs_color[0], st.attributes.hs_color[1], st.attributes.brightness || 255)
            : "transparent";
        const segLabel = (z.segments || [])
          .slice()
          .sort((a, b) => a - b)
          .map((s) => s + 1)
          .join(", ");
        return `
          <div class="zone-row" data-zone-id="${escapeHtml(z.id)}">
            <div class="zone-swatch" style="background:${color};"></div>
            <div class="zone-info">
              <div class="zone-name">${escapeHtml(z.name)}</div>
              <div class="zone-segments">Segments ${segLabel || "—"} · ${isOn ? "allumée" : "éteinte"}</div>
            </div>
            <button class="btn btn-outline lightzone-more-info-btn">Ouvrir</button>
            <button class="btn btn-outline lightzone-delete-zone-btn">Supprimer</button>
          </div>`;
      })
      .join("");

    list.querySelectorAll(".lightzone-more-info-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const zoneId = btn.closest(".zone-row").getAttribute("data-zone-id");
        const zone = this._lightzoneZones[zoneId];
        if (!zone) return;
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            detail: { entityId: this._lightzoneEntityIdFor(zone) },
            bubbles: true,
            composed: true,
          })
        );
      });
    });
    list.querySelectorAll(".lightzone-delete-zone-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._deleteLightZoneZone(btn.closest(".zone-row").getAttribute("data-zone-id")));
    });
  }

  async _saveLightZoneStrip() {
    const s = this._lightzoneNewStrip;
    if (!s.entity) {
      this.shadowRoot.querySelector("#lightzone-strip-entity-select").focus();
      return;
    }
    const payload = {
      type: "alex_light_studio/save_strip",
      entity: s.entity,
      device_type: s.device_type,
      friendly_name: s.friendly_name || "",
      length_entity: s.length_entity || "",
      name: s.name || "",
    };
    if (s.segments) payload.segments = s.segments;

    const result = await this._hass.callWS(payload);
    if (result && result.strip) {
      this._lightzoneStrips[result.strip.id] = result.strip;
      this._lightzoneSelectedStripId = result.strip.id;
      this._lightzoneSelectedSegments = [];
    }
    this._lightzoneShowNewStripForm = false;
    this.shadowRoot.querySelector("#lightzone-new-strip-form").style.display = "none";
    this._populateLightZoneStripSelect();
    this._lightzoneLastZonesSig = null;
    this._renderLightZoneStripDependent();
  }

  async _deleteLightZoneStrip() {
    const stripId = this._lightzoneSelectedStripId;
    if (!stripId) return;
    const errEl = this.shadowRoot.querySelector("#lightzone-strip-error");
    if (errEl) errEl.style.display = "none";
    try {
      await this._hass.callWS({ type: "alex_light_studio/delete_strip", strip_id: stripId });
    } catch (err) {
      // Le plus probable ici : strip_in_use (des zones referencent encore
      // ce bandeau) -- message du serveur affiche tel quel, pas besoin de
      // le retraduire cote panel.
      if (errEl) {
        errEl.textContent = (err && err.message) || "Suppression impossible.";
        errEl.style.display = "block";
      }
      return;
    }
    delete this._lightzoneStrips[stripId];
    this._lightzoneSelectedStripId = "";
    this._populateLightZoneStripSelect();
    this._lightzoneLastZonesSig = null;
    this._renderLightZoneStripDependent();
  }

  async _createLightZone() {
    const nameInput = this.shadowRoot.querySelector("#lightzone-zone-name-input");
    const name = (nameInput.value || "").trim();
    if (!name || !this._lightzoneSelectedSegments.length || !this._lightzoneSelectedStripId) {
      if (!name) nameInput.focus();
      return;
    }
    const result = await this._hass.callWS({
      type: "alex_light_studio/save_light_zone",
      strip_id: this._lightzoneSelectedStripId,
      name,
      segments: this._lightzoneSelectedSegments.slice().sort((a, b) => a - b),
    });
    if (result && result.zone) {
      this._lightzoneZones[result.zone.id] = result.zone;
    }
    this._lightzoneSelectedSegments = [];
    nameInput.value = "";
    this._lightzoneNewZoneName = "";
    this._lightzoneLastZonesSig = null;
    this._renderLightZoneGrid();
    this._renderLightZoneList();
  }

  async _deleteLightZoneZone(zoneId) {
    await this._hass.callWS({ type: "alex_light_studio/delete_light_zone", zone_id: zoneId });
    delete this._lightzoneZones[zoneId];
    this._lightzoneLastZonesSig = null;
    this._renderLightZoneGrid();
    this._renderLightZoneList();
  }

  // ===========================================================================
  // === Generation de scene depuis une image ==================================
  // ===========================================================================

  _wireSceneImageInputs() {
    const dropzone = this.shadowRoot.querySelector("#scene-image-dropzone");
    const fileInput = this.shadowRoot.querySelector("#scene-image-file-input");
    const canvas = this.shadowRoot.querySelector("#scene-image-canvas");
    if (!dropzone || !fileInput || !canvas) return;

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (ev) => {
      ev.preventDefault();
      dropzone.classList.remove("dragover");
      const file = ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) this._loadSceneImageFile(file);
    });
    fileInput.addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (file) this._loadSceneImageFile(file);
    });

    canvas.addEventListener("click", (ev) => this._onSceneImageCanvasClick(ev));

    this.shadowRoot.querySelector("#scene-image-clear-points-btn").addEventListener("click", () => {
      this._sceneImagePoints = [];
      this._renderSceneImagePoints();
    });
    this.shadowRoot.querySelector("#scene-image-change-btn").addEventListener("click", () => {
      this._sceneImageDataUrl = null;
      this._sceneImagePoints = [];
      this.shadowRoot.querySelector("#scene-image-preview-wrap").style.display = "none";
      dropzone.style.display = "block";
      fileInput.value = "";
    });

    // Retour sur cette vue avec une image deja chargee precedemment (la
    // coquille est reconstruite a chaque bascule de vue, mais pas l'etat) --
    // la redessine sans perdre les points deja places.
    if (this._sceneImageDataUrl) {
      this._loadSceneImageFromDataUrl(this._sceneImageDataUrl, true);
    }
  }

  _loadSceneImageFile(file) {
    if (!file.type || !file.type.startsWith("image/")) {
      alert("Le fichier déposé n'est pas une image.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => this._loadSceneImageFromDataUrl(reader.result);
    reader.readAsDataURL(file);
  }

  // keepPoints : vrai uniquement lors d'un retour sur la vue avec une image
  // deja chargee -- une VRAIE nouvelle image (glisser-depose/choix de
  // fichier/"Changer d'image") repart toujours d'une palette vide, les
  // points precedents n'ayant plus de sens sur une image differente.
  _loadSceneImageFromDataUrl(dataUrl, keepPoints) {
    const img = new Image();
    img.onload = () => {
      this._sceneImageDataUrl = dataUrl;
      if (!keepPoints) this._sceneImagePoints = [];

      const canvas = this.shadowRoot.querySelector("#scene-image-canvas");
      if (!canvas) return;
      // Cap la resolution interne du canvas -- les teintes restent
      // representatives de l'image sans avoir besoin de sa pleine
      // resolution photo, qui alourdirait inutilement getImageData.
      const MAX_DIM = 800;
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      this.shadowRoot.querySelector("#scene-image-dropzone").style.display = "none";
      this.shadowRoot.querySelector("#scene-image-preview-wrap").style.display = "block";
      this._renderSceneImagePoints();
    };
    img.onerror = () => alert("Impossible de charger cette image.");
    img.src = dataUrl;
  }

  _onSceneImageCanvasClick(ev) {
    if (this._sceneImagePoints.length >= 8) {
      alert("Maximum 8 points de couleur -- retire-en un avant d'en ajouter un autre.");
      return;
    }
    const canvas = this.shadowRoot.querySelector("#scene-image-canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Le canvas peut etre affiche plus petit/grand que sa resolution
    // interne relle (width/height de l'element canvas) via le CSS --
    // convertit les coordonnees d'affichage (clientX/Y) vers les pixels
    // REELS du canvas avant d'echantillonner.
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round((ev.clientX - rect.left) * scaleX)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round((ev.clientY - rect.top) * scaleY)));

    const ctx = canvas.getContext("2d");
    const pixel = ctx.getImageData(px, py, 1, 1).data;
    const { hue, saturation } = rgbToHueSat(pixel[0], pixel[1], pixel[2]);

    this._sceneImagePoints.push({
      x: px / canvas.width, // fraction 0-1 -- le marqueur reste au bon endroit meme si le canvas est redimensionne
      y: py / canvas.height,
      hue,
      saturation,
    });
    this._renderSceneImagePoints();
  }

  _removeSceneImagePoint(index) {
    this._sceneImagePoints.splice(index, 1);
    this._renderSceneImagePoints();
  }

  _renderSceneImagePoints() {
    const wrap = this.shadowRoot.querySelector("#scene-image-canvas-wrap");
    if (!wrap) return;
    wrap.querySelectorAll(".scene-image-point-marker").forEach((el) => el.remove());
    this._sceneImagePoints.forEach((p, i) => {
      const marker = document.createElement("div");
      marker.className = "scene-image-point-marker";
      marker.style.left = `${p.x * 100}%`;
      marker.style.top = `${p.y * 100}%`;
      marker.style.background = hsvToCss(p.hue, p.saturation, 220);
      marker.textContent = String(i + 1);
      marker.title = "Cliquer pour retirer ce point";
      marker.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._removeSceneImagePoint(i);
      });
      wrap.appendChild(marker);
    });

    const list = this.shadowRoot.querySelector("#scene-image-palette-list");
    if (!list) return;
    if (!this._sceneImagePoints.length) {
      list.innerHTML = `<div class="empty">Aucun point placé pour l'instant.</div>`;
      return;
    }
    list.innerHTML = this._sceneImagePoints
      .map((p, i) => {
        const css = hsvToCss(p.hue, p.saturation, 220);
        return `
          <div class="scene-image-palette-row">
            <span style="width:20px;height:20px;border-radius:5px;background:${css};flex:0 0 20px;"></span>
            <span style="flex:1;">Point ${i + 1} — teinte ${Math.round(p.hue)}°, saturation ${Math.round(p.saturation)}%</span>
            <span class="scene-image-del-point" data-index="${i}" style="cursor:pointer;opacity:.7;">✕</span>
          </div>`;
      })
      .join("");
    list.querySelectorAll(".scene-image-del-point").forEach((el) => {
      el.addEventListener("click", () => this._removeSceneImagePoint(parseInt(el.getAttribute("data-index"), 10)));
    });
  }
}

customElements.define("alex-light-studio-panel", AlexLightStudioPanel);
