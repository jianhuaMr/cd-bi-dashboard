/* ===== CD-BI storage layer: Supabase cloud first, IndexedDB fallback ===== */
(function (global) {
  'use strict';

  const DB_NAME = 'cdbi';
  const DB_VER = 7;
  const STORES = [
    'summary',
    'detail',
    'kuaishou',
    'meta',
    'exchangeRates',
    'inventoryMonthly',
    'inventoryMovementMonthly',
    'monthlyCostAnalysis',
    'productMaster',
    'uploadRecords',
  ];
  const DATA_STORES = STORES.filter(s => s !== 'meta');

  const CLOUD = {
    enabled: true,
    url: 'https://loooajojyuxsgbjjzzvs.supabase.co',
    key: 'sb_publishable_udQnr2K3DDnnlCLaQENvsw_ZKfxniVv',
    table: 'cdbi_records',
    pollMs: 15000,
  };
  const SESSION_KEY = 'cdbi_supabase_session';

  let dbp = null;
  let cloudBroken = false;
  let lastCloudStamp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      const out = fn(os);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    }));
  }

  function localPut(store, key, val) { return tx(store, 'readwrite', os => os.put(val, key)); }
  function localDel(store, key) { return tx(store, 'readwrite', os => os.delete(key)); }
  function localClear(store) { return tx(store, 'readwrite', os => os.clear()); }

  function localGetAll(store) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readonly');
      const os = t.objectStore(store);
      const keys = os.getAllKeys();
      const vals = os.getAll();
      t.oncomplete = () => {
        const out = {};
        keys.result.forEach((k, i) => { out[k] = vals.result[i]; });
        resolve(out);
      };
      t.onerror = () => reject(t.error);
    }));
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function setSession(session) {
    if (!session) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function sessionExpired(session) {
    if (!session || !session.access_token) return true;
    if (!session.expires_at) return false;
    return Date.now() > (Number(session.expires_at) * 1000 - 60000);
  }

  async function authRequest(path, body) {
    const res = await fetch(`${CLOUD.url}${path}`, {
      method: 'POST',
      headers: {
        apikey: CLOUD.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(txt || res.statusText);
    }
    return parseJsonResponse(res);
  }

  async function refreshSession(session) {
    if (!session || !session.refresh_token) return null;
    const next = await authRequest('/auth/v1/token?grant_type=refresh_token', {
      refresh_token: session.refresh_token,
    });
    setSession(next);
    return next;
  }

  async function ensureSession() {
    let session = getSession();
    if (sessionExpired(session)) session = await refreshSession(session);
    return session;
  }

  function cloudReady() {
    const session = getSession();
    return CLOUD.enabled && CLOUD.url && CLOUD.key && !cloudBroken && typeof fetch === 'function' && !!(session && session.access_token);
  }

  function isCloudConfigured() {
    return !!(CLOUD.enabled && CLOUD.url && CLOUD.key && typeof fetch === 'function');
  }

  function hasCloudSession() {
    const session = getSession();
    return !!(session && session.access_token);
  }

  async function cloudRequest(path, options = {}) {
    if (!cloudReady()) throw new Error('cloud storage disabled');
    const session = await ensureSession();
    if (!session || !session.access_token) throw new Error('请先登录云端账号');
    const res = await fetch(`${CLOUD.url}${path}`, {
      ...options,
      headers: {
        apikey: CLOUD.key,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Supabase ${res.status}: ${txt || res.statusText}`);
    }
    return parseJsonResponse(res, options);
  }

  async function parseJsonResponse(res, options = {}) {
    if (res.status === 204) return null;
    const txt = await res.text().catch(() => '');
    if (!txt || !txt.trim()) return null;
    const prefer = String((options.headers && (options.headers.Prefer || options.headers.prefer)) || '');
    if (/return=minimal/i.test(prefer)) return null;
    try {
      return JSON.parse(txt);
    } catch (err) {
      const contentType = res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '';
      if (res.ok && !/json/i.test(contentType)) return null;
      throw new Error(`Supabase returned non-JSON response: ${txt.slice(0, 160)}`);
    }
  }

  function enc(v) {
    return encodeURIComponent(v);
  }

  async function cloudPut(store, key, val) {
    const row = {
      store_name: store,
      record_key: String(key),
      payload: val,
      updated_at: new Date().toISOString(),
    };
    return cloudRequest(`/rest/v1/${CLOUD.table}?on_conflict=store_name,record_key`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
  }

  async function cloudDel(store, key) {
    return cloudRequest(`/rest/v1/${CLOUD.table}?store_name=eq.${enc(store)}&record_key=eq.${enc(String(key))}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  }

  async function cloudClear(store) {
    return cloudRequest(`/rest/v1/${CLOUD.table}?store_name=eq.${enc(store)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
  }

  async function cloudGetAll(store) {
    const rows = await cloudRequest(`/rest/v1/${CLOUD.table}?store_name=eq.${enc(store)}&select=record_key,payload&order=record_key.asc`);
    const out = {};
    for (const row of rows || []) out[row.record_key] = row.payload;
    return out;
  }

  async function cloudLatestStamp() {
    const rows = await cloudRequest(`/rest/v1/${CLOUD.table}?select=updated_at&order=updated_at.desc&limit=1`);
    return rows && rows[0] ? rows[0].updated_at : '';
  }

  async function pushLocalStoreIfCloudEmpty(store, localObj) {
    const entries = Object.entries(localObj || {});
    if (!entries.length) return;
    for (const [key, val] of entries) await cloudPut(store, key, val);
  }

  async function put(store, key, val) {
    await localPut(store, key, val);
    if (!cloudReady()) return;
    try {
      await cloudPut(store, key, val);
      lastCloudStamp = new Date().toISOString();
    } catch (err) {
      console.warn('[CD-BI] Supabase write failed, local copy kept:', err);
      throw err;
    }
  }

  async function del(store, key) {
    await localDel(store, key);
    if (!cloudReady()) return;
    try {
      await cloudDel(store, key);
      lastCloudStamp = new Date().toISOString();
    } catch (err) {
      console.warn('[CD-BI] Supabase delete failed, local copy deleted:', err);
      throw err;
    }
  }

  async function getAll(store) {
    const localObj = await localGetAll(store);
    if (!cloudReady()) return localObj;
    try {
      const cloudObj = await cloudGetAll(store);
      if (Object.keys(cloudObj).length) {
        for (const [key, val] of Object.entries(cloudObj)) await localPut(store, key, val);
        return cloudObj;
      }
      if (Object.keys(localObj).length) {
        await pushLocalStoreIfCloudEmpty(store, localObj);
      }
      return localObj;
    } catch (err) {
      cloudBroken = true;
      console.warn('[CD-BI] Supabase read failed, using local IndexedDB:', err);
      return localObj;
    }
  }

  async function exportAll() {
    return {
      _app: 'cdbi-backup',
      _ver: 7,
      _exportedAt: new Date().toISOString(),
      summary: await getAll('summary'),
      detail: await getAll('detail'),
      kuaishou: await getAll('kuaishou'),
      inventoryMonthly: await getAll('inventoryMonthly'),
      inventoryMovementMonthly: await getAll('inventoryMovementMonthly'),
      monthlyCostAnalysis: await getAll('monthlyCostAnalysis'),
      productMaster: await getAll('productMaster'),
      uploadRecords: await getAll('uploadRecords'),
      exchangeRates: await getAll('exchangeRates'),
    };
  }

  async function importAll(data) {
    if (!data || data._app !== 'cdbi-backup') throw new Error('不是有效的 CD-BI 备份文件');
    if (typeof data._ver !== 'number') throw new Error('备份文件缺少版本号');
    const perStoreMax = 50000;
    for (const s of DATA_STORES) {
      const entries = data[s] ? Object.entries(data[s]) : [];
      if (entries.length > perStoreMax) throw new Error(`备份 ${s} 行数过多: ${entries.length}`);
      for (const [k, v] of entries) {
        if (typeof k !== 'string' || k.length > 200) continue;
        await put(s, k, v);
      }
    }
  }

  async function clearAll() {
    for (const s of DATA_STORES.filter(s => s !== 'exchangeRates')) {
      await localClear(s);
      if (cloudReady()) await cloudClear(s);
    }
  }

  function putRate(rec) { return put('exchangeRates', rec.month, rec); }
  function delRate(month) { return del('exchangeRates', month); }
  function getAllRates() { return getAll('exchangeRates'); }

  function isCloudEnabled() {
    return cloudReady();
  }

  async function signIn(email, password) {
    if (!email || !password) throw new Error('请输入邮箱和密码');
    const session = await authRequest('/auth/v1/token?grant_type=password', {
      email: String(email).trim(),
      password: String(password),
    });
    setSession(session);
    cloudBroken = false;
    return session.user || null;
  }

  function signOut() {
    setSession(null);
    cloudBroken = false;
  }

  function getCloudUser() {
    const session = getSession();
    return session && session.user ? session.user : null;
  }

  function onCloudChange(cb) {
    if (!cloudReady()) return () => {};
    let timer = null;
    let busy = false;
    const tick = async () => {
      if (busy || !cloudReady()) return;
      busy = true;
      try {
        const stamp = await cloudLatestStamp();
        if (stamp && lastCloudStamp && stamp !== lastCloudStamp) cb(stamp);
        if (stamp) lastCloudStamp = stamp;
      } catch (err) {
        console.warn('[CD-BI] cloud poll failed:', err);
      } finally {
        busy = false;
      }
    };
    tick();
    timer = setInterval(tick, CLOUD.pollMs);
    return () => clearInterval(timer);
  }

  global.CDBI_DB = {
    put,
    del,
    getAll,
    exportAll,
    importAll,
    clearAll,
    putRate,
    delRate,
    getAllRates,
    isCloudEnabled,
    isCloudConfigured,
    hasCloudSession,
    onCloudChange,
    signIn,
    signOut,
    getCloudUser,
  };
})(window);
