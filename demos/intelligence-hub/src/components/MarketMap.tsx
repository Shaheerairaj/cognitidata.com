import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  WORLD_VIEW, circleBbox, circlePolygon, cornerPos, dragCorner,
  type BBox, type Corner, type PinState, type ResetTarget,
} from "../registry_search";

// The resident discovery map (ADR-079 map-first). One instance sits under the whole flow:
// full-bleed behind the ask/confirm/finding moments on home, then ~40% height above the lead
// list in the work phase. Repurposes the retired MapPin modal's guts — the Carto Positron
// vector style with the English-label override, and the circle-geometry helpers — but the
// modal UX itself is gone. Presentational: every decision (what the area is, what each pin's
// state is, what a click means) is handed down from Workbench via props/callbacks.

// Colours + basemap come from the theme tokens (public/theme.css), read at map-init time.
// maplibre paint can't read CSS vars (or every CSS colour syntax), so each token is resolved
// to plain rgba by painting it onto a 1px canvas. A missing token (or no canvas, in tests)
// paints transparent: every colour lives in public/theme.css.
function themeToken(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function themeColor(name: string, fallback = "transparent"): string {
  const raw = themeToken(name);
  if (!raw) return fallback;
  try {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.fillStyle = fallback;
    ctx.fillStyle = raw; // an unparseable value leaves the fallback in place
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}
function readMapTheme() {
  return {
    // no --map-style token → an empty map rather than a hidden default
    styleUrl: themeToken("--map-style").replace(/^["']|["']$/g, "") ||
      ({ version: 8, sources: {}, layers: [] } as maplibregl.StyleSpecification),
    accent: themeColor("--accent"),
    accentInk: themeColor("--accent-ink"),
    warn: themeColor("--warn-ink"), // the review-band ◌ ring (ADR-083)
    pinFill: themeColor("--surface"),
  };
}

// Carto Positron swaps labels from name_en to the local name at z13+ — pin English at every
// zoom (the pilot's fix; see funnel_prototype.py).
function forceEnglishLabels(m: maplibregl.Map) {
  for (const l of m.getStyle().layers) {
    if (l.type !== "symbol") continue;
    const tf = m.getLayoutProperty(l.id, "text-field");
    if (tf && JSON.stringify(tf).includes("name")) {
      m.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name_en"], ["get", "name"]]);
    }
  }
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export type MapArea =
  | { kind: "place"; label: string; bbox: BBox; polygon: GeoJSON.Geometry | null }
  | { kind: "pin"; label: string; lat: number; lng: number; radiusKm: number };

export type MapPinDatum = { id: string; lng: number; lat: number; state: PinState };

export const areaBbox = (a: MapArea): BBox =>
  a.kind === "place" ? a.bbox : circleBbox(a.lng, a.lat, a.radiusKm);

// The glow geometry: the suggestion's polygon when it carried one, else the bbox rectangle;
// a dropped pin glows as its radius circle.
function areaGeometry(a: MapArea): GeoJSON.Feature {
  if (a.kind === "pin") return circlePolygon(a.lng, a.lat, a.radiusKm);
  if (a.polygon) return { type: "Feature", properties: {}, geometry: a.polygon };
  const [w, s, e, n] = a.bbox;
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

export function MarketMap(props: {
  area: MapArea | null;
  fitKey: string | null; // fit the view to the area only when this changes (never mid-drag)
  pins: MapPinDatum[];
  hoverId: string | null; // the lit pin (row hover ↔ pin highlight)
  pulsing: boolean; // the finding moment's soft pulse (CSS honors prefers-reduced-motion)
  editable: boolean; // confirm moment: bbox corner handles are draggable
  resetTarget?: ResetTarget; // the ◎ reset-view button's state-dependent destination
  focus?: { lng: number; lat: number; key: string } | null; // fly to a lead when key changes
  onMapClick?: (p: { lng: number; lat: number }) => void;
  onBboxDrag?: (bbox: BBox) => void;
  onPinClick?: (id: string, point: { x: number; y: number }) => void;
  onPinHover?: (id: string | null) => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const pinMarkerRef = useRef<maplibregl.Marker | null>(null);
  const handlesRef = useRef<maplibregl.Marker[]>([]);
  // Callbacks + area live in refs so the one-time map listeners always see the latest.
  const cb = useRef(props);
  cb.current = props;

  const [mapDead, setMapDead] = useState(false);
  const themeRef = useRef<ReturnType<typeof readMapTheme> | null>(null);

  // Mount the map once for the component's whole life (it survives phase changes via CSS).
  useEffect(() => {
    if (!mapEl.current) return;
    // A failed WebGL init (exhausted/reset GPU process — seen live 2026-07-17 as a
    // flash-then-blank of the whole app) must degrade to a quiet placeholder, never
    // take the workbench down: an exception here unwinds React's whole tree.
    let map: maplibregl.Map;
    const theme = readMapTheme();
    themeRef.current = theme;
    try {
      map = new maplibregl.Map({
        container: mapEl.current,
        style: theme.styleUrl,
        center: WORLD_VIEW.center,
        zoom: WORLD_VIEW.zoom,
        attributionControl: false,
      });
    } catch (e) {
      console.error("map init failed (WebGL unavailable?) — continuing without the map", e);
      setMapDead(true);
      return;
    }
    map.on("error", (e) => console.error("maplibre:", e?.error ?? e));
    mapRef.current = map;
    map.on("load", () => {
      forceEnglishLabels(map);
      map.addSource("mm-area", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "mm-area-fill", type: "fill", source: "mm-area",
        paint: { "fill-color": theme.accent, "fill-opacity": 0.1 },
      });
      map.addLayer({
        id: "mm-area-line", type: "line", source: "mm-area",
        paint: { "line-color": theme.accentInk, "line-width": 1.5 },
      });
      map.addSource("mm-pins", { type: "geojson", data: EMPTY_FC });
      map.addLayer({
        id: "mm-pins", type: "circle", source: "mm-pins",
        paint: {
          "circle-radius": ["case", ["get", "lit"], 8, 5],
          // Fill tracks HOVER, not enrichment: the hovered pin fills orange (and enlarges via
          // circle-radius above); every other pin stays hollow (--surface). State is conveyed by the
          // stroke ring + opacity below, never by fill.
          "circle-color": ["case", ["get", "lit"], theme.accent, theme.pinFill],
          "circle-opacity": ["match", ["get", "state"], "faded", 0.25, 1],
          "circle-stroke-color": ["match", ["get", "state"], "review", theme.warn, theme.accentInk],
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": ["match", ["get", "state"], "faded", 0.25, 1],
        },
      });
      setStyleReady(true);
    });
    const pinHits = (point: { x: number; y: number }) =>
      map.getLayer("mm-pins")
        ? map.queryRenderedFeatures([point.x, point.y] as [number, number], { layers: ["mm-pins"] })
        : [];
    map.on("click", (e) => {
      const hit = pinHits(e.point)[0];
      if (hit && cb.current.onPinClick) {
        cb.current.onPinClick(String(hit.properties?.id), { x: e.point.x, y: e.point.y });
      } else {
        cb.current.onMapClick?.({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      }
    });
    map.on("mousemove", (e) => {
      if (!cb.current.onPinHover) return;
      const hit = pinHits(e.point)[0];
      cb.current.onPinHover(hit ? String(hit.properties?.id) : null);
      map.getCanvas().style.cursor = hit ? "pointer" : "";
    });
    // The container is resized by the phase layout (full-bleed ↔ 40% strip ↔ collapsed).
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => map.resize())
      : null;
    if (ro && mapEl.current) ro.observe(mapEl.current);
    return () => {
      ro?.disconnect();
      pinMarkerRef.current = null;
      handlesRef.current = [];
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // Area glow + the pin's marker track the area.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource("mm-area") as maplibregl.GeoJSONSource | undefined)?.setData(
      props.area ? areaGeometry(props.area) : EMPTY_FC,
    );
    if (props.area?.kind === "pin") {
      const at = { lng: props.area.lng, lat: props.area.lat };
      if (!pinMarkerRef.current) {
        pinMarkerRef.current = new maplibregl.Marker({ color: themeRef.current?.accent }).setLngLat(at).addTo(map);
      } else {
        pinMarkerRef.current.setLngLat(at);
      }
    } else if (pinMarkerRef.current) {
      pinMarkerRef.current.remove();
      pinMarkerRef.current = null;
    }
  }, [props.area, styleReady]);

  // Corner drag handles — only while confirming a place area (never a pin, never mid-scan).
  const showHandles = props.editable && props.area?.kind === "place";
  const bboxRef = useRef<BBox | null>(null);
  bboxRef.current = props.area?.kind === "place" ? props.area.bbox : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    if (!showHandles) {
      handlesRef.current.forEach((m) => m.remove());
      handlesRef.current = [];
      return;
    }
    if (handlesRef.current.length === 0) {
      handlesRef.current = CORNERS.map((corner) => {
        const el = document.createElement("div");
        el.className = "mm-handle";
        el.setAttribute("aria-label", `${corner} handle`);
        const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([0, 0]).addTo(map);
        marker.on("drag", () => {
          const p = marker.getLngLat();
          const box = bboxRef.current;
          if (box) cb.current.onBboxDrag?.(dragCorner(box, corner, p.lng, p.lat));
        });
        return marker;
      });
    }
    const box = bboxRef.current;
    if (box) handlesRef.current.forEach((m, i) => m.setLngLat(cornerPos(box, CORNERS[i])));
  }, [showHandles, props.area, styleReady]);

  // Pins mirror the classified rows; the hovered one re-renders lit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource("mm-pins") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: props.pins.map((p) => ({
        type: "Feature" as const,
        properties: { id: p.id, state: p.state, lit: p.id === props.hoverId },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      })),
    });
  }, [props.pins, props.hoverId, styleReady]);

  // Fly to the area when (and only when) the caller mints a new fitKey — a handle drag
  // reshapes the bbox without one, so the camera holds still under the user's hand.
  // A new fitKey with no area is the "start over" signal (goHome): fly back to the world
  // view — the map survives phase changes, so nothing else returns the camera home.
  const lastFit = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.fitKey || props.fitKey === lastFit.current) return;
    lastFit.current = props.fitKey;
    if (!props.area) {
      map.flyTo({ center: WORLD_VIEW.center, zoom: WORLD_VIEW.zoom, duration: 700 });
      return;
    }
    const [w, s, e, n] = areaBbox(props.area);
    map.fitBounds([[w, s], [e, n]], { padding: 72, duration: 900, maxZoom: 13 });
  }, [props.fitKey, props.area]);

  // Fly to a focused lead (row click, feedback #10) — once per minted focus key.
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    const f = props.focus;
    if (!map || !f || f.key === lastFocus.current) return;
    lastFocus.current = f.key;
    map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 13), duration: 700 });
  }, [props.focus]);

  // The ◎ reset-view control (feedback #2) — the destination is decided upstream
  // (resetViewTarget, pure + tested); this just applies it to the camera.
  const resetView = () => {
    const map = mapRef.current;
    const t = cb.current.resetTarget;
    if (!map || !t) return;
    if (t.kind === "world") {
      map.flyTo({ center: WORLD_VIEW.center, zoom: WORLD_VIEW.zoom, duration: 700 });
    } else {
      const [w, s, e, n] = t.bbox;
      map.fitBounds([[w, s], [e, n]], { padding: 72, duration: 700, maxZoom: 13 });
    }
  };

  return (
    <div className="mm-wrap">
      <div className="mm-canvas" ref={mapEl} data-testid="market-map" />
      {mapDead && (
        <div className="mm-dead" data-testid="map-dead">
          The map couldn't start (graphics unavailable) — search and the list still work.
          Restarting the browser usually brings it back.
        </div>
      )}
      {props.resetTarget && (
        <button
          type="button"
          className="mm-reset"
          title="Reset view"
          aria-label="reset map view"
          onClick={resetView}
        >
          ◎
        </button>
      )}
      {props.pulsing && (
        <div className="mm-pulse" aria-hidden="true">
          <span className="mm-ring r1" />
          <span className="mm-ring r2" />
          <span className="mm-ring r3" />
        </div>
      )}
    </div>
  );
}
