# LEARNINGS

## 2026-10-28 — Cytoscape bounding boxes lag behind positions set in code
After a layout or `node.position(...)`, `boundingBox()` can still return the boxes from before the change until the next render. Post-layout steps (closing empty bands, packing groups) therefore compute boxes from `position()` and the known node size instead.

## 2026-10-28 — Dagre puts unconnected groups into the empty bands of another group
A long column of dependents leaves tall empty bands inside one connected group, and dagre fills them with nodes of other groups. Closing bands over the whole graph sees no gap; it has to run per connected component, before the components are packed.
