import { P_INIT, S_INIT } from './blowfish_const.js?v=1';

export class Blowfish {
  constructor(key) {
    this.p = Uint32Array.from(P_INIT);
    this.s = S_INIT.map((box) => Uint32Array.from(box));

    let k = 0;
    for (let i = 0; i < 18; i++) {
      let word = 0;
      for (let j = 0; j < 4; j++) {
        word = ((word << 8) | key[k % key.length]) >>> 0;
        k++;
      }
      this.p[i] = (this.p[i] ^ word) >>> 0;
    }

    let l = 0;
    let r = 0;
    for (let i = 0; i < 18; i += 2) {
      [l, r] = this._encryptBlock(l, r);
      this.p[i] = l;
      this.p[i + 1] = r;
    }
    for (let box = 0; box < 4; box++) {
      for (let i = 0; i < 256; i += 2) {
        [l, r] = this._encryptBlock(l, r);
        this.s[box][i] = l;
        this.s[box][i + 1] = r;
      }
    }
  }

  _f(x) {
    const s = this.s;
    const a = s[0][(x >>> 24) & 0xff];
    const b = s[1][(x >>> 16) & 0xff];
    const c = s[2][(x >>> 8) & 0xff];
    const d = s[3][x & 0xff];

    return ((((a + b) >>> 0) ^ c) + d) >>> 0;
  }

  _encryptBlock(l, r) {
    for (let i = 0; i < 16; i++) {
      l = (l ^ this.p[i]) >>> 0;
      r = (r ^ this._f(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    r = (r ^ this.p[16]) >>> 0;
    l = (l ^ this.p[17]) >>> 0;
    return [l, r];
  }

  _decryptBlock(l, r) {
    for (let i = 17; i > 1; i--) {
      l = (l ^ this.p[i]) >>> 0;
      r = (r ^ this._f(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    r = (r ^ this.p[1]) >>> 0;
    l = (l ^ this.p[0]) >>> 0;
    return [l, r];
  }

  decryptEcb(data) {
    const out = new Uint8Array(data.length);
    const src = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const dst = new DataView(out.buffer);
    for (let i = 0; i < data.length; i += 8) {
      const [l, r] = this._decryptBlock(src.getUint32(i, false), src.getUint32(i + 4, false));
      dst.setUint32(i, l, false);
      dst.setUint32(i + 4, r, false);
    }
    return out;
  }
}
