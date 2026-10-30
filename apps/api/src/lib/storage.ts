import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../env';
import { HttpError } from './errors';

export interface StoredFile {
  size: number;
  /** First bytes of the file, for checking what it really is. */
  head: Buffer;
}

/**
 * Where uploaded files live. Keys are random and never come from user input.
 * The disk implementation is enough for one server or several sharing a volume;
 * an S3-compatible store would implement the same four methods.
 */
export interface FileStorage {
  put(key: string, body: Readable, maxBytes: number): Promise<StoredFile>;
  get(key: string): Readable;
  delete(key: string): Promise<void>;
  /** Every stored key with its last modification time, for garbage collection. */
  list(): Promise<{ key: string; modifiedAt: Date }[]>;
}

const HEAD_BYTES = 16;

export const fileTooLarge = (maxBytes: number) =>
  new HttpError(413, 'PAYLOAD_TOO_LARGE', `Files can be at most ${Math.floor(maxBytes / 1024 / 1024)} MB`);

/** Counts bytes as they pass, keeps the first few, and fails once the limit is crossed. */
function limiter(maxBytes: number, result: StoredFile) {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (result.head.length < HEAD_BYTES) {
        result.head = Buffer.concat([result.head, chunk.subarray(0, HEAD_BYTES - result.head.length)]);
      }
      result.size += chunk.length;
      if (result.size > maxBytes) return done(fileTooLarge(maxBytes));
      done(null, chunk);
    },
  });
}

export class DiskStorage implements FileStorage {
  constructor(private dir: string) {}

  private pathFor(key: string) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return path.join(this.dir, key);
  }

  async put(key: string, body: Readable, maxBytes: number) {
    await mkdir(this.dir, { recursive: true });
    const target = this.pathFor(key);
    // Write next to the target and rename at the end, so a half-written file never has the real name.
    const partial = `${target}.partial`;
    const result: StoredFile = { size: 0, head: Buffer.alloc(0) };
    try {
      await pipeline(body, limiter(maxBytes, result), createWriteStream(partial));
      await rename(partial, target);
      return result;
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }

  get(key: string) {
    return createReadStream(this.pathFor(key));
  }

  async delete(key: string) {
    const target = this.pathFor(key);
    await Promise.all([rm(target, { force: true }), rm(`${target}.partial`, { force: true })]);
  }

  async list() {
    const names = await readdir(this.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    const files = await Promise.all(
      names.map(async (name) => {
        const info = await stat(path.join(this.dir, name)).catch(() => null);
        // Partial files are listed under their final key so the sweep cleans up after crashed uploads.
        return info?.isFile() ? { key: name.replace(/\.partial$/, ''), modifiedAt: info.mtime, name } : null;
      }),
    );
    return files.filter((f) => f !== null).map(({ key, modifiedAt }) => ({ key, modifiedAt }));
  }
}

export const storage: FileStorage = new DiskStorage(path.resolve(env.UPLOAD_DIR));
