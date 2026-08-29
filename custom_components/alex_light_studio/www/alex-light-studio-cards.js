/**
 * Alex Light Studio — cartes Lovelace custom.
 * Extraites du bundle alex-cards (alex-gradient-card, alex-gradient-scene-card)
 * pour vivre aux cotes de l'integration Alex Light Studio (fusion d'Alex Scene
 * Studio et Alex Gradient Studio). Fichier standalone, aucune dependance a
 * alex-cards : le socle commun necessaire (escapeHtml, colorOr, AlexFormEditor)
 * est duplique ici plutot que partage -- integration et bundle de cartes sont
 * deux unites de distribution HACS distinctes qui ne doivent pas dependre
 * l'une de l'autre, meme principe deja applique entre alex-cards et les
 * panels dedies des differents projets Alex.
 *
 * Aucune dependance, aucun build : JS natif + <ha-form>/<ha-selector>
 * (fournis par Home Assistant).
 */

const ALEX_LIGHT_STUDIO_CARDS_VERSION = "1.0.0";

console.info(
  `%c ALEX-LIGHT-STUDIO-CARDS %c v${ALEX_LIGHT_STUDIO_CARDS_VERSION} `,
  "color:white;background:#5b6b7a;font-weight:700;border-radius:4px 0 0 4px;padding:2px 6px;",
  "color:#5b6b7a;background:#e8ebee;border-radius:0 4px 4px 0;padding:2px 6px;"
);

window.customCards = window.customCards || [];

// Charge le composant natif utilise par Home Assistant pour les panneaux
// repliables (utilise par AlexFormEditor pour les groupes "customisation").
if (!customElements.get("ha-expansion-panel")) {
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/frontend_latest/ha-expansion-panel.js";
  document.head.appendChild(script);
}

/* =========================================================================
 * === Socle commun (duplique depuis alex-cards, voir note en tete) ========
 * ========================================================================= */

