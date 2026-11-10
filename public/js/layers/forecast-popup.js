// HTML for the click-for-forecast popup (Open-Meteo forecast response).

import { esc } from './flight-panel.js';

// WMO weather codes -> [label, day icon, night icon]
const WMO = {
  0: ['Clear sky', '☀️', '🌙'], 1: ['Mainly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️', '☁️'],
  45: ['Fog', '🌫️', '🌫️'], 48: ['Freezing fog', '🌫️', '🌫️'],
  51: ['Light drizzle', '🌦️', '🌧️'], 53: ['Drizzle', '🌦️', '🌧️'], 55: ['Heavy drizzle', '🌧️', '🌧️'],
  56: ['Freezing drizzle', '🌧️', '🌧️'], 57: ['Freezing drizzle', '🌧️', '🌧️'],
  61: ['Light rain', '🌦️', '🌧️'], 63: ['Rain', '🌧️', '🌧️'], 65: ['Heavy rain', '🌧️', '🌧️'],
  66: ['Freezing rain', '🌧️', '🌧️'], 67: ['Freezing rain', '🌧️', '🌧️'],
  71: ['Light snow', '🌨️', '🌨️'], 73: ['Snow', '🌨️', '🌨️'], 75: ['Heavy snow', '❄️', '❄️'], 77: ['Snow grains', '🌨️', '🌨️'],
  80: ['Rain showers', '🌦️', '🌧️'], 81: ['Rain showers', '🌧️', '🌧️'], 82: ['Violent showers', '⛈️', '⛈️'],
  85: ['Snow showers', '🌨️', '🌨️'], 86: ['Snow showers', '🌨️', '🌨️'],
  95: ['Thunderstorm', '⛈️', '⛈️'], 96: ['Thunderstorm, hail', '⛈️', '⛈️'], 99: ['Thunderstorm, hail', '⛈️', '⛈️'],
};
const wmo = (code, day = true) => {
  const w = WMO[code] || ['—', '·', '·'];
  return { label: w[0], icon: day ? w[1] : w[2] };
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];
const r = (n) => Math.round(n);

// 24 h temperature line with precipitation bars underneath.
function sparkline(hourly) {
  const W = 248;
  const H = 54;
  const temps = hourly.temperature_2m;
  const precip = hourly.precipitation;
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const span = hi - lo || 1;
  const step = W / (temps.length - 1);
  const y = (t) => 6 + (1 - (t - lo) / span) * (H - 22);
  const line = temps.map((t, i) => `${(i * step).toFixed(1)},${y(t).toFixed(1)}`).join(' ');
  const maxP = Math.max(2, ...precip);
  const bars = precip.map((p, i) => {
    if (p <= 0) return '';
    const bh = (p / maxP) * 14;
    return `<rect x="${(i * step - 3).toFixed(1)}" y="${H - bh}" width="6" height="${bh.toFixed(1)}" class="wx-bar"/>`;
  }).join('');
  const hours = [0, 6, 12, 18, 24].filter((i) => i < hourly.time.length)
    .map((i) => `<text x="${Math.min(W - 14, i * step)}" y="${H + 11}">${hourly.time[i].slice(11, 13)}h</text>`).join('');
  return `
    <svg class="wx-spark" viewBox="0 -2 ${W} ${H + 14}" preserveAspectRatio="none" aria-label="Temperature next 24 hours">
      ${bars}
      <polyline points="${line}" class="wx-line"/>
      <text x="0" y="${y(hi) - 2}" class="wx-hi">${r(hi)}°</text>
      <text x="0" y="${y(lo) + 10}" class="wx-lo">${r(lo)}°</text>
      ${hours}
    </svg>`;
}

export function forecastHtml(f, lngLat) {
  const c = f.current;
  const now = wmo(c.weather_code, c.is_day === 1);
  const lat = `${Math.abs(lngLat.lat).toFixed(2)}°${lngLat.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(lngLat.lng).toFixed(2)}°${lngLat.lng >= 0 ? 'E' : 'W'}`;
  const days = f.daily.time.map((t, i) => {
    const d = wmo(f.daily.weather_code[i]);
    const name = i === 0 ? 'Today' : new Date(`${t}T12:00`).toLocaleDateString(undefined, { weekday: 'short' });
    return `<li><span>${name}</span><span title="${d.label}">${d.icon}</span><b>${r(f.daily.temperature_2m_max[i])}°</b><span class="wx-dim">${r(f.daily.temperature_2m_min[i])}°</span></li>`;
  }).join('');

  return `
    <div class="wx-pop">
      <div class="wx-pop-head">
        <span class="wx-icon">${now.icon}</span>
        <div><b class="wx-temp">${r(c.temperature_2m)}°C</b><span>${now.label}</span></div>
      </div>
      <p class="wx-pop-sub">Feels like ${r(c.apparent_temperature)}° · ${lat} ${lon} · ${esc(f.timezone_abbreviation || f.timezone)}</p>
      <dl class="wx-pop-stats">
        <div><dt>Wind</dt><dd>${r(c.wind_speed_10m)} km/h ${compass(c.wind_direction_10m)}</dd></div>
        <div><dt>Gusts</dt><dd>${r(c.wind_gusts_10m)} km/h</dd></div>
        <div><dt>Humidity</dt><dd>${r(c.relative_humidity_2m)}%</dd></div>
        <div><dt>Clouds</dt><dd>${r(c.cloud_cover)}%</dd></div>
        <div><dt>Pressure</dt><dd>${r(c.pressure_msl)} hPa</dd></div>
        <div><dt>Precip</dt><dd>${c.precipitation} mm</dd></div>
      </dl>
      ${sparkline(f.hourly)}
      <ul class="wx-days">${days}</ul>
      <p class="wx-pop-src">Forecast: Open-Meteo</p>
    </div>`;
}
