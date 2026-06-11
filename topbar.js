// =============================================================
// Persistent dashboard top bar + bottom tab bar.
// Drop this on any page with:
//     <script src="topbar.js" defer></script>
// It self-injects HTML + CSS, reads progress from localStorage,
// and renders the water +1 button in the top bar plus the
// Main/Health/Fitness bottom tabs. Skips chrome on finance.html
// and inside iframes (so the water tracker can embed cleanly).
// =============================================================
(function () {
  'use strict';

  // -------- Supabase config (replace with your own project URL + publishable key) --------
  const TOPBAR_SUPABASE_URL = 'https://uvsxdjrcnegqysybjcvd.supabase.co';
  const TOPBAR_SUPABASE_KEY = 'sb_publishable_suJS8-ESdormxrbrkhk8hA_msmS08FM';
  const WATER_KEY = 'po_water_v1';
  const HEALTH_ROW_KEY = 'health';
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  const origSetItem = localStorage.setItem.bind(localStorage);
  const origRemoveItem = localStorage.removeItem.bind(localStorage);
  let supa = null;
  let supabaseLoadPromise = null;
  let syncStarted = false;
  let suppressWaterPush = false;
  let waterPushTimer = null;
  let lastSyncedWaterJson = null;
  let waterChannel = null;

  try {
    waterChannel = new BroadcastChannel(WATER_KEY);
    waterChannel.onmessage = () => notifyWaterChanged(false);
  } catch (e) {}

  // -------- CSS --------
  const css = `
.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; justify-content: flex-end; align-items: center;
  gap: 8px;
  padding:
    max(12px, env(safe-area-inset-top))
    max(14px, env(safe-area-inset-right))
    max(8px, env(safe-area-inset-bottom))
    max(14px, env(safe-area-inset-left));
  background: #0a0a0b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.topbar-water-wrap { display: flex; align-items: stretch; }
.topbar-water-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 14px;
  background: rgba(125, 211, 252, 0.08);
  border: 1px solid rgba(125, 211, 252, 0.16);
  border-right: none;
  border-radius: 12px 0 0 12px;
  text-decoration: none; color: #FAFAFA;
  -webkit-tap-highlight-color: transparent;
}
.topbar-water-pill .topbar-pill-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #7DD3FC; flex-shrink: 0;
}
.topbar-water-pill.warn .topbar-pill-dot { background: #fbbf24; }
.topbar-water-pill.miss .topbar-pill-dot {
  background: #ff8a8a;
  animation: topbar-miss-pulse 1.6s ease-in-out infinite;
}
@keyframes topbar-miss-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(239, 68, 68, 0); }
}
.topbar-pill-count {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px; font-weight: 700; color: #FAFAFA;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.topbar-water-add {
  width: 44px;
  border: 1px solid rgba(125, 211, 252, 0.16);
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.28), rgba(110, 231, 183, 0.28));
  color: #FFFFFF; font-family: inherit;
  font-size: 20px; font-weight: 700; line-height: 1;
  cursor: pointer; border-radius: 0 12px 12px 0;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, transform 0.10s;
}
.topbar-water-add:active { transform: scale(0.94); }
.topbar-water-add.flash {
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.7), rgba(110, 231, 183, 0.7));
}
.topbar-finance-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px; text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.topbar-finance-btn:hover { background: rgba(255, 255, 255, 0.08); }
.topbar-finance-icon {
  font-size: 20px; line-height: 1;
  filter: grayscale(100%) brightness(1.4); opacity: 0.85;
}
.bottombar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: flex; justify-content: space-around; align-items: stretch;
  padding: 6px max(0px, env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) max(0px, env(safe-area-inset-left));
  background: #0a0a0b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.bottombar-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; padding: 6px 0 4px; text-decoration: none;
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
  -webkit-tap-highlight-color: transparent; transition: color 0.15s;
}
.bottombar-tab-icon {
  font-size: 24px; line-height: 1;
  filter: grayscale(100%) brightness(1.2); opacity: 0.55;
  transition: opacity 0.15s, filter 0.15s, transform 0.10s;
}
.bottombar-tab.active { color: #FAFAFA; }
.bottombar-tab.active .bottombar-tab-icon {
  filter: grayscale(100%) brightness(1.6); opacity: 1;
}
.bottombar-tab:active .bottombar-tab-icon { transform: scale(0.92); }
body.has-bottombar {
  padding-bottom: calc(72px + env(safe-area-inset-bottom)) !important;
}
@media (max-width: 480px) {
  .topbar {
    padding-left: max(10px, env(safe-area-inset-left));
    padding-right: max(10px, env(safe-area-inset-right));
    gap: 6px;
  }
  .topbar-water-pill { padding: 8px 11px; gap: 6px; }
  .topbar-pill-count { font-size: 12px; }
  .topbar-water-add { width: 40px; font-size: 18px; }
  .topbar-finance-btn { width: 40px; height: 38px; }
  .topbar-finance-icon { font-size: 18px; }
  .bottombar-tab-icon { font-size: 22px; }
  .bottombar-tab { font-size: 10px; }
}
html, body { -webkit-text-size-adjust: 100%; }
@media (max-width: 768px) {
  html { touch-action: pan-y; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer {
  overscroll-behavior: contain;
}
body.topbar-modal-open { overflow: hidden; touch-action: none; }
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .modal, .po-modal {
    width: 100% !important; max-width: 100% !important;
    max-height: 100vh !important; height: 100vh !important;
    border-radius: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-right: max(20px, env(safe-area-inset-right)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    padding-left: max(20px, env(safe-area-inset-left)) !important;
    overflow-y: auto !important; overscroll-behavior: contain;
  }
}
`;

  const topbarHtml = `
<header class="topbar" id="topbar" role="navigation" aria-label="Quick actions">
  <div class="topbar-water-wrap">
    <a href="health.html#water" class="topbar-water-pill" id="topbarWater" aria-label="Water progress">
      <span class="topbar-pill-dot"></span>
      <span class="topbar-pill-count" id="topbarWaterCount">0/0</span>
    </a>
    <button class="topbar-water-add" id="topbarWaterAdd" aria-label="Log one drink" type="button">+</button>
  </div>
  <a href="finance.html" class="topbar-finance-btn" id="topbarFinance" aria-label="Finance">
    <span class="topbar-finance-icon">📊</span>
  </a>
</header>`;

  const bottombarHtml = `
<nav class="bottombar" id="bottombar" role="navigation" aria-label="Main tabs">
  <a href="main.html" class="bottombar-tab" data-page="main">
    <span class="bottombar-tab-icon">🏠</span><span>Main</span>
  </a>
  <a href="health.html" class="bottombar-tab" data-page="health">
    <span class="bottombar-tab-icon">💊</span><span>Health</span>
  </a>
  <a href="gym.html" class="bottombar-tab" data-page="fitness">
    <span class="bottombar-tab-icon">💪</span><span>Fitness</span>
  </a>
</nav>`;

  function isFinancePage() {
    const p = (window.location.pathname || '').toLowerCase();
    return p.endsWith('/finance.html') || p.endsWith('finance.html');
  }
  function isEmbedded() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }
  function shouldShowChrome() { return !isFinancePage() && !isEmbedded(); }
  function currentPageKey() {
    const p = (window.location.pathname || '').toLowerCase();
    if (p.endsWith('main.html')) return 'main';
    if (p.endsWith('health.html')) return 'health';
    if (p.endsWith('gym.html')) return 'fitness';
    return 'main';
  }

  function injectStyleAndHTML() {
    if (document.getElementById('topbar') || document.getElementById('bottombar')) return;
    if (!shouldShowChrome()) return;
    const style = document.createElement('style');
    style.id = 'topbar-style';
    style.textContent = css;
    document.head.appendChild(style);
    const topWrap = document.createElement('div');
    topWrap.innerHTML = topbarHtml.trim();
    document.body.insertBefore(topWrap.firstChild, document.body.firstChild);
    const bottomWrap = document.createElement('div');
    bottomWrap.innerHTML = bottombarHtml.trim();
    document.body.appendChild(bottomWrap.firstChild);
    const active = currentPageKey();
    document.querySelectorAll('.bottombar-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-page') === active);
    });
    document.body.classList.add('has-bottombar');
  }

  function calendarDateKey() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function getWaterProgress() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(WATER_KEY)); } catch (e) {}
    if (!state) return { done: 0, total: 0 };
    const todayKey = calendarDateKey();
    const done = (state.logs || {})[todayKey] || 0;
    const p = state.profile || { weightKg: 75 };
    const wKg = state.weightUnit === 'lb' ? (p.weightKg || 0) / 2.20462 : (p.weightKg || 0);
    const base = wKg * 35;
    const exercise = (p.activityHrsPerWeek || 0) / 7 * 500;
    const caffeine = Math.max(0, (state.caffeineMgPerDay || 0) - 200) * 1.5;
    const subs = (state.substances || []).reduce((s, x) => {
      const dose = (x && x.dose != null ? x.dose : (x && x.defaultDose)) || 0;
      return s + Math.max(0, dose * ((x && x.mlPerUnit) || 0));
    }, 0);
    let adjust = 0;
    if (p.sex === 'm') adjust += 200;
    if ((p.age || 0) >= 50) adjust += 100;
    const totalMl = base + exercise + caffeine + subs + adjust;
    let unitVol;
    if (state.unit === 'glass') unitVol = state.glassMl || 250;
    else if (state.unit === 'oz') unitVol = 30;
    else if (state.unit === 'ml') unitVol = 1;
    else unitVol = state.bottleMl || 500;
    const total = Math.max(1, Math.ceil(totalMl / unitVol));
    return { done, total };
  }
  function classifyStatus(done, total) {
    if (total === 0) return 'idle';
    if (done >= total) return 'good';
    if (done >= total * 0.5) return 'warn';
    const h = new Date().getHours();
    if (h >= 18 && done < total * 0.5) return 'miss';
    return 'warn';
  }
  function setPillStatus(pillEl, status) {
    pillEl.classList.remove('good', 'warn', 'miss');
    if (status === 'warn' || status === 'miss') pillEl.classList.add(status);
  }
  function render() {
    const waterEl = document.getElementById('topbarWater');
    if (!waterEl) return;
    const w = getWaterProgress();
    const countEl = document.getElementById('topbarWaterCount');
    if (countEl) countEl.textContent = w.total ? w.done + '/' + w.total : '0/0';
    setPillStatus(waterEl, classifyStatus(w.done, w.total));
  }

  function notifyWaterChanged(shouldBroadcast) {
    render();
    try { window.dispatchEvent(new CustomEvent('po-water-sync')); } catch (e) {}
    if (shouldBroadcast && waterChannel) {
      try { waterChannel.postMessage({ key: WATER_KEY, t: Date.now() }); } catch (e) {}
    }
  }

  function defaultWaterState() {
    return {
      unit: 'bottle', bottleMl: 500, glassMl: 250, weightUnit: 'kg',
      profile: { weightKg: 75, age: 25, sex: 'm', activityHrsPerWeek: 5 },
      caffeineMgPerDay: 200, substances: [], logs: {}
    };
  }
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
    if (!TOPBAR_SUPABASE_URL || !TOPBAR_SUPABASE_KEY) return null;
    if (TOPBAR_SUPABASE_URL.indexOf('PASTE-') === 0 || TOPBAR_SUPABASE_KEY.indexOf('PASTE-') === 0) return null;
    if (window.__rowSupabaseClient) { supa = window.__rowSupabaseClient; return supa; }
    if (supa) return supa;
    await loadSupabaseClient();
    supa = window.supabase.createClient(TOPBAR_SUPABASE_URL, TOPBAR_SUPABASE_KEY);
    window.__rowSupabaseClient = supa;
    return supa;
  }

  function readLocalWaterJson() {
    return localStorage.getItem(WATER_KEY);
  }

  function readLocalWater() {
    const raw = readLocalWaterJson();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function applyRemoteWater(remoteWater) {
    const incoming = remoteWater == null ? null : JSON.stringify(remoteWater);
    if (incoming === readLocalWaterJson()) return;
    suppressWaterPush = true;
    try {
      if (incoming == null) origRemoveItem(WATER_KEY);
      else origSetItem(WATER_KEY, incoming);
      lastSyncedWaterJson = incoming;
    } finally {
      suppressWaterPush = false;
    }
    notifyWaterChanged(true);
  }

  async function pushWaterMergedToSupabase(localWater) {
    if (suppressWaterPush) return;
    const localJson = localWater == null ? null : JSON.stringify(localWater);
    if (localJson === lastSyncedWaterJson) return;
    try {
      const client = await getSupa();
      if (!client) return;
      const { data } = await client
        .from('app_state').select('data').eq('key', HEALTH_ROW_KEY).maybeSingle();
      const current = (data && data.data && typeof data.data === 'object') ? data.data : {};
      const merged = Object.assign({}, current);
      if (localWater == null) delete merged[WATER_KEY];
      else merged[WATER_KEY] = localWater;
      const { error } = await client.from('app_state').upsert(
        { key: HEALTH_ROW_KEY, data: merged, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
      if (!error) lastSyncedWaterJson = localJson;
    } catch (e) {}
  }

  function scheduleWaterPush() {
    if (suppressWaterPush) return;
    clearTimeout(waterPushTimer);
    waterPushTimer = setTimeout(() => pushWaterMergedToSupabase(readLocalWater()), 250);
  }

  function installWaterStorageHooks() {
    localStorage.setItem = function(k, v) {
      origSetItem(k, v);
      if (k === WATER_KEY) {
        notifyWaterChanged(true);
        scheduleWaterPush();
      }
    };
    localStorage.removeItem = function(k) {
      origRemoveItem(k);
      if (k === WATER_KEY) {
        notifyWaterChanged(true);
        scheduleWaterPush();
      }
    };
  }

  async function startWaterCloudSync() {
    if (isFinancePage() || syncStarted) return;
    syncStarted = true;
    installWaterStorageHooks();
    try {
      const client = await getSupa();
      if (!client) return;
      const { data, error } = await client
        .from('app_state').select('data').eq('key', HEALTH_ROW_KEY).maybeSingle();
      const remoteWater = !error && data && data.data ? data.data[WATER_KEY] : null;
      if (remoteWater) {
        applyRemoteWater(remoteWater);
      } else if (readLocalWater()) {
        scheduleWaterPush();
      }
      client.channel('app_state_' + HEALTH_ROW_KEY + '_water')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + HEALTH_ROW_KEY,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          applyRemoteWater(payload.new.data[WATER_KEY] || null);
        })
        .subscribe();
    } catch (e) {}
  }

  function addWater() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(WATER_KEY)); } catch (e) {}
    if (!state || typeof state !== 'object') state = defaultWaterState();
    state.logs = state.logs || {};
    const k = calendarDateKey();
    state.logs[k] = (state.logs[k] || 0) + 1;
    try { localStorage.setItem(WATER_KEY, JSON.stringify(state)); } catch (e) {}
    render();
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) { btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 220); }
  }

  function blockGesture(e) { e.preventDefault(); }
  function lockGestures() {
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend', blockGesture, { passive: false });
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }
  function startModalLock() {
    const MODAL_SELECTORS = ['.modal-bg', '.po-modal-bg', '.wt-overlay', '.wt-viewer', '.wt-cam'];
    function anyOpen() {
      for (const sel of MODAL_SELECTORS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.classList.contains('show') || el.classList.contains('is-open')) return true;
        }
      }
      return false;
    }
    function sync() { document.body.classList.toggle('topbar-modal-open', anyOpen()); }
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    sync();
  }

  function boot() {
    startWaterCloudSync();
    injectStyleAndHTML();
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); addWater(); });
    render();
    lockGestures();
    startModalLock();
    window.addEventListener('storage', render);
    window.addEventListener('focus', render);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    setInterval(render, 30 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