// Échappe le texte injecté en innerHTML (noms/entités saisis par l'utilisateur).
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// [r,g,b] ou [r,g,b,a] -> "rgba(r, g, b, a)" (a vaut 1 si absent).
function rgbaCss(rgb) {
  const [r, g, b, a] = rgb;
  const alpha = a == null ? 1 : a;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Résout une couleur optionnelle ([r,g,b]/[r,g,b,a] du picker, chaîne CSS, ou
// vide) vers une valeur CSS, avec repli sur une variable de thème.
function colorOr(v, fallback) {
  if (Array.isArray(v)) return rgbaCss(v);
  if (typeof v === "string" && v.trim()) return v;
  return fallback;
}

/*
 * Base pour les éditeurs "formulaire" : construit un <ha-form> natif pour
 * les champs simples, et une ligne compacte dédiée (libellé + pastille +
 * opacité) pour chaque champ color_rgb -- HA n'a pas de sélecteur natif
 * couleur+alpha. La sous-classe fournit this._schema / this._labels.
 */
class AlexFormEditor extends HTMLElement {
  setConfig(config) {
    const incoming = JSON.stringify(config || {});
    if (incoming === this._configStr) return;
    this._config = JSON.parse(incoming);
    this._configStr = incoming;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    (this._forms || []).forEach((f) => (f.hass = hass));
    (this._selectors || []).forEach((s) => (s.hass = hass));
  }

  _emit(patch) {
    const cfg = { ...this._config, ...patch };
    this._config = cfg;
    this._configStr = JSON.stringify(cfg);
    this.dispatchEvent(
      new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true })
    );
  }

  _form(schema, data, labels, onChange) {
    const f = document.createElement("ha-form");
    f.schema = schema;
    f.data = data || {};
    f.computeLabel = (s) => (labels && labels[s.name]) || s.name;
    if (this._hass) f.hass = this._hass;
    f.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      onChange(ev.detail.value);
    });
    this._forms.push(f);
    return f;
  }

  // Ligne compacte : libellé à gauche, color-picker à droite — même gabarit
  // partout, quel que soit le champ (fond de carte, icône, texte, bouton…).
  _colorRow(label, value, onChange) {
    const rgb = Array.isArray(value) ? [value[0], value[1], value[2]] : undefined;
    const alphaPct = Array.isArray(value) && value[3] != null ? Math.round(value[3] * 100) : 100;

    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:40px;padding:6px 0;";
    const lab = document.createElement("div");
    lab.textContent = label;
    lab.style.cssText =
      "flex:1;min-width:0;font-size:14px;color:var(--primary-text-color);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

    const colorSel = document.createElement("ha-selector");
    colorSel.selector = { color_rgb: {} };
    colorSel.value = rgb;
    if (this._hass) colorSel.hass = this._hass;
    colorSel.style.cssText = "flex:0 0 auto;";

    // Opacite en % : HA n'a pas de selecteur couleur+alpha natif, donc on
    // combine le picker RGB avec un champ numerique dedie, recombines en
    // [r, g, b, a] (a entre 0 et 1) a chaque changement.
    const alphaSel = document.createElement("ha-selector");
    alphaSel.selector = { number: { min: 0, max: 100, step: 1, mode: "box", unit_of_measurement: "%" } };
    alphaSel.value = alphaPct;
    if (this._hass) alphaSel.hass = this._hass;
    alphaSel.style.cssText = "flex:0 0 64px;";

    const emit = () => {
      const cur = Array.isArray(colorSel.value) ? colorSel.value : null;
      if (!cur) {
        onChange(undefined);
        return;
      }
      const a = alphaSel.value != null ? alphaSel.value / 100 : 1;
      onChange([cur[0], cur[1], cur[2], a]);
    };

    colorSel.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      colorSel.value = ev.detail.value;
      emit();
    });
    alphaSel.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      alphaSel.value = ev.detail.value;
      emit();
    });

    this._selectors.push(colorSel, alphaSel);
    row.append(lab, colorSel, alphaSel);
    return row;
  }

  _panel(title, iconName, contentEl, expanded) {
    const panel = document.createElement("ha-expansion-panel");
    panel.outlined = true;
    panel.expanded = !!expanded;
    panel.style.cssText =
      "display:block;margin:12px 0 8px;--expansion-panel-summary-padding:0 12px;--expansion-panel-content-padding:0 12px 12px;";
    const header = document.createElement("div");
    header.setAttribute("slot", "header");
    header.style.cssText =
      "display:flex;align-items:center;gap:8px;height:32px;font-size:14px;font-weight:500;color:var(--primary-text-color);";
    if (iconName) {
      const ic = document.createElement("ha-icon");
      ic.icon = iconName;
      ic.style.cssText = "--mdc-icon-size:20px;color:var(--secondary-text-color);flex:0 0 auto;";
      header.appendChild(ic);
    }
    const t = document.createElement("span");
    t.textContent = title;
    header.appendChild(t);
    panel.appendChild(header);
    panel.appendChild(contentEl);
    return panel;
  }

  // Parcourt un schéma (champs + groupes "expandable") et route chaque champ
  // color_rgb vers une ligne compacte, tout le reste vers un <ha-form> natif
  // groupé.
  _mixed(schema, data, labels, onChange) {
    const frag = document.createDocumentFragment();
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      frag.appendChild(this._form(batch, data, labels, onChange));
      batch = [];
    };
    (schema || []).forEach((field) => {
      if (field.type === "expandable") {
        flush();
        const content = this._mixed(field.schema, data, labels, onChange);
        frag.appendChild(this._panel(field.title, field.icon, content));
        return;
      }
      if (field.selector && field.selector.color_rgb) {
        flush();
        frag.appendChild(
          this._colorRow(labels[field.name] || field.name, data[field.name], (val) => onChange({ [field.name]: val }))
        );
        return;
      }
      batch.push(field);
    });
    flush();
    return frag;
  }

  _render() {
    this._forms = [];
    this._selectors = [];
    this.innerHTML = "";
    this.appendChild(this._mixed(this._schema, this._config, this._labels, (v) => this._emit(v)));
    if (this._hass) {
      this._forms.forEach((f) => (f.hass = this._hass));
      this._selectors.forEach((s) => (s.hass = this._hass));
    }
  }
}

