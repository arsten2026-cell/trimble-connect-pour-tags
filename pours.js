// Pure pour logic for the Pour tags extension: read the 'Pour/Такт' property set, group pour objects by
// pour number, sum quantities, merge embed lists and build label text. No Workspace API calls here, so
// the same file runs in the browser (window.PourLogic) and in Node tests (module.exports).
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.PourLogic = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PSET = "Pour/Такт";
  // Property names exactly as the Arsten_PourExport macro writes them (MultiplanBulgaria.xml).
  const P = {
    number: "Pour_Number/Номер_Такт",
    type: "Pour_Type/Тип_Такт",
    phase: "Pour_Phase/Такт",
    material: "Material/Материал",
    volume: "Concrete_Volume/Обем_Бетон",
    rebar: "Rebar_Weight/Тегло_Армировка",
    fwSides: "Formwork_Sides/Кофраж_Страни",
    fwBottom: "Formwork_Bottom/Кофраж_Дъно",
    embeds: "Embedded_Parts/Закладни_Части",
    date: "Pour_Data_Date/Дата_Данни",
  };

  const norm = (s) => String(s == null ? "" : s).normalize("NFC").trim().toLowerCase();

  /** Find the pour property set in a Connect ObjectProperties record (or a fixture's psets map).
   *  Returns a plain {propertyName: value} map, or null when the object has no pour data. */
  function readPourPset(obj) {
    if (!obj) return null;
    if (Array.isArray(obj.properties)) {
      const want = norm(PSET);
      const set = obj.properties.find((s) => norm(s && s.name) === want) ||
        obj.properties.find((s) => s && Array.isArray(s.properties) &&
          s.properties.some((p) => norm(p && p.name) === norm(P.number)));
      if (!set) return null;
      const out = {};
      for (const p of set.properties || []) if (p && p.name != null) out[String(p.name).normalize("NFC")] = p.value;
      return out;
    }
    if (obj.psets) {
      const key = Object.keys(obj.psets).find((k) => norm(k) === norm(PSET));
      return key ? obj.psets[key] : null;
    }
    return null;
  }

  /** Numbers may arrive as numbers or display strings ("9,9 m³", "1 234.5"). */
  function num(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return isFinite(v) ? v : 0;
    const m = String(v).replace(/\s/g, "").replace(",", ".").match(/-?\d+(\.\d+)?([eE][-+]?\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }

  const str = (v) => (v == null ? "" : String(v).trim());

  /** "TAKT 5" -> "TAKT 5"; "takt  05" -> "TAKT 5"; "TAKT" -> null (no number: known data issue). */
  function pourKey(raw) {
    const s = str(raw).replace(/\s+/g, " ");
    if (!s) return { key: null, label: "(empty)" };
    if (!/\d/.test(s)) return { key: null, label: s };
    const m = s.match(/^(.*?)(\d+)\s*$/);
    if (m) return { key: (m[1].trim().toUpperCase() + " " + String(parseInt(m[2], 10))).trim(), label: s };
    return { key: s.toUpperCase(), label: s };
  }

  /** Parse "EB1 x4, AG2" -> [{code:'EB1', count:4}, {code:'AG2', count:1}]. */
  function parseEmbeds(text) {
    const out = [];
    for (const part of str(text).split(/[,;\n]+/)) {
      const t = part.trim();
      if (!t) continue;
      const m = t.match(/^(.*?)\s*[x×*]\s*(\d+)\s*$/i);
      if (m && m[1]) out.push({ code: m[1].trim(), count: parseInt(m[2], 10) });
      else out.push({ code: t, count: 1 });
    }
    return out;
  }

  /** Merge embed lists, summing counts per code, keeping first-seen order. */
  function mergeEmbeds(lists) {
    const map = new Map();
    for (const list of lists) for (const e of list) map.set(e.code, (map.get(e.code) || 0) + e.count);
    return [...map].map(([code, count]) => ({ code, count }));
  }
  const formatEmbeds = (list) => list.map((e) => (e.count > 1 ? `${e.code} x${e.count}` : e.code)).join(", ");

  /** Natural sort: TAKT 2 before TAKT 10. */
  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  function bboxVolume(b) {
    if (!b) return 0;
    return Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
  }

  /**
   * Group pour objects.
   * @param items [{modelId, id, props: {..pour pset..}, bbox?: {min:{x,y,z}, max:{x,y,z}}}]
   * @returns {pours: Group[], unnumbered: Group[]}  Group = {key, label, objects, totals, embeds, ...}
   */
  function groupPours(items) {
    const groups = new Map();
    const loose = new Map();
    for (const it of items) {
      const pr = it.props || {};
      const { key, label } = pourKey(pr[P.number]);
      const bucket = key ? groups : loose;
      const k = key || label;
      if (!bucket.has(k)) {
        bucket.set(k, {
          key: k, label: key ? k : label, numbered: !!key, objects: [],
          totals: { volume: 0, rebar: 0, fwSides: 0, fwBottom: 0 },
          _embeds: [], types: new Set(), materials: new Set(), phases: new Set(), date: "",
        });
      }
      const g = bucket.get(k);
      g.objects.push(it);
      g.totals.volume += num(pr[P.volume]);
      g.totals.rebar += num(pr[P.rebar]);
      g.totals.fwSides += num(pr[P.fwSides]);
      g.totals.fwBottom += num(pr[P.fwBottom]);
      g._embeds.push(parseEmbeds(pr[P.embeds]));
      if (str(pr[P.type])) g.types.add(str(pr[P.type]));
      if (str(pr[P.material])) g.materials.add(str(pr[P.material]));
      if (str(pr[P.phase])) g.phases.add(str(pr[P.phase]));
      if (str(pr[P.date]) > g.date) g.date = str(pr[P.date]);
    }
    const finish = (g) => {
      g.embeds = mergeEmbeds(g._embeds);
      delete g._embeds;
      g.types = [...g.types]; g.materials = [...g.materials]; g.phases = [...g.phases];
      g.anchorObject = pickAnchorObject(g.objects);
      return g;
    };
    const byKey = (a, b) => naturalCompare(a.key, b.key);
    return {
      pours: [...groups.values()].map(finish).sort(byKey),
      unnumbered: [...loose.values()].map(finish).sort(byKey),
    };
  }

  /** Largest object of a group: by concrete volume, then by bounding-box volume. */
  function pickAnchorObject(objects) {
    let best = null, bestV = -1, bestB = -1;
    for (const o of objects) {
      const v = num((o.props || {})[P.volume]);
      const b = bboxVolume(o.bbox);
      if (v > bestV + 1e-9 || (Math.abs(v - bestV) <= 1e-9 && b > bestB)) { best = o; bestV = v; bestB = b; }
    }
    return best;
  }

  /** Top centre of a bounding box. */
  function topCentre(b) {
    return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.max.z };
  }

  const FIELDS = [
    { id: "number", label: "Pour number", def: true },
    { id: "volume", label: "Concrete volume (m³)", def: true },
    { id: "embeds", label: "Embedded parts", def: true },
    { id: "rebar", label: "Rebar weight (kg)", def: false },
    { id: "formwork", label: "Formwork area (m²)", def: false },
    { id: "type", label: "Pour type", def: false },
    { id: "material", label: "Concrete grade", def: false },
  ];

  const fmt = (v, d) => {
    const r = Number(v.toFixed(d));
    return String(r);
  };
  /** Volume to 1 decimal, but keep 2 for small pours so 0.04 m³ doesn't print as 0. */
  const fmtVolume = (v) => (v > 0 && v < 1 ? fmt(v, 2) : fmt(v, 1));

  /** Label text such as "TAKT 5, 9.9 m³, Embeds EB01". */
  function labelText(g, fields) {
    const on = new Set(fields || FIELDS.filter((f) => f.def).map((f) => f.id));
    const parts = [];
    if (on.has("number")) parts.push(g.label);
    if (on.has("type") && g.types.length) parts.push(g.types.map((t) => t.split("/")[0]).join("+"));
    if (on.has("material") && g.materials.length) parts.push(g.materials.join("+"));
    if (on.has("volume")) parts.push(`${fmtVolume(g.totals.volume)} m³`);
    if (on.has("rebar") && g.totals.rebar > 0) parts.push(`${fmt(g.totals.rebar, 0)} kg`);
    if (on.has("formwork")) {
      const fw = g.totals.fwSides + g.totals.fwBottom;
      if (fw > 0) parts.push(`FW ${fmt(fw, 1)} m²`);
    }
    if (on.has("embeds") && g.embeds.length) parts.push(`Embeds ${formatEmbeds(g.embeds)}`);
    return parts.join(", ");
  }

  /** Distinct, readable colours for pour numbers (cycled). */
  const PALETTE = [
    "#E6194B", "#3CB44B", "#4363D8", "#F58231", "#911EB4", "#42D4F4", "#F032E6", "#BFEF45",
    "#469990", "#DCBEFF", "#9A6324", "#800000", "#AAFFC3", "#808000", "#000075", "#FFD8B1",
  ];
  const colourFor = (index) => PALETTE[index % PALETTE.length];
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: a == null ? 255 : a };
  }

  return {
    PSET, P, FIELDS, PALETTE, readPourPset, num, pourKey, parseEmbeds, mergeEmbeds, formatEmbeds,
    naturalCompare, groupPours, pickAnchorObject, topCentre, labelText, fmtVolume, colourFor, hexToRgba,
  };
});
