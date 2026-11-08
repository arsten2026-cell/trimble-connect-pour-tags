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
    focusKey: null, focusPiece: null, focusTagAdded: false,
    inspectKey: null,        // pour whose pieces are listed
    openPieces: new Set(),   // pieces whose contents are expanded
    contents: new Map(),     // piece key -> PourUnit contents
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

  function setStatus(text, bad) {
    $("status").textContent = text;
    $("status").className = "status" + (bad ? " bad" : "");
  }
  const errText = (e) => (e && (e.message || e.toString())) || String(e);

  // ---------- reading the model ----------
  async function loadPours() {
    const api = state.api;
    setStatus("Reading pours from the loaded models…");
    state.contents.clear(); state.openPieces.clear();   // runtime ids change when models reload
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
        setStatus(`Reading pours… ${scanned} objects checked, ${items.length} pour objects found`);
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
      setStatus(`No pour objects found: ${scanned} objects checked (${proxyCount} ${PROXY}), none with property set ${L.PSET}. ` +
        `Load a Tekla IFC exported with Arsten_PourExport.` + (seen ? ` Property sets seen: ${seen}` : ""), true);
      console.warn("[pour-tags] property sets seen", Object.fromEntries(psetNames));
    } else {
      const loose = unnumbered.reduce((n, g) => n + g.objects.length, 0);
      const nModels = new Set(counted.map((it) => it.modelId)).size;
      setStatus(`${pours.length} pours, ${counted.length} pour objects` + (nModels > 1 ? ` from ${nModels} models` : "") +
        (loose ? ` · ${loose} without a pour number` : "") + (dd.warnings.length ? " · ⚠ " + dd.warnings.join(" ") : ""), dd.warnings.length > 0);
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
    setStatus(`${n} tags shown` + (missing ? ` · ${missing} pours have no geometry to anchor to` : ""));
    render();
  }
  async function clearAll() {
    await removeTags([...state.tags.keys()]);
    setStatus("Tags cleared");
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
    for (const g of state.pours) await api.viewer.setObjectState(selectorFor(g.objects), { color: g.colour });
    if (state.unnumbered.length) {
      await api.viewer.setObjectState(selectorFor(state.unnumbered.flatMap((g) => g.objects)), { color: "#9E9E9E" });
    }
  }
  async function applyIsolate() {
    const api = state.api;
    const all = allPourObjects();
    if (state.isolated) {
      await api.viewer.setObjectState(undefined, { visible: false });
      await api.viewer.setObjectState(selectorFor(all), { visible: true });
    } else {
      await api.viewer.setObjectState(undefined, { visible: "reset" });
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
    if (state.focusKey === g.key && !state.focusPiece) return clearFocus();
    await focusTagFor(g);
    state.focusPiece = null;
    render();
    await applyFocus(g.objects, g.colour);
  }
  // Inspect list: focus one piece of a pour (only that piece opaque). Again on the same piece = back to the pour.
  async function focusPiece(g, o) {
    if (state.focusPiece === objKey(o)) return backToPour(g);
    await focusTagFor(g);
    state.focusPiece = objKey(o);
    render();
    await applyFocus([o], g.colour);
  }
  async function backToPour(g) {
    await focusTagFor(g);
    state.focusPiece = null;
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
    state.focusPiece = null;
    render();
    const all = await everyObject();
    if (all.length) await state.api.viewer.setObjectState(selectorFor(all), { color: "reset", opacity: 1 });
    if (state.coloured) await applyColours();   // put the per-pour colours back
  }

  // ---------- inspect: the pieces of a pour and what each PourUnit holds ----------
  // Tekla exports each pour piece as an IfcBuildingElementProxy "PourObject" under an IfcElementAssembly
  // "PourUnit" that also holds its rebars (pset Rebar/Армировка) and embed / steel assemblies.
  const HIERARCHY_ASSEMBLY = 4;   // HierarchyType.ElementAssembly
  async function loadContents(o) {
    const k = objKey(o);
    if (state.contents.has(k)) return state.contents.get(k);
    const api = state.api;
    let result;
    try {
      const parents = (await api.viewer.getHierarchyParents(o.modelId, [o.id], HIERARCHY_ASSEMBLY)) || [];
      const unit = parents[0];
      if (!unit) throw new Error("no PourUnit parent");
      const kids = ((await api.viewer.getHierarchyChildren(o.modelId, [unit.id], HIERARCHY_ASSEMBLY)) || [])
        .filter((c) => c.id !== o.id);
      const props = kids.length ? (await api.viewer.getObjectProperties(o.modelId, kids.map((c) => c.id))) || [] : [];
      const byId = new Map(props.map((p) => [p.id, p]));
      const rebarRecs = [], others = [];
      for (const c of kids) {
        const p = byId.get(c.id);
        const rebar = p && L.readPset(p, "Rebar/Армировка");
        if (rebar) rebarRecs.push(rebar);
        else others.push({ id: c.id, name: (p && p.product && p.product.name) || c.name || "?", cls: p && p.class });
      }
      result = { unitId: unit.id, rebars: L.summariseRebars(rebarRecs), rebarIds: kids.filter((c) => byId.get(c.id) && L.readPset(byId.get(c.id), "Rebar/Армировка")).map((c) => c.id),
        others, all: kids.map((c) => c.id) };
    } catch (e) {
      result = { error: errText(e) };
    }
    state.contents.set(k, result);
    return result;
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
  // Row detail: the Tekla parts of the pour (optional Parts/Елементи), first few, full list on hover.
  function partsLine(parts) {
    const all = L.formatEmbeds(parts);
    const shown = parts.slice(0, 3);
    const more = parts.length - shown.length;
    return `<div class="sub" title="${esc(all)}">Parts: ${esc(L.formatEmbeds(shown))}${more > 0 ? ` +${more} more` : ""}</div>`;
  }
  function inspectRow(g, i) {
    const pcs = piecesOf(g);
    const items = pcs.map((o, j) => {
      const pr = o.props || {};
      const type = String(pr[L.P.type] || "–").split("/")[0];
      const fs = L.num(pr[L.P.fwSides]), fb = L.num(pr[L.P.fwBottom]), rb = L.num(pr[L.P.rebar]);
      const emb = String(pr[L.P.embeds] || "").trim();
      const parts = L.parseParts(pr[L.P.parts]);   // optional field; [] in older exports
      const k = objKey(o);
      const open = state.openPieces.has(k);
      const focused = state.focusPiece === k;
      const bits = [`${L.fmtVolume(L.num(pr[L.P.volume]))} m³`];
      if (fs || fb) bits.push(`кофр. ${f1(fs)} + ${f1(fb)} m²`);
      if (rb) bits.push(`${f0(rb)} kg`);
      return `<li class="${focused ? "focused" : ""}">
          ${parts.length
            ? `<div><span class="pno">${j + 1}</span> <b>${esc(L.formatEmbeds(parts))}</b></div><div class="sub pdet">${esc(type)} · ${bits.join(" · ")}</div>`
            : `<div><span class="pno">${j + 1}</span> <b>${esc(type)}</b> · ${bits.join(" · ")}</div>`}
          ${emb ? `<div class="sub">Embeds ${esc(emb)}</div>` : ""}
          ${g.models.length > 1 ? `<div class="sub">${esc(L.shortModelName(o.modelName || o.modelId))}</div>` : ""}
          <div class="acts"><button class="small secondary" data-act="pSelect" data-i="${i}" data-j="${j}">Select</button><button
            class="small secondary" data-act="pZoom" data-i="${i}" data-j="${j}">Zoom</button><button
            class="small ${focused ? "on" : "secondary"}" data-act="pFocus" data-i="${i}" data-j="${j}" title="Only this piece opaque">Focus</button><button
            class="small secondary" data-act="pOpen" data-i="${i}" data-j="${j}">Contents ${open ? "▴" : "▾"}</button></div>
          ${open ? contentsHtml(i, j, state.contents.get(k), rb) : ""}</li>`;
    }).join("");
    const pieceFocus = state.focusKey === g.key && state.focusPiece;
    return `<tr class="insp"><td colspan="3">
        <div class="insphead">${pcs.length} pieces of ${esc(g.label)}${pieceFocus ? ` <button class="small secondary" data-act="backToPour" data-i="${i}">Back to pour</button>` : ""}</div>
        ${pourLists(g, i)}
        <ol class="pieces">${items}</ol></td></tr>`;
  }
  // Whole-pour rebar and embed lists, shown above the pieces in Inspect.
  function pourLists(g, i) {
    const pcs = piecesOf(g);
    const cs = pcs.map((o) => state.contents.get(objKey(o)));
    const loaded = cs.filter(Boolean).length;
    let reb;
    if (loaded < pcs.length) {
      reb = `<div class="sub">Reading rebar… ${loaded}/${pcs.length} pieces</div>`;
    } else {
      const failed = cs.filter((c) => c.error).length;
      const list = L.pourRebarList(cs.filter((c) => !c.error).map((c) => c.rebars));
      const pourKg = g.totals.rebar;
      if (!list.rows.length) {
        reb = `<div class="sub">No rebar found in this pour's PourUnits${pourKg > 0 ? ` (pour data: ${f0(pourKg)} kg)` : ""}.</div>`;
      } else {
        const mism = L.rebarMismatch(list.weight, pourKg);
        reb = `<table class="rebars"><tr><th>Pos</th><th>Ø</th><th class="num">pcs</th><th class="num">kg</th></tr>` +
          list.rows.map((r) => `<tr><td>${esc(r.pos)}</td><td>${esc(r.size)}</td><td class="num">${f0(r.qty)}</td><td class="num">${f1(r.weight)}</td></tr>`).join("") +
          `<tr class="tot"><td colspan="2">List</td><td class="num">${f0(list.qty)}</td><td class="num">${f1(list.weight)}</td></tr></table>` +
          (mism
            ? `<div class="mism">List ${f0(list.weight)} kg vs pour data ${f0(pourKg)} kg — ${list.weight > pourKg
                ? "Tekla's export repeats split groups"
                : "Tekla's export writes identical groups as identical rows, which the list counts once"}; trust the pour data total.</div>`
            : `<div class="sub">List ${f0(list.weight)} kg matches the pour data (${f0(pourKg)} kg).</div>`) +
          `<div class="acts"><button class="small secondary" data-act="selAllRebar" data-i="${i}">Select all rebar</button></div>`;
      }
      if (failed) reb += `<div class="sub">${failed} piece(s) could not be read.</div>`;
    }
    const withEmb = pcs.filter((o) => String((o.props || {})[L.P.embeds] || "").trim()).length;
    const emb = g.embeds.length
      ? `<table class="rebars"><tr><th>Mark</th><th class="num">Qty</th></tr>` +
        g.embeds.map((e) => `<tr><td>${esc(e.code)}</td><td class="num">${f0(e.count)}</td></tr>`).join("") +
        `</table><div class="sub">${withEmb} of ${pcs.length} pieces contain embeds.</div>`
      : `<div class="sub">No embedded parts.</div>`;
    return `<div class="pourlists"><div class="lh">Rebar · whole pour</div>${reb}<div class="lh">Embeds · whole pour</div>${emb}</div>`;
  }
  // Read every piece's PourUnit (cached), a few at a time, re-rendering as they arrive.
  async function loadAllContents(g) {
    const pcs = piecesOf(g).filter((o) => !state.contents.has(objKey(o)));
    for (let k = 0; k < pcs.length; k += 4) {
      await Promise.all(pcs.slice(k, k + 4).map((o) => loadContents(o)));
      if (state.inspectKey === g.key) render();
    }
  }
  function contentsHtml(i, j, c, rebarKg) {
    if (!c) return `<div class="contents sub">Loading…</div>`;
    if (c.error) return `<div class="contents sub">Contents not available (${esc(c.error)}).</div>`;
    const reb = c.rebars.length
      ? `<table class="rebars"><tr><th>Pos</th><th>Ø</th><th class="num">pcs/gr</th><th class="num">kg/gr</th></tr>` +
        c.rebars.map((r) => `<tr><td>${esc(r.pos)}</td><td>${esc(r.size)}</td><td class="num">${f0(r.qty)}</td><td class="num">${f1(r.weight)}</td></tr>`).join("") +
        `</table><div class="sub">Rebar groups as Tekla exported them (not summed). Piece total from the pour data: ${f0(rebarKg)} kg.</div>`
      : `<div class="sub">No rebar in this PourUnit.</div>`;
    const oth = c.others.length
      ? `<div class="sub">Also in the PourUnit: ${esc([...c.others.reduce((m, o) => m.set(o.name, (m.get(o.name) || 0) + 1), new Map())].map(([n, k]) => k > 1 ? `${n} ×${k}` : n).join(", "))}</div>`
      : "";
    const sel = c.rebarIds.length ? `<div class="acts"><button class="small secondary" data-act="pSelRebar" data-i="${i}" data-j="${j}">Select rebar</button></div>` : "";
    return `<div class="contents">${reb}${oth}${sel}</div>`;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString("en-US");
  const f0 = (v) => Math.round(v).toLocaleString("en-US");

  function render() {
    const rows = $("rows");
    if (!state.pours.length) {
      rows.innerHTML = `<tr><td colspan="3" class="empty">No numbered pours in the loaded models.</td></tr>`;
      $("foot").innerHTML = "";
    } else {
      rows.innerHTML = state.pours.map((g, i) => {
        const tagged = state.tags.has(g.key);
        const types = g.types.map((t) => t.split("/")[0]).join(", ");
        const emb = g.embeds.length ? `<div class="emb">Embeds ${esc(L.formatEmbeds(g.embeds))}</div>` : "";
        return `<tr>
          <td>${state.coloured ? `<span class="sw" style="background:${g.colour}"></span>` : ""}<span class="name">${esc(g.label)}</span><button
              class="small inspect ${state.inspectKey === g.key ? "on" : "secondary"}" data-act="inspect" data-i="${i}" title="List the pieces this pour is made of">Inspect ${state.inspectKey === g.key ? "▴" : "▾"}</button>
            <div class="sub">${g.objects.length} obj · ${esc(types || "–")}${g.materials.length ? " · " + esc(g.materials.join(", ")) : ""}</div>${emb}
            ${g.parts.length ? partsLine(g.parts) : ""}
            ${g.models.length > 1 ? `<div class="sub">${g.models.length} models: ${esc(g.models.join(", "))}</div>` : ""}
            <div class="acts"><button class="small ${tagged ? "on" : "secondary"}" data-act="tag" data-i="${i}" title="${tagged ? "Remove tag" : "Tag this pour"}">Tag</button><button
              class="small secondary" data-act="select" data-i="${i}" title="Select this pour's objects and zoom to them">Select</button><button
              class="small ${state.focusKey === g.key ? "on" : "secondary"}" data-act="focus" data-i="${i}" title="${state.focusKey === g.key ? "Clear focus" : "Zoom and make everything else transparent"}">Focus</button></div></td>
          <td class="num">${L.fmtVolume(g.totals.volume)}</td>
          <td class="num">${f0(g.totals.rebar)}</td></tr>` + (state.inspectKey === g.key ? inspectRow(g, i) : "");
      }).join("");
      const t = state.pours.reduce((a, g) => ({ v: a.v + g.totals.volume, r: a.r + g.totals.rebar }), { v: 0, r: 0 });
      $("foot").innerHTML = `<tr><td>Total (${state.pours.length})</td><td class="num">${f1(t.v)}</td><td class="num">${f0(t.r)}</td></tr>`;
    }
    const unnumbered = state.pours.filter((g) => g.embeds.some((e) => L.isUnnumbered(e.code))).map((g) => g.label);
    $("embWarn").hidden = !unnumbered.length;
    $("embWarn").textContent = unnumbered.length
      ? `Embed marks show "(?)" in ${unnumbered.join(", ")}: numbering was not up to date in Tekla when this was exported.`
      : "";
    const loose = state.unnumbered;
    $("looseBox").hidden = !loose.length;
    $("looseRows").innerHTML = loose.map((g, i) => `<tr>
        <td><span class="name">"${esc(g.label)}"</span><div class="sub">${g.objects.length} obj · ${esc(g.types.map((t) => t.split("/")[0]).join(", ") || "–")}</div>
          <div class="acts"><button class="small secondary" data-act="selectLoose" data-i="${i}" title="Select these objects and zoom to them">Select</button></div></td>
        <td class="num">${L.fmtVolume(g.totals.volume)} m³</td></tr>`).join("");
    $("btnClearFocus").hidden = state.focusKey == null;
  }

  function renderFieldOptions() {
    $("fields").innerHTML = L.FIELDS.map((f) =>
      `<label class="chk"><input type="checkbox" data-field="${f.id}" ${settings.fields.includes(f.id) ? "checked" : ""}> ${esc(f.label)}</label>`).join("");
    $("numLift").value = settings.lift;
    $("numSide").value = settings.side;
    $("selLang").value = settings.lang;
    $("selLayout").value = settings.layout;
  }

  // ---------- wiring ----------
  async function guarded(fn) {
    try { await fn(); } catch (e) { setStatus("Error: " + errText(e), true); console.error(e); }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const i = +b.dataset.i;
    guarded(async () => {
      if (b.dataset.act === "tag") {
        const g = state.pours[i];
        if (state.tags.has(g.key)) await removeTags([g.key]);
        else if (!(await addTags([g]))) setStatus(`${g.label}: no geometry to anchor the tag`, true);
        render();
      } else if (b.dataset.act === "inspect") {
        const g = state.pours[i];
        state.inspectKey = state.inspectKey === g.key ? null : g.key;
        render();
        if (state.inspectKey === g.key) await loadAllContents(g);
      } else if (b.dataset.act && b.dataset.act[0] === "p" && b.dataset.j != null) {
        const g = state.pours[i], o = piecesOf(g)[+b.dataset.j];
        const sel = selectorFor([o]);
        if (b.dataset.act === "pSelect") { await state.api.viewer.setSelection(sel, "set"); await state.api.viewer.setCamera(sel, { animationTime: 600 }); }
        else if (b.dataset.act === "pZoom") await state.api.viewer.setCamera(sel, { animationTime: 600 });
        else if (b.dataset.act === "pFocus") await focusPiece(g, o);
        else if (b.dataset.act === "pOpen") {
          const k = objKey(o);
          if (state.openPieces.has(k)) { state.openPieces.delete(k); render(); }
          else { state.openPieces.add(k); render(); await loadContents(o); render(); }
        } else if (b.dataset.act === "pSelRebar") {
          const c = state.contents.get(objKey(o));
          if (c && c.rebarIds.length) {
            const rs = { modelObjectIds: [{ modelId: o.modelId, objectRuntimeIds: c.rebarIds }] };
            await state.api.viewer.setSelection(rs, "set");
            await state.api.viewer.setCamera(rs, { animationTime: 600 });
          }
        }
      } else if (b.dataset.act === "selAllRebar") {
        const g = state.pours[i];
        const byModel = new Map();
        for (const o of piecesOf(g)) {
          const c = state.contents.get(objKey(o));
          if (!c || c.error) continue;
          if (!byModel.has(o.modelId)) byModel.set(o.modelId, []);
          byModel.get(o.modelId).push(...c.rebarIds);
        }
        const sel = { modelObjectIds: [...byModel].filter(([, ids]) => ids.length).map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
        if (sel.modelObjectIds.length) {
          await state.api.viewer.setSelection(sel, "set");
          await state.api.viewer.setCamera(sel, { animationTime: 600 });
        }
      } else if (b.dataset.act === "backToPour") await backToPour(state.pours[i]);
      else if (b.dataset.act === "select") await selectPour(state.pours[i]);
      else if (b.dataset.act === "focus") await focusPour(state.pours[i]);
      else if (b.dataset.act === "selectLoose") await selectPour(state.unnumbered[i]);
    });
  });
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
  renderFieldOptions();

  // Re-read automatically when models are loaded or unloaded (debounced; the event fires in bursts).
  let reloadTimer = null;
  function onEvent(event) {
    // Connect's own "Reset model" restores opacity and colours: forget our focus/colour state.
    if (event === "viewer.onModelReset") {
      state.focusKey = null; state.focusTagAdded = false; state.coloured = false; $("chkColour").checked = false;
      render();
      return;
    }
    if (event === "viewer.onModelStateChanged" && state.api) {
      setStatus("Models changed, reading pours again…");
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => guarded(async () => {
        await removeTags([...state.tags.keys()]);
        await loadPours();
        if (state.coloured) await applyColours();
      }), 1500);
    }
  }

  // ---------- start ----------
  async function start(api) {
    state.api = api;
    await guarded(loadPours);
  }
  window.PourTagsApp = { start, state };   // used by demo.js

  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) {
      const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s);
    } else {
      setStatus("Not inside Trimble Connect. Add this extension to a project and open it from the 3D viewer side panel.", true);
    }
    return;
  }
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus("Could not connect to Trimble Connect: " + errText(e), true));
})();
