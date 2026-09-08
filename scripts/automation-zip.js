'use strict';

// Small, bounded ZIP interchange for JSON tasks. No files are extracted to disk.
// Writes standard UTF-8/store ZIPs; reads store/deflate with central-directory sizes
// (including archives with data descriptors). ZIP64, encryption and split ZIPs fail closed.
const { inflateRawSync } = require('node:zlib');
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 512; // Allows Finder metadata alongside at most 200 tasks.
const fail = () => { throw new Error('ZIP 文件损坏、加密或格式不支持'); };
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function safeName(name) {
  if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.')) fail();
  return name;
}
function checkExtra(bytes, start, size) {
  const end = start + size;
  if (end > bytes.length) fail();
  while (start < end) {
    if (start + 4 > end || bytes.readUInt16LE(start) === 1) fail(); // ZIP64
    const length = bytes.readUInt16LE(start + 2);
    start += 4 + length;
    if (start > end) fail();
  }
}
function encodeZip(entries) {
  if (!entries.length || entries.length > MAX_ENTRIES) fail();
  const files = [], directory = [], names = new Set();
  let offset = 0, total = 0;
  for (const entry of entries) {
    const name = Buffer.from(safeName(entry.name)), content = Buffer.from(entry.content);
    if (names.has(entry.name) || name.length > 1024 || content.length > MAX_ENTRY_BYTES || (total += content.length) > MAX_BYTES) fail();
    names.add(entry.name);
    const local = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(content);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); local.copy(central, 6, 4, 30); central.writeUInt32LE(offset, 42);
    files.push(local, name, content); directory.push(central, name); offset += local.length + name.length + content.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...files, index, end]);
  if (result.length > MAX_BYTES) throw new Error('任务文件不能超过 8 MiB');
  return result;
}
function decodeZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_BYTES) fail();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail();
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryStart = bytes.readUInt32LE(end + 16);
  if (!count || count > MAX_ENTRIES || bytes.readUInt16LE(end + 8) !== count || directoryStart + directorySize !== end) fail();
  const entries = [], names = new Set(), ranges = [];
  let cursor = directoryStart, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || nameSize > 1024 || flags & ~0x80e || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34) || size > MAX_ENTRY_BYTES || (total += size) > MAX_BYTES) fail();
    checkExtra(bytes, cursor + 46 + nameSize, extraSize);
    // Reject symlinks even though this parser never extracts paths.
    if ((bytes.readUInt32LE(cursor + 38) >>> 16 & 0xf000) === 0xa000) fail();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize), name = safeName(nameBytes.toString('utf8'));
    if (names.has(name)) fail();
    names.add(name);
    if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail();
    const localNameSize = bytes.readUInt16LE(local + 26), dataStart = local + 30 + localNameSize + bytes.readUInt16LE(local + 28), dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryStart || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes) || ranges.some(([a, b]) => local < b && dataEnd > a)) fail();
    checkExtra(bytes, local + 30 + localNameSize, bytes.readUInt16LE(local + 28));
    ranges.push([local, dataEnd]);
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== size)) fail();
    const compressed = bytes.subarray(dataStart, dataEnd);
    let content;
    try { content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }); } catch (_) { fail(); }
    if (content.length !== size || crc32(content) !== crc) fail();
    entries.push({ name, content }); cursor = next;
  }
  if (cursor !== end) fail();
  return entries;
}
module.exports = { encodeZip, decodeZip, MAX_BYTES, MAX_ENTRY_BYTES };
