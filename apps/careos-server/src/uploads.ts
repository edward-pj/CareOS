import { randomUUID } from "node:crypto";
import type { ImageInput, ImageStore } from "open-caregiver-mcp";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const TTL_MS = 10 * 60_000;
const MAX_PER_HOUSEHOLD = 10;

/** The type of an image from its first bytes. The client's content-type header is never trusted. */
export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  return undefined;
}

interface Item { householdId: string; image: ImageInput; expires: number }

/**
 * Holds uploaded photos in memory just long enough for one read. Nothing is written to disk or to the database: a photo of a
 * prescription is sensitive, and the extracted fields (after a person confirms them) are all CareOS keeps. Each upload belongs
 * to one household, can be read once, and expires after ten minutes.
 */
export class UploadStore {
  private items = new Map<string, Item>();

  constructor(private clock: () => number = Date.now) {}

  /** Returns the new id, or an error string. */
  put(householdId: string, bytes: Uint8Array): { id: string; mime: string } | { error: "empty" | "too_large" | "not_an_image" | "too_many" } {
    this.sweep();
    if (bytes.length === 0) return { error: "empty" };
    if (bytes.length > MAX_UPLOAD_BYTES) return { error: "too_large" };
    const mime = sniffImage(bytes);
    if (!mime) return { error: "not_an_image" };
    if ([...this.items.values()].filter((i) => i.householdId === householdId).length >= MAX_PER_HOUSEHOLD) return { error: "too_many" };
    const id = `up_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.items.set(id, { householdId, image: { mime, bytes }, expires: this.clock() + TTL_MS });
    return { id, mime };
  }

  /** The image view one household gets: it can only ever take its own uploads. */
  forHousehold(householdId: string): ImageStore {
    return {
      take: async (id) => {
        this.sweep();
        const it = this.items.get(id);
        if (!it || it.householdId !== householdId) return undefined;
        this.items.delete(id);
        return it.image;
      },
    };
  }

  get size() { return this.items.size; }

  private sweep() {
    const now = this.clock();
    for (const [id, it] of this.items) if (it.expires <= now) this.items.delete(id);
  }
}
