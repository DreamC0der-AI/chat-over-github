/**
 * Group pictures. An uploaded picture is shrunk to a small square and travels inside the group's
 * encrypted `meta` message as a data URL, so members get it with no extra GitHub request. Without
 * one, every member draws the same pattern from the group id.
 */

/** Side of the stored picture, in pixels (shown at up to 56 px, so this is sharp on 2x screens). */
export const AVATAR_PX = 128;
/** Largest data URL accepted from anyone: keeps the meta message small. */
export const MAX_AVATAR_CHARS = 48_000;

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A picture string from a group's meta message, if it is one we'll show; else undefined. */
export function safeAvatar(s: unknown): string | undefined {
  return typeof s === 'string' && s.length <= MAX_AVATAR_CHARS && DATA_URL.test(s) ? s : undefined;
}

/** Shrink and centre-crop a picked file to a small square data URL. Throws a readable message. */
export async function makeAvatar(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Pick a picture file.');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('This picture could not be opened.');
  }
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff'; // transparent parts would turn black as JPEG
  ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  bmp.close();
  for (const q of [0.85, 0.7, 0.5]) {
    // WebP where the browser can write it (Safari writes PNG instead, so fall back to JPEG).
    let url = canvas.toDataURL('image/webp', q);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', q);
    if (safeAvatar(url)) return url;
  }
  throw new Error('This picture could not be made small enough.');
}

/** 32-bit FNV-1a, then a few xorshift rounds for more bits. Stable on every browser. */
function bits(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  let x = h || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

export interface Pattern {
  /** Index into the six theme tints (--t0..--t5). */
  tint: number;
  /** SVG path data on a 10 x 10 canvas, drawn in the tint's foreground colour. */
  d: string;
}

/**
 * The default picture: a 4 x 4 mosaic, mirrored left to right. Each cell is empty, a full tile,
 * or a quarter disc rounded toward the centre, so neighbouring discs join into dots and arches
 * rather than reading as pixels. Cells sit in a 1-unit margin on a 10-unit canvas.
 */
export function groupPattern(key: string): Pattern {
  const next = bits(`group-avatar:${key}`);
  const tint = next() % 6;
  const cells: number[] = []; // 0 empty, 1 tile, 2 quarter disc
  for (let i = 0; i < 8; i++) cells.push(next() % 3);
  // Never too empty: at least three of the eight cells are filled.
  for (let i = 0, filled = cells.filter(Boolean).length; filled < 3; i = (i + 3) % 8) {
    if (!cells[i]) { cells[i] = 1 + (next() % 2); filled++; }
  }
  const S = 2; // cell size
  const O = 1; // margin
  const parts: string[] = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) {
      const kind = cells[row * 2 + col]!;
      if (!kind) continue;
      for (const c of [col, 3 - col]) {
        const x = O + c * S;
        const y = O + row * S;
        if (kind === 1) {
          parts.push(`M${x} ${y}h${S}v${S}h${-S}z`);
          continue;
        }
        // A quarter circle centred on the outer corner: its round side faces the middle.
        const left = c < 2;
        const top = row < 2;
        const cx = left ? x + S : x; // inner corner
        const cy = top ? y + S : y;
        const ox = left ? x : x + S; // outer corner, cut round
        const oy = top ? y : y + S;
        const sweep = left === top ? 1 : 0;
        parts.push(`M${cx} ${cy}L${ox} ${cy}A${S} ${S} 0 0 ${sweep} ${cx} ${oy}Z`);
      }
    }
  }
  return { tint, d: parts.join('') };
}
