// Pour tags: Trimble Connect 3D-viewer extension. Lists concrete pours (такт) from the Tekla
// 'Pour/Такт' property set and tags each pour number in the model with a red leader label.
(() => {
  "use strict";
  const L = window.PourLogic;
  const $ = (id) => document.getElementById(id);
  const TAG_COLOUR = { r: 200, g: 16, b: 46, a: 255 };
  const PROXY = "IfcBuildingElementProxy";
  const BATCH = 200;
  // Bounding boxes come back in metres, markup picks are in millimetres.
  const BBOX_TO_MM = 1000;

  const state = {
    api: null,
    pours: [],         // grouped pours (numbered)
    unnumbered: [],    // groups whose number has no digit
    tags: new Map(),   // pour key -> markup id
    coloured: false,
    selKeys: null,           // Show selected: pour keys of the model selection (null = off)
    focusKey: null, focusTagAdded: false,
    inspectKey: null,        // pour whose pieces are listed
    isolated: false,
  };

  // ---------- settings (per viewer, kept in localStorage) ----------
  const SETTINGS_KEY = "arsten.pourTags.v2";   // v2: split formwork, language, layout
  const settings = (() => {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch {}
    const known = new Set(L.FIELDS.map((f) => f.id));
    return {
      fields: (s.fields || L.FIELDS.filter((f) => f.def).map((f) => f.id)).filter((id) => known.has(id)),
      lift: s.lift || 3,
      side: s.side != null ? s.side : 3,
      lang: s.lang === "en" ? "en" : "bg",
      layout: s.layout === "single" ? "single" : "lines",
    };
  })();
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

  // ---------- interface language (A10): shared with every tool (shared/arsten-i18n.js); BG by default ----------
  // Not the label language: settings.lang is what the tags in the model say.
  const I18N = window.ArstenI18n;
  let ui = I18N ? I18N.getLang() : "bg";
  const L2 = (b, e) => (ui === "bg" ? b : e);
  const pl = (n, one, many, en1, enN) => (ui === "bg" ? (I18N ? I18N.plural(n, one, many) : many) : n === 1 ? en1 : enN);
  /** The static texts of index.html: data-en / data-en-title hold the English, the Bulgarian is kept on first use. */
  function applyStatic() {
    document.documentElement.lang = ui;
    if ($("selUi")) $("selUi").value = ui;
    document.querySelectorAll("[data-en]").forEach((el) => { if (el.dataset.bg == null) el.dataset.bg = el.textContent; el.textContent = ui === "en" ? el.dataset.en : el.dataset.bg; });
    document.querySelectorAll("[data-en-title]").forEach((el) => { if (el.dataset.bgTitle == null) el.dataset.bgTitle = el.title; el.title = ui === "en" ? el.dataset.enTitle : el.dataset.bgTitle; });
  }
  /** A field name of pours.js ("Pour number · Такт") in the interface language. */
  const fieldName = (f) => { const [en, bg] = String(f.label).split(" · "); return ui === "en" || !bg ? en : bg.charAt(0).toUpperCase() + bg.slice(1); };
  /** The model-check warnings of pours.js (English) in the interface language. */
  function warnText(w) {
    if (ui === "en") return w;
    return String(w)
      .replace(/^(\d+) versions of (.+) are loaded: counting the latest only\.$/, "Заредени са $1 версии на $2: брои се само последната.")
      .replace(/^(\d+) pour objects appear twice in (.+): counted once\.$/, "$1 обекта от тактове са два пъти в $2: броят се веднъж.")
      .replace(/^(\d+) pour objects are in both (.+) and (.+) \(same IFC GUID\): counted once, from (.+)\.$/, "$1 обекта от тактове са и в $2, и в $3 (същият IFC GUID): броят се веднъж, от $4.");
  }
  // text may be a function: then it is built again in the new language after a language switch (round 19 L4)
  let statusAgain = null;
  const relabelStatus = () => { if (statusAgain) setStatus(statusAgain.text, statusAgain.bad); if (window.ArstenDiag && ArstenDiag.relabel) ArstenDiag.relabel(); };
  function setStatus(text, bad) {
    statusAgain = typeof text === "function" ? { text, bad } : null;
    if (typeof text === "function") text = text();
    $("status").textContent = text;
    $("status").className = "status" + (bad ? " bad" : "");
  }
  const errText = (e) => (e && (e.message || e.toString())) || String(e);

  // ---------- reading the model ----------
  async function loadPours() {
    const api = state.api;
    setStatus(L2("Четене на тактовете от заредените модели…", "Reading pours from the loaded models…"));
    let modelObjs = await api.viewer.getObjects({ parameter: { class: PROXY } });
    const proxyCount = (modelObjs || []).reduce((n, m) => n + (m.objects || []).length, 0);
    if (!proxyCount) modelObjs = await api.viewer.getObjects();   // class filter found nothing: scan everything
    const items = [];
    const psetNames = new Map();
    let scanned = 0;
    for (const m of modelObjs || []) {
      const ids = (m.objects || []).map((o) => o.id);
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const props = await api.viewer.getObjectProperties(m.modelId, chunk);
        scanned += chunk.length;
        const found = [];
        for (const p of props || []) {
          for (const s of p.properties || []) psetNames.set(s.name, (psetNames.get(s.name) || 0) + 1);
          const pset = L.readPourPset(p);
          if (pset) found.push({ modelId: m.modelId, id: p.id, name: p.product && p.product.name, props: pset });
        }
        if (found.length) {
          let boxes = [];
          try { boxes = await api.viewer.getObjectBoundingBoxes(m.modelId, found.map((f) => f.id)); } catch {}
          const byId = new Map((boxes || []).map((b) => [b.id, b.boundingBox]));
          for (const f of found) f.bbox = byId.get(f.id) || null;
          // IFC GUIDs, to count a pour object once when it is in two loaded models
          try {
            const guids = await api.viewer.convertToObjectIds(m.modelId, found.map((f) => f.id));
            found.forEach((f, k) => { f.guid = (guids && guids[k]) || null; });
          } catch {}
          items.push(...found);
        }
        setStatus(L2(`Четене на тактовете… проверени ${scanned} обекта, намерени ${items.length} обекта от тактове`, `Reading pours… ${scanned} objects checked, ${items.length} pour objects found`));
      }
    }
    // Several models: pour numbers are project-wide, so they merge; never count a pour object twice.
    const models = await loadedModels(modelObjs);
    const names = new Map(models.map((m) => [m.modelId, m.name]));
    for (const it of items) it.modelName = names.get(it.modelId) || it.modelId;
    const dd = L.dedupePourObjects(items, models);
    const counted = dd.items;
    const { pours, unnumbered } = L.groupPours(counted);
    pours.forEach((g, i) => { g.colour = L.colourFor(i); });
    state.pours = pours;
    state.unnumbered = unnumbered;
    render();
    if (!items.length) {
      const seen = [...psetNames].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} (${c})`).join(", ");
      setStatus(() => L2(`Няма обекти от тактове: проверени ${scanned} обекта (${proxyCount} ${PROXY}), нито един с набор свойства ${L.PSET}. ` +
        `Заредете Tekla IFC, експортиран с Arsten_PourExport.` + (seen ? ` Видени набори свойства: ${seen}` : ""),
        `No pour objects found: ${scanned} objects checked (${proxyCount} ${PROXY}), none with property set ${L.PSET}. ` +
        `Load a Tekla IFC exported with Arsten_PourExport.` + (seen ? ` Property sets seen: ${seen}` : "")), true);
      console.warn("[pour-tags] property sets seen", Object.fromEntries(psetNames));
    } else {
      const loose = unnumbered.reduce((n, g) => n + g.objects.length, 0);
      const nModels = new Set(counted.map((it) => it.modelId)).size;
      setStatus(() => `${pours.length} ${pl(pours.length, "такт", "такта", "pour", "pours")}, ${counted.length} ${pl(counted.length, "обект", "обекта", "pour object", "pour objects")}` + (nModels > 1 ? L2(` от ${nModels} модела`, ` from ${nModels} models`) : "") +
        (loose ? L2(` · ${loose} без номер на такт`, ` · ${loose} without a pour number`) : "") + (dd.warnings.length ? " · ⚠ " + dd.warnings.map(warnText).join(" ") : ""), dd.warnings.length > 0);
    }
    for (const b of ["btnShowAll", "btnClear", "btnReload"]) $(b).disabled = false;
  }

  // Loaded models with file id / version, in load order, for the de-duplication rules.
  async function loadedModels(modelObjs) {
    let specs = [];
    try { specs = (await state.api.viewer.getModels("loaded")) || []; } catch {}
    const byId = new Map(specs.map((m) => [m.id, m]));
    return (modelObjs || []).map((mo, order) => {
      const m = byId.get(mo.modelId) || specs.find((x) => x.versionId === mo.modelId) || {};
      return { modelId: mo.modelId, fileId: m.id || mo.modelId, name: m.name || mo.modelId,
        versionId: m.versionId, isLatest: m.isLatestVersion, order };
    });
  }

  // ---------- selectors ----------
  function selectorFor(objects) {
    const byModel = new Map();
    for (const o of objects) {
      if (!byModel.has(o.modelId)) byModel.set(o.modelId, []);
      byModel.get(o.modelId).push(o.id);
    }
    return { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
  }
  const allPourObjects = () => state.pours.concat(state.unnumbered).flatMap((g) => g.objects);

  // ---------- tags (text markups with a leader) ----------
  // Arrow tip on the pour object nearest the pour's centre; text raised by the leader height and pushed
  // sideways away from the middle of the site so it clears the building.
  function markupFor(g, index) {
    const pl = L.tagPlacement(g, L.siteCentre(state.pours));
    if (!pl) return null;
    const k = BBOX_TO_MM;
    const p = { x: pl.tip.x * k, y: pl.tip.y * k, z: pl.tip.z * k };
    // Stagger heights a little so labels of neighbouring pours overlap less.
    const lift = settings.lift * 1000 * (1 + 0.3 * (index % 3));
    const side = settings.side * 1000;
    return {
      text: L.labelText(g, settings.fields, settings),
      // Same colour as the pour when colouring is on, otherwise the standard tag red.
      color: (state.coloured || state.focusKey === g.key) && g.colour ? L.hexToRgba(g.colour) : TAG_COLOUR,
      start: { positionX: p.x, positionY: p.y, positionZ: p.z, modelId: pl.object.modelId, objectId: pl.object.id },
      end: { positionX: p.x + pl.away.x * side, positionY: p.y + pl.away.y * side, positionZ: p.z + lift },
    };
  }

  async function addTags(groups) {
    const list = [];
    for (const g of groups) {
      const idx = state.pours.indexOf(g);
      const m = markupFor(g, idx < 0 ? 0 : idx);
      if (!m) continue;
      const old = state.tags.get(g.key);
      if (old != null) m.id = old;   // replace in place
      list.push({ g, m });
    }
    if (!list.length) return 0;
    const res = await state.api.markup.addTextMarkup(list.map((x) => x.m));
    (res || []).forEach((r, i) => { if (r && r.id != null && list[i]) state.tags.set(list[i].g.key, r.id); });
    return list.length;
  }

  async function removeTags(keys) {
    const ids = keys.map((k) => state.tags.get(k)).filter((id) => id != null);
    if (ids.length) await state.api.markup.removeMarkups(ids);
    keys.forEach((k) => state.tags.delete(k));
  }

  async function showAll() {
    const n = await addTags(state.pours);
    const missing = state.pours.length - n;
    setStatus(L2(`Показани етикети: ${n}`, `${n} tags shown`) + (missing ? ` · ${missing} ${pl(missing, "такт няма", "такта нямат", "pour has", "pours have")} ${L2("геометрия за етикета", "no geometry to anchor to")}` : ""));
    render();
  }
  async function clearAll() {
    await removeTags([...state.tags.keys()]);
    setStatus(L2("Етикетите са изчистени", "Tags cleared"));
    render();
  }
  async function refreshTags() {
    if (state.tags.size) await addTags(state.pours.filter((g) => state.tags.has(g.key)));
  }

  // ---------- colours / isolate / zoom ----------
  async function applyColours() {
    const api = state.api;
    const all = allPourObjects();
    if (!all.length) return;
    if (!state.coloured) {
      await api.viewer.setObjectState(selectorFor(all), { color: "reset" });
      return;
    }
    // one call per colour, not per pour (speed audit item 4); unnumbered grey last, as before
    const entries = state.pours.map((g) => ({ objects: g.objects, colour: g.colour }));
    if (state.unnumbered.length) entries.push({ objects: state.unnumbered.flatMap((g) => g.objects), colour: "#9E9E9E" });
    for (const b of L.colourBatches(entries)) await api.viewer.setObjectState(selectorFor(b.objects), { color: b.colour });
  }
  // "Show pours only": viewer.isolateEntities (as in Cast unit tags and the MCP bridge). Hiding everything with an
  // undefined selector and then showing the pours left the pours hidden too.
  async function applyIsolate() {
    const api = state.api;
    if (state.isolated) {
      const byModel = new Map();
      for (const o of allPourObjects()) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.id); }
      if (byModel.size) await api.viewer.isolateEntities([...byModel].map(([modelId, entityIds]) => ({ modelId, entityIds })));
    } else {
      await api.viewer.setObjectState(undefined, { visible: "reset" });
      const all = await everyObject();
      if (all.length) await api.viewer.setObjectState(selectorFor(all), { visible: true });
    }
  }
  // Select: select the pour's objects (properties panel shows them) and zoom to them.
  async function selectPour(g) {
    const sel = selectorFor(g.objects);
    await state.api.viewer.setSelection(sel, "set");
    await state.api.viewer.setCamera(sel, { animationTime: 600 });
  }

  // Focus: zoom to the pour; only that pour keeps a colour (its pour colour), everything else grey at 50%.
  // Opacity is 0..1 in Connect (verified live). Focus again, or "Clear focus", restores colours and opacity.
  const FOCUS_OPACITY = 0.5;
  const FOCUS_GREY = "#9E9E9E";
  // Every object in the loaded models as {modelId, id}. Connect ignores opacity with an undefined
  // ("all objects") selector, so focus works on explicit object lists.
  async function everyObject() {
    const out = [];
    for (const m of (await state.api.viewer.getObjects()) || []) for (const o of m.objects || []) out.push({ modelId: m.modelId, id: o.id });
    return out;
  }
  const objKey = (o) => o.modelId + ":" + o.id;
  // Only `objects` keep a colour and full opacity; everything else grey at 50%.
  async function applyFocus(objects, colour) {
    const api = state.api;
    const mine = new Set(objects.map(objKey));
    const others = (await everyObject()).filter((o) => !mine.has(objKey(o)));
    if (others.length) await api.viewer.setObjectState(selectorFor(others), { color: FOCUS_GREY, opacity: FOCUS_OPACITY });
    await api.viewer.setObjectState(selectorFor(objects), { color: colour, opacity: 1 });
    await api.viewer.setCamera(selectorFor(objects), { animationTime: 600 });
  }
  // Focus also tags the pour; remember if we added the tag, so moving/clearing focus removes only that tag.
  async function focusTagFor(g) {
    if (state.focusKey === g.key) return;
    await dropFocusTag();   // the tag Focus added for the previous pour
    state.focusKey = g.key;
    state.focusTagAdded = !state.tags.has(g.key);
    await addTags([g]);   // (re)draws it in the pour colour
  }
  async function focusPour(g) {
    if (state.focusKey === g.key) return clearFocus();
    await focusTagFor(g);
    render();
    await applyFocus(g.objects, g.colour);
  }
  async function dropFocusTag() {
    const key = state.focusKey;
    if (key == null) return;
    if (state.focusTagAdded) await removeTags([key]);
    else { const g = state.pours.find((p) => p.key === key); if (g) { state.focusKey = null; await addTags([g]); } }  // back to normal colour
    state.focusTagAdded = false;
  }
  async function clearFocus() {
    if (state.focusKey == null) return;
    await dropFocusTag();
    state.focusKey = null;
    render();
    const all = await everyObject();
    if (all.length) await state.api.viewer.setObjectState(selectorFor(all), { color: "reset", opacity: 1 });
    if (state.coloured) await applyColours();   // put the per-pour colours back
  }

  // ---------- rendering ----------
  // Pieces of a pour, in a stable order: by pour type, then biggest first.
  function piecesOf(g) {
    if (!g._pieces) {
      g._pieces = [...g.objects].sort((a, b) =>
        String((a.props || {})[L.P.type] || "").localeCompare(String((b.props || {})[L.P.type] || "")) ||
        L.num((b.props || {})[L.P.volume]) - L.num((a.props || {})[L.P.volume]));
    }
    return g._pieces;
  }
  // Inspect: the whole-pour embed list only (rebar per pour is not reliable yet; the piece list was removed earlier).
  function inspectRow(g) {
    const pcs = piecesOf(g);
    const withEmb = pcs.filter((o) => String((o.props || {})[L.P.embeds] || "").trim()).length;
    const emb = g.embeds.length
      ? `<table class="rebars"><tr><th>${L2("Марка", "Mark")}</th><th class="num">${L2("Бр.", "Qty")}</th></tr>` +
        g.embeds.map((e) => `<tr><td>${esc(e.code)}</td><td class="num">${f0(e.count)}</td></tr>`).join("") +
        `</table><div class="sub">${L2(`${withEmb} от ${pcs.length} части съдържат закладни части.`, `${withEmb} of ${pcs.length} pieces contain embeds.`)}</div>`
      : `<div class="sub">${L2("Няма закладни части.", "No embedded parts.")}</div>`;
    return `<tr class="insp"><td colspan="3">
        <div class="insphead">${esc(g.label)} · ${pcs.length} ${L2(pcs.length === 1 ? "част" : "части", pcs.length === 1 ? "piece" : "pieces")}</div>
        <div class="pourlists"><div class="lh">${L2("Закладни части · целият такт", "Embeds · whole pour")}</div>${emb}</div></td></tr>`;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // numbers in the interface language: BG "3 292" / "37,9", EN "3,292" / "37.9" (round 15 L8)
  const fNum = (v, d) => (I18N && I18N.fmtNum ? I18N.fmtNum(v, ui, d) : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(ui === "en" ? "en-US" : "bg-BG"));
  const f1 = (v) => fNum(v, 1);
  const f0 = (v) => fNum(v, 0);

  function render() {
    const rows = $("rows");
    if (!state.pours.length) {
      rows.innerHTML = `<tr><td colspan="3" class="empty">${L2("В заредените модели няма номерирани тактове.", "No numbered pours in the loaded models.")}</td></tr>`;
      $("foot").innerHTML = "";
    } else {
      const shown = (g) => !state.selKeys || state.selKeys.has(g.key);
      const visible = state.pours.filter(shown);
      rows.innerHTML = !visible.length
        ? `<tr><td colspan="3" class="empty">${L2("Нито един от избраните обекти не е в номериран такт.", "None of the selected objects is in a numbered pour.")}</td></tr>`
        : state.pours.map((g, i) => {
        if (!shown(g)) return "";
        const tagged = state.tags.has(g.key);
        const types = g.types.map((t) => t.split("/")[0]).join(", ");
        const emb = g.embeds.length ? `<div class="emb">${L2("Закладни", "Embeds")} ${esc(L.formatEmbeds(g.embeds))}</div>` : "";
        return `<tr>
          <td>${state.coloured ? `<span class="sw" style="background:${g.colour}"></span>` : ""}<span class="name">${esc(g.label)}</span><button
              class="small inspect ${state.inspectKey === g.key ? "on" : "secondary"}" data-act="inspect" data-i="${i}" title="${L2("Закладните части на такта", "Embedded parts of this pour")}">${L2("Виж", "Inspect")} ${state.inspectKey === g.key ? "▴" : "▾"}</button>
            <div class="sub">${g.objects.length} ${L2("об.", "obj")} · ${esc(types || "–")}${g.materials.length ? " · " + esc(g.materials.join(", ")) : ""}</div>${emb}
            ${g.models.length > 1 ? `<div class="sub">${g.models.length} ${L2("модела", "models")}: ${esc(g.models.join(", "))}</div>` : ""}
            <div class="acts"><button class="small ${tagged ? "on" : "secondary"}" data-act="tag" data-i="${i}" title="${tagged ? L2("Махни етикета", "Remove tag") : L2("Етикет на такта", "Tag this pour")}">${L2("Етикет", "Tag")}</button><button
              class="small secondary" data-act="select" data-i="${i}" title="${L2("Избери обектите на такта и приближи", "Select this pour's objects and zoom to them")}">${L2("Избери", "Select")}</button><button
              class="small ${state.focusKey === g.key ? "on" : "secondary"}" data-act="focus" data-i="${i}" title="${state.focusKey === g.key ? L2("Без фокус", "Clear focus") : L2("Приближи и направи всичко друго прозрачно", "Zoom and make everything else transparent")}">${L2("Фокус", "Focus")}</button></div></td>
          <td class="num">${L.fmtVolume(g.totals.volume, ui)}</td>
          <td class="num">${f0(g.totals.rebar)}</td></tr>` + (state.inspectKey === g.key ? inspectRow(g) : "");
      }).join("");
      const t = visible.reduce((a, g) => ({ v: a.v + g.totals.volume, r: a.r + g.totals.rebar }), { v: 0, r: 0 });
      $("foot").innerHTML = `<tr><td>${state.selKeys ? L2(`Избрани (${visible.length} от ${state.pours.length})`, `Selected (${visible.length} of ${state.pours.length})`) : L2(`Общо (${state.pours.length})`, `Total (${state.pours.length})`)}</td><td class="num">${f1(t.v)}</td><td class="num">${f0(t.r)}</td></tr>`;
    }
    const unnumbered = state.pours.filter((g) => g.embeds.some((e) => L.isUnnumbered(e.code))).map((g) => g.label);
    $("embWarn").hidden = !unnumbered.length;
    $("embWarn").textContent = unnumbered.length
      ? L2(`Марките на закладните части са „(?)“ в ${unnumbered.join(", ")}: номерирането в Tekla не е било обновено при експорта.`, `Embed marks show "(?)" in ${unnumbered.join(", ")}: numbering was not up to date in Tekla when this was exported.`)
      : "";
    const loose = state.selKeys ? state.unnumbered.filter((g) => state.selKeys.has(g.key)) : state.unnumbered;
    $("looseBox").hidden = !loose.length;
    $("looseRows").innerHTML = loose.map((g, i) => `<tr>
        <td><span class="name">"${esc(g.label)}"</span><div class="sub">${g.objects.length} ${L2("об.", "obj")} · ${esc(g.types.map((t) => t.split("/")[0]).join(", ") || "–")}</div>
          <div class="acts"><button class="small secondary" data-act="selectLoose" data-i="${state.unnumbered.indexOf(g)}" title="${L2("Избери тези обекти и приближи", "Select these objects and zoom to them")}">${L2("Избери", "Select")}</button></div></td>
        <td class="num">${L.fmtVolume(g.totals.volume, ui)} m³</td></tr>`).join("");
    $("btnClearFocus").hidden = state.focusKey == null;
    $("btnShowSel").className = "small " + (state.selKeys ? "on" : "secondary");
    $("btnShowAllRows").hidden = !state.selKeys;
  }

  // "Show selected": list only the pours of what is selected in the model. A pour object maps directly; anything
  // else (e.g. a rebar) is traced through its PourUnit (ElementAssembly parent) to the pour object beside it.
  async function showSelected() {
    const api = state.api;
    const sel = (await api.viewer.getSelection()) || [];
    const index = new Map();
    for (const g of [...state.pours, ...state.unnumbered]) for (const o of g.objects) index.set(objKey(o), g.key);
    const keys = new Set();
    const unmatched = [];
    let n = 0;
    for (const m of sel) for (const id of m.objectRuntimeIds || []) {
      n++;
      const k = index.get(m.modelId + ":" + id);
      if (k) keys.add(k); else unmatched.push({ modelId: m.modelId, id });
    }
    if (!n) return setStatus(L2("Нищо не е избрано в модела. Изберете тактове и натиснете „Покажи избраните“.", "Nothing is selected in the model. Select pours first, then click Show selected."), true);
    for (const o of unmatched.slice(0, 60)) {
      try {
        const unit = ((await api.viewer.getHierarchyParents(o.modelId, [o.id], 4)) || [])[0];
        if (!unit) continue;
        for (const c of (await api.viewer.getHierarchyChildren(o.modelId, [unit.id], 4)) || []) {
          const k = index.get(o.modelId + ":" + c.id);
          if (k) { keys.add(k); break; }
        }
      } catch {}
    }
    if (!keys.size) return setStatus(L2(`Нито един от избраните ${n} ${pl(n, "обект", "обекта")} не е в такт.`, `None of the ${n} selected objects belongs to a pour.`), true);
    state.selKeys = keys;
    setStatus(L2(`Показани са ${keys.size} ${pl(keys.size, "такт", "такта")} от избора (${n} ${pl(n, "обект", "обекта")}).`, `Showing the ${keys.size} pour${keys.size > 1 ? "s" : ""} of the selection (${n} objects).`));
    render();
  }

  function renderFieldOptions() {
    $("fields").innerHTML = L.FIELDS.map((f) =>
      `<label class="chk"><input type="checkbox" data-field="${f.id}" ${settings.fields.includes(f.id) ? "checked" : ""}> ${esc(fieldName(f))}</label>`).join("");
    $("numLift").value = settings.lift;
    $("numSide").value = settings.side;
    $("selLang").value = settings.lang;
    $("selLayout").value = settings.layout;
  }

  // ---------- wiring ----------
  async function guarded(fn) {
    try { await fn(); } catch (e) { setStatus(I18N ? I18N.err(errText(e), ui) : "Error: " + errText(e), true); console.error(e); }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const i = +b.dataset.i;
    guarded(async () => {
      if (b.dataset.act === "tag") {
        const g = state.pours[i];
        if (state.tags.has(g.key)) await removeTags([g.key]);
        else if (!(await addTags([g]))) setStatus(`${g.label}: ${L2("няма геометрия за етикета", "no geometry to anchor the tag")}`, true);
        render();
      } else if (b.dataset.act === "inspect") {
        const g = state.pours[i];
        state.inspectKey = state.inspectKey === g.key ? null : g.key;
        render();
      } else if (b.dataset.act === "select") await selectPour(state.pours[i]);
      else if (b.dataset.act === "focus") await focusPour(state.pours[i]);
      else if (b.dataset.act === "selectLoose") await selectPour(state.unnumbered[i]);
    });
  });
  $("btnShowSel").onclick = () => guarded(showSelected);
  $("btnShowAllRows").onclick = () => { state.selKeys = null; setStatus(L2("Показани са всички тактове", "Showing all pours")); render(); };
  $("btnShowAll").onclick = () => guarded(showAll);
  $("btnClear").onclick = () => guarded(clearAll);
  $("btnClearFocus").onclick = () => guarded(clearFocus);
  $("btnReload").onclick = () => guarded(async () => {
    await clearFocus();
    await removeTags([...state.tags.keys()]);
    await loadPours();
    await applyColours();
  });
  $("chkColour").onchange = (e) => guarded(async () => {
    state.coloured = e.target.checked;
    if (state.focusKey == null) await applyColours();   // during focus, colours come back on Clear focus
    await refreshTags();   // recolour labels that are shown
    render();
  });
  $("chkIsolate").onchange = (e) => guarded(async () => { state.isolated = e.target.checked; await applyIsolate(); });
  $("fields").onchange = (e) => {
    const id = e.target.dataset.field;
    if (!id) return;
    settings.fields = L.FIELDS.map((f) => f.id).filter((fid) =>
      fid === id ? e.target.checked : settings.fields.includes(fid));
    saveSettings();
    guarded(refreshTags);
  };
  $("selLang").onchange = (e) => { settings.lang = e.target.value; saveSettings(); guarded(refreshTags); };
  $("selLayout").onchange = (e) => { settings.layout = e.target.value; saveSettings(); guarded(refreshTags); };
  $("numSide").onchange = (e) => {
    const v = parseFloat(e.target.value);
    if (v >= 0) { settings.side = v; saveSettings(); guarded(refreshTags); }
  };
  $("numLift").onchange = (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) { settings.lift = v; saveSettings(); guarded(refreshTags); }
  };
  $("selUi").onchange = (e) => { ui = I18N ? I18N.setLang(e.target.value) : e.target.value; applyStatic(); renderFieldOptions(); render(); relabelStatus(); };
  applyStatic();
  renderFieldOptions();

  // Re-read automatically when models are loaded or unloaded (debounced; the event fires in bursts).
  let reloadTimer = null;
  function onEvent(event, data) {
    if (tokenHelper) tokenHelper.onEvent(event, data);
    if (denied) return;
    // Connect's own "Reset model" restores opacity and colours: forget our focus/colour state.
    if (event === "viewer.onModelReset") {
      state.focusKey = null; state.focusTagAdded = false; state.coloured = false; $("chkColour").checked = false;
      render();
      return;
    }
    if (event === "viewer.onModelStateChanged" && state.api) {
      setStatus(L2("Моделите са променени, тактовете се четат отново…", "Models changed, reading pours again…"));
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => guarded(async () => {
        await removeTags([...state.tags.keys()]);
        await loadPours();
        if (state.coloured) await applyColours();
      }), 1500);
    }
  }

  // ---------- start ----------

  // ---------- access (shared/arsten-access.js): ADMIN or GENERAL CONTRACTOR group only ----------
  let tokenHelper = null, denied = false;
  async function gate(api) {
    if (window.ARSTEN_DEMO) return true;
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Pour tags (pour-tags)", lang: () => ui });   // round 19 M1: before the access check, so a denied screen's diagnostics name the panel
    tokenHelper = ArstenAccess.tokenGetter(api);
    setStatus(L2("Проверка на достъпа…", "Checking access…"));
    const access = await ArstenAccess.check({ api, getToken: tokenHelper.getToken, app: "execution" });
    if (access.allowed) return true;
    denied = true;
    ArstenAccess.renderDenied(document.body, ui, access);   // the interface language (A10; was the label language, round 11 L2)
    return false;
  }

  async function start(api) {
    if (I18N) { const l = await I18N.pickLang(api, null); if (l !== ui) { ui = l; applyStatic(); renderFieldOptions(); } }   // stored choice, else the Connect user's language
    if (!(await gate(api))) return;   // no data is read before access is confirmed
    state.api = api;
    // diagnostics: the interface language (not the tag language), and the signed-in user's name hidden (round 15 L3)
    if (window.ArstenDiag) Promise.resolve().then(async () => {
      let user = "";
      try { const u = await api.user.getUser(); user = (u && ([u.firstName, u.lastName].filter(Boolean).join(" ") || u.email)) || ""; } catch {}
      const p = await api.project.getProject();
      ArstenDiag.set({ panel: "Pour tags (pour-tags)", projectId: p && p.id, redact: [user], lang: () => ui });
    }).catch(() => {});   // A23
    await guarded(loadPours);
  }
  window.PourTagsApp = { start, state };   // used by demo.js

  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) {
      const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s);
    } else {
      setStatus(I18N ? I18N.word("notInside", ui) : "Not inside Trimble Connect.", true);
    }
    return;
  }
  if (I18N) setStatus(I18N.word("connecting", ui));
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus((I18N ? I18N.word("connectFail", ui) : "Could not connect to Trimble Connect") + ": " + errText(e), true));
})();
