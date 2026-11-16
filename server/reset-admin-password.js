import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { hashPassword, encryptPassword, loadPasswordKey } from './passwords.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.QZZ_DATA_DIR || path.join(projectDir, 'data'));
const databaseFile = path.join(dataDir, 'platform.db');
if (!fs.existsSync(databaseFile)) throw new Error('Database does not exist; start the server once to initialize it');
const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (password.length < 6 || password.length > 200) throw new Error('Password must contain 6-200 characters');
const db = new Database(databaseFile);
try {
  const user = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
  if (!user) throw new Error('Reserved admin account does not exist');
  if (!db.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'password_encrypted')) {
    throw new Error('Start the updated server once to migrate the database before resetting the password');
  }
  const key = loadPasswordKey(dataDir, Boolean(db.prepare('SELECT 1 FROM users WHERE password_encrypted IS NOT NULL').get()));
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, password_encrypted = ?, role = 'admin', disabled = 0 WHERE id = ?")
      .run(hashPassword(password), encryptPassword(password, key), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO account_audit VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), user.id, user.id, 'password.local_reset', new Date().toISOString());
  })();
  const credentialFile = path.join(dataDir, 'initial-admin.txt');
  if (fs.existsSync(credentialFile)) fs.unlinkSync(credentialFile);
  console.log('Admin password updated; existing admin sessions were revoked.');
} finally { db.close(); }
