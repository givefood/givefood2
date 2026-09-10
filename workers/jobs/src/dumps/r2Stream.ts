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
  put(key: string, value: string, options?: unknown): Promise<unknown>;
}

export class R2CsvStream {
  private buffer: string[] = [];
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
    this.buffer.push(chunk);
    // byteLength, not .length: every non-ASCII character in the data -- and
    // there are thousands (3,217 change-line items, 3,127 article titles) --
    // costs more than one byte, so counting characters would under-measure
    // the buffer and could flush a part below R2's 5 MiB floor.
    const size = this.encoder.encode(chunk).byteLength;
    this.bufferBytes += size;
    this.bytes += size;
    if (this.bufferBytes >= PART_SIZE) await this.flushPart();
  }

  private async flushPart(): Promise<void> {
    const body = this.buffer.join("");
    this.buffer = [];
    this.bufferBytes = 0;
    if (!this.upload) {
      this.upload = await this.bucket.createMultipartUpload(this.key, { httpMetadata: this.httpMetadata });
    }
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, body));
  }

  /** Finishes the object. Returns the byte count written. */
  async close(): Promise<number> {
    if (!this.upload) {
      // Never reached the part size, so multipart buys nothing: one PUT.
      await this.bucket.put(this.key, this.buffer.join(""), { httpMetadata: this.httpMetadata });
      this.buffer = [];
      return this.bytes;
    }
    if (this.bufferBytes > 0) await this.flushPart();
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
