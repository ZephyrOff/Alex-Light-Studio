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
const GRID_SIZE = 20; // unites SVG entre deux lignes de la grille -- meme pas utilise pour l'accroche des points de mur

function snapToGrid(v) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

const MOUNT_TYPE_LABELS = { ceiling: "Plafond", wall: "Mur", desk: "Bureau" };
const ROLE_LABELS = { primary: "Principale", accent: "Accentuation", ambient: "Ambiance" };

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
    this._lights = []; // {entity_id, x, y, mount_type, height, direction, importance, light_type, power}
    this._zones = []; // {name, x, y, hue, saturation, influence_radius}

    // Mode de placement au clic dans le contour : "light" ou "zone".
    this._placementMode = "light";

    // Selections courantes pour le placement de la prochaine lumiere.
    this._pendingEntity = "";
    this._pendingMountType = "ceiling";
    this._pendingHeight = 2.2; // metres, valeur de depart raisonnable (hauteur sous plafond courante)
    this._pendingDirection = "direct";
    this._pendingLightType = "color"; // "color" | "white" -- choix explicite, plus fiable qu'une detection automatique
    this._pendingImportance = 0.7; // 0-1
    this._pendingPower = 1.0; // puissance/capacite relative -- 1.0 = reference

    // Selections courantes pour le placement de la prochaine zone.
    this._pendingZoneName = "";
    this._pendingZoneHue = 30;
    this._pendingZoneSaturation = 70;
    this._pendingZoneRadius = 150;

    // Glisser-depose : point de mur, lumiere ou zone en cours de deplacement.
    // { kind: "point"|"light"|"zone", index: N, startX, startY } ou null.
    this._dragging = null;

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
    this._lights = [];
    this._zones = [];
    this._placementMode = "light";
    this._pendingEntity = "";
    this._pendingMountType = "ceiling";
    this._pendingHeight = 2.2;
    this._pendingDirection = "direct";
    this._pendingLightType = "color";
    this._pendingImportance = 0.7;
    this._pendingPower = 1.0;
    this._pendingZoneName = "";
    this._pendingZoneHue = 30;
    this._pendingZoneSaturation = 70;
    this._pendingZoneRadius = 150;
    this._dragging = null;
    this._suggestions = null;
    this._previewMode = false;
  }

  _loadRoomIntoEditor(room) {
    this._editingRoomId = room.id;
    this._roomName = room.name;
    this._points = room.points.map((p) => ({ x: p.x, y: p.y }));
    this._closed = this._points.length >= 3;
    // height/direction/light_type/importance/power : repli sur des valeurs
    // par defaut pour les pieces enregistrees avant l'ajout de ces champs.
    this._lights = room.lights.map((l) => ({
      height: 2.2,
      direction: "direct",
      light_type: "color",
      importance: 0.7,
      power: 1.0,
      ...l,
    }));
    this._zones = (room.zones || []).map((z) => ({
      saturation: 70,
      influence_radius: 150,
      ...z,
    }));
    // Une proposition generee pour une AUTRE piece n'a plus de sens ici.
    this._suggestions = null;
    this._previewMode = false;
    this._syncEditorInputs();
    this._renderCanvas();
    this._renderLightsList();
    this._renderZonesList();
    this._renderScenePreviewList();
    this._renderRoomList();
  }

  _syncEditorInputs() {
    const nameInput = this.shadowRoot.querySelector("#room-name");
    if (nameInput) nameInput.value = this._roomName;
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
          <div class="card">
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
            </div>
          </div>

          <div id="view-room">

          <div class="card" id="placement-mode-card" style="display:none;">
            <h2>Que place le clic dans le contour ?</h2>
            <div class="row">
              <label>Mode</label>
              <select id="placement-mode-select">
                <option value="light">Une lumière</option>
                <option value="zone">Une zone</option>
              </select>
            </div>
          </div>

          <div class="card" id="lights-card" style="display:none;margin-top:20px;">
            <h2>Positionner les lumières</h2>
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
              pour un rendu équivalent. Choisis tes réglages ci-dessus, puis clique dans le contour pour
              placer la lumière. Une fois placée, glisse-la directement dans le plan pour la repositionner.
            </div>
            <div id="lights-list" style="margin-top:12px;"></div>
          </div>

          <div class="card" id="zones-card" style="display:none;">
            <h2>Zones (ancrages chromatiques)</h2>
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
            <div class="hint">
              Une zone influence les lumières proches vers sa teinte — l'influence décroît avec la distance et
              s'annule à la portée choisie. Donne un nom à la zone ci-dessus, puis clique dans le contour pour
              la placer. Une fois placée, glisse-la pour la repositionner.
            </div>
            <div id="zones-list" style="margin-top:12px;"></div>
          </div>

          <div class="actions">
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
      this._lights = [];
      this._zones = [];
      this._suggestions = null;
      this._previewMode = false;
      this._renderCanvas();
      this._renderLightsList();
      this._renderZonesList();
      this._renderScenePreviewList();
    });
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
    this.shadowRoot.querySelector("#placement-mode-select").addEventListener("change", (ev) => {
      this._placementMode = ev.target.value;
      this.shadowRoot.querySelector("#lights-card").style.display = this._placementMode === "light" ? "block" : "none";
      this.shadowRoot.querySelector("#zones-card").style.display = this._placementMode === "zone" ? "block" : "none";
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
    const outlineActions = this.shadowRoot.querySelector("#outline-actions");
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
    if (outlineActions) outlineActions.style.display = view === "room" ? "flex" : "none";
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

  _onCanvasClick(ev) {
    // Plan en lecture seule en vue Scene -- l'edition (contour/lumieres/
    // zones) ne se fait qu'en vue Room.
    if (this._activeView !== "room") return;

    // Un clic qui suit immediatement un glisser-depose ne doit pas EN PLUS
    // ajouter un point ou placer une lumiere -- sans ce garde-fou, relacher
    // le glissement declenche aussi un "click" fantome au meme endroit.
    if (this._justDragged) {
      this._justDragged = false;
      return;
    }

    const p = this._svgPointFromEvent(ev);

    if (!this._closed) {
      // Mode dessin du contour : clic pres du premier point -> ferme.
      if (this._points.length >= 3 && distance(p, this._points[0]) <= CLOSE_THRESHOLD) {
        this._closed = true;
        this._renderCanvas();
        this._renderLightsList();
        return;
      }
      this._points.push({ x: snapToGrid(p.x), y: snapToGrid(p.y) });
      this._renderCanvas();
      return;
    }

    // Mode placement : lumiere ou zone selon le selecteur, seulement a
    // l'interieur du contour.
    if (!pointInPolygon(p, this._points)) return;

    if (this._placementMode === "zone") {
      if (!this._pendingZoneName.trim()) {
        this.shadowRoot.querySelector("#zone-name").focus();
        return;
      }
      this._zones.push({
        name: this._pendingZoneName.trim(),
        x: p.x,
        y: p.y,
        hue: this._pendingZoneHue,
        saturation: this._pendingZoneSaturation,
        influence_radius: this._pendingZoneRadius,
      });
      this._renderCanvas();
      this._renderZonesList();
      return;
    }

    if (!this._pendingEntity) return;
    this._lights.push({
      entity_id: this._pendingEntity,
      x: p.x,
      y: p.y,
      mount_type: this._pendingMountType,
      height: this._pendingHeight,
      direction: this._pendingDirection,
      light_type: this._pendingLightType,
      importance: this._pendingImportance,
      power: this._pendingPower,
    });
    this._renderCanvas();
    this._renderLightsList();
  }

  // -----------------------------------------------------------------------
  // Glisser-depose des points de mur et des lumieres deja places. pointerdown
  // demarre sur le marqueur lui-meme (attache apres chaque rendu, voir
  // _renderCanvas) ; pointermove/pointerup sont sur le SVG entier pour ne
  // pas perdre le geste si le curseur sort brievement du marqueur.
  // -----------------------------------------------------------------------
  _onMarkerPointerDown(ev, kind, index) {
    if (this._activeView !== "room") return;
    ev.stopPropagation();
    const source = kind === "point" ? this._points[index] : kind === "zone" ? this._zones[index] : this._lights[index];
    this._dragging = { kind, index, startX: source.x, startY: source.y, moved: false };
  }

  _onCanvasPointerMove(ev) {
    if (!this._dragging) return;
    const p = this._svgPointFromEvent(ev);
    this._dragging.moved = true;
    if (this._dragging.kind === "point") {
      this._points[this._dragging.index] = { x: snapToGrid(p.x), y: snapToGrid(p.y) };
    } else if (this._dragging.kind === "zone") {
      this._zones[this._dragging.index].x = p.x;
      this._zones[this._dragging.index].y = p.y;
    } else {
      this._lights[this._dragging.index].x = p.x;
      this._lights[this._dragging.index].y = p.y;
    }
    this._renderCanvas();
  }

  _onCanvasPointerUp() {
    if (!this._dragging) return;
    const { kind, index, startX, startY, moved } = this._dragging;
    if ((kind === "light" || kind === "zone") && moved) {
      // Une lumiere ou une zone deposee hors du contour revient a sa
      // position de depart plutot que d'accepter une position invalide.
      const item = kind === "zone" ? this._zones[index] : this._lights[index];
      if (!pointInPolygon(item, this._points)) {
        item.x = startX;
        item.y = startY;
      }
    }
    this._justDragged = moved;
    this._dragging = null;
    this._renderCanvas();
    if (kind === "zone") {
      this._renderZonesList();
    } else {
      this._renderLightsList();
    }
  }

  _renderCanvas() {
    const svg = this.shadowRoot.querySelector("#plan");
    if (!svg) return;

    // Rayons des poignees (points de mur/zones/lumieres) adaptes a l'echelle
    // REELLE de rendu du plan, pas seulement a la largeur de la fenetre --
    // le viewBox reste fixe (${VIEWBOX_W}x${VIEWBOX_H}) mais le plan peut
    // s'afficher bien plus compresse sur un telephone qu'en desktop. Sans
    // ca, un rayon de 7-10 unites devient quelques pixels a peine des que
    // le plan est compresse a moins de la moitie de sa largeur de
    // conception, rendant les poignees quasi impossibles a toucher.
    const svgRect = svg.getBoundingClientRect();
    const renderScale = svgRect.width > 0 ? svgRect.width / VIEWBOX_W : 1;
    const wallPointR = Math.max(7, 9 / renderScale);
    const zoneCenterR = Math.max(8, 10 / renderScale);
    const lightMarkerR = Math.max(10, 12 / renderScale);

    const placementModeCard = this.shadowRoot.querySelector("#placement-mode-card");
    const lightsCard = this.shadowRoot.querySelector("#lights-card");
    const zonesCard = this.shadowRoot.querySelector("#zones-card");
    const sceneCard = this.shadowRoot.querySelector("#scene-card");
    const drawHint = this.shadowRoot.querySelector("#draw-hint");
    if (placementModeCard) placementModeCard.style.display = this._closed ? "block" : "none";
    if (lightsCard) lightsCard.style.display = this._closed && this._placementMode === "light" ? "block" : "none";
    if (zonesCard) zonesCard.style.display = this._closed && this._placementMode === "zone" ? "block" : "none";
    if (sceneCard) sceneCard.style.display = this._closed && this._lights.length ? "block" : "none";
    if (drawHint) {
      drawHint.textContent = this._closed
        ? "Contour terminé. Glisse un point, une lumière ou une zone pour la repositionner ; « Recommencer le contour » pour tout retracer."
        : "Clique dans le plan pour placer les coins du contour (accroché à la grille). Clique près du premier point pour refermer.";
    }

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

    // Zones : cercle de portee (pointille, semi-transparent) + centre plein
    // dans la teinte de la zone -- rendu AVANT les lumieres pour qu'elles
    // restent visibles par-dessus.
    const zoneMarkers = this._zones
      .map((z, i) => {
        const css = hsvToCss(z.hue, z.saturation, 220);
        return `
          <g class="zone-marker" data-zone-index="${i}">
            <circle cx="${z.x}" cy="${z.y}" r="${z.influence_radius}" fill="${css}" fill-opacity="0.08"
                    stroke="${css}" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="6,4" style="pointer-events:none;" />
            <circle class="zone-center" data-zone-index="${i}" cx="${z.x}" cy="${z.y}" r="${zoneCenterR}" fill="${css}"
                    stroke="white" stroke-width="1.5" style="cursor:grab;" />
            <text x="${z.x}" y="${z.y - 14}" font-size="11" text-anchor="middle" fill="white" style="pointer-events:none;">${escapeHtml(z.name)}</text>
          </g>`;
      })
      .join("");

    // En mode apercu (une proposition vient d'etre generee), les marqueurs
    // affichent la couleur SUGGEREE plutot que la couleur par role -- pur
    // affichage, rien n'est envoye a aucune lumiere par ce rendu.
    const suggestionByEntity = {};
    if (this._previewMode && this._suggestions) {
      this._suggestions.forEach((s) => {
        suggestionByEntity[s.entity_id] = s;
      });
    }

    const lightMarkers = this._lights
      .map((l, i) => {
        let color = l.mount_type === "ceiling" ? "#f4a935" : l.mount_type === "wall" ? "#4caf50" : "#e91e63";
        const sug = suggestionByEntity[l.entity_id];
        if (sug) {
          color = sug.color_temp_kelvin != null ? kelvinToCss(sug.color_temp_kelvin) : hsvToCss(sug.hue, sug.saturation, sug.brightness);
        }
        return `
          <g class="light-marker" data-light-index="${i}" style="cursor:grab;">
            <circle cx="${l.x}" cy="${l.y}" r="${lightMarkerR}" fill="${color}" stroke="white" stroke-width="1.5" opacity="0.95" />
            ${!sug ? `<text x="${l.x}" y="${l.y + 3}" font-size="9" text-anchor="middle" fill="white" style="pointer-events:none;">${MOUNT_TYPE_ICONS[l.mount_type] || ""}</text>` : ""}
          </g>`;
      })
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
      ${zoneMarkers}
      ${lightMarkers}
    `;

    svg.querySelectorAll(".wall-point").forEach((el) => {
      el.addEventListener("pointerdown", (ev) =>
        this._onMarkerPointerDown(ev, "point", parseInt(el.getAttribute("data-point-index"), 10))
      );
    });
    svg.querySelectorAll(".light-marker").forEach((el) => {
      el.addEventListener("pointerdown", (ev) =>
        this._onMarkerPointerDown(ev, "light", parseInt(el.getAttribute("data-light-index"), 10))
      );
    });
    svg.querySelectorAll(".zone-center").forEach((el) => {
      el.addEventListener("pointerdown", (ev) =>
        this._onMarkerPointerDown(ev, "zone", parseInt(el.getAttribute("data-zone-index"), 10))
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
        return `
          <div class="light-item" data-index="${i}" style="flex-wrap:wrap;">
            <span>${MOUNT_TYPE_ICONS[l.mount_type] || ""}</span>
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
      });
    });
    list.querySelectorAll(".light-direction").forEach((el) => {
      el.addEventListener("change", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        this._lights[idx].direction = ev.target.value;
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
          <div class="light-item" data-index="${i}">
            <span style="width:14px;height:14px;border-radius:50%;background:${swatch};flex:0 0 14px;"></span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(z.name)}</span>
            <span style="color:var(--secondary-text-color);">portée ${Math.round(z.influence_radius)}</span>
            <span class="del-btn" data-del-zone-index="${i}">✕</span>
          </div>`;
      })
      .join("");
    list.querySelectorAll("[data-del-zone-index]").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.getAttribute("data-del-zone-index"), 10);
        this._zones.splice(idx, 1);
        this._renderCanvas();
        this._renderZonesList();
      });
    });
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

  async _generateScene() {
    if (this._sceneGenMode === "image" && this._sceneImagePoints.length < 1) {
      alert("Place au moins un point de couleur sur l'image avant de générer.");
      return;
    }

    const payload = {
      type: "alex_light_studio/compute_scene",
      lights: this._lights.map(lightPayload),
      zones: this._zones.map(zonePayload),
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

  // Entity_id predit a partir du zone_id (meme convention que light.py cote
  // integration -- voir AlexLightStudioZoneLight) : pas de recherche par nom,
  // le panel connait deja le zone_id via get_light_zones/save_light_zone.
  _lightzoneEntityIdFor(zoneId) {
    return `light.alex_light_studio_zone_${zoneId.replace(/-/g, "")}`;
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
        const st = this._hass.states[this._lightzoneEntityIdFor(z.id)];
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
        const entityId = this._lightzoneEntityIdFor(z.id);
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
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            detail: { entityId: this._lightzoneEntityIdFor(zoneId) },
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
