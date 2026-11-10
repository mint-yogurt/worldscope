// Map setup. We load OpenFreeMap's "Liberty" vector style once, recolor it
// per theme, and add the imagery layers into the same style. Switching theme
// or base map then only flips paint properties and visibility, so overlays we
// add later (flights, weather, ...) survive every switch.

import { THEMES } from './themes.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ESRI_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// NOAA-20's daily mosaic tends to be more complete than Suomi NPP's; SNPP covers the years before NOAA-20.
const gibsUrl = (date) => {
  const layer = date >= '2018-01-01' ? 'VIIRS_NOAA20_CorrectedReflectance_TrueColor' : 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
};

// First day of VIIRS true-color imagery in GIBS.
export const GIBS_FIRST_DATE = '2012-01-19';

// Data overlays (weather etc.) go just below this layer: above land, water and
// roads, below borders and labels.
export const OVERLAY_BEFORE_ID = 'boundary_3';

// Yesterday in UTC: today's daily mosaic is usually still incomplete.
export function yesterdayUTC() {
  return new Date(Date.now() - 864e5).toISOString().slice(0, 10);
}

// Liberty layers we never show: busy POI icons, colored road shields, etc.
const ALWAYS_HIDDEN = /^(poi_|highway-shield|road_shield|road_one_way|road_area_pattern|building-3d|airport$)/;

function category(layer) {
  const { id, type } = layer;
  if (id.startsWith('sat-')) return id; // before 'background': sat-tint is a background layer too
  if (type === 'background') return 'background';
  if (id === 'natural_earth') return 'relief';
  if (type === 'symbol') {
    if (id.startsWith('water')) return 'waterLabel';
    if (id.startsWith('label_country')) return 'majorLabel';
    return 'label';
  }
  if (id === 'water') return 'water';
  if (id.startsWith('waterway')) return 'waterway';
  if (id.startsWith('boundary')) return 'boundary';
  if (id === 'building') return 'building';
  if (id.includes('rail')) return 'rail';
  if (id.includes('casing')) return 'casing';
  if (/motorway|trunk_primary/.test(id)) return 'roadMajor';
  if (layer['source-layer'] === 'transportation' || /^aeroway_(runway|taxiway)/.test(id)) return 'road';
  return 'land'; // parks, landuse, landcover, aeroway areas
}

function paintFor(layer, theme, mode) {
  const m = theme.map;
  const s = theme.sat;
  const colorProp = `${layer.type}-color`;
  switch (category(layer)) {
    case 'background': return { 'background-color': m.land };
    case 'relief': return { 'raster-opacity': m.relief, 'raster-saturation': -1, 'raster-brightness-max': 0.55 };
    case 'sat-esri':
    case 'sat-gibs':
      return { 'raster-saturation': s.saturation, 'raster-contrast': s.contrast, 'raster-brightness-max': s.brightness };
    case 'sat-tint': return { 'background-color': s.tint, 'background-opacity': s.tintOpacity };
    case 'land': return { [colorProp]: m.landAlt, [`${layer.type}-opacity`]: 0.6 };
    case 'water':
    case 'waterway': return { [colorProp]: m.water };
    case 'building': return { 'fill-color': m.building, 'fill-outline-color': m.building, 'fill-opacity': 0.85 };
    case 'boundary': return { 'line-color': m.boundary, 'line-opacity': mode === 'streets' ? 0.7 : 0.9 };
    // Transport layers are mostly lines, but a few are fills (road areas), hence colorProp.
    case 'rail': return { [colorProp]: m.rail };
    case 'casing': return { [colorProp]: m.casing };
    case 'roadMajor': return { [colorProp]: m.roadMajor, [`${layer.type}-opacity`]: mode === 'streets' ? 1 : 0.5 };
    case 'road': return { [colorProp]: m.road };
    case 'label':
    case 'waterLabel':
    case 'majorLabel': {
      const color = { label: m.label, waterLabel: m.waterLabel, majorLabel: m.labelMajor }[category(layer)];
      return { 'text-color': color, 'text-halo-color': m.halo, 'text-halo-width': mode === 'streets' ? 1.2 : 1.8 };
    }
    default: return {};
  }
}

