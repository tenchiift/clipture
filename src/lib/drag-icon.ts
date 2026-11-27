export const MINI_DRAG_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAH0lEQVR42mNk+M9QzwAEjAwM1AAjI6MBUQ2jGgYKAwB8uQMJ4J8WKwAAAABJRU5ErkJggg==';

const miniIconCache = new Map<string, string>();
const MINI_SIZE = 44;

export function getMiniDragIcon(
  clipId: string,
  containerEl?: HTMLElement | null,
): string {
  const cached = miniIconCache.get(clipId);
  if (cached) return cached;

  const imgEl =
    containerEl instanceof HTMLImageElement
      ? containerEl
      : containerEl?.querySelector('img');

  if (imgEl && imgEl.complete && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = MINI_SIZE;
      canvas.height = MINI_SIZE;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const iw = imgEl.naturalWidth;
        const ih = imgEl.naturalHeight;
        const side = Math.min(iw, ih);
        const sx = (iw - side) / 2;
        const sy = (ih - side) / 2;
        ctx.drawImage(imgEl, sx, sy, side, side, 0, 0, MINI_SIZE, MINI_SIZE);
        const miniUrl = canvas.toDataURL('image/png');
        miniIconCache.set(clipId, miniUrl);
        return miniUrl;
      }
    } catch {
      // Fallback to tiny default icon if canvas fails
    }
  }

  return MINI_DRAG_ICON_DATA_URL;
}