/* =========================================================================
 * === alex-gradient-card ==================================================
 * Pilotage des degrades par segment des lampes/bandeaux "Gradient" Philips
 * Hue via Zigbee2MQTT. Z2M expose `gradient` en ECRITURE SEULE (confirme
 * dans sa doc officielle : "It's not possible to read (/get) this value.")
 * — pas de service natif HA pour ca, donc appel direct a mqtt.publish sur
 * le topic zigbee2mqtt/<nom_convivial>/set avec {"gradient": [...]}.
 * Consequence assumee : les pickers ne refletent jamais l'etat reel du
 * bandeau au chargement (impossible techniquement), ils partent neutres.
 * Autonome : aucune dependance a l'integration Alex Light Studio.
 * ========================================================================= */

function hexToRgbObj(hex) {
  const h = (hex || "#ffffff").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

class GradientCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("alex-gradient-card-editor");
  }
  static getStubConfig() {
    return {
      entity: "",
      device_type: "hue",
      segments: 5,
      name: "Bandeau",
      icon: "mdi:led-strip-variant",
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Configuration invalide");
    this._config = config;
    this._built = false;
    this._lastSig = null;
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 2;
  }

  // Nom convivial Z2M utilise dans le topic MQTT : par priorite, le champ
  // explicite, puis l'attribut friendly_name de l'entite (HA le copie tel
  // quel depuis la decouverte MQTT Z2M, casse d'origine comprise), et en
  // dernier repli le dernier segment de l'entity_id -- qui, lui, est
  // "slugifie" par HA (tout en minuscules) et peut donc diverger du vrai
  // nom Z2M des que celui-ci contient de la casse mixte (ex. "Chambre_BLed"
  // -> entity_id "chambre_bled", qui ne correspond plus au topic MQTT reel).
  _friendlyName() {
    const c = this._config;
    if (c.friendly_name) return c.friendly_name;
    const st = c.entity && this._hass && this._hass.states[c.entity];
    const attrName = st && st.attributes && st.attributes.friendly_name;
    if (attrName) return attrName;
    return c.entity ? c.entity.split(".")[1] || "" : "";
  }

  // Entite number.*_length deduite du nom de l'entite lumiere elle-meme
  // (convention confirmee : light.chambre_bled -> number.chambre_bled_length,
  // meme "object_id" avec juste le domaine et le suffixe qui changent).
  // N'est qu'un point de depart : `length_entity` explicite prend toujours
  // le pas si l'utilisateur l'a renseignee (ex. entite renommee cote HA).
  _defaultLengthEntity() {
    const c = this._config;
    if (!c.entity) return null;
    const objectId = c.entity.split(".")[1];
    return objectId ? `number.${objectId}_length` : null;
  }

  // Nombre de segments effectif. Pour l'Aqara T1, deduit automatiquement de
  // l'entite longueur (number.*_length — deduite par convention du nom de
  // l'entite lumiere, ou fournie explicitement via `length_entity` si le
  // nommage ne correspond pas) : 5 segments de 20cm par metre de bandeau.
  // Z2M expose cette propriete comme une entite SEPAREE de la lumiere,
  // jamais comme simple attribut de l'entite light. Pour Hue (ou si aucune
  // entite longueur n'est resolvable/lisible), repli sur `segments` regle
  // manuellement.
  _effectiveSegments() {
    const c = this._config;
    if (c.device_type === "aqara" && this._hass) {
      const lengthEntityId = c.length_entity || this._defaultLengthEntity();
      const st = lengthEntityId ? this._hass.states[lengthEntityId] : null;
      if (st && st.state != null && !Number.isNaN(Number(st.state))) {
        const n = Math.round(Number(st.state) * 5);
        if (n > 0) return Math.min(50, n);
      }
    }
    return Math.max(2, Math.min(50, c.segments || 5));
  }

  // Reechantillonne un tableau plat de couleurs (points d'edition,
  // egalement espaces) vers exactement `targetCount` couleurs par
  // interpolation lineaire -- meme principe qu'un degrade CSS rendu a une
  // resolution donnee. Permet d'editer moins de points que le nombre reel
  // de segments physiques et de laisser la carte interpoler le reste.
  _resamplePoints(points, targetCount) {
    if (targetCount <= 0) return [];
    if (!points.length) return new Array(targetCount).fill("#ffffff");
    if (points.length === 1) return new Array(targetCount).fill(points[0]);

    const hexToRgb = (h) => [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ];
    const rgbToHex = (r, g, b) =>
      "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

    const out = [];
    for (let i = 0; i < targetCount; i++) {
      const pos = targetCount > 1 ? i / (targetCount - 1) : 0;
      const srcPos = pos * (points.length - 1);
      const lo = Math.floor(srcPos);
      const hi = Math.min(points.length - 1, lo + 1);
      const t = srcPos - lo;
      const [r1, g1, b1] = hexToRgb(points[lo]);
      const [r2, g2, b2] = hexToRgb(points[hi]);
      out.push(rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t));
    }
    return out;
  }

  _render() {
    if (!this._config || !this._hass) return;
    const c = this._config;
    const hass = this._hass;
    const entity = c.entity;
    const stateObj = entity ? hass.states[entity] : null;
    const isOn = !!stateObj && stateObj.state === "on";
    const segmentsCount = this._effectiveSegments();
    const friendlyName = this._friendlyName();

    // Points d'edition (jamais lus depuis Z2M, voir note en tete de
    // fichier) : par defaut, autant de points que de segments reels
    // (comportement identique a avant), mais ajustable via +Point/-Point
    // independamment de segmentsCount -- reechantillonne vers le nombre
    // reel de segments seulement au moment d'appliquer (_resamplePoints).
    if (this._pointCount == null) {
      this._pointCount = segmentsCount;
    }
    this._pointCount = Math.max(2, Math.min(segmentsCount, this._pointCount));
    if (!this._points || this._points.length !== this._pointCount) {
      const prev = this._points || [];
      this._points = Array.from({ length: this._pointCount }, (_, i) => prev[i] || "#ffffff");
    }

    const sig = [
      c.name,
      c.icon,
      c.device_type,
      c.length_entity,
      JSON.stringify(c.icon_color || null),
      JSON.stringify(c.background || null),
      JSON.stringify(c.primary_color || null),
      JSON.stringify(c.secondary_color || null),
      JSON.stringify(c.accent_color || null),
      segmentsCount,
      this._pointCount,
      isOn,
      entity,
      friendlyName,
    ].join("~");
    if (this._built && sig === this._lastSig) return;
    this._lastSig = sig;

    const cardBg = colorOr(c.background, "var(--ha-card-background, var(--card-background-color))");
    const primaryColor = colorOr(c.primary_color, "var(--primary-text-color)");
    const secondaryColor = colorOr(c.secondary_color, "var(--secondary-text-color)");
    const accentColor = colorOr(c.accent_color, "#8b7ae6");
    const iconColor = colorOr(c.icon_color, accentColor);
    const badgeRgb = Array.isArray(c.icon_color) ? c.icon_color : [139, 122, 230];
    const badgeBg = `rgba(${badgeRgb[0]}, ${badgeRgb[1]}, ${badgeRgb[2]}, 0.16)`;

    // Repartition equilibree sur plusieurs lignes (plutot qu'un flex-wrap
    // qui remplit une ligne au maximum et laisse un reliquat difforme sur
    // la suivante, ex. 11 puis 1 pour 12 points) : calcule le nombre de
    // lignes necessaires selon un maximum par ligne, puis redistribue le
    // total de facon egale entre ces lignes. Base sur le nombre de POINTS
    // d'edition, pas le nombre reel de segments -- peuvent diverger si
    // l'utilisateur a reduit via -Point.
    const maxPerRow = 6;
    const rowsNeeded = Math.max(1, Math.ceil(this._pointCount / maxPerRow));
    const perRow = Math.ceil(this._pointCount / rowsNeeded);
    const segmentRows = [];
    for (let r = 0; r < rowsNeeded; r++) {
      const start = r * perRow;
      const end = Math.min(start + perRow, this._pointCount);
      if (start >= end) break;
      const rowItems = this._points
        .slice(start, end)
        .map((color, localIdx) => {
          const i = start + localIdx;
          return `
            <input type="color" class="ac-gradient-seg" data-index="${i}" value="${color}"
              style="flex:1;min-width:0;height:44px;border:none;border-radius:10px;padding:0;
                     cursor:pointer;background:${color};-webkit-appearance:none;appearance:none;" />`;
        })
        .join("");
      segmentRows.push(`<div style="display:flex;gap:6px;">${rowItems}</div>`);
    }
    const segmentsHtml = `<div style="display:flex;flex-direction:column;gap:6px;">${segmentRows.join("")}</div>`;

    // Boutons +Point/-Point : nombre de points d'edition independant du
    // nombre reel de segments (borne entre 2 et segmentsCount) -- meme
    // principe que Alex Gradient Studio, integre directement dans la carte.
    const pointControlsHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">
        <div style="font-size:12px;color:${secondaryColor};">
          ${this._pointCount} point${this._pointCount > 1 ? "s" : ""} sur ${segmentsCount} segment${segmentsCount > 1 ? "s" : ""}
        </div>
        <div style="display:flex;gap:6px;">
          <button class="ac-gradient-point-remove" style="border:1px solid ${secondaryColor};background:transparent;
                      color:${secondaryColor};border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;"
                      ${this._pointCount <= 2 ? "disabled" : ""}>− Point</button>
          <button class="ac-gradient-point-add" style="border:1px solid ${secondaryColor};background:transparent;
                      color:${secondaryColor};border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;"
                      ${this._pointCount >= segmentsCount ? "disabled" : ""}>+ Point</button>
        </div>
      </div>`;

    const missingConfig = !entity || !friendlyName;

    this.innerHTML = `
      <ha-card style="border-radius:20px;box-shadow:none;background:${cardBg};padding:16px 18px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
          <div style="width:40px;height:40px;border-radius:12px;background:${badgeBg};
                      display:flex;align-items:center;justify-content:center;flex:0 0 auto;">
            <ha-icon icon="${c.icon || "mdi:led-strip-variant"}" style="--mdc-icon-size:20px;color:${iconColor};"></ha-icon>
          </div>
          <div style="flex:1;min-width:0;font-size:17px;font-weight:700;color:${primaryColor};
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.name || "")}</div>
          ${
            entity
              ? `<div class="ac-gradient-toggle" style="flex:0 0 auto;width:44px;height:24px;border-radius:12px;
                      background:${isOn ? accentColor : "rgba(var(--rgb-primary-text-color,0,0,0),0.18)"};
                      position:relative;cursor:pointer;transition:background .15s;">
                  <div style="width:18px;height:18px;border-radius:50%;background:#fff;position:absolute;
                              top:3px;left:${isOn ? "23px" : "3px"};transition:left .15s;
                              box-shadow:0 1px 3px rgba(0,0,0,.3);"></div>
                </div>`
              : ""
          }
        </div>

        ${
          missingConfig
            ? `<div style="font-size:13px;color:${secondaryColor};padding:8px 0;">
                Configure l'entité de la lumière (et le nom convivial Z2M si besoin) dans les réglages de la carte.
              </div>`
            : `<div style="margin-bottom:14px;">
                ${segmentsHtml}
                ${pointControlsHtml}
              </div>
              <div class="ac-gradient-apply" style="text-align:center;padding:10px;border-radius:12px;
                          background:${accentColor};color:#000;font-size:14px;font-weight:600;cursor:pointer;">
                Appliquer le dégradé
              </div>`
        }
      </ha-card>`;

    this.querySelectorAll(".ac-gradient-seg").forEach((el) => {
      el.addEventListener("input", (ev) => {
        const idx = parseInt(el.getAttribute("data-index"), 10);
        this._points[idx] = ev.target.value;
        el.style.background = ev.target.value;
      });
    });

    const addPointEl = this.querySelector(".ac-gradient-point-add");
    if (addPointEl) {
      addPointEl.addEventListener("click", () => {
        if (this._pointCount >= segmentsCount) return;
        this._pointCount += 1;
        this._lastSig = null; // force le rebuild complet, ce n'est pas un changement venant de hass
        this._render();
      });
    }

    const removePointEl = this.querySelector(".ac-gradient-point-remove");
    if (removePointEl) {
      removePointEl.addEventListener("click", () => {
        if (this._pointCount <= 2) return;
        this._pointCount -= 1;
        this._lastSig = null;
        this._render();
      });
    }

    const toggleEl = this.querySelector(".ac-gradient-toggle");
    if (toggleEl && entity) {
      toggleEl.addEventListener("click", () => {
        hass.callService("homeassistant", "toggle", { entity_id: entity });
      });
    }

    const applyEl = this.querySelector(".ac-gradient-apply");
    if (applyEl) {
      applyEl.addEventListener("click", () => {
        if (!friendlyName) return;
        // Reechantillonne les points d'edition (potentiellement moins
        // nombreux que segmentsCount) vers le nombre reel de segments --
        // seulement a l'application, jamais pendant l'edition elle-meme.
        const colors = this._resamplePoints(this._points, segmentsCount);
        const payload =
          c.device_type === "aqara"
            ? {
                segment_colors: colors.map((hex, i) => ({
                  segment: i + 1,
                  color: hexToRgbObj(hex),
                })),
              }
            : { gradient: colors };
        hass.callService("mqtt", "publish", {
          topic: `zigbee2mqtt/${friendlyName}/set`,
          payload: JSON.stringify(payload),
        });
      });
    }

    this._built = true;
  }
}
customElements.define("alex-gradient-card", GradientCard);

class GradientCardEditor extends AlexFormEditor {
  static getStubConfig() {
    return GradientCard.getStubConfig();
  }

  constructor() {
    super();
    this._schema = [
      { name: "entity", selector: { entity: { domain: "light" } } },
      {
        name: "device_type",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "hue", label: "Philips Hue Gradient" },
              { value: "aqara", label: "Aqara LED Strip T1 (LGYCDD01LM)" },
            ],
          },
        },
      },
      { name: "friendly_name", selector: { text: {} } },
      {
        name: "segments",
        selector: { number: { min: 2, max: 50, step: 1, mode: "box" } },
      },
      { name: "name", selector: { text: {} } },
      { name: "icon", selector: { icon: {} } },
      {
        name: "customisation",
        type: "expandable",
        flatten: true,
        title: "Customisation",
        icon: "mdi:palette",
        schema: [
          { name: "icon_color", selector: { color_rgb: {} } },
          { name: "background", selector: { color_rgb: {} } },
          { name: "primary_color", selector: { color_rgb: {} } },
          { name: "secondary_color", selector: { color_rgb: {} } },
          { name: "accent_color", selector: { color_rgb: {} } },
        ],
      },
    ];
    this._labels = {
      entity: "Entité de la lumière",
      device_type: "Type d'appareil",
      friendly_name: "Nom convivial Z2M (vide = déduit de l'entité)",
      segments: "Nombre de segments (Aqara : ignoré si longueur détectée)",
      name: "Nom",
      icon: "Icône",
      icon_color: "Couleur du badge",
      background: "Fond de la carte",
      primary_color: "Couleur du nom",
      secondary_color: "Couleur secondaire",
      accent_color: "Couleur du bouton / interrupteur actif",
    };
  }
}
customElements.define("alex-gradient-card-editor", GradientCardEditor);

window.customCards.push({
  type: "alex-gradient-card",
  name: "Alex Gradient Card",
  description: "Réglage des segments de couleur des lampes Gradient Philips Hue via Zigbee2MQTT.",
  preview: false,
  documentationURL: "https://github.com/<user>/alex-cards",
});


/* =========================================================================
 * === alex-gradient-scene-card ============================================
 * Liste et applique les scenes de degrade enregistrees via l'integration
 * Alex Light Studio (custom_components/alex_light_studio, vue Gradient) sur
 * une lumiere precise. Delibrement simple : toute la logique de detection
 * de segments/interpolation/format de payload (Hue vs Aqara) vit deja cote
 * service Python `load_scene` -- la carte se contente de lister les scenes
 * (via l'attribut de sensor.alex_light_studio_gradient_scenes) et d'appeler
 * ce service au clic.
 * ========================================================================= */

class GradientSceneCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("alex-gradient-scene-card-editor");
  }
  static getStubConfig() {
    return { entity: "", device_type: "hue", name: "Scènes", icon: "mdi:palette-swatch" };
  }

  setConfig(config) {
    if (!config) throw new Error("Configuration invalide");
    this._config = config;
    this._built = false;
    this._lastSig = null;
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    const names = Object.keys(this._scenes());
    return 1 + Math.max(1, names.length);
  }

  _scenes() {
    if (!this._hass) return {};
    const st = this._hass.states["sensor.alex_light_studio_gradient_scenes"];
    return (st && st.attributes && st.attributes.scenes) || {};
  }

  _render() {
    if (!this._config || !this._hass) return;
    const c = this._config;
    const scenes = this._scenes();
    const names = Object.keys(scenes);

    const sig = [
      c.name,
      c.icon,
      c.entity,
      c.device_type,
      c.friendly_name,
      JSON.stringify(c.icon_color || null),
      JSON.stringify(c.background || null),
      JSON.stringify(c.primary_color || null),
      JSON.stringify(c.secondary_color || null),
      JSON.stringify(scenes),
    ].join("~");
    if (this._built && sig === this._lastSig) return;
    this._lastSig = sig;

    const cardBg = colorOr(c.background, "var(--ha-card-background, var(--card-background-color))");
    const primaryColor = colorOr(c.primary_color, "var(--primary-text-color)");
    const secondaryColor = colorOr(c.secondary_color, "var(--secondary-text-color)");
    const iconColor = colorOr(c.icon_color, "#8b7ae6");
    const badgeRgb = Array.isArray(c.icon_color) ? c.icon_color : [139, 122, 230];
    const badgeBg = `rgba(${badgeRgb[0]}, ${badgeRgb[1]}, ${badgeRgb[2]}, 0.16)`;
    const missingConfig = !c.entity;

    const rowsHtml = names
      .map((name, i) => {
        const stops = (scenes[name] && scenes[name].stops) || [];
        const gradientCss = stops.length
          ? stops
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((s) => `${s.color} ${Math.round(s.position * 100)}%`)
              .join(", ")
          : "#ffffff, #ffffff";
        const border = i < names.length - 1 ? "border-bottom:1px solid var(--divider-color);" : "";
        return `
          <div class="ac-gscene-row" data-name="${escapeHtml(name)}"
              style="display:flex;align-items:center;gap:12px;padding:10px 2px;cursor:pointer;${border}">
            <div style="width:52px;height:24px;border-radius:8px;flex:0 0 auto;
                        background:linear-gradient(90deg, ${gradientCss});"></div>
            <div style="flex:1;min-width:0;font-size:14px;font-weight:600;color:${secondaryColor};
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</div>
          </div>`;
      })
      .join("");

    this.innerHTML = `
      <ha-card style="border-radius:20px;box-shadow:none;background:${cardBg};padding:16px 18px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:${names.length ? "6px" : "0"};">
          <div style="width:40px;height:40px;border-radius:12px;background:${badgeBg};
                      display:flex;align-items:center;justify-content:center;flex:0 0 auto;">
            <ha-icon icon="${c.icon || "mdi:palette-swatch"}" style="--mdc-icon-size:20px;color:${iconColor};"></ha-icon>
          </div>
          <div style="flex:1;min-width:0;font-size:17px;font-weight:700;color:${primaryColor};
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.name || "")}</div>
        </div>
        ${
          missingConfig
            ? `<div style="font-size:13px;color:${secondaryColor};padding:8px 0;">
                Configure l'entité de la lumière dans les réglages de la carte.
              </div>`
            : names.length === 0
            ? `<div style="font-size:13px;color:${secondaryColor};padding:8px 0;">
                Aucune scène enregistrée pour l'instant (Alex Gradient Studio).
              </div>`
            : `<div>${rowsHtml}</div>`
        }
      </ha-card>`;

    this.querySelectorAll(".ac-gscene-row").forEach((el) => {
      el.addEventListener("click", () => {
        const name = el.getAttribute("data-name");
        const data = { entity_id: c.entity, name, device_type: c.device_type || "hue" };
        if (c.friendly_name) data.friendly_name = c.friendly_name;
        this._hass.callService("alex_light_studio", "load_scene", data);
      });
    });

    this._built = true;
  }
}
customElements.define("alex-gradient-scene-card", GradientSceneCard);

class GradientSceneCardEditor extends AlexFormEditor {
  static getStubConfig() {
    return GradientSceneCard.getStubConfig();
  }

  constructor() {
    super();
    this._schema = [
      { name: "entity", selector: { entity: { domain: "light" } } },
      {
        name: "device_type",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "hue", label: "Philips Hue Gradient" },
              { value: "aqara", label: "Aqara LED Strip T1" },
            ],
          },
        },
      },
      { name: "friendly_name", selector: { text: {} } },
      { name: "name", selector: { text: {} } },
      { name: "icon", selector: { icon: {} } },
      {
        name: "customisation",
        type: "expandable",
        flatten: true,
        title: "Customisation",
        icon: "mdi:palette",
        schema: [
          { name: "icon_color", selector: { color_rgb: {} } },
          { name: "background", selector: { color_rgb: {} } },
          { name: "primary_color", selector: { color_rgb: {} } },
          { name: "secondary_color", selector: { color_rgb: {} } },
        ],
      },
    ];
    this._labels = {
      entity: "Entité de la lumière",
      device_type: "Type d'appareil",
      friendly_name: "Nom convivial Z2M (vide = déduit de l'entité)",
      name: "Nom",
      icon: "Icône",
      icon_color: "Couleur du badge",
      background: "Fond de la carte",
      primary_color: "Couleur du nom",
      secondary_color: "Couleur des scènes",
    };
  }
}
customElements.define("alex-gradient-scene-card-editor", GradientSceneCardEditor);

window.customCards.push({
  type: "alex-gradient-scene-card",
  name: "Alex Gradient Scene Card",
  description: "Liste et applique les scènes de dégradé enregistrées via Alex Gradient Studio.",
  preview: false,
  documentationURL: "https://github.com/<user>/alex-cards",
});