function isVisible(layer, theme, mode) {
  const { id, type } = layer;
  if (ALWAYS_HIDDEN.test(id)) return false;
  if (id === 'sat-esri') return mode === 'satellite';
  if (id === 'sat-gibs') return mode === 'space';
  if (id === 'sat-tint') return mode !== 'streets' && theme.sat.tintOpacity > 0;
  if (mode === 'streets') return true;
  // Imagery modes: keep labels and borders on top of the photo, plus major roads on satellite.
  const cat = category(layer);
  if (type === 'symbol' || cat === 'boundary' || cat === 'background') return true;
  return mode === 'satellite' && cat === 'roadMajor' && !id.startsWith('tunnel');
}

function skyFor(theme) {
  return {
    'sky-color': theme.map.space,
    'horizon-color': theme.map.horizon,
    'fog-color': theme.map.space,
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.8,
    'fog-ground-blend': 0.9,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
  };
}

function addImageryLayers(style, gibsDate) {
  style.sources.esri = {
    type: 'raster', tiles: [ESRI_URL], tileSize: 256, maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  };
  style.sources.gibs = {
    type: 'raster', tiles: [gibsUrl(gibsDate)], tileSize: 256, maxzoom: 9,
    attribution: 'Imagery: NASA GIBS / LANCE (VIIRS)',
  };
  const at = style.layers.findIndex((l) => l.id === 'natural_earth') + 1;
  style.layers.splice(at, 0,
    { id: 'sat-esri', type: 'raster', source: 'esri' },
    { id: 'sat-gibs', type: 'raster', source: 'gibs' },
    { id: 'sat-tint', type: 'background' },
  );
}

function restyle(layers, state, apply) {
  const theme = THEMES[state.theme];
  for (const layer of layers) apply(layer, paintFor(layer, theme, state.mode), isVisible(layer, theme, state.mode));
}

export async function createWorldMap(container, opts) {
  const state = { ...opts };

  const res = await fetch(STYLE_URL);
  if (!res.ok) throw new Error(`Base map style failed to load (HTTP ${res.status})`);
  const style = await res.json();

  addImageryLayers(style, state.gibsDate);
  // Only these get restyled on theme/mode switches; overlays added later manage themselves.
  const baseLayerIds = new Set(style.layers.map((l) => l.id));
  style.projection = { type: state.globe ? 'globe' : 'mercator' };
  style.sky = skyFor(THEMES[state.theme]);
  restyle(style.layers, state, (layer, paint, visible) => {
    layer.paint = { ...layer.paint, ...paint };
    layer.layout = { ...layer.layout, visibility: visible ? 'visible' : 'none' };
  });

  const map = new maplibregl.Map({
    container,
    style,
    center: state.view?.center || [10, 28],
    zoom: state.view?.zoom ?? 1.7,
    bearing: state.view?.bearing || 0,
    pitch: state.view?.pitch || 0,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

  function apply() {
    restyle(map.getStyle().layers.filter((l) => baseLayerIds.has(l.id)), state, (layer, paint, visible) => {
      for (const [prop, value] of Object.entries(paint)) map.setPaintProperty(layer.id, prop, value);
      map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    });
    map.setSky(skyFor(THEMES[state.theme]));
  }

  return {
    map,
    setTheme(id) { state.theme = id; apply(); },
    setMode(mode) { state.mode = mode; apply(); },
    setGibsDate(date) {
      state.gibsDate = date;
      map.getSource('gibs').setTiles([gibsUrl(date)]);
    },
    setGlobe(on) {
      state.globe = on;
      map.setProjection({ type: on ? 'globe' : 'mercator' });
    },
  };
}
