// Small offline GeoJSON/TopoJSON compiler. Boundaries remain the input author's responsibility.
import fs from "node:fs";
import path from "node:path";

export function compileGeo(
  input,
  {
    width = 1600,
    height = 900,
    projection = "mercator",
    simplify = 0.6,
    object,
    idField,
  } = {},
) {
  width = Number(width);
  height = Number(height);
  simplify = Number(simplify);
  if (
    ![width, height].every(
      (n) => Number.isInteger(n) && n >= 32 && n <= 8192,
    ) ||
    !Number.isFinite(simplify) ||
    simplify < 0 ||
    simplify > 50
  )
    throw new Error("geo: width/height 32–8192; simplify 0–50 output pixels");
  if (!["mercator", "equirectangular"].includes(projection))
    throw new Error("geo: projection mercator or equirectangular");
  if (idField !== undefined && (typeof idField !== "string" || !idField.trim()))
    throw new Error("geo: --id-field must name a nonempty properties field");
  if (input.type === "Topology") input = topologyFeatures(input, object);
  const features =
    input.type === "FeatureCollection"
      ? input.features
      : input.type === "Feature"
        ? [input]
        : null;
  if (!Array.isArray(features) || !features.length)
    throw new Error("geo needs a nonempty FeatureCollection or Topology");
  const project = ([lon, lat]) => {
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lon) > 180 ||
      Math.abs(lat) > 90
    )
      throw new Error("geo: invalid longitude/latitude");
    const phi =
      (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
    return [
      (lon * Math.PI) / 180,
      projection === "mercator"
        ? -Math.log(Math.tan(Math.PI / 4 + phi / 2))
        : (-lat * Math.PI) / 180,
    ];
  };
  const used = new Set();
  const raw = features.map((f, i) => {
    const g = f.geometry;
    let polygons;
    if (g?.type === "Polygon") polygons = [g.coordinates];
    else if (g?.type === "MultiPolygon") polygons = g.coordinates;
    else
      throw new Error(
        `geo feature ${i}: only Polygon/MultiPolygon regions are supported`,
      );
    if (
      !Array.isArray(polygons) ||
      !polygons.length ||
      polygons.some((p) => !Array.isArray(p) || !p.length)
    )
      throw new Error(`geo feature ${i}: empty polygon`);
    const usableId = (v) => (typeof v === "string" && Boolean(v.trim())) || (typeof v === "number" && Number.isFinite(v));
    const selected = idField !== undefined ? f.properties?.[idField] : [f.id, f.properties?.name, i].find(usableId);
    if (!usableId(selected)) throw new Error(`geo feature ${i}: --id-field ${idField} is missing or empty`);
    const id = String(selected).trim();
    if (used.has(id)) throw new Error(`geo duplicate region ID: ${id}; choose a unique properties field with --id-field (for example, name)`);
    used.add(id);
    return {
      id,
      name: String(f.properties?.[idField ?? "name"] || id),
      polygons: polygons.map((p) =>
        p.map((ring) => {
          if (!Array.isArray(ring) || ring.length < 4)
            throw new Error(
              `geo ${id}: polygon ring needs at least four coordinates`,
            );
          if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])
            throw new Error(`geo ${id}: polygon ring is not closed`);
          return ring.map(project);
        }),
      ),
    };
  });
  const points = raw.flatMap((f) => f.polygons.flat(2));
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const scale = Math.min(
    (width - 32) / (maxX - minX || 1),
    (height - 32) / (maxY - minY || 1),
  );
  const offset = [
    (width - (maxX - minX) * scale) / 2 - minX * scale,
    (height - (maxY - minY) * scale) / 2 - minY * scale,
  ];
  const round = (n) => Math.round(n * 100) / 100;
  const regions = raw.map((f) => ({
    ...f,
    polygons: f.polygons.map((p) =>
      p.map((ring) => {
        const transformed = ring.map(([x, y]) => [
          round(x * scale + offset[0]),
          round(y * scale + offset[1]),
        ]);
        const reduced = reduceLine(transformed, simplify);
        return reduced.length >= 4 ? reduced : transformed;
      }),
    ),
  }));
  return {
    schema: "motion-use-map/v1",
    width,
    height,
    projection,
    transform: { scale, offset },
    regions,
    notice:
      "Illustrative geometry derived from supplied data, not an authoritative boundary. Antimeridian-crossing rings must be split upstream.",
  };
}

