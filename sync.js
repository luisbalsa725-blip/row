// Shared Supabase localStorage sync helper.
// Pages can call window.initCloudSync({ appKey, syncedKeys, syncedPrefixes, onApplied }).
(function () {
  'use strict';

  const SYNC_SUPABASE_URL = 'https://uvsxdjrcnegqysybjcvd.supabase.co';
  const SYNC_SUPABASE_KEY = 'sb_publishable_suJS8-ESdormxrbrkhk8hA_msmS08FM';
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  const origSetItem = localStorage.setItem.bind(localStorage);
  const origRemoveItem = localStorage.removeItem.bind(localStorage);
  const syncers = [];
  let supa = null;
  let supabaseLoadPromise = null;
  let hooksInstalled = false;

  function loadSupabaseClient() {
    if (window.supabase) return Promise.resolve(window.supabase);
    if (supabaseLoadPromise) return supabaseLoadPromise;
    supabaseLoadPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src*="@supabase/supabase-js"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.supabase), { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = SUPABASE_CDN;
      script.onload = () => window.supabase ? resolve(window.supabase) : reject(new Error('Supabase failed to load'));
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return supabaseLoadPromise;
  }

  async function getSupa() {
    if (!SYNC_SUPABASE_URL || !SYNC_SUPABASE_KEY) return null;
    if (SYNC_SUPABASE_URL.indexOf('PASTE-') === 0 || SYNC_SUPABASE_KEY.indexOf('PASTE-') === 0) return null;
    if (window.__rowSupabaseClient) { supa = window.__rowSupabaseClient; return supa; }
    if (supa) return supa;
    await loadSupabaseClient();
    supa = window.supabase.createClient(SYNC_SUPABASE_URL, SYNC_SUPABASE_KEY);
    window.__rowSupabaseClient = supa;
    return supa;
  }

  function matchesSyncer(syncer, key) {
    if (!key) return false;
    if (syncer.syncedKeys.indexOf(key) !== -1) return true;
    return syncer.syncedPrefixes.some((prefix) => key.indexOf(prefix) === 0);
  }

  function collectState(syncer) {
    const keys = new Set(syncer.syncedKeys);
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && syncer.syncedPrefixes.some((prefix) => key.indexOf(prefix) === 0)) keys.add(key);
      }
    } catch (e) {}
    const data = {};
    keys.forEach((key) => {
      const raw = localStorage.getItem(key);
      if (raw == null) return;
      try { data[key] = JSON.parse(raw); }
      catch (e) { data[key] = raw; }
    });
    return data;
  }

  function applyRemote(syncer, remote) {
    if (!remote || typeof remote !== 'object') return false;
    syncer.suppress = true;
    let changed = false;
    try {
      const known = new Set(syncer.syncedKeys);
      Object.keys(remote).forEach((key) => known.add(key));
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && matchesSyncer(syncer, key)) known.add(key);
        }
      } catch (e) {}
      known.forEach((key) => {
        if (!matchesSyncer(syncer, key)) return;
        if (!(key in remote)) {
          if (localStorage.getItem(key) != null) {
            try { origRemoveItem(key); changed = true; } catch (e) {}
          }
          return;
        }
        const value = typeof remote[key] === 'string' ? remote[key] : JSON.stringify(remote[key]);
        if (localStorage.getItem(key) !== value) {
          try { origSetItem(key, value); changed = true; } catch (e) {}
        }
      });
    } finally {
      syncer.suppress = false;
    }
    if (changed && typeof syncer.onApplied === 'function') {
      try { syncer.onApplied(remote); } catch (e) {}
    }
    return changed;
  }

  async function pushNow(syncer) {
    if (syncer.suppress) return;
    const state = collectState(syncer);
    const json = JSON.stringify(state);
    if (json === syncer.lastJson) return;
    try {
      const client = await getSupa();
      if (!client) return;
      const { error } = await client.from('app_state').upsert(
        { key: syncer.appKey, data: state, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      if (!error) syncer.lastJson = json;
    } catch (e) {}
  }

  function schedulePush(syncer) {
    if (syncer.suppress) return;
    clearTimeout(syncer.timer);
    syncer.timer = setTimeout(() => pushNow(syncer), 250);
  }

  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    localStorage.setItem = function (key, value) {
      origSetItem(key, value);
      syncers.forEach((syncer) => {
        if (matchesSyncer(syncer, key)) schedulePush(syncer);
      });
    };
    localStorage.removeItem = function (key) {
      origRemoveItem(key);
      syncers.forEach((syncer) => {
        if (matchesSyncer(syncer, key)) schedulePush(syncer);
      });
    };
    window.addEventListener('pagehide', () => syncers.forEach(pushNow));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) syncers.forEach(pushNow);
    });
  }

  async function start(syncer) {
    try {
      const client = await getSupa();
      if (!client) return;
      const { data, error } = await client
        .from('app_state').select('data').eq('key', syncer.appKey).maybeSingle();
      if (!error && data && data.data && Object.keys(data.data).length > 0) {
        applyRemote(syncer, data.data);
        syncer.lastJson = JSON.stringify(collectState(syncer));
      } else if (Object.keys(collectState(syncer)).length > 0) {
        schedulePush(syncer);
      }
      client.channel('app_state_' + syncer.appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + syncer.appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === syncer.lastJson) return;
          applyRemote(syncer, payload.new.data);
          syncer.lastJson = JSON.stringify(collectState(syncer));
        })
        .subscribe();
    } catch (e) {}
  }

  window.initCloudSync = function initCloudSync(options) {
    const syncer = {
      appKey: options && options.appKey,
      syncedKeys: (options && options.syncedKeys) || [],
      syncedPrefixes: (options && options.syncedPrefixes) || [],
      onApplied: options && options.onApplied,
      suppress: false,
      timer: null,
      lastJson: null
    };
    if (!syncer.appKey || (!syncer.syncedKeys.length && !syncer.syncedPrefixes.length)) return null;
    installHooks();
    syncers.push(syncer);
    start(syncer);
    return {
      push: () => pushNow(syncer),
      collect: () => collectState(syncer)
    };
  };
})();
