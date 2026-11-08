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
          items.push(...found);
        }
        setStatus(`Reading pours… ${scanned} objects checked, ${items.length} pour objects found`);
      }
    }
    const { pours, unnumbered } = L.groupPours(items);
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
      setStatus(`${pours.length} pours, ${items.length} pour objects` + (loose ? ` · ${loose} without a pour number` : ""));
    }
    for (const b of ["btnShowAll", "btnClear", "btnReload"]) $(b).disabled = false;
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
      color: state.coloured && g.colour ? L.hexToRgba(g.colour) : TAG_COLOUR,
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
  async function zoomTo(g) {
    const sel = selectorFor(g.objects);
    await state.api.viewer.setSelection(sel, "set");
    await state.api.viewer.setCamera(sel, { animationTime: 600 });
  }

  // ---------- rendering ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const f1 = (v) => (Math.round(v * 10) / 10).toLocaleString("en-US");
  const f0 = (v) => Math.round(v).toLocaleString("en-US");

  function render() {
    const rows = $("rows");
    if (!state.pours.length) {
      rows.innerHTML = `<tr><td colspan="4" class="empty">No numbered pours in the loaded models.</td></tr>`;
      $("foot").innerHTML = "";
    } else {
      rows.innerHTML = state.pours.map((g, i) => {
        const tagged = state.tags.has(g.key);
        const types = g.types.map((t) => t.split("/")[0]).join(", ");
        const emb = g.embeds.length ? `<div class="emb">Embeds ${esc(L.formatEmbeds(g.embeds))}</div>` : "";
        return `<tr>
          <td>${state.coloured ? `<span class="sw" style="background:${g.colour}"></span>` : ""}<span class="name">${esc(g.label)}</span>
            <div class="sub">${g.objects.length} obj · ${esc(types || "–")}${g.materials.length ? " · " + esc(g.materials.join(", ")) : ""}</div>${emb}</td>
          <td class="num">${L.fmtVolume(g.totals.volume)}</td>
          <td class="num">${f0(g.totals.rebar)}</td>
          <td class="acts"><button class="small ${tagged ? "on" : "secondary"}" data-act="tag" data-i="${i}" title="${tagged ? "Remove tag" : "Tag this pour"}">Tag</button>
            <button class="small secondary" data-act="zoom" data-i="${i}" title="Select and zoom">Zoom</button></td></tr>`;
      }).join("");
      const t = state.pours.reduce((a, g) => ({ v: a.v + g.totals.volume, r: a.r + g.totals.rebar }), { v: 0, r: 0 });
      $("foot").innerHTML = `<tr><td>Total (${state.pours.length})</td><td class="num">${f1(t.v)}</td><td class="num">${f0(t.r)}</td><td></td></tr>`;
    }
    const unnumbered = state.pours.filter((g) => g.embeds.some((e) => L.isUnnumbered(e.code))).map((g) => g.label);
    $("embWarn").hidden = !unnumbered.length;
    $("embWarn").textContent = unnumbered.length
      ? `Embed marks show "(?)" in ${unnumbered.join(", ")}: numbering was not up to date in Tekla when this was exported.`
      : "";
    const loose = state.unnumbered;
    $("looseBox").hidden = !loose.length;
    $("looseRows").innerHTML = loose.map((g, i) => `<tr>
        <td><span class="name">"${esc(g.label)}"</span><div class="sub">${g.objects.length} obj · ${esc(g.types.map((t) => t.split("/")[0]).join(", ") || "–")}</div></td>
        <td class="num">${L.fmtVolume(g.totals.volume)} m³</td>
        <td class="acts"><button class="small secondary" data-act="zoomLoose" data-i="${i}">Zoom</button></td></tr>`).join("");
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
      } else if (b.dataset.act === "zoom") await zoomTo(state.pours[i]);
      else if (b.dataset.act === "zoomLoose") await zoomTo(state.unnumbered[i]);
    });
  });
  $("btnShowAll").onclick = () => guarded(showAll);
  $("btnClear").onclick = () => guarded(clearAll);
  $("btnReload").onclick = () => guarded(async () => {
    await removeTags([...state.tags.keys()]);
    await loadPours();
    await applyColours();
  });
  $("chkColour").onchange = (e) => guarded(async () => {
    state.coloured = e.target.checked;
    await applyColours();
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
      const s = document.createElement("script"); s.src = "demo.js"; document.body.appendChild(s);
    } else {
      setStatus("Not inside Trimble Connect. Add this extension to a project and open it from the 3D viewer side panel.", true);
    }
    return;
  }
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus("Could not connect to Trimble Connect: " + errText(e), true));
})();
