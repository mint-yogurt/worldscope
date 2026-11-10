import { gunzipSync } from 'node:zlib';

export const USER_AGENT = 'WorldScope/0.1 (personal non-commercial map project)';

export class HttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// GET/POST JSON from an upstream API with a timeout. Handles bodies that are
// gzip files served without a Content-Encoding header (adsb.lol traces).
export async function fetchJson(url, { timeout = 15_000, headers = {}, ...opts } = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `${new URL(url).host} responded ${res.status}`,
      Number(res.headers.get('retry-after') || res.headers.get('x-rate-limit-retry-after-seconds')) || undefined);
  }
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}
