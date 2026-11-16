import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export function loadPasswordKey(dataDir, hasEncryptedPasswords = false) {
  const keyFile = path.join(dataDir, 'password-key');
  if (!fs.existsSync(keyFile)) {
    if (hasEncryptedPasswords) throw new Error('Local password-key is missing; restore it from backup');
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('Invalid local password encryption key');
  return key;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt, encoded] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'hex');
  if (expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function encryptPassword(password, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptPassword(value, key) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
