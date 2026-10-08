/*
 * Full-backup file format (.dsbackup). Pure: no database, no HTTP — shared by
 * the server (lib/backup-service.js) and the offline tool (scripts/restore-backup.js).
 *
 *   "DSBACKUP\n" | uint32 BE header length | header JSON | ciphertext | 16-byte GCM tag
 *
 * The header holds only the encryption parameters (scrypt salt/cost, GCM IV) and is
 * authenticated as additional data, so changing any byte of the file fails decryption.
 * The plaintext is a gzipped JSON bundle: { manifest, files: [{ path, size, sha256, data }] }.
 */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const MAGIC = Buffer.from('DSBACKUP\n', 'utf8');
const FORMAT = 1;            // bundle/manifest layout this code reads and writes
const TAG_BYTES = 16;
const HEADER_MAX = 4096;
// scrypt N=2^17, r=8: ~128 MB and a few hundred ms per guess — slow enough to make guessing expensive
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const KDF_MAX_N = 2 ** 18;   // 256 MB; a file asking for more is refused instead of exhausting memory
const PLAIN_MAX = 512 * 1024 * 1024; // decompressed bundle cap (guards against a zip bomb)

const BAD_FILE = 'This is not a Daily Scrum full backup, or the file is damaged.';
const BAD_PASSWORD = 'Wrong password, or the backup file is damaged.';

function formatError(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function deriveKey(password, salt, k) {
  return scrypt(String(password), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r + 32 * 1024 * 1024 });
}

/**
 * A bundle path must be a plain relative path inside db/, app/ or the top level:
 * no absolute paths, drive letters, backslashes, "." or ".." segments, or control characters.
 */
function isSafePath(p) {
  if (typeof p !== 'string' || !p || p.length > 300) return false;
  if (/[\\\x00-\x1f:*?"<>|]/.test(p) || p.startsWith('/')) return false;
  return p.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

/** Builds the plaintext bundle. files: [{ path, data: Buffer }]. */
function packBundle(manifest, files) {
  const list = files.map((f) => {
    if (!isSafePath(f.path)) throw new Error('Unsafe backup path: ' + f.path);
    return { path: f.path, size: f.data.length, sha256: sha256(f.data), data: f.data.toString('base64') };
  });
  return zlib.gzipSync(Buffer.from(JSON.stringify({ manifest: Object.assign({ format: FORMAT }, manifest), files: list }), 'utf8'));
}

/** Reads and checks a bundle: format version, every path and every checksum. Returns { manifest, files: Map path→Buffer }. */
function unpackBundle(gz) {
  let json;
  try { json = JSON.parse(zlib.gunzipSync(gz, { maxOutputLength: PLAIN_MAX }).toString('utf8')); }
  catch (_) { throw formatError(BAD_FILE, 'damaged'); }
  if (!json || typeof json !== 'object' || !json.manifest || !Array.isArray(json.files)) throw formatError(BAD_FILE, 'damaged');
  const format = Number(json.manifest.format);
  if (!Number.isInteger(format) || format < 1) throw formatError(BAD_FILE, 'damaged');
  if (format > FORMAT) {
    throw formatError('This backup was made by a newer version of Daily Scrum (backup format ' + format +
      '). Update the app before restoring it.', 'unsupported');
  }
  const files = new Map();
  for (const f of json.files) {
    if (!f || !isSafePath(f.path) || files.has(f.path)) throw formatError('The backup lists an unsafe or repeated file path.', 'damaged');
    const data = Buffer.from(String(f.data || ''), 'base64');
    if (data.length !== f.size || sha256(data) !== f.sha256) {
      throw formatError('A file in the backup failed its checksum (' + f.path + '). The backup is damaged.', 'checksum');
    }
    files.set(f.path, data);
  }
  return { manifest: json.manifest, files };
}

/** Encrypts a bundle with a password: AES-256-GCM, key from scrypt with a random salt. */
async function encrypt(bundle, password, kdf = KDF) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({
    v: 1, kdf: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64'), cipher: 'aes-256-gcm', iv: iv.toString('base64'),
  }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const aad = Buffer.concat([MAGIC, len, header]);
  const key = await deriveKey(password, salt, kdf);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(bundle), cipher.final()]);
  return Buffer.concat([aad, body, cipher.getAuthTag()]);
}

/** Reads the unencrypted header; throws a 400 for anything that is not a well-formed backup. */
function readHeader(file) {
  if (!Buffer.isBuffer(file) || file.length < MAGIC.length + 4 + TAG_BYTES || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw formatError(BAD_FILE, 'damaged');
  }
  const len = file.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (len < 2 || len > HEADER_MAX || start + len + TAG_BYTES > file.length) throw formatError(BAD_FILE, 'damaged');
  let h;
  try { h = JSON.parse(file.subarray(start, start + len).toString('utf8')); } catch (_) { throw formatError(BAD_FILE, 'damaged'); }
  if (!h || h.v !== 1) {
    throw formatError('This backup uses an encryption format this version does not know. Update the app before restoring it.', 'unsupported');
  }
  const N = Number(h.N); const r = Number(h.r); const p = Number(h.p);
  const powerOfTwo = Number.isInteger(N) && N >= 2 ** 14 && N <= KDF_MAX_N && (N & (N - 1)) === 0;
  if (h.kdf !== 'scrypt' || h.cipher !== 'aes-256-gcm' || !powerOfTwo || r !== 8 || p !== 1) throw formatError(BAD_FILE, 'damaged');
  const salt = Buffer.from(String(h.salt || ''), 'base64');
  const iv = Buffer.from(String(h.iv || ''), 'base64');
  if (salt.length !== 16 || iv.length !== 12) throw formatError(BAD_FILE, 'damaged');
  return { kdf: { N, r, p }, salt, iv, bodyStart: start + len };
}

/** Decrypts and verifies a backup file. Returns { manifest, files }. */
async function decrypt(file, password) {
  const h = readHeader(file);
  const key = await deriveKey(password, h.salt, h.kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, h.iv);
  decipher.setAAD(file.subarray(0, h.bodyStart));
  decipher.setAuthTag(file.subarray(file.length - TAG_BYTES));
  let plain;
  try { plain = Buffer.concat([decipher.update(file.subarray(h.bodyStart, file.length - TAG_BYTES)), decipher.final()]); }
  catch (_) { throw formatError(BAD_PASSWORD, 'password'); }
  return unpackBundle(plain);
}

module.exports = { FORMAT, KDF, MAGIC, isSafePath, sha256, packBundle, unpackBundle, encrypt, decrypt, readHeader };
