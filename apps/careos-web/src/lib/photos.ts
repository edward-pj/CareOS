// Photos stay in the browser: the preview shown beside what was read is the local file, and the server only holds the bytes
// for one read. Keyed by the upload id the server returned.

const previews = new Map<string, string>();

export function rememberPreview(uploadId: string, file: Blob): void {
  previews.set(uploadId, URL.createObjectURL(file));
  if (previews.size > 6) {
    const oldest = previews.keys().next().value!;
    URL.revokeObjectURL(previews.get(oldest)!);
    previews.delete(oldest);
  }
}

export const previewFor = (uploadId: string | undefined): string | undefined => (uploadId ? previews.get(uploadId) : undefined);
