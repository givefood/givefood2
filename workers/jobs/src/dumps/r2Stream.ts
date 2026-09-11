// Streams a dump into R2 without ever holding it whole.
//
// This is the piece PLAN.md §8.8 said needed a Container. It does not: R2
// multipart takes parts of 5 MiB..5 GiB (up to 10,000 of them), so the ~63 MB
// items CSV is about eight 8 MiB parts and the isolate's high-water mark is
// one part, not one dump. The Container was proposed because "140 MB in a
// single string cannot exist in a 128 MB isolate" -- true, and irrelevant
// once nothing builds the single string.
//
// 8 MiB, not the 5 MiB minimum: the floor applies to every part except the
// last, and a buffer that flushes exactly at the floor would emit a final
// part of whatever is left over -- fine -- but leaves no room for the row
// that tips it over. Overshooting by one row is normal and harmless; landing
// under the floor on a NON-final part is a failed upload.
const PART_SIZE = 8 * 1024 * 1024;

export interface DumpTarget {
  createMultipartUpload(key: string, options?: unknown): Promise<R2MultipartUpload>;
  put(key: string, value: string | Uint8Array, options?: unknown): Promise<unknown>;
}

export class R2CsvStream {
  /** Encoded, not string: parts are sized in BYTES and must be cut exactly. */
  private chunks: Uint8Array[] = [];
  private bufferBytes = 0;
  private upload: R2MultipartUpload | null = null;
  private parts: R2UploadedPart[] = [];
  private encoder = new TextEncoder();
  /** Total bytes written, for the caller's log line. */
  bytes = 0;

  constructor(
    private bucket: DumpTarget,
    private key: string,
    private httpMetadata: Record<string, string>,
  ) {}

  async write(chunk: string): Promise<void> {
    const encoded = this.encoder.encode(chunk);
    this.chunks.push(encoded);
    this.bufferBytes += encoded.byteLength;
    this.bytes += encoded.byteLength;
    while (this.bufferBytes >= PART_SIZE) await this.flushExactPart();
  }

  private drain(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const all = new Uint8Array(this.bufferBytes);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    return all;
  }

  /**
   * Uploads EXACTLY PART_SIZE bytes and keeps the remainder.
   *
   * R2 requires every non-trailing part of a multipart upload to be the same
   * length, and rejects the whole object at completeMultipartUpload() if they
   * are not -- "All non-trailing parts must have the same length. (10048)".
   * Flushing "whatever is in the buffer once it passes the threshold" gives
   * parts of 8.0, 8.3, 8.1 MB and fails. The bug hid for two runs because the
   * foodbanks dump is 8.4 MB and makes exactly ONE non-trailing part, which is
   * trivially uniform; items is 63 MB and makes eight, which is not.
   *
   * Cut in bytes, never characters: the data is full of multi-byte text
   * (thousands of rows), so slicing the string would split a character across
   * two parts and corrupt the object.
   */
  private async flushExactPart(): Promise<void> {
    const all = this.drain();
    const body = all.subarray(0, PART_SIZE);
    const rest = all.subarray(PART_SIZE);
    this.chunks = rest.byteLength > 0 ? [rest.slice()] : [];
    this.bufferBytes = rest.byteLength;
    if (!this.upload) {
      this.upload = await this.bucket.createMultipartUpload(this.key, { httpMetadata: this.httpMetadata });
    }
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, body.slice()));
  }

  /** Finishes the object. Returns the byte count written. */
  async close(): Promise<number> {
    if (!this.upload) {
      // Never reached the part size, so multipart buys nothing: one PUT.
      await this.bucket.put(this.key, this.drain(), { httpMetadata: this.httpMetadata });
      this.chunks = [];
      return this.bytes;
    }
    // The trailing part may be any size, including smaller than the rest.
    if (this.bufferBytes > 0) {
      this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.drain()));
      this.chunks = [];
      this.bufferBytes = 0;
    }
    await this.upload.complete(this.parts);
    return this.bytes;
  }

  /**
   * Abandons a part-written object.
   *
   * An incomplete multipart upload is INVISIBLE to list() but still billed as
   * storage until R2's lifecycle rules expire it, so a run that dies halfway
   * must not simply be dropped on the floor.
   */
  async abort(): Promise<void> {
    if (this.upload) await this.upload.abort().catch(() => {});
  }
}
