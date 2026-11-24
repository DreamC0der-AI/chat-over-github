/**
 * Attachment types. Pictures show inline; everything else is a file to download. SVG is not a
 * picture here: it is a document that can run script, and a blob: URL of it is same-origin.
 */
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

export const isImage = (mime?: string) => !!mime && INLINE_IMAGE.test(mime);

/** The type a decrypted attachment's blob gets: its own for pictures, otherwise one no browser renders. */
export const servedType = (mime?: string) => (isImage(mime) ? mime! : 'application/octet-stream');
