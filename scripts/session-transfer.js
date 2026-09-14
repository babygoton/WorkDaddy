'use strict';

// v4 session archives: authenticated header + AES-GCM(gzip(framed records/files)).
// Only small metadata is buffered. Attachment bytes never become a JS string.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { requiredPassword, remapSessionArchivePath } = require('./secure-transfer');
const MAGIC = Buffer.from('WDS4\r\n\x1a\n');
const HEADER_SIZE = 52;
const MAX_METADATA = 1024 * 1024;
const MAX_FILES = 20000;

function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > MAX_METADATA) throw new Error('会话归档元数据过大');
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
  return Buffer.concat([prefix, data]);
}

// Exact reads and bounded copies over a single iterator, including HTTP uploads.
class ChunkReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; }
  async available() {
    while (this.offset === this.chunk.length) {
      const next = await this.iterator.next();
      if (next.done) return false;
      this.chunk = Buffer.from(next.value); this.offset = 0;
    }
    return true;
  }
  async *take(size) {
    while (size > 0) {
      if (!await this.available()) throw new Error('会话归档不完整或已损坏');
      const length = Math.min(size, this.chunk.length - this.offset);
      const data = this.chunk.subarray(this.offset, this.offset + length);
      this.offset += length; size -= length;
      yield data;
    }
  }
  async read(size) {
    const parts = [];
    for await (const part of this.take(size)) parts.push(part);
    return Buffer.concat(parts, size);
  }
  async metadata() {
    const size = (await this.read(4)).readUInt32BE();
    if (!size || size > MAX_METADATA) throw new Error('会话归档元数据无效');
    try { return JSON.parse((await this.read(size)).toString('utf8')); }
    catch (_) { throw new Error('会话归档元数据无效'); }
  }
  async *rest() {
    while (await this.available()) {
      const data = this.chunk.subarray(this.offset); this.offset = this.chunk.length;
      yield data;
    }
  }
  async close() { if (this.iterator.return) await this.iterator.return(); }
}

async function* archiveChunks(sessions) {
  yield frame({ type: 'archive', version: 4, count: sessions.length });
  for (const session of sessions) {
    yield frame({ type: 'session', record: session.record, count: session.files.length });
    for (const file of session.files) {
      remapSessionArchivePath(file.path, session.record.id, session.record.id);
      const handle = await fs.promises.open(file.source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.size) throw new Error('会话附件发生变化，请重新导出');
        yield frame({ type: 'file', path: file.path, size: stat.size });
        let total = 0;
        if (stat.size) {
          for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: stat.size - 1 })) {
            total += chunk.length; yield chunk;
          }
        }
        const after = await handle.stat();
        if (total !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('会话附件发生变化，请重新导出');
      } finally { await handle.close(); }
    }
  }
}

async function writeSessionTransfer(file, sessions, password) {
  requiredPassword(password);
  if (!Array.isArray(sessions) || !sessions.length || sessions.length > 100) throw new Error('单次最多导出 100 个会话');
  const header = Buffer.alloc(HEADER_SIZE); MAGIC.copy(header);
  crypto.randomFillSync(header, 8, 28);
  const key = crypto.scryptSync(password, header.subarray(8, 24), 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, header.subarray(24, 36));
  cipher.setAAD(header.subarray(0, 36));
  let created = false;
  try {
    await fs.promises.writeFile(file, header, { flag: 'wx', mode: 0o600 }); created = true;
    await pipeline(Readable.from(archiveChunks(sessions)), zlib.createGzip(), cipher,
      fs.createWriteStream(file, { flags: 'r+', start: HEADER_SIZE }));
    const handle = await fs.promises.open(file, 'r+');
    try { await handle.write(cipher.getAuthTag(), 0, 16, 36); } finally { await handle.close(); }
  } catch (error) {
    if (created) await fs.promises.rm(file, { force: true });
    throw error;
  }
}

async function readSessionTransfer(file, password, staging) {
  requiredPassword(password);
  // Unique private staging is owned by this operation and removed on every failure.
  await fs.promises.mkdir(staging, { mode: 0o700 });
  const compressed = path.join(staging, 'authenticated.gz');
  try {
    const handle = await fs.promises.open(file, 'r');
    const header = Buffer.alloc(HEADER_SIZE);
    try {
      const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0);
      if (bytesRead !== HEADER_SIZE || !header.subarray(0, 8).equals(MAGIC)) throw new Error('不是有效的 WorkDaddy 会话归档');
    } finally { await handle.close(); }
    const key = crypto.scryptSync(password, header.subarray(8, 24), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(24, 36));
    decipher.setAAD(header.subarray(0, 36)); decipher.setAuthTag(header.subarray(36, 52));
    // Verify the complete authentication tag before decompressing or restoring anything.
    try {
      await pipeline(fs.createReadStream(file, { start: HEADER_SIZE }), decipher,
        fs.createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      if (['ENOSPC', 'EACCES', 'EIO'].includes(error.code)) throw error;
      throw new Error('密码错误或导出文件已损坏');
    }
    const input = fs.createReadStream(compressed), gunzip = zlib.createGunzip();
    const pumping = pipeline(input, gunzip);
    // Attach rejection immediately; the reader also surfaces the stream failure.
    pumping.catch(() => {});
    const reader = new ChunkReader(gunzip), sessions = [];
    try {
      const root = await reader.metadata();
      if (root.type !== 'archive' || root.version !== 4 || !Number.isInteger(root.count) || root.count < 1 || root.count > 100) throw new Error('会话归档元数据无效');
      const ids = new Set();
      for (let i = 0; i < root.count; i++) {
        const meta = await reader.metadata();
        const id = meta.record && meta.record.id;
        if (meta.type !== 'session' || typeof id !== 'string' || !id || id.length > 200 || /[\x00-\x20/\\]/.test(id)
          || ids.has(id) || !Number.isInteger(meta.count) || meta.count < 0 || meta.count > MAX_FILES) throw new Error('会话归档元数据无效');
        ids.add(id);
        const files = [], paths = new Set();
        for (let j = 0; j < meta.count; j++) {
          const entry = await reader.metadata();
          if (entry.type !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('会话归档包含无效附件');
          const relative = remapSessionArchivePath(entry.path, id, id);
          if (paths.has(relative)) throw new Error('会话归档包含重复附件路径');
          paths.add(relative);
          const source = path.join(staging, `${i}-${j}.bin`);
          await pipeline(Readable.from(reader.take(entry.size)), fs.createWriteStream(source, { flags: 'wx', mode: 0o600 }));
          files.push({ path: relative, size: entry.size, source });
        }
        sessions.push({ record: meta.record, files });
      }
      if (await reader.available()) throw new Error('会话归档包含多余数据');
      await pumping;
      await fs.promises.unlink(compressed);
      return { exportType: 'WorkDaddy-sessions', version: 4, sessions };
    } finally {
      gunzip.destroy(); input.destroy();
      await reader.close(); await pumping.catch(() => {});
    }
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function receiveSessionUpload(input, directory) {
  const reader = new ChunkReader(input);
  const meta = await reader.metadata();
  requiredPassword(meta.password);
  if (meta.targetUid !== undefined && typeof meta.targetUid !== 'string') throw new Error('无效的账号归属');
  const file = path.join(directory, crypto.randomUUID() + '.wds');
  try {
    await pipeline(Readable.from(reader.rest()), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    return { file, password: meta.password, targetUid: meta.targetUid };
  } catch (error) {
    await fs.promises.rm(file, { force: true });
    throw error;
  }
}

module.exports = { writeSessionTransfer, readSessionTransfer, receiveSessionUpload };
