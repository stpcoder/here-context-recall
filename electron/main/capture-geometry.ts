import type { WindowBounds } from "../shared/contracts";

export type ImageSize = { width: number; height: number };

/** Maps Electron DIP window bounds into the actual captured thumbnail pixels. */
export function calculateCaptureCrop(
  display: WindowBounds,
  image: ImageSize,
  window: WindowBounds,
): WindowBounds | undefined {
  if (
    display.width <= 0 ||
    display.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0 ||
    window.width <= 0 ||
    window.height <= 0
  )
    return undefined;

  const left = Math.max(display.x, window.x);
  const top = Math.max(display.y, window.y);
  const right = Math.min(display.x + display.width, window.x + window.width);
  const bottom = Math.min(display.y + display.height, window.y + window.height);
  if (right <= left || bottom <= top) return undefined;

  const scaleX = image.width / display.width;
  const scaleY = image.height / display.height;
  const x = clamp(
    Math.round((left - display.x) * scaleX),
    0,
    image.width - 1,
  );
  const y = clamp(
    Math.round((top - display.y) * scaleY),
    0,
    image.height - 1,
  );
  const width = clamp(Math.round((right - left) * scaleX), 1, image.width - x);
  const height = clamp(
    Math.round((bottom - top) * scaleY),
    1,
    image.height - y,
  );
  return { x, y, width, height };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