// Douglas–Peucker with an explicit stack, bounded by the input's point count.
function reduceLine(points, tolerance) {
  if (points.length < 3 || !tolerance) return points;
  const keep = new Set([0, points.length - 1]),
    stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(),
      [ax, ay] = points[a],
      [bx, by] = points[b],
      dx = bx - ax,
      dy = by - ay;
    let best = tolerance * tolerance,
      index = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = points[i],
        q = Math.max(
          0,
          Math.min(
            1,
            ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1),
          ),
        );
      const d = (x - ax - q * dx) ** 2 + (y - ay - q * dy) ** 2;
      if (d > best) {
        best = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep.add(index);
      stack.push([a, index], [index, b]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}
function topologyFeatures(t, name) {
  const keys = Object.keys(t.objects ?? {});
  if (!name && keys.length !== 1)
    throw new Error(`geo: choose --object (${keys.join(", ")})`);
  const object = t.objects?.[name ?? keys[0]];
  if (!object) throw new Error("geo: unknown topology object");
  const arcs = t.arcs.map((arc) => {
    let x = 0,
      y = 0;
    return arc.map((p) => {
      if (!t.transform) return p;
      x += p[0];
      y += p[1];
      return [
        x * t.transform.scale[0] + t.transform.translate[0],
        y * t.transform.scale[1] + t.transform.translate[1],
      ];
    });
  });
  const ring = (ids) => {
    const out = [];
    for (const id of ids) {
      const original = arcs[id < 0 ? ~id : id];
      if (!original) throw new Error("geo: invalid topology arc");
      const a = id < 0 ? [...original].reverse() : original;
      out.push(...(out.length ? a.slice(1) : a));
    }
    return out;
  };
  const geometries =
    object.type === "GeometryCollection" ? object.geometries : [object];
  return {
    type: "FeatureCollection",
    features: geometries.map((g) => ({
      type: "Feature",
      id: g.id,
      properties: g.properties,
      geometry: {
        type: g.type,
        coordinates:
          g.type === "Polygon"
            ? g.arcs.map(ring)
            : g.type === "MultiPolygon"
              ? g.arcs.map((p) => p.map(ring))
              : null,
      },
    })),
  };
}
export function exportGeo(file, options = {}) {
  if (!options.out) throw new Error("geo requires --out <new-map.json>");
  const out = path.resolve(options.out);
  if (fs.existsSync(out))
    throw new Error(`${out} exists; choose a fresh --out`);
  const builtin = {
    world: { name: "Natural Earth 1:110m admin-0 countries", license: "Public domain", url: "https://www.naturalearthdata.com/about/terms-of-use/" },
    "china-provinces": { name: "geoBoundaries gbOpen CHN ADM1", license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", dataUrl: "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/CHN/ADM1/geoBoundaries-CHN-ADM1_simplified.geojson", modifications: ["Properties reduced to shapeID/name", "Coordinates rounded to five decimal places", "Projected and optionally simplified by motion-use"], year: "2019", boundaryID: "CHN-ADM1-43563684", url: "https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM1/", attribution: "geoBoundaries — www.geoboundaries.org — CC BY 4.0" },
  };
  const entry = Object.hasOwn(builtin, file) ? builtin[file] : null;
  const source = entry ? new URL(`../assets/geo/${file}.geojson`, import.meta.url) : file;
  const map = compileGeo(JSON.parse(fs.readFileSync(source, "utf8")), options);
  if (entry) map.source = { ...entry };
  if (entry?.attribution) map.notice += ` Source represents ${entry.year}; credit in the film/product: ${entry.attribution}.`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(map) + "\n", { flag: "wx" });
  return {
    ok: true,
    file: out,
    regions: map.regions.length,
    notice: map.notice,
    attribution: entry?.attribution ?? null,
  };
}
