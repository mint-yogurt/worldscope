// Minimal GRIB2 decoder: just enough for NOAA GFS fields from the NOMADS
// filter. Supports grid template 3.0 (regular lat/lon), product template 4.x
// (reads category/parameter), data templates 5.0 (simple packing) and 5.3
// (complex packing with spatial differencing), and no bitmap.
// Spec: https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/

class BitReader {
  constructor(buf, byteOffset) {
    this.buf = buf;
    this.pos = byteOffset * 8;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3];
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  alignByte() {
    this.pos = Math.ceil(this.pos / 8) * 8;
  }
}

// GRIB2 signed integers are sign-and-magnitude, not two's complement.
function signedN(buf, offset, bytes) {
  let v = 0;
  for (let i = 0; i < bytes; i++) v = v * 256 + buf[offset + i];
  const signBit = 2 ** (bytes * 8 - 1);
  return v >= signBit ? -(v - signBit) : v;
}

function unpackSimple(s5, s7) {
  const R = s5.readFloatBE(11);
  const E = signedN(s5, 15, 2);
  const D = signedN(s5, 17, 2);
  const nbits = s5[19];
  const n = s5.readUInt32BE(5);
  const out = new Float32Array(n);
  const bits = new BitReader(s7, 5);
  for (let i = 0; i < n; i++) out[i] = (R + (nbits ? bits.read(nbits) : 0) * 2 ** E) / 10 ** D;
  return out;
}

function unpackComplexSpatial(s5, s7) {
  const n = s5.readUInt32BE(5);
  const R = s5.readFloatBE(11);
  const E = signedN(s5, 15, 2);
  const D = signedN(s5, 17, 2);
  const nbits = s5[19];
  const missingMgmt = s5[22];
  const ng = s5.readUInt32BE(31);
  const refWidth = s5[35];
  const bitsWidth = s5[36];
  const refLen = s5.readUInt32BE(37);
  const lenIncr = s5[41];
  const lastLen = s5.readUInt32BE(42);
  const bitsLen = s5[46];
  const order = s5[47];
  const nExtra = s5[48];
  if (missingMgmt !== 0) throw new Error('GRIB2: missing-value management not supported');
  if (order !== 1 && order !== 2) throw new Error(`GRIB2: spatial differencing order ${order} not supported`);

  // Extra descriptors: the first `order` original values, then the overall minimum.
  let o = 5;
  const first = [];
  for (let i = 0; i < order; i++, o += nExtra) first.push(signedN(s7, o, nExtra));
  const minimum = signedN(s7, o, nExtra);
  o += nExtra;

  const bits = new BitReader(s7, o);
  const refs = new Array(ng);
  for (let g = 0; g < ng; g++) refs[g] = bits.read(nbits);
  bits.alignByte();
  const widths = new Array(ng);
  for (let g = 0; g < ng; g++) widths[g] = refWidth + bits.read(bitsWidth);
  bits.alignByte();
  const lens = new Array(ng);
  for (let g = 0; g < ng; g++) lens[g] = refLen + bits.read(bitsLen) * lenIncr;
  lens[ng - 1] = lastLen;
  bits.alignByte();

  const x = new Float64Array(n);
  let k = 0;
  for (let g = 0; g < ng; g++) {
    for (let j = 0; j < lens[g]; j++) x[k++] = refs[g] + (widths[g] ? bits.read(widths[g]) : 0);
  }
  if (k !== n) throw new Error(`GRIB2: unpacked ${k} values, expected ${n}`);

  // Undo spatial differencing.
  if (order === 1) {
    x[0] = first[0];
    for (let i = 1; i < n; i++) x[i] = x[i] + minimum + x[i - 1];
  } else {
    x[0] = first[0];
    x[1] = first[1];
    for (let i = 2; i < n; i++) x[i] = x[i] + minimum + 2 * x[i - 1] - x[i - 2];
  }
  const out = new Float32Array(n);
  const scale = 2 ** E;
  const dscale = 10 ** D;
  for (let i = 0; i < n; i++) out[i] = (R + x[i] * scale) / dscale;
  return out;
}

// Returns [{ category, parameter, grid: { nx, ny, la1, lo1, dx, dy }, values }].
export function decodeGrib2(buf) {
  const messages = [];
  let offset = 0;
  while (offset < buf.length - 4) {
    if (buf.toString('ascii', offset, offset + 4) !== 'GRIB') throw new Error('GRIB2: bad message header');
    const total = Number(buf.readBigUInt64BE(offset + 8));
    const msg = {};
    let s5;
    let p = offset + 16;
    while (p < offset + total - 4) {
      const len = buf.readUInt32BE(p);
      const num = buf[p + 4];
      const sec = buf.subarray(p, p + len);
      if (num === 3) {
        if (sec.readUInt16BE(12) !== 0) throw new Error('GRIB2: only lat/lon grids supported');
        msg.grid = {
          nx: sec.readUInt32BE(30),
          ny: sec.readUInt32BE(34),
          la1: signedN(sec, 46, 4) / 1e6,
          lo1: signedN(sec, 50, 4) / 1e6,
          dx: sec.readUInt32BE(63) / 1e6,
          dy: sec.readUInt32BE(67) / 1e6 * ((sec[71] & 0x40) ? 1 : -1), // scan +j means south→north
        };
      } else if (num === 4) {
        msg.category = sec[9];
        msg.parameter = sec[10];
      } else if (num === 5) {
        s5 = sec;
      } else if (num === 6) {
        if (sec[5] !== 255) throw new Error('GRIB2: bitmaps not supported');
      } else if (num === 7) {
        const tmpl = s5.readUInt16BE(9);
        if (tmpl === 0) msg.values = unpackSimple(s5, sec);
        else if (tmpl === 3) msg.values = unpackComplexSpatial(s5, sec);
        else throw new Error(`GRIB2: data template 5.${tmpl} not supported`);
      }
      p += len;
    }
    messages.push(msg);
    offset += total;
  }
  return messages;
}
