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

/** A square of the source picture, in its own pixels. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

/** Open a picked file as a bitmap. Throws a readable message. */
export async function openPicture(file: Blob): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new Error('Pick a picture file.');
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error('This picture could not be opened.');
  }
}

/** The largest centred square: the crop when nobody moved anything. */
export function centreCrop(w: number, h: number): Crop {
  const size = Math.min(w, h);
  return { x: (w - size) / 2, y: (h - size) / 2, size };
}

/** Draw this square of the picture at AVATAR_PX and encode it as a small data URL. */
export function renderAvatar(bmp: CanvasImageSource & { width: number; height: number }, crop = centreCrop(bmp.width, bmp.height)): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff'; // transparent parts would turn black as JPEG
  ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
  ctx.drawImage(bmp, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_PX, AVATAR_PX);
  for (const q of [0.85, 0.7, 0.5]) {
    // WebP where the browser can write it (Safari writes PNG instead, so fall back to JPEG).
    let url = canvas.toDataURL('image/webp', q);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', q);
    if (safeAvatar(url)) return url;
  }
  throw new Error('This picture could not be made small enough.');
}

/** Picked file to picture, centre-cropped (no crop step). */
export async function makeAvatar(file: Blob, crop?: Crop): Promise<string> {
  const bmp = await openPicture(file);
  try {
    return renderAvatar(bmp, crop);
  } finally {
    bmp.close();
  }
}

/**
 * Crop maths for a square viewport of `view` px showing a w x h picture. `zoom` 1 = the picture
 * just covers the viewport; (cx, cy) is the picture point at the viewport centre, in picture px.
 * Returns the clamped state and the crop it stands for.
 */
export function fitCrop(w: number, h: number, view: number, zoom: number, cx: number, cy: number) {
  const z = Math.min(Math.max(zoom, 1), MAX_ZOOM);
  const size = Math.min(w, h) / z; // picture px seen across the viewport
  const half = size / 2;
  const x = Math.min(Math.max(cx, half), w - half);
  const y = Math.min(Math.max(cy, half), h - half);
  const scale = view / size; // screen px per picture px
  return { zoom: z, cx: x, cy: y, scale, crop: { x: x - half, y: y - half, size } as Crop };
}
export const MAX_ZOOM = 6;

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
