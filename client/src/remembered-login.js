import { gcm } from '@noble/ciphers/aes.js';

const STORAGE_KEY = 'qzz-remembered-login';

function keyStore(mode, action) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('qzz-local-credentials', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('keys', mode);
      const operation = action(transaction.objectStore('keys'));
      let result;
      operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  });
}

export async function forgetLogin() {
  localStorage.removeItem(STORAGE_KEY);
  await keyStore('readwrite', (store) => store.delete('login'));
}

export async function rememberLogin(username, password) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = gcm(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify({ username, password })));
  await keyStore('readwrite', (store) => store.put(key, 'login'));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ nonce: [...nonce], ciphertext: [...ciphertext] }));
}

export async function readRememberedLogin() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored) return null;
    const key = await keyStore('readonly', (store) => store.get('login'));
    if (!key) return null;
    const cleartext = gcm(key, new Uint8Array(stored.nonce)).decrypt(new Uint8Array(stored.ciphertext));
    return JSON.parse(new TextDecoder().decode(cleartext));
  } catch { await forgetLogin().catch(() => {}); return null; }
}
