// 16-bit limbs avoid BigInt literals for < ES2020 MDX bundle targets; bit-identical to Go mdpat.Fnv64aHex (mod 2^64, no leading zeros).

export function fnv1a64Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  const p0 = 0x01b3;
  const p2 = 0x0100;
  for (let i = 0; i < bytes.length; i++) {
    h0 = (h0 ^ bytes[i]) & 0xffff;
    let r0 = h0 * p0;
    let r1 = h1 * p0;
    let r2 = h2 * p0 + h0 * p2;
    let r3 = h3 * p0 + h1 * p2;
    const c0 = Math.floor(r0 / 0x10000);
    r0 &= 0xffff;
    r1 += c0;
    const c1 = Math.floor(r1 / 0x10000);
    r1 &= 0xffff;
    r2 += c1;
    const c2 = Math.floor(r2 / 0x10000);
    r2 &= 0xffff;
    r3 = (r3 + c2) & 0xffff;
    h0 = r0;
    h1 = r1;
    h2 = r2;
    h3 = r3;
  }
  const hex = [h3, h2, h1, h0].map((n) => n.toString(16).padStart(4, '0')).join('');
  return hex.replace(/^0+(?=.)/, '');
}
