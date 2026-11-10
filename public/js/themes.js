// Theme definitions for the map itself. UI colors and fonts live in
// css/themes.css under the same theme ids; this file only holds what CSS
// can't reach: the vector map palette, satellite imagery treatment, the
// globe's sky, and which canvas effect runs.

export const DEFAULT_THEME = 'midnight';

export const THEMES = {
  midnight: {
    name: 'Midnight',
    swatch: ['#0e1726', '#4fd1ff'],
    effect: null,
    map: {
      land: '#0e1726', landAlt: '#122033', water: '#060e19',
      road: '#1b2a40', roadMajor: '#2c5179', casing: '#0a121e', rail: '#22344b',
      building: '#16243a', boundary: '#4a6f9a',
      label: '#8ea7c3', labelMajor: '#d6e8ff', waterLabel: '#3d6890', halo: '#060e19',
      relief: 0.3,
      space: '#02050b', horizon: '#1f6fa8',
    },
    sat: { saturation: 0, contrast: 0, brightness: 1, tint: '#000000', tintOpacity: 0 },
    // Planes are colored low -> mid -> high by altitude (0 to 40,000 ft).
    flights: {
      low: '#ffd166', mid: '#4fd1ff', high: '#d0a8ff', ground: '#5c6f86',
      mil: '#ff9f43', alert: '#ff3b5c', trail: '#4fd1ff', selected: '#ffffff',
    },
    satellites: { station: '#ffffff', constellation: '#5b8db8', gnss: '#7cf7c9', weather: '#ffd166', geo: '#d0a8ff', other: '#8ea7c3', orbit: '#4fd1ff' },
    // World event markers, by severity; disc is the marker background.
    events: { minor: '#8ea7c3', significant: '#ffb020', major: '#ff3b5c', disc: '#0b1322' },
    // Ships by type (AIS category); trail is the selected ship's recent path.
    ships: { cargo: '#7bd88f', tanker: '#ff6b6b', passenger: '#5aa9ff', fishing: '#ffb347', service: '#4fe0d2', leisure: '#e58cff', other: '#8ea7c3', trail: '#4fd1ff' },
  },

  matrix: {
    name: 'Matrix',
    swatch: ['#000a02', '#00ff41'],
    effect: 'rain',
    map: {
      land: '#000a02', landAlt: '#011806', water: '#000000',
      road: '#013a10', roadMajor: '#00a82b', casing: '#000000', rail: '#013a10',
      building: '#022a0b', boundary: '#00c832',
      label: '#00c832', labelMajor: '#7dff98', waterLabel: '#007a1f', halo: '#000000',
      relief: 0.15,
      space: '#000000', horizon: '#00ff41',
    },
    sat: { saturation: -1, contrast: 0.25, brightness: 0.75, tint: '#00ff41', tintOpacity: 0.3 },
    flights: {
      low: '#0fa83a', mid: '#00ff41', high: '#d4ffd9', ground: '#0b4a1a',
      mil: '#e8ff00', alert: '#ff2a2a', trail: '#00ff41', selected: '#ffffff',
    },
    satellites: { station: '#ffffff', constellation: '#0f8f32', gnss: '#b6ffbf', weather: '#e8ff00', geo: '#7dff98', other: '#3fae55', orbit: '#00ff41' },
    // World event markers, by severity; disc is the marker background.
    events: { minor: '#3fae55', significant: '#e8ff00', major: '#ff3030', disc: '#000a02' },
    // Ships by type (AIS category); trail is the selected ship's recent path.
    ships: { cargo: '#00ff41', tanker: '#e8ff00', passenger: '#ffffff', fishing: '#0fa83a', service: '#7dff98', leisure: '#b6ffbf', other: '#2f7a3f', trail: '#00ff41' },
  },

  royal: {
    name: 'Crimson & Gold',
    swatch: ['#3a0a14', '#d4af37'],
    effect: 'dust',
    map: {
      land: '#2a0710', landAlt: '#350b16', water: '#130309',
      road: '#4c1522', roadMajor: '#a8822a', casing: '#1a0408', rail: '#4c1522',
      building: '#3d0d18', boundary: '#d4af37',
      label: '#d9b968', labelMajor: '#f7dc85', waterLabel: '#7d2c3c', halo: '#130309',
      relief: 0.2,
      space: '#0d0205', horizon: '#d4af37',
    },
    sat: { saturation: -0.6, contrast: 0.1, brightness: 0.85, tint: '#8b0f1f', tintOpacity: 0.25 },
    flights: {
      low: '#c98b2a', mid: '#f0cf6b', high: '#fff4cf', ground: '#6b4a36',
      mil: '#ff7a7a', alert: '#ff2f4f', trail: '#f0cf6b', selected: '#ffffff',
    },
    satellites: { station: '#ffffff', constellation: '#a8822a', gnss: '#f7dc85', weather: '#ff9a7a', geo: '#e8c7ff', other: '#c9a77a', orbit: '#f0cf6b' },
    // World event markers, by severity; disc is the marker background.
    events: { minor: '#c9a77a', significant: '#ffd54a', major: '#ff4a3a', disc: '#1a050b' },
    // Ships by type (AIS category); trail is the selected ship's recent path.
    ships: { cargo: '#d4af37', tanker: '#ff6b5b', passenger: '#f7e7b0', fishing: '#ff9a7a', service: '#7fd1c7', leisure: '#e8c7ff', other: '#a08070', trail: '#f0cf6b' },
  },

  halloween: {
    name: 'Halloween',
    swatch: ['#1c0f28', '#ff7518'],
    effect: 'embers',
    map: {
      land: '#140a1c', landAlt: '#1d0f29', water: '#07030c',
      road: '#33180f', roadMajor: '#c75a12', casing: '#0a0410', rail: '#2a1438',
      building: '#251434', boundary: '#8a2be2',
      label: '#d9a066', labelMajor: '#ffb347', waterLabel: '#6b3fa0', halo: '#07030c',
      relief: 0.2,
      space: '#05010a', horizon: '#ff7518',
    },
    sat: { saturation: -0.7, contrast: 0.15, brightness: 0.8, tint: '#ff7518', tintOpacity: 0.18 },
    flights: {
      low: '#ff7518', mid: '#ffb347', high: '#d9b3ff', ground: '#4b3358',
      mil: '#7cff6b', alert: '#ff2a2a', trail: '#ffb347', selected: '#ffffff',
    },
    satellites: { station: '#ffffff', constellation: '#8a4fd1', gnss: '#7cff6b', weather: '#ffb347', geo: '#ff7518', other: '#b48a9f', orbit: '#ffb347' },
    // World event markers, by severity; disc is the marker background.
    events: { minor: '#b48a9f', significant: '#ffb347', major: '#ff2a2a', disc: '#0d0614' },
    // Ships by type (AIS category); trail is the selected ship's recent path.
    ships: { cargo: '#7cff6b', tanker: '#ff2a2a', passenger: '#d9b3ff', fishing: '#ffb347', service: '#4fe0d2', leisure: '#ff7518', other: '#b48a9f', trail: '#ffb347' },
  },
};
