// Camada de dados: Supabase (nuvem) quando configurado, senão IndexedDB (só no aparelho).
import { CONFIG } from './config.js';

const TABLES = ['species', 'plantings', 'photos', 'readings', 'events', 'settings', 'harvests'];
const T = t => (CONFIG.tablePrefix || '') + t;
const BUCKET = () => CONFIG.bucket || 'fotos';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

// ---------- Local (IndexedDB) ----------
function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('horta', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of TABLES) if (!db.objectStoreNames.contains(t)) db.createObjectStore(t, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class LocalStore {
  mode = 'local';
  async init() { this.db = await openIdb(); this.urls = new Map(); return true; }
  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const s = tx.objectStore(store);
      const r = fn(s);
      tx.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }
  list(table) { return this._tx(table, 'readonly', s => s.getAll()); }
  async insert(table, row) {
    const r = { id: uid(), created_at: new Date().toISOString(), ...row };
    await this._tx(table, 'readwrite', s => s.put(r));
    return r;
  }
  async update(table, id, patch) {
    const cur = await this._tx(table, 'readonly', s => s.get(id));
    const r = { ...cur, ...patch };
    await this._tx(table, 'readwrite', s => s.put(r));
    return r;
  }
  remove(table, id) { return this._tx(table, 'readwrite', s => s.delete(id)); }
  async uploadPhoto(blob) {
    const path = uid() + '.jpg';
    await this._tx('blobs', 'readwrite', s => s.put(blob, path));
    return path;
  }
  async photoUrl(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    const blob = await this._tx('blobs', 'readonly', s => s.get(path));
    if (!blob) return '';
    const u = URL.createObjectURL(blob);
    this.urls.set(path, u);
    return u;
  }
  removePhoto(path) { return this._tx('blobs', 'readwrite', s => s.delete(path)); }
}

// ---------- Supabase ----------
class CloudStore {
  mode = 'cloud';
  async init() {
    const { createClient } = await import('./supabase.js');
    this.sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });
    this.urls = new Map();
    const { data } = await this.sb.auth.getSession();
    this.session = data.session;
    return !!this.session;
  }
  async signIn(email, password) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.session = data.session;
  }
  async signUp(email, password) {
    const { data, error } = await this.sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    this.session = data.session;
    return data;
  }
  async signOut() { await this.sb.auth.signOut(); this.session = null; }
  _chk({ data, error }) { if (error) throw error; return data; }
  async list(table) { return this._chk(await this.sb.from(T(table)).select('*')); }
  async insert(table, row) { return this._chk(await this.sb.from(T(table)).insert(row).select().single()); }
  async update(table, id, patch) { return this._chk(await this.sb.from(T(table)).update(patch).eq('id', id).select().single()); }
  async remove(table, id) { return this._chk(await this.sb.from(T(table)).delete().eq('id', id)); }
  async uploadPhoto(blob) {
    const path = `${this.session.user.id}/${uid()}.jpg`;
    this._chk(await this.sb.storage.from(BUCKET()).upload(path, blob, { contentType: 'image/jpeg' }));
    return path;
  }
  async photoUrl(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    const { data } = await this.sb.storage.from(BUCKET()).createSignedUrl(path, 60 * 60 * 24);
    const u = data?.signedUrl || '';
    this.urls.set(path, u);
    return u;
  }
  async removePhoto(path) { await this.sb.storage.from(BUCKET()).remove([path]); }
  async savePush(sub, device) {
    this._chk(await this.sb.from(T('push_subs')).upsert({ user_id: this.session.user.id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, device }, { onConflict: 'endpoint' }));
  }
  async testPush() {
    const { data, error } = await this.sb.functions.invoke('horta-lembretes', { body: { test: true } });
    if (error) throw error;
    return data;
  }
}

export function makeStore() {
  return CONFIG.supabaseUrl && CONFIG.supabaseKey ? new CloudStore() : new LocalStore();
}
