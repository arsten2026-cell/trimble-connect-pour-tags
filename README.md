# Pour tags (Arsten), Trimble Connect 3D-viewer extension

Lists the concrete pours (такт) in the loaded Tekla IFC models and tags each pour number with a red leader
label, for example `TAKT 5, 9.9 m³, Embeds EB01`.

Data: IfcBuildingElementProxy pour objects with the property set `Pour/Такт`, written by the Tekla macro
`Arsten_PourExport`. One pour number can span many pour objects; the panel sums volume, rebar and formwork,
merges the embed lists and anchors one label on the largest object of each pour.

Install: Trimble Connect project → Settings → Apps & Capabilities → + Add Custom →
`https://arsten2026-cell.github.io/trimble-connect-pour-tags/manifest.json`. Then open a model in 3D and pick
"Pour tags" in the side panel.

Static files only, no data leaves the browser.
