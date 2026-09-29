// content.js — ScrollMap v3.0 (production-ready)

/* ═══════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════ */
const SM_VERSION        = '3.0.0';
const SM_MAX_BOOKMARKS  = 100;
const SM_ADD_COOLDOWN   = 1500;
const SM_QUOTA_WARN_MB  = 7;
const SM_QUOTA_HARD_MB  = 9;

/* ─── Inject review-prompt.css ──────────────────────────────────── */
// Loaded lazily so it doesn't block page render.
// The file is declared in web_accessible_resources in manifest.json.
try {
    const _smReviewStyle = document.createElement('link');
    _smReviewStyle.rel  = 'stylesheet';
    _smReviewStyle.href = chrome.runtime.getURL('review-prompt.css');
    (document.head || document.documentElement).appendChild(_smReviewStyle);
} catch { /* non-fatal — review prompt will still show, just unstyled */ }

/* ═══════════════════════════════════════════════════════════════════
   IndexedDB — screenshots + error log
═══════════════════════════════════════════════════════════════════ */
const ScrollMapDB = (() => {
    const DB_NAME    = 'ScrollMapDB';
    const DB_VERSION = 2;
    const SS_STORE   = 'screenshots';
    const ERR_STORE  = 'errors';
    let _db = null;

    async function open() {
        if (_db) return _db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(SS_STORE)) {
                    const ss = db.createObjectStore(SS_STORE, { keyPath: 'key' });
                    ss.createIndex('savedAt', 'savedAt', { unique: false });
                }
                if (!db.objectStoreNames.contains(ERR_STORE)) {
                    const er = db.createObjectStore(ERR_STORE, { autoIncrement: true });
                    er.createIndex('ts', 'ts', { unique: false });
                }
            };
            req.onsuccess = e => { _db = e.target.result; resolve(_db); };
            req.onerror   = e => reject(e.target.error);
        });
    }

    function tx(storeName, mode, fn) {
        return open().then(db => new Promise((resolve, reject) => {
            const t     = db.transaction(storeName, mode);
            const store = t.objectStore(storeName);
            const req   = fn(store);
            req.onsuccess = e => resolve(e.target.result ?? null);
            req.onerror   = e => reject(e.target.error);
        })).catch(() => null);
    }

    return {
        putScreenshot:  (key, dataUrl) => tx(SS_STORE, 'readwrite', s => s.put({ key, dataUrl, savedAt: Date.now() })),
        getScreenshot:  (key) => tx(SS_STORE, 'readonly',  s => s.get(key)).then(r => r?.dataUrl || null),
        delScreenshot:  (key) => tx(SS_STORE, 'readwrite', s => s.delete(key)),

        async pruneScreenshots(liveKeys) {
            try {
                const db    = await open();
                const t     = db.transaction(SS_STORE, 'readwrite');
                const store = t.objectStore(SS_STORE);
                const set   = new Set(liveKeys);
                const req   = store.openCursor();
                req.onsuccess = e => {
                    const cursor = e.target.result;
                    if (!cursor) return;
                    if (!set.has(cursor.value.key)) cursor.delete();
                    cursor.continue();
                };
            } catch { /* non-fatal */ }
        },

        async logError(context, message) {
            try {
                const db    = await open();
                const t     = db.transaction(ERR_STORE, 'readwrite');
                const store = t.objectStore(ERR_STORE);
                store.add({ ts: Date.now(), context, message: String(message).substring(0, 500) });
                const countReq = store.count();
                countReq.onsuccess = () => {
                    if (countReq.result > 100) {
                        const cursor = store.index('ts').openCursor();
                        cursor.onsuccess = e => { e.target.result?.delete(); };
                    }
                };
            } catch { /* non-fatal */ }
        },

        async getErrors() {
            try {
                const db    = await open();
                return new Promise(resolve => {
                    const t     = db.transaction(ERR_STORE, 'readonly');
                    const store = t.objectStore(ERR_STORE);
                    const req   = store.getAll();
                    req.onsuccess = e => resolve(e.target.result || []);
                    req.onerror   = () => resolve([]);
                });
            } catch { return []; }
        }
    };
})();

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════ */
function isSafeUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const p = new URL(url);
        return p.protocol === 'https:' || p.protocol === 'http:';
    } catch { return false; }
}

function escHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function validateBookmark(b) {
    if (!b || typeof b !== 'object') return false;
    if (typeof b.id !== 'number' || !isFinite(b.id)) return false;
    if (!['scroll', 'message'].includes(b.type)) return false;
    if (!b.timestamp || isNaN(new Date(b.timestamp).getTime())) return false;
    return true;
}

function validateNote(n) {
    if (!n || typeof n !== 'object') return false;
    if (typeof n.id !== 'number' || !isFinite(n.id)) return false;
    if (!n.timestamp || isNaN(new Date(n.timestamp).getTime())) return false;
    return true;
}

async function checkStorageQuota() {
    try {
        const estimate = await navigator.storage?.estimate?.();
        if (!estimate) return { usedMB: 0, overWarn: false, overHard: false };
        const usedMB = estimate.usage / (1024 * 1024);
        return {
            usedMB,
            overWarn: usedMB >= SM_QUOTA_WARN_MB,
            overHard: usedMB >= SM_QUOTA_HARD_MB,
        };
    } catch { return { usedMB: 0, overWarn: false, overHard: false }; }
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN CLASS
═══════════════════════════════════════════════════════════════════ */
class ScrollMap {
    constructor() {
        this.bookmarks           = [];
        this.notes               = [];
        this.stickyNotes         = [];
        this.nextId              = 1;
        this.nextNoteId          = 1;
        this.nextStickyId        = 1;
        this.pageUrl             = window.location.href;
        this.pageTitle           = document.title;
        this.panelVisible        = false;
        this.activePanelTab      = 'bookmarks';
        this.isChatSite          = false;
        this.autoSaveEnabled     = true;
        this.showPrompt          = true;
        this.screenshotEnabled   = true;
        this.panelPosition       = 'right';
        this.theme               = 'light';
        this.lastSavedPosition   = 0;
        this.scrollTimeout       = null;
        this.updateTimeout       = null;
        this.observer            = null;
        this.contentChanged      = false;
        this.noteSearchQuery     = '';
        this.bookmarkSearchQuery = '';
        this._spaLastUrl         = window.location.href;
        this._spaPollingId       = null;
        this._savingBookmarks    = false;
        this.showToggleButton   = true;
        this.showQuickAdd        = true;
        this.idleTransparent     = true;
        this._saveBookmarkQueue  = [];
        this._lastAddTime        = 0;
        this._isFirstVisit       = false;
        this._schemaVersion      = 1;
        this.init();
    }

    /* ── Init & Destroy ────────────────────────────────────────── */
    async init() {
        try {
            await this.loadSettings();
            await this.runMigrations();
            this.detectChatSite();
            this.createToggleButton();
            this.createPanel();
            this.createQuickAddButton();
            this.createMiniMarkers();
            this.applySettings();
            await this.loadBookmarks();
            await this.loadNotes();
            await this.loadStickyNotes();
            this.renderAllStickyNotes();
            this.setupEventListeners();
            this.setupKeyboardShortcut();
            this.setupProximitySensor();
            this.setupMutationObserver();
            this.setupSPADetection();
            this.checkLastPosition();
            this.setupMessageListener();
            this.maybeShowOnboarding();
            const delay = window.location.hostname.includes('youtube.com') ? 4000 : 2500;
            setTimeout(() => this.runPassiveContentCheck(), delay);
            setTimeout(() => this._gcScreenshots(), 8000);
        } catch (err) {
            console.error('ScrollMap init error:', err);
            ScrollMapDB.logError('init', err.message || err);
        }
    }

    destroy() {
        clearTimeout(this.scrollTimeout);
        clearTimeout(this.updateTimeout);
        if (this._spaPollingId) { clearInterval(this._spaPollingId); this._spaPollingId = null; }
        this.cleanupObserver();
    }

    /* ── Schema migrations ─────────────────────────────────────── */
    async runMigrations() {
        try {
            const result = await chrome.storage.local.get('sm_schema_version');
            const stored = result.sm_schema_version || 0;
            if (stored < 1) {
                await chrome.storage.local.set({ sm_schema_version: 1 });
            }
        } catch { /* non-fatal */ }
    }

    /* ── Settings ──────────────────────────────────────────────── */
    async loadSettings() {
        try {
            const r = await chrome.storage.local.get('settings');
            if (r.settings) {
                this.autoSaveEnabled   = r.settings.autoSave           !== false;
                this.showPrompt        = r.settings.showPrompt         !== false;
                this.screenshotEnabled = r.settings.screenshotEnabled  !== false;
                this.showToggleButton  = r.settings.showToggleButton   !== false;
                this.showQuickAdd     = r.settings.showQuickAdd       !== false;
                this.idleTransparent  = r.settings.idleTransparent    !== false;
                this.panelPosition     = r.settings.panelPosition      || 'right';
                this.theme             = r.settings.theme              || 'light';
            }
        } catch (err) {
            console.warn('ScrollMap: failed to load settings', err);
        }
    }

    applySettings() {
        this.applyTheme();
        this.applyPanelPosition();
        this.applyFloatingVisibility();
    }

    applyFloatingVisibility() {
        if (this.toggleBtn) {
            this.toggleBtn.style.display = this.showToggleButton !== false ? 'flex' : 'none';
            this.toggleBtn.classList.toggle('sm-idle-transparent', this.idleTransparent !== false);
        }
        if (this.quickAddBtn) {
            this.quickAddBtn.style.display = this.showQuickAdd !== false ? 'flex' : 'none';
            this.quickAddBtn.classList.toggle('sm-idle-transparent', this.idleTransparent !== false);
        }
    }

    setupProximitySensor() {
        let ticking = false;
        window.addEventListener('mousemove', e => {
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    this._checkMouseProximity(e.clientX, e.clientY);
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });
    }

    _checkMouseProximity(mx, my) {
        if (!this.idleTransparent) return;
        const DISTANCE_THRESHOLD = 120;
        [this.quickAddBtn, this.toggleBtn].forEach(btn => {
            if (!btn || btn.style.display === 'none') return;
            const rect = btn.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dist = Math.hypot(mx - cx, my - cy);
            btn.classList.toggle('sm-near-mouse', dist < DISTANCE_THRESHOLD);
        });
    }

    applyTheme() {
        let dark = false;
        if (this.theme === 'dark') dark = true;
        else if (this.theme === 'system') dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.panel.classList.toggle('scrollmap-dark', dark);
    }

    applyPanelPosition() {
        const left = this.panelPosition === 'left';
        [this.panel, this.toggleBtn, this.quickAddBtn, this.miniMarkers].forEach(el => {
            el.classList.toggle('scrollmap-left', left);
        });
        const prompt = document.querySelector('.scrollmap-continue-prompt');
        if (prompt) {
            prompt.style.right = left ? 'auto' : '310px';
            prompt.style.left  = left ? '310px' : 'auto';
        }
    }

    /* ── Onboarding ────────────────────────────────────────────── */
    async maybeShowOnboarding() {
        // The full onboarding page is opened by background.js on first install.
        // This tooltip is a lightweight fallback for pages that were already open
        // when the extension was installed (they won't get the tab redirect).
        try {
            const r = await chrome.storage.local.get('sm_onboarded');
            if (r.sm_onboarded) return;
            await chrome.storage.local.set({ sm_onboarded: true });
            setTimeout(() => this._showOnboardingTooltip(), 1200);
        } catch { /* non-fatal */ }
    }

    _showOnboardingTooltip() {
        if (document.querySelector('.sm-onboard')) return;
        const tip = document.createElement('div');
        tip.className = 'sm-onboard' + (this.panel.classList.contains('scrollmap-dark') ? ' scrollmap-dark' : '');
        tip.innerHTML = `
            <div class="sm-onboard-box">
                <div class="sm-onboard-emoji">🎉</div>
                <div class="sm-onboard-title">Welcome to ScrollMap!</div>
                <div class="sm-onboard-body">
                    <p>Bookmark any position on any page and jump back instantly.</p>
                    <ul>
                        <li>Click <strong>+</strong> or press <kbd>Ctrl+Shift+B</kbd> to add a bookmark</li>
                        <li>Click the <strong>📚</strong> button to open your list</li>
                        <li>Use <kbd>Ctrl+Shift+1–9</kbd> to jump to bookmarks by number</li>
                        <li>Add <strong>Notes</strong> and pin them as sticky notes on any page</li>
                    </ul>
                </div>
                <button class="sm-onboard-close">Got it!</button>
            </div>
        `;
        document.body.appendChild(tip);
        requestAnimationFrame(() => tip.classList.add('sm-onboard-visible'));
        const close = () => { tip.classList.remove('sm-onboard-visible'); setTimeout(() => tip.remove(), 300); };
        tip.querySelector('.sm-onboard-close').addEventListener('click', close);
        tip.addEventListener('click', e => { if (e.target === tip) close(); });
        setTimeout(close, 20000);
    }

    /* ── SPA Detection ─────────────────────────────────────────── */
    setupSPADetection() {
        if (this._spaPollingId) clearInterval(this._spaPollingId);
        this._spaLastUrl   = window.location.href;
        this._spaPollingId = setInterval(() => {
            if (this._spaLastUrl !== window.location.href) {
                this._spaLastUrl = window.location.href;
                this._handleSPANavigation();
            }
        }, 600);

        if (window.location.hostname.includes('youtube.com')) {
            document.addEventListener('yt-navigate-finish', () => {
                setTimeout(() => {
                    if (this._spaLastUrl !== window.location.href) {
                        this._spaLastUrl = window.location.href;
                        this._handleSPANavigation();
                    }
                }, 500);
            });
        }
    }

    _handleSPANavigation() {
        if (window.location.href === this.pageUrl) return;
        this.pageUrl             = window.location.href;
        this.pageTitle           = document.title;
        this.contentChanged      = false;
        this.noteSearchQuery     = '';
        this.bookmarkSearchQuery = '';
        document.querySelector('.scrollmap-change-banner')?.remove();
        document.querySelectorAll('.sm-sticky-note').forEach(el => el.remove());
        this.cleanupObserver();
        this.detectChatSite();
        this.loadBookmarks().then(() => this.setupMutationObserver());
        this.loadNotes();
        this.loadStickyNotes().then(() => this.renderAllStickyNotes());
        const delay = window.location.hostname.includes('youtube.com') ? 4000 : 2500;
        setTimeout(() => this.runPassiveContentCheck(), delay);
    }

    /* ── Content fingerprint & change detection ────────────────── */
    getContentFingerprint() {
        const hostname = window.location.hostname;
        let parts = [];
        if (hostname.includes('youtube.com')) {
            const v = new URLSearchParams(window.location.search).get('v');
            if (v) parts.push(`yt:${v}`);
            for (const s of ['h1.ytd-watch-metadata yt-formatted-string','#title h1','h1.title']) {
                const el = document.querySelector(s);
                if (el?.textContent?.trim()) { parts.push(el.textContent.trim()); break; }
            }
            if (!parts.length) parts.push(document.title);
        } else if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
            parts.push(window.location.pathname);
            document.querySelectorAll('[data-testid="tweetText"]').forEach((el, i) => { if (i < 5) parts.push(el.textContent.trim()); });
            if (parts.length <= 1) parts.push(document.title);
        } else if (hostname.includes('reddit.com')) {
            parts.push(window.location.pathname);
            for (const s of ['h1[slot="title"]','[data-testid="post-title"] h1','shreddit-post h1']) {
                const el = document.querySelector(s);
                if (el?.textContent?.trim()) { parts.push(el.textContent.trim()); break; }
            }
        } else {
            let root = null;
            for (const s of ['article','main','[role="main"]','.content','#content']) { root = document.querySelector(s); if (root) break; }
            if (!root) root = document.body;
            parts = Array.from(root.querySelectorAll('h1,h2,h3,p,li'))
                .map(el => el.textContent.trim()).filter(t => t.length > 20).slice(0, 60);
        }
        const text = parts.join('|').trim();
        if (!text) return '0';
        let hash = 5381;
        for (let i = 0; i < Math.min(text.length, 8000); i++) {
            hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
            hash = hash >>> 0;
        }
        return hash.toString(16);
    }

    async checkContentChange() {
        if (!this.bookmarks.length || this.isChatSite) return { changed: false, savedAt: null };
        const skip = [/[?&](q|query|search)=/, /\/search[/?]/, /\/inbox/, /\/dashboard/, /\/account/, /\/settings/];
        if (skip.some(p => p.test(this.pageUrl))) return { changed: false, savedAt: null };
        const current = this.getContentFingerprint();
        if (current === '0') return { changed: false, savedAt: null };
        try {
            const key = `content_hash_${this.pageUrl}`;
            const r = await chrome.storage.local.get(key);
            if (!r[key]?.hash) return { changed: false, savedAt: null };
            const changed = r[key].hash !== current;
            this.contentChanged = changed;
            return { changed, savedAt: r[key].savedAt || null };
        } catch { return { changed: false, savedAt: null }; }
    }

    async runPassiveContentCheck() {
        const { changed, savedAt } = await this.checkContentChange();
        if (changed) {
            this.showContentChangedBanner(savedAt);
            if (this.panelVisible && this.activePanelTab === 'bookmarks') this.renderBookmarkList();
        }
    }

    async saveContentSnapshot() {
        if (this.isChatSite) return;
        try {
            const fp = this.getContentFingerprint();
            if (fp === '0') return;
            await chrome.storage.local.set({ [`content_hash_${this.pageUrl}`]: { hash: fp, savedAt: Date.now() } });
        } catch { /* non-fatal */ }
    }

    /* ── UI: change modal & banner ─────────────────────────────── */
    async checkContentChangeBeforeNavigate(bookmark, onConfirm) {
        const { changed, savedAt } = await this.checkContentChange();
        if (!changed) { onConfirm(); return; }
        this.showContentChangedModal(bookmark, savedAt, onConfirm);
    }

    showContentChangedModal(bookmark, savedAt, onProceed) {
        document.querySelector('.sm-content-changed-modal')?.remove();
        const isDark = this.panel.classList.contains('scrollmap-dark');
        let host = 'this page';
        try { host = new URL(this.pageUrl).hostname.replace('www.', ''); } catch {}
        const savedDate = savedAt ? new Date(savedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : null;
        const sinceText = savedDate ? `since ${savedDate}` : 'since this bookmark was saved';
        const modal = document.createElement('div');
        modal.className = 'sm-content-changed-modal' + (isDark ? ' scrollmap-dark' : '');
        modal.innerHTML = `
            <div class="sm-ccm-backdrop"></div>
            <div class="sm-ccm-box">
                <div class="sm-ccm-icon">⚠️</div>
                <div class="sm-ccm-title">Page content changed</div>
                <div class="sm-ccm-site">${escHtml(host)}</div>
                <div class="sm-ccm-body">
                    This page has changed ${escHtml(sinceText)}.
                    Your bookmark <strong>"${escHtml(bookmark.customTitle || 'Bookmark')}"</strong> may point to different content.
                </div>
                <div class="sm-ccm-actions">
                    <button class="sm-ccm-proceed">Navigate Anyway</button>
                    <button class="sm-ccm-cancel">Cancel</button>
                </div>
                <div class="sm-ccm-hint">Tip: Delete and re-add this bookmark to reset the warning</div>
            </div>`;
        document.body.appendChild(modal);
        requestAnimationFrame(() => modal.classList.add('sm-ccm-visible'));
        const close = () => { modal.classList.remove('sm-ccm-visible'); setTimeout(() => modal.remove(), 280); };
        modal.querySelector('.sm-ccm-proceed').addEventListener('click', () => { close(); onProceed(); });
        modal.querySelector('.sm-ccm-cancel').addEventListener('click', close);
        modal.querySelector('.sm-ccm-backdrop').addEventListener('click', close);
        const esc = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
        document.addEventListener('keydown', esc);
    }

    showContentChangedBanner(lastSeenTimestamp) {
        if (document.querySelector('.scrollmap-change-banner')) return;
        const lastSeen  = lastSeenTimestamp ? new Date(lastSeenTimestamp).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null;
        const sinceText = lastSeen ? `since ${lastSeen}` : 'since your last visit';
        const banner = document.createElement('div');
        banner.className = 'scrollmap-change-banner' + (this.panel.classList.contains('scrollmap-dark') ? ' scrollmap-dark' : '');
        banner.classList.toggle('scrollmap-left', this.panelPosition === 'left');
        banner.innerHTML = `
            <div class="scb-icon">⚠️</div>
            <div class="scb-body">
                <div class="scb-title">Page content has changed</div>
                <div class="scb-desc">This page changed ${escHtml(sinceText)}. Bookmarks may point to different content.</div>
            </div>
            <div class="scb-actions">
                <button class="scb-view-btn">View Bookmarks</button>
                <button class="scb-dismiss-btn" title="Dismiss">✕</button>
            </div>`;
        document.body.appendChild(banner);
        requestAnimationFrame(() => banner.classList.add('scb-visible'));
        const t = setTimeout(dismiss, 15000);
        function dismiss() { clearTimeout(t); banner.classList.remove('scb-visible'); setTimeout(() => banner.remove(), 350); }
        banner.querySelector('.scb-dismiss-btn').addEventListener('click', dismiss);
        banner.querySelector('.scb-view-btn').addEventListener('click', () => { dismiss(); if (!this.panelVisible) this.togglePanel(); });
    }

    /* ── Detection ─────────────────────────────────────────────── */
    detectChatSite() {
    const chatDomains = [
        'chat.openai.com','chatgpt.com','claude.ai','chat.deepseek.com',
        'poe.com','perplexity.ai','gemini.google.com','copilot.microsoft.com',
        'pi.ai','character.ai','chat.mistral.ai'  // Add more AI sites
    ];
    
    this.isChatSite = chatDomains.some(d => window.location.hostname.includes(d));
    
    if (!this.isChatSite) {
        
        const indicators = [
            '[class*="message"]','[class*="Message"]','[class*="chat"]','[class*="Chat"]',
            '[class*="conversation"]','[data-message-id]','[role="log"]',
            '[class*="thread"]','[class*="Thread"]','.prose','.markdown'
        ];
        
        for (const s of indicators) {
            if (document.querySelector(s)) {
                this.isChatSite = true;
                break;
            }
        }
    }
}

    /* ── UI Creation ────────────────────────────────────────────── */
    createToggleButton() {
        const MAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 128 128" fill="none"><defs><linearGradient id="sm_map_bg" x1="12" y1="10" x2="116" y2="118" gradientUnits="userSpaceOnUse"><stop stop-color="#12351F"/><stop offset="1" stop-color="#08130C"/></linearGradient><linearGradient id="sm_map_route" x1="25" y1="22" x2="101" y2="104" gradientUnits="userSpaceOnUse"><stop stop-color="#A7F3D0"/><stop offset=".42" stop-color="#4ADE80"/><stop offset="1" stop-color="#16A34A"/></linearGradient><linearGradient id="sm_map_panel" x1="33" y1="39" x2="83" y2="83" gradientUnits="userSpaceOnUse"><stop stop-color="#2F7F48"/><stop offset="1" stop-color="#174D2B"/></linearGradient><filter id="sm_map_glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect x="5" y="5" width="118" height="118" rx="28" fill="url(#sm_map_bg)"/><rect x="24" y="26" width="69" height="27" rx="10" transform="rotate(-7 24 26)" fill="#123B24" stroke="#2E6740" stroke-width="1.5"/><rect x="25" y="76" width="69" height="28" rx="10" transform="rotate(7 25 76)" fill="#123B24" stroke="#2E6740" stroke-width="1.5"/><rect x="22" y="45" width="75" height="36" rx="12" fill="url(#sm_map_panel)" stroke="#5BE28A" stroke-width="2"/><circle cx="38" cy="57" r="6.5" fill="#86EFAC"/><rect x="50" y="53" width="30" height="5" rx="2.5" fill="#D1FAE5"/><rect x="50" y="63" width="21" height="5" rx="2.5" fill="#86EFAC"/><path d="M18 89 C35 96 49 98 62 94 C75 90 86 81 94 68 C102 55 104 41 97 30" stroke="#0B1B10" stroke-width="11" stroke-linecap="round" opacity=".65"/><path d="M18 89 C35 96 49 98 62 94 C75 90 86 81 94 68 C102 55 104 41 97 30" stroke="url(#sm_map_route)" stroke-width="5" stroke-linecap="round"/><rect x="98" y="29" width="7" height="70" rx="3.5" fill="#255B35"/><rect x="98" y="52" width="7" height="22" rx="3.5" fill="#E7FCEB" filter="url(#sm_map_glow)"/><circle cx="110" cy="42" r="2.5" fill="#2F7A47"/><circle cx="110" cy="63" r="2.5" fill="#86EFAC"/><circle cx="110" cy="85" r="2.5" fill="#2F7A47"/><path d="M19 42H26M17 49H24" stroke="#4ADE80" stroke-width="2.8" stroke-linecap="round" opacity=".7"/></svg>`;
        this.toggleBtn = document.createElement('button');
        this.toggleBtn.className = 'scrollmap-toggle';
        this.toggleBtn.innerHTML = MAP_SVG;
        this.toggleBtn.title     = 'Show ScrollMap (Ctrl+Shift+B)';
        this.toggleBtn.setAttribute('aria-label', 'Open ScrollMap bookmark panel');
        this.toggleBtn.addEventListener('click', e => { e.stopPropagation(); this.togglePanel(); });
        document.body.appendChild(this.toggleBtn);
    }

    createPanel() {
        this.panel = document.createElement('div');
        this.panel.className = 'scrollmap-panel';
        this.panel.setAttribute('role', 'complementary');
        this.panel.setAttribute('aria-label', 'ScrollMap bookmark panel');

        const header = document.createElement('div');
        header.className = 'scrollmap-header';
        header.innerHTML = `<h3>ScrollMap</h3><button class="scrollmap-close" aria-label="Close panel">✕</button>`;

        const tabBar = document.createElement('div');
        tabBar.className = 'scrollmap-panel-tabbar';
        tabBar.setAttribute('role', 'tablist');
        tabBar.innerHTML = `
            <button class="sp-tab active" data-tab="bookmarks" role="tab" aria-selected="true">📚 Bookmarks</button>
            <button class="sp-tab" data-tab="notes" role="tab" aria-selected="false">📝 Notes</button>`;

        this.bookmarkList = document.createElement('div');
        this.bookmarkList.className = 'scrollmap-bookmark-list';
        this.bookmarkList.setAttribute('role', 'tabpanel');

        this.notesList = document.createElement('div');
        this.notesList.className = 'scrollmap-notes-list';
        this.notesList.setAttribute('role', 'tabpanel');
        this.notesList.style.display = 'none';

        this.panel.appendChild(header);
        this.panel.appendChild(tabBar);
        this.panel.appendChild(this.bookmarkList);
        this.panel.appendChild(this.notesList);
        document.body.appendChild(this.panel);

        header.querySelector('.scrollmap-close').addEventListener('click', e => { e.stopPropagation(); this.hidePanel(); });
        this.panel.addEventListener('click', e => e.stopPropagation());
        tabBar.querySelectorAll('.sp-tab').forEach(tab => tab.addEventListener('click', () => this.switchPanelTab(tab.dataset.tab)));
    }

    createQuickAddButton() {
        this.quickAddBtn = document.createElement('button');
        this.quickAddBtn.className = 'scrollmap-quick-add';
        this.quickAddBtn.innerHTML = '+';
        this.quickAddBtn.title     = 'Add bookmark (Ctrl+Shift+B)';
        this.quickAddBtn.setAttribute('aria-label', 'Add bookmark at current position');
        this.quickAddBtn.addEventListener('click', e => { e.stopPropagation(); this.addBookmark(); });
        document.body.appendChild(this.quickAddBtn);
    }

    createMiniMarkers() {
        this.miniMarkers = document.createElement('div');
        this.miniMarkers.className = 'scrollmap-mini-markers';
        this.miniMarkers.setAttribute('aria-hidden', 'true');
        document.body.appendChild(this.miniMarkers);
    }

    /* ── Panel ─────────────────────────────────────────────────── */
    togglePanel() {
        this.panelVisible = !this.panelVisible;
        if (this.panelVisible) {
            this.panel.classList.add('visible');
            this.renderCurrentPanelTab();
            this._hydrateScreenshots();
        } else {
            this.panel.classList.remove('visible');
        }
    }

    hidePanel() { this.panelVisible = false; this.panel.classList.remove('visible'); }

    switchPanelTab(tab) {
        this.activePanelTab = tab;
        this.panel.querySelectorAll('.sp-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
            t.setAttribute('aria-selected', String(t.dataset.tab === tab));
        });
        this.bookmarkList.style.display = tab === 'bookmarks' ? '' : 'none';
        this.notesList.style.display    = tab === 'notes'     ? '' : 'none';
        this.renderCurrentPanelTab();
    }

    renderCurrentPanelTab() {
        if (this.activePanelTab === 'bookmarks') this.renderBookmarkList();
        else this.renderNotesList();
    }

    /* ── Lazy screenshot hydration ─────────────────────────────── */
    async _hydrateScreenshots() {
        let updated = false;
        for (const bm of this.bookmarks) {
            if (bm.screenshotKey && !bm.screenshot) {
                bm.screenshot = await ScrollMapDB.getScreenshot(bm.screenshotKey);
                if (bm.screenshot) updated = true;
            }
        }
        if (updated && this.panelVisible && this.activePanelTab === 'bookmarks') this.renderBookmarkList();
    }

    /* ── IndexedDB GC ──────────────────────────────────────────── */
    async _gcScreenshots() {
        try {
            const allKeys = await chrome.storage.local.get(null);
            const liveKeys = new Set();
            for (const [k, v] of Object.entries(allKeys)) {
                if (!k.startsWith('bookmarks_') || !Array.isArray(v)) continue;
                v.forEach(bm => { if (bm.screenshotKey) liveKeys.add(bm.screenshotKey); });
            }
            await ScrollMapDB.pruneScreenshots([...liveKeys]);
        } catch { /* non-fatal */ }
    }

    /* ── Storage: bookmarks ────────────────────────────────────── */
    async loadBookmarks() {
        try {
            const key = `bookmarks_${this.pageUrl}`;
            const r   = await chrome.storage.local.get(key);
            if (Array.isArray(r[key]) && r[key].length) {
                this.bookmarks = r[key].filter(validateBookmark);
                this.nextId    = Math.max(...this.bookmarks.map(b => b.id), 0) + 1;
            } else {
                this.bookmarks = [];
            }
            this.renderMiniMarkers();
            if (this.panelVisible && this.activePanelTab === 'bookmarks') this.renderBookmarkList();
        } catch (err) {
            console.warn('ScrollMap: loadBookmarks error', err);
            ScrollMapDB.logError('loadBookmarks', err.message);
            this.bookmarks = [];
        }
    }

    async saveBookmarks() {
        return new Promise((resolve, reject) => {
            this._saveBookmarkQueue.push({ resolve, reject });
            if (!this._savingBookmarks) this._flushSaveQueue();
        });
    }

    async _flushSaveQueue() {
        if (this._savingBookmarks || !this._saveBookmarkQueue.length) return;
        this._savingBookmarks = true;
        const { resolve, reject } = this._saveBookmarkQueue.shift();
        try {
            const { overHard, overWarn, usedMB } = await checkStorageQuota();
            if (overHard) {
                this.showToast(`❌ Storage full (${usedMB.toFixed(1)} MB used). Delete some bookmarks.`);
                resolve(); return;
            }
            if (overWarn) {
                this.showToast(`⚠️ Storage nearly full (${usedMB.toFixed(1)} MB). Consider exporting data.`);
            }
            const key     = `bookmarks_${this.pageUrl}`;
            const toStore = this.bookmarks.map(bm => {
                const c = { ...bm };
                delete c.screenshot;
                return c;
            });
            await chrome.storage.local.set({
                [key]: toStore,
                [`metadata_${this.pageUrl}`]: { title: this.pageTitle, lastVisited: new Date().toISOString(), version: SM_VERSION }
            });
            await this.saveContentSnapshot();
            this.renderMiniMarkers();
            if (this.panelVisible && this.activePanelTab === 'bookmarks') this.renderBookmarkList();
            resolve();
        } catch (err) {
            ScrollMapDB.logError('saveBookmarks', err.message);
            setTimeout(async () => {
                try {
                    const key = `bookmarks_${this.pageUrl}`;
                    await chrome.storage.local.set({ [key]: this.bookmarks.map(b => { const c={...b}; delete c.screenshot; return c; }) });
                    resolve();
                } catch (e2) { reject(e2); }
            }, 500);
        } finally {
            this._savingBookmarks = false;
            if (this._saveBookmarkQueue.length) this._flushSaveQueue();
        }
    }

    /* ── Screenshot capture ────────────────────────────────────── */
    async captureScreenshot() {
        if (!this.screenshotEnabled) return null;
        try {
            return await new Promise(resolve => {
                chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, response => {
                    if (chrome.runtime.lastError || !response?.dataUrl) { resolve(null); return; }
                    resolve(response.dataUrl);
                });
            });
        } catch { return null; }
    }

    /* ── Add bookmark (rate-limited) ───────────────────────────── */
    addBookmark() {
        const now = Date.now();
        if (now - this._lastAddTime < SM_ADD_COOLDOWN) {
            this.showToast('⏳ Please wait a moment before adding another bookmark');
            return;
        }
        if (this.bookmarks.length >= SM_MAX_BOOKMARKS) {
            this.showToast(`❌ Maximum ${SM_MAX_BOOKMARKS} bookmarks per page reached`);
            return;
        }
        this._lastAddTime = now;
        if (this.isChatSite) this._addChatBookmark();
        else                  this._addNormalBookmark();
    }

    async _addNormalBookmark() {
        const scrollY       = window.scrollY;
        const docHeight     = document.documentElement.scrollHeight;
        const windowHeight  = window.innerHeight;
        const scrollPercent = docHeight > windowHeight ? (scrollY / (docHeight - windowHeight)) * 100 : 0;
        const preview       = this._getSmartPreview();
        const screenshotUrl = await this.captureScreenshot();

        const id            = this.nextId++;
        const screenshotKey = screenshotUrl ? `ss_${this.pageUrl}_${id}` : null;
        if (screenshotKey) await ScrollMapDB.putScreenshot(screenshotKey, screenshotUrl);

        const bm = {
            id, type: 'scroll',
            scrollY, scrollPercent, preview,
            screenshotKey,
            screenshot:  screenshotUrl || null,
            customTitle: `Bookmark ${id}`,
            timestamp:   new Date().toISOString(),
            comments:    []
        };
        this.bookmarks.push(bm);
        await this.saveBookmarks();
        this._afterBookmarkChange();

        // Track usage — may trigger review prompt after 5 bookmarks + 3 days
        this._trackUsageAndMaybeReview('bookmark_added');

        this.showToast(`✅ Bookmark added at ${Math.round(scrollPercent)}%`);
        this._showUndoToast('bookmark', () => this._undoAdd(id, screenshotKey));
        if (!this.panelVisible) this.togglePanel();
    }

    async _addChatBookmark() {
        const messages = this._findAllMessages();
        let best = null, bestScore = -1, bestIdx = -1;
        messages.forEach((msg, i) => {
            const rect  = msg.getBoundingClientRect();
            if (rect.bottom < 0 || rect.top > window.innerHeight) return;
            const score = 1000 - Math.abs(rect.top - 100);
            if (score > bestScore) { bestScore = score; best = msg; bestIdx = i; }
        });
        if (!best) { this.showToast('❌ No message found'); return; }

        const content       = this._extractMessageContent(best);
        const msgId         = this._generateMessageId(best, bestIdx);
        const screenshotUrl = await this.captureScreenshot();

        const id            = this.nextId++;
        const screenshotKey = screenshotUrl ? `ss_${this.pageUrl}_${id}` : null;
        if (screenshotKey) await ScrollMapDB.putScreenshot(screenshotKey, screenshotUrl);

        const bm = {
            id, type: 'message',
            messageId: msgId, messageIndex: bestIdx, messageContent: content,
            preview:   content.substring(0, 60) + (content.length > 60 ? '...' : ''),
            screenshotKey, screenshot: screenshotUrl || null,
            customTitle: `Message ${bestIdx + 1}`,
            timestamp:   new Date().toISOString(),
            url:         window.location.href,
            comments:    []
        };
        this.bookmarks.push(bm);
        await this.saveBookmarks();
        this._afterBookmarkChange();

        // Track usage — may trigger review prompt after 5 bookmarks + 3 days
        this._trackUsageAndMaybeReview('bookmark_added');

        this.showToast(`✅ Bookmarked message ${bestIdx + 1}`);
        this._showUndoToast('bookmark', () => this._undoAdd(id, screenshotKey));
        this._highlightMessage(best);
        if (!this.panelVisible) this.togglePanel();
    }

    /* ─────────────────────────────────────────────────────────────
       REVIEW PROMPT — usage tracking + smart display
    ───────────────────────────────────────────────────────────── */

    /**
     * Tells the background service worker that a trackable action happened.
     * The SW decides whether the review prompt conditions are met.
     * If yes, we show the prompt after a short delay so it doesn't fight
     * with the bookmark-added toast.
     */
    async _trackUsageAndMaybeReview(action) {
        try {
            const response = await new Promise(resolve =>
                chrome.runtime.sendMessage({ type: 'TRACK_USAGE', action }, r => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(r);
                })
            );
            if (response?.shouldShowReview) {
                // 2.5-second delay so the bookmark toast finishes first
                setTimeout(() => this._showReviewPrompt(), 2500);
            }
        } catch { /* non-fatal — never block the happy path */ }
    }

    /**
     * Renders the review prompt card in the bottom corner.
     * Includes animated star hover, three dismissal paths, and a
     * thank-you state before opening the store.
     *
     * IMPORTANT: Replace 'YOUR_EXTENSION_ID_HERE' with your real
     * Chrome Web Store extension ID once you publish.
     */
    _showReviewPrompt() {
        // Only one prompt at a time
        if (document.querySelector('.sm-review-prompt')) return;

        const isDark   = this.panel.classList.contains('scrollmap-dark');
        const isLeft   = this.panelPosition === 'left';

        // Dynamically resolve runtime extension ID or fallback
        const extId    = (typeof chrome !== 'undefined' && chrome.runtime?.id) ? chrome.runtime.id : 'YOUR_EXTENSION_ID_HERE';
        const storeUrl = `https://chromewebstore.google.com/detail/${extId}/reviews`;

        const prompt = document.createElement('div');
        prompt.className = 'sm-review-prompt'
            + (isDark ? ' scrollmap-dark' : '')
            + (isLeft ? ' sm-rp-left'     : '');

        prompt.innerHTML = `
            <div class="sm-rp-stripe"></div>
            <div class="sm-rp-body">
                <div class="sm-rp-stars">
                    ${[1,2,3,4,5].map(i =>
                        `<span class="sm-rp-star" data-star="${i}" role="button" aria-label="${i} star">⭐</span>`
                    ).join('')}
                </div>
                <div class="sm-rp-title">Enjoying ScrollMap? 🎉</div>
                <div class="sm-rp-sub">
                    You've been bookmarking like a pro!<br>
                    A quick review helps us grow and keeps ScrollMap free.
                </div>
                <div class="sm-rp-actions">
                    <button class="sm-rp-btn-yes" id="sm-rp-yes">⭐ Leave a review</button>
                    <button class="sm-rp-btn-later" id="sm-rp-later">Later</button>
                </div>
                <button class="sm-rp-btn-no" id="sm-rp-no">No thanks, don't ask again</button>
            </div>
            <div class="sm-rp-thankyou">
                <div class="sm-rp-ty-emoji">🙏</div>
                <div class="sm-rp-ty-title">Thank you so much!</div>
                <div class="sm-rp-ty-sub">Your review means the world to us.<br>Happy bookmarking!</div>
            </div>`;

        document.body.appendChild(prompt);
        requestAnimationFrame(() => prompt.classList.add('sm-rp-visible'));

        // ── Star hover interactions ──────────────────────────────
        const stars = prompt.querySelectorAll('.sm-rp-star');
        stars.forEach(star => {
            star.addEventListener('mouseenter', () => {
                const n = parseInt(star.dataset.star);
                stars.forEach((s, i) => s.classList.toggle('lit', i < n));
            });
            star.addEventListener('mouseleave', () => {
                stars.forEach(s => s.classList.remove('lit'));
            });
            star.addEventListener('click', openReview);
        });

        // ── Shared helpers ───────────────────────────────────────
        const dismiss = () => {
            prompt.classList.remove('sm-rp-visible');
            setTimeout(() => prompt.remove(), 400);
        };

        const openReview = () => {
            // Show the thank-you state before opening the store
            prompt.querySelector('.sm-rp-body').style.display = 'none';
            const ty = prompt.querySelector('.sm-rp-thankyou');
            ty.style.display = 'flex';

            chrome.runtime.sendMessage({ type: 'SET_REVIEW_STATE', state: 'done' });
            setTimeout(() => {
                chrome.runtime.sendMessage({ type: 'OPEN_URL', url: storeUrl });
                setTimeout(dismiss, 2000);
            }, 900);
        };

        // ── Button wiring ────────────────────────────────────────
        prompt.querySelector('#sm-rp-yes').addEventListener('click', openReview);

        prompt.querySelector('#sm-rp-later').addEventListener('click', () => {
            // 'asked' state: background already set this when shouldShowReview fired,
            // so clicking Later effectively means "ask me again eventually"
            // (you'd reset to 'pending' after N more bookmarks if desired)
            chrome.runtime.sendMessage({ type: 'SET_REVIEW_STATE', state: 'asked' });
            dismiss();
        });

        prompt.querySelector('#sm-rp-no').addEventListener('click', () => {
            // 'never' state: permanently suppresses future prompts
            chrome.runtime.sendMessage({ type: 'SET_REVIEW_STATE', state: 'never' });
            dismiss();
        });

        // Auto-dismiss after 20 seconds so it never traps the user
        setTimeout(dismiss, 20000);
    }

    /* ── Undo delete/add ───────────────────────────────────────── */
    _showUndoToast(label, undoFn) {
        document.querySelector('.sm-undo-toast')?.remove();
        const t = document.createElement('div');
        t.className = 'sm-undo-toast';
        t.innerHTML = `<span>✅ ${escHtml(label)} added</span><button class="sm-undo-btn">Undo</button>`;
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add('sm-undo-visible'));
        const timer = setTimeout(() => dismiss(), 5000);
        const dismiss = () => { clearTimeout(timer); t.classList.remove('sm-undo-visible'); setTimeout(() => t.remove(), 300); };
        t.querySelector('.sm-undo-btn').addEventListener('click', () => { undoFn(); dismiss(); });
    }

    async _undoAdd(id, screenshotKey) {
        if (screenshotKey) await ScrollMapDB.delScreenshot(screenshotKey);
        this.bookmarks = this.bookmarks.filter(b => b.id !== id);
        await this.saveBookmarks();
        this._afterBookmarkChange();
        this.showToast('↩️ Bookmark removed');
    }

    /* ── Chat helpers ──────────────────────────────────────────── */
    _findAllMessages() {
    const selectors = [
        '[class*="message"]','[class*="Message"]','[class*="msg"]','[class*="Msg"]',
        '[data-message-id]','[data-testid*="message"]','[role="article"]',
        '[role="log"] > div','.group','.text-base','[data-message-author-role]',
        '.chat-message','.message-item','.prose','.font-claude-message',
        '.flex.w-full','.items-start','.gap-4','.px-4','.py-6'
    ];
    
    for (const s of selectors) {
        const els = Array.from(document.querySelectorAll(s))
            .filter(el => (el.textContent?.trim() || '').length > 10);
        if (els.length > 0) return els;
    }
    return [];
}

    _extractMessageContent(el) {
        for (const s of ['[class*="markdown"]','[class*="prose"]','p']) {
            const c = el.querySelector(s);
            if (c?.textContent?.trim().length > 20) return c.textContent.trim();
        }
        return el.textContent?.trim() || 'No content';
    }

    _generateMessageId(el, index) {
        if (el.id) return el.id;
        for (const attr of ['data-message-id','data-id','data-testid']) {
            const v = el.getAttribute(attr);
            if (v) return `${attr}-${v}`;
        }
        return `msg-${index}`;
    }

    /* ── Navigate ──────────────────────────────────────────────── */
    navigateToBookmark(bookmark) {
        this.checkContentChangeBeforeNavigate(bookmark, () => {
            if (bookmark.type === 'message') this._navMessage(bookmark);
            else                              this._navScroll(bookmark);
        });
    }

    _navMessage(bm) {
        const messages = this._findAllMessages();
        if (!messages.length) { this.showToast('❌ No messages found'); return; }
        let target = messages.find(m => this._generateMessageId(m, messages.indexOf(m)) === bm.messageId);
        if (!target && bm.messageContent) target = messages.find(m => this._extractMessageContent(m).includes(bm.messageContent.substring(0, 50)));
        if (!target && bm.messageIndex != null && bm.messageIndex < messages.length) target = messages[bm.messageIndex];
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            this._highlightMessage(target);
            this.showToast(`📍 Jumped to ${escHtml(bm.customTitle)}`);
        } else {
            this.showToast('❌ Could not find this message');
        }
    }

    _navScroll(bm) {
        window.scrollTo({ top: bm.scrollY, behavior: 'smooth' });
        this._highlightArea(bm.scrollY);
        this.showToast(`📍 Jumped to ${escHtml(bm.customTitle || 'bookmark')}`);
    }

    _highlightMessage(el) {
        document.querySelectorAll('.scrollmap-message-highlight').forEach(h => h.remove());
        const rect = el.getBoundingClientRect();
        const h = document.createElement('div');
        h.className = 'scrollmap-message-highlight';
        h.style.cssText = `position:absolute;top:${rect.top+window.scrollY}px;left:0;width:100%;height:${rect.height}px;background:rgba(76,175,80,0.15);pointer-events:none;z-index:999997;border-left:4px solid #4CAF50;box-sizing:border-box;transition:opacity 0.5s;`;
        document.body.appendChild(h);
        setTimeout(() => { h.style.opacity='0'; setTimeout(() => h.remove(), 500); }, 2000);
    }

    _highlightArea(scrollY) {
        const h = document.createElement('div');
        h.style.cssText = `position:absolute;top:${scrollY}px;left:0;width:100%;height:80px;background:rgba(76,175,80,0.15);pointer-events:none;z-index:999997;transition:opacity 0.5s;border-top:2px solid #4CAF50;border-bottom:2px solid #4CAF50;`;
        document.body.appendChild(h);
        setTimeout(() => { h.style.opacity='0'; setTimeout(() => h.remove(), 500); }, 1000);
    }

    _getSmartPreview() {
        for (const el of document.elementsFromPoint(window.innerWidth / 2, 100)) {
            if (['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName)) continue;
            const text = el.textContent?.trim();
            if (text && text.length > 20) {
                const line = text.split('\n')[0];
                return line.substring(0, 60) + (line.length > 60 ? '...' : '');
            }
        }
        return `Position at ${Math.round((window.scrollY / document.documentElement.scrollHeight) * 100)}%`;
    }

    /* ── Render bookmarks ──────────────────────────────────────── */
    renderBookmarkList() {
        const q = this.bookmarkSearchQuery;
        const toolbarHtml = `
            <div class="scrollmap-bookmarks-toolbar">
                <input type="text" class="scrollmap-bookmarks-search"
                    placeholder="Search bookmarks…" value="${escHtml(q)}"
                    aria-label="Search bookmarks">
            </div>`;

        if (!this.bookmarks.length) {
            this.bookmarkList.innerHTML = toolbarHtml + `<div class="scrollmap-empty">No bookmarks yet<br><small>Press Ctrl+Shift+B to add one</small></div>`;
            this._attachBookmarkSearchListener();
            return;
        }

        const filtered = q
            ? this.bookmarks.filter(b =>
                (b.customTitle||'').toLowerCase().includes(q) ||
                (b.preview||'').toLowerCase().includes(q) ||
                (b.messageContent||'').toLowerCase().includes(q))
            : this.bookmarks;

        const sorted = [...filtered].sort((a, b) => {
            if (a.type==='message' && b.type==='message') return (a.messageIndex||0)-(b.messageIndex||0);
            return (a.scrollY||0)-(b.scrollY||0);
        });

        const changeWarn = this.contentChanged ? `
            <div class="scrollmap-inline-change-warn" role="alert">
                <span>⚠️</span><span>Page content changed. Bookmarks may point to different locations.</span>
            </div>` : '';

        const emptySearch = sorted.length===0 && q
            ? `<div class="scrollmap-empty">No bookmarks match<br><small>"${escHtml(q)}"</small></div>` : '';

        this.bookmarkList.innerHTML = toolbarHtml + changeWarn + emptySearch + sorted.map((bm, idx) => {
            const date  = new Date(bm.timestamp);
            const ts    = `${date.toLocaleDateString([],{month:'short',day:'numeric'})} ${date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
            const icon  = bm.type==='message' ? '💬' : '📍';
            const title = bm.customTitle || (bm.type==='message' ? `Message ${(bm.messageIndex||0)+1}` : `Bookmark ${idx+1}`);
            const commentBadge = bm.comments?.length ? `<span class="bookmark-comments" aria-label="${bm.comments.length} comments">💬 ${bm.comments.length}</span>` : '';
            const staleBadge   = this.contentChanged ? `<span class="bookmark-changed-badge">⚠️ Stale</span>` : '';

            const previewHtml = bm.screenshot
                ? `<div class="scrollmap-bm-screenshot">
                    <img src="${escHtml(bm.screenshot)}" alt="Screenshot of bookmarked area" loading="lazy">
                    <button class="scrollmap-expand-btn" data-id="${bm.id}" aria-label="Expand screenshot">
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 4V1H4M7 1H10V4M10 7V10H7M4 10H1V7" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        Expand
                    </button>
                </div>`
                : `<div class="scrollmap-bookmark-preview">${escHtml(bm.preview || 'No preview')}</div>`;

            return `
                <div class="scrollmap-bookmark-item" data-id="${bm.id}" tabindex="0" role="button"
                    aria-label="Bookmark: ${escHtml(title)}">
                    <div class="scrollmap-bookmark-actions" role="group" aria-label="Bookmark actions">
                        <button class="scrollmap-action-btn scrollmap-comment-btn" aria-label="Add comment">💬</button>
                        <button class="scrollmap-action-btn scrollmap-edit-btn" aria-label="Edit title">✎</button>
                        <button class="scrollmap-action-btn scrollmap-delete-btn" aria-label="Delete bookmark">✕</button>
                    </div>
                    <div class="scrollmap-bookmark-header">
                        <span class="scrollmark-badge" aria-hidden="true">${idx+1}</span>
                        <span class="scrollmap-bookmark-title">${icon} ${escHtml(title)}</span>
                    </div>
                    ${previewHtml}
                    <div class="scrollmap-bookmark-meta">
                        <span class="scrollmap-bookmark-time">${escHtml(ts)}</span>
                        <div style="display:flex;gap:4px;align-items:center">${staleBadge}${commentBadge}</div>
                    </div>
                </div>`;
        }).join('');

        this._attachBookmarkSearchListener();
        this._attachBookmarkEvents();
    }

    _attachBookmarkSearchListener() {
        const inp = this.bookmarkList.querySelector('.scrollmap-bookmarks-search');
        if (!inp) return;
        inp.addEventListener('input', e => {
            this.bookmarkSearchQuery = e.target.value.toLowerCase();
            const pos = e.target.selectionStart;
            this.renderBookmarkList();
            const ni = this.bookmarkList.querySelector('.scrollmap-bookmarks-search');
            if (ni) { ni.focus(); ni.setSelectionRange(pos, pos); }
        });
    }

    _attachBookmarkEvents() {
        this.bookmarkList.querySelectorAll('.scrollmap-bookmark-item').forEach(item => {
            const id = parseInt(item.dataset.id);
            const bm = this.bookmarks.find(b => b.id === id);

            const navigate = e => {
                if (e.target.classList.contains('scrollmap-action-btn')) return;
                if (e.target.closest('.scrollmap-expand-btn')) return;
                if (bm) { this.navigateToBookmark(bm); if (window.innerWidth <= 768) this.hidePanel(); }
            };
            item.addEventListener('click', navigate);
            item.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); navigate(e); } });

            item.querySelector('.scrollmap-edit-btn')?.addEventListener('click', e => { e.stopPropagation(); this._editBookmarkTitle(bm, item); });
            item.querySelector('.scrollmap-comment-btn')?.addEventListener('click', e => { e.stopPropagation(); this._showCommentModal(bm); });
            item.querySelector('.scrollmap-delete-btn')?.addEventListener('click', e => { e.stopPropagation(); this._deleteBookmarkWithUndo(id); });
            item.querySelector('.scrollmap-expand-btn')?.addEventListener('click', e => { e.stopPropagation(); if (bm?.screenshot) this._openLightbox(bm); });
        });
    }

    _openLightbox(bm) {
        document.querySelector('.scrollmap-lightbox')?.remove();
        const lb = document.createElement('div');
        lb.className = 'scrollmap-lightbox';
        lb.setAttribute('role', 'dialog');
        lb.setAttribute('aria-modal', 'true');
        lb.setAttribute('aria-label', 'Screenshot lightbox');
        lb.innerHTML = `
            <div class="sm-lb-backdrop"></div>
            <div class="sm-lb-content">
                <div class="sm-lb-header">
                    <span class="sm-lb-title">${escHtml(bm.customTitle||'Screenshot')}</span>
                    <div class="sm-lb-controls">
                        <a class="sm-lb-download" download="scrollmap-screenshot.jpg" href="${escHtml(bm.screenshot)}" title="Download" aria-label="Download screenshot">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </a>
                        <button class="sm-lb-close" aria-label="Close lightbox">✕</button>
                    </div>
                </div>
                <div class="sm-lb-img-wrap"><img src="${escHtml(bm.screenshot)}" alt="Full screenshot of bookmarked area"></div>
                <div class="sm-lb-footer">
                    <span class="sm-lb-preview">${escHtml(bm.preview||'')}</span>
                    <span class="sm-lb-date">${new Date(bm.timestamp).toLocaleString()}</span>
                </div>
            </div>`;
        document.body.appendChild(lb);
        requestAnimationFrame(() => lb.classList.add('sm-lb-visible'));
        const close = () => { lb.classList.remove('sm-lb-visible'); setTimeout(() => lb.remove(), 280); document.removeEventListener('keydown', esc); };
        const esc = e => { if (e.key==='Escape') close(); };
        lb.querySelector('.sm-lb-close').addEventListener('click', close);
        lb.querySelector('.sm-lb-backdrop').addEventListener('click', close);
        document.addEventListener('keydown', esc);
    }

    _editBookmarkTitle(bm, item) {
        const span  = item.querySelector('.scrollmap-bookmark-title');
        const icon  = bm.type==='message' ? '💬' : '📍';
        const input = document.createElement('input');
        input.type  = 'text';
        input.value = bm.customTitle || '';
        input.maxLength = 200;
        input.setAttribute('aria-label', 'Edit bookmark title');
        input.style.cssText = 'width:100%;padding:4px 8px;border:1px solid #4CAF50;border-radius:4px;font-size:13px;outline:none;background:var(--sm-panel-input-bg,#fff);color:var(--sm-panel-text,#374151);';
        span.innerHTML = '';
        span.appendChild(input);
        input.focus();
        let saved = false;
        const save = () => {
            if (saved) return; saved = true;
            bm.customTitle = (input.value.trim() || `Bookmark ${bm.id}`).substring(0, 200);
            this.saveBookmarks();
            span.textContent = `${icon} ${bm.customTitle}`;
            this.showToast('📝 Title updated');
        };
        input.addEventListener('keydown', e => {
            if (e.key==='Enter')  { e.preventDefault(); save(); }
            if (e.key==='Escape') { saved=true; span.textContent=`${icon} ${bm.customTitle||''}`; }
        });
        input.addEventListener('blur', save);
    }

    _showCommentModal(bm) {
        document.querySelector('.scrollmap-comment-modal')?.remove();
        const modal = document.createElement('div');
        modal.className = 'scrollmap-comment-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', 'Bookmark comments');
        const comments = bm.comments || [];
        const renderComments = () => {
            modal.querySelector('.scrollmap-comment-list').innerHTML = comments.length
                ? comments.map(c => `
                    <div class="scrollmap-comment-item">
                        <div class="scrollmap-comment-text">${escHtml(c.text)}</div>
                        <div class="scrollmap-comment-time">${new Date(c.timestamp).toLocaleString()}</div>
                    </div>`).join('')
                : '<div class="scrollmap-comment-empty">No comments yet</div>';
        };
        modal.innerHTML = `
            <div class="scrollmap-comment-modal-content${this.panel.classList.contains('scrollmap-dark')?' scrollmap-dark':''}">
                <h4>💬 Comments</h4>
                <div class="scrollmap-comment-list"></div>
                <textarea class="scrollmap-comment-input" placeholder="Add a comment…" rows="2" maxlength="2000" aria-label="Comment text"></textarea>
                <div class="scrollmap-comment-actions">
                    <button class="scrollmap-comment-save">Save</button>
                    <button class="scrollmap-comment-cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        renderComments();
        modal.querySelector('.scrollmap-comment-save').addEventListener('click', () => {
            const text = modal.querySelector('.scrollmap-comment-input').value.trim().substring(0, 2000);
            if (text) {
                if (!bm.comments) bm.comments = [];
                bm.comments.push({ id: Date.now(), text, timestamp: new Date().toISOString() });
                this.saveBookmarks();
                this.showToast('💬 Comment added');
                modal.querySelector('.scrollmap-comment-input').value = '';
                renderComments();
            }
        });
        modal.querySelector('.scrollmap-comment-cancel').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target===modal) modal.remove(); });
    }

    renderMiniMarkers() {
        this.miniMarkers.innerHTML = '';
        this.bookmarks.forEach((bm, idx) => {
            const m = document.createElement('div');
            m.className = 'scrollmap-mini-marker';
            if (bm.type==='message' && this.isChatSite) {
                const total = this._findAllMessages().length || 50;
                m.style.top = `${Math.min(98, Math.max(2, ((bm.messageIndex||0)/total)*100))}%`;
            } else {
                m.style.top = `${Math.max(0, Math.min(100, bm.scrollPercent||0))}%`;
            }
            m.title = bm.customTitle || `Bookmark ${idx+1}`;
            this.miniMarkers.appendChild(m);
        });
    }

    /* ── Delete with undo ──────────────────────────────────────── */
    async _deleteBookmarkWithUndo(id) {
        const bm = this.bookmarks.find(b => b.id === id);
        if (!bm) return;
        const snapshot = JSON.parse(JSON.stringify(bm));
        this.bookmarks = this.bookmarks.filter(b => b.id !== id);
        await this.saveBookmarks();
        this._afterBookmarkChange();

        document.querySelector('.sm-undo-toast')?.remove();
        const t = document.createElement('div');
        t.className = 'sm-undo-toast';
        t.innerHTML = `<span>🗑️ Bookmark deleted</span><button class="sm-undo-btn">Undo</button>`;
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add('sm-undo-visible'));
        const timer = setTimeout(() => {
            if (snapshot.screenshotKey) ScrollMapDB.delScreenshot(snapshot.screenshotKey);
            dismiss();
        }, 5000);
        const dismiss = () => { clearTimeout(timer); t.classList.remove('sm-undo-visible'); setTimeout(() => t.remove(), 300); };
        t.querySelector('.sm-undo-btn').addEventListener('click', async () => {
            clearTimeout(timer);
            this.bookmarks.push(snapshot);
            if (snapshot.screenshotKey) snapshot.screenshot = await ScrollMapDB.getScreenshot(snapshot.screenshotKey);
            await this.saveBookmarks();
            this._afterBookmarkChange();
            this.showToast('↩️ Bookmark restored');
            dismiss();
        });
    }

    _afterBookmarkChange() {
        if (!this.bookmarks.length && !this.isChatSite) this.cleanupObserver();
        else if (!this.observer) this.setupMutationObserver();
    }

    /* ── Notes storage ─────────────────────────────────────────── */
    async loadNotes() {
        try {
            const r = await chrome.storage.local.get(`notes_${this.pageUrl}`);
            const raw = r[`notes_${this.pageUrl}`];
            this.notes      = Array.isArray(raw) ? raw.filter(validateNote) : [];
            this.nextNoteId = this.notes.length ? Math.max(...this.notes.map(n=>n.id), 0)+1 : 1;
        } catch { this.notes = []; }
    }

    async saveNotes() {
        try {
            await chrome.storage.local.set({ [`notes_${this.pageUrl}`]: this.notes });
            if (this.panelVisible && this.activePanelTab === 'notes') this.renderNotesList();
        } catch (err) { ScrollMapDB.logError('saveNotes', err.message); }
    }

    async loadStickyNotes() {
        try {
            const r = await chrome.storage.local.get(`sticky_notes_${this.pageUrl}`);
            this.stickyNotes  = r[`sticky_notes_${this.pageUrl}`] || [];
            this.nextStickyId = this.stickyNotes.length ? Math.max(...this.stickyNotes.map(s=>s.id))+1 : 1;
        } catch { this.stickyNotes = []; }
    }

    async saveStickyNotes() {
        try { await chrome.storage.local.set({ [`sticky_notes_${this.pageUrl}`]: this.stickyNotes }); }
        catch { /* non-fatal */ }
    }

    /* ── Sticky notes rendering ────────────────────────────────── */
    renderAllStickyNotes() {
        document.querySelectorAll('.sm-sticky-note').forEach(el => el.remove());
        this.stickyNotes.forEach(sticky => {
            const el = this._createStickyEl(sticky);
            document.body.appendChild(el);
            requestAnimationFrame(() => el.classList.add('sm-sticky-visible'));
        });
    }

    _replaceStickyEl(old, sticky) {
        const el = this._createStickyEl(sticky);
        if (old?.parentNode) { old.parentNode.insertBefore(el, old); old.remove(); }
        else document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('sm-sticky-visible'));
        return el;
    }

    _createStickyEl(sticky) {
        const PALETTE = {
            yellow: { bg:'#fef9c3', header:'rgba(202,138,4,0.18)',  text:'#713f12' },
            green:  { bg:'#dcfce7', header:'rgba(22,163,74,0.18)',  text:'#14532d' },
            blue:   { bg:'#dbeafe', header:'rgba(37,99,235,0.18)',  text:'#1e3a8a' },
            pink:   { bg:'#fce7f3', header:'rgba(219,39,119,0.18)', text:'#831843' },
            purple: { bg:'#ede9fe', header:'rgba(109,40,217,0.18)', text:'#4c1d95' },
        };
        const theme = PALETTE[sticky.color] || PALETTE.yellow;
        const note  = this.notes.find(n => n.id === sticky.noteId);
        const title   = note?.title   || sticky.noteTitle   || '✏️ Sticky Note';
        const content = note?.content || sticky.noteContent || '';
        const media   = note?.media   || sticky.media       || [];

        const buildMedia = (expanded) => {
            if (!media.length) return '';
            return '<div class="sm-sticky-media">' + media.map(m => {
                if (m.type==='image' && m.data?.startsWith('data:image/'))
                    return `<img src="${escHtml(m.data)}" alt="${escHtml(m.name||'image')}" class="sm-sticky-img${expanded?' sm-sticky-img-full':''}">`;
                if (m.type==='video') {
                    const ytId = this._ytId(m.url||'');
                    if (ytId) return `<div class="sm-sticky-yt-thumb" data-yt-id="${escHtml(ytId)}"><img src="https://img.youtube.com/vi/${escHtml(ytId)}/hqdefault.jpg" alt="Video" loading="lazy"><div class="sm-sticky-yt-overlay"><span class="sm-sticky-yt-play-btn">▶</span></div></div>`;
                    if (isSafeUrl(m.url)) return `<a href="${escHtml(m.url)}" target="_blank" rel="noopener noreferrer" class="sm-sticky-link">🎬 ${escHtml(m.url.substring(0,36))}…</a>`;
                }
                if (m.type==='link' && isSafeUrl(m.url))
                    return `<a href="${escHtml(m.url)}" target="_blank" rel="noopener noreferrer" class="sm-sticky-link">🔗 ${escHtml(m.label||m.url)}</a>`;
                return '';
            }).join('') + '</div>';
        };

        const el = document.createElement('div');
        el.className = 'sm-sticky-note' + (sticky.minimized?' sm-sticky-min':'') + (sticky.expanded?' sm-sticky-expanded':'');
        el.dataset.stickyId = sticky.id;
        el.setAttribute('role', 'note');
        el.setAttribute('aria-label', `Sticky note: ${title}`);
        el.style.cssText = `left:${sticky.x}px;top:${sticky.y}px;--sm-sk-bg:${theme.bg};--sm-sk-hd:${theme.header};--sm-sk-txt:${theme.text};`;
        if (sticky.width) el.style.width = sticky.width + 'px';

        el.innerHTML = `
            <div class="sm-sticky-header" title="Drag to move">
                <span class="sm-sticky-grip" aria-hidden="true">⠿</span>
                <span class="sm-sticky-label" title="${escHtml(title)}">${escHtml(title)}</span>
                <div class="sm-sticky-controls">
                    <button class="sm-sk-btn sm-sk-edit" title="Edit text & attach media" aria-label="Edit note">✎</button>
                    <button class="sm-sk-btn sm-sk-color" title="Change color" aria-label="Change color">🎨</button>
                    <button class="sm-sk-btn sm-sk-expand" aria-label="${sticky.expanded?'Compact':'Expand'}">${sticky.expanded?'⊖':'⊕'}</button>
                    <button class="sm-sk-btn sm-sk-toggle" aria-label="${sticky.minimized?'Show':'Minimize'}">${sticky.minimized?'▲':'▼'}</button>
                    <button class="sm-sk-btn sm-sk-close" aria-label="Unpin note">✕</button>
                </div>
            </div>
            <div class="sm-sticky-swatches" style="display:none">
                ${['yellow','green','blue','pink','purple'].map(c=>`<button data-color="${c}" style="background:${PALETTE[c].bg}" title="${c[0].toUpperCase()+c.slice(1)}" aria-label="${c}"></button>`).join('')}
            </div>
            <div class="sm-sticky-body" title="Click text to edit note">
                ${content ? `<div class="sm-sticky-text">${escHtml(content)}</div>` : `<div class="sm-sticky-text sm-sticky-placeholder">✏️ Click to write note...</div>`}
                ${buildMedia(!!sticky.expanded)}
                <div class="sm-sticky-quick-actions">
                    <button class="sm-sticky-act-btn sm-sk-act-edit" title="Write/edit text">✏️ Edit</button>
                    <button class="sm-sticky-act-btn sm-sk-act-image" title="Attach image">🖼 Image</button>
                    <button class="sm-sticky-act-btn sm-sk-act-video" title="Attach video">🎬 Video</button>
                    <button class="sm-sticky-act-btn sm-sk-act-link" title="Attach link">🔗 Link</button>
                </div>
            </div>
            <div class="sm-sticky-resize-handle" title="Drag to resize" aria-hidden="true">⇲</div>`;

        this._setupStickyBehavior(el, sticky);
        return el;
    }

    _setupStickyBehavior(el, sticky) {
        const openEditorWithAction = (action = null) => {
            let note = this.notes.find(n => n.id === sticky.noteId);
            if (!note) {
                note = {
                    id: sticky.noteId || this.nextNoteId++,
                    title: sticky.noteTitle || '✏️ Sticky Note',
                    content: sticky.noteContent || '',
                    media: JSON.parse(JSON.stringify(sticky.media || [])),
                    timestamp: new Date().toISOString()
                };
                this.notes.unshift(note);
                sticky.noteId = note.id;
                this.saveNotes();
            }
            this.showNoteModal(note);
            if (action) {
                setTimeout(() => {
                    if (action === 'image') document.querySelector('#snm-add-image')?.click();
                    if (action === 'video') document.querySelector('#snm-add-video')?.click();
                    if (action === 'link')  document.querySelector('#snm-add-link')?.click();
                }, 120);
            }
        };

        el.querySelector('.sm-sk-edit')?.addEventListener('click', e => { e.stopPropagation(); openEditorWithAction(); });
        el.querySelector('.sm-sticky-text')?.addEventListener('click', e => { e.stopPropagation(); openEditorWithAction(); });
        el.querySelector('.sm-sk-act-edit')?.addEventListener('click', e => { e.stopPropagation(); openEditorWithAction(); });
        el.querySelector('.sm-sk-act-image')?.addEventListener('click', e => { e.stopPropagation(); openEditorWithAction('image'); });
        el.querySelector('.sm-sk-act-video')?.addEventListener('click', e => { e.stopPropagation(); openEditorWithAction('video'); });
        el.querySelector('.sm-sk-act-link')?.addEventListener('click', e => { e.stopPropagation(); openEditorWithAction('link'); });

        const header = el.querySelector('.sm-sticky-header');
        header.addEventListener('mousedown', e => {
            if (e.target.closest('.sm-sticky-controls')) return;
            const ox = e.clientX - sticky.x, oy = e.clientY - sticky.y;
            el.classList.add('sm-sticky-dragging');
            const onMove = ev => {
                sticky.x = Math.max(0, Math.min(window.innerWidth-80,  ev.clientX-ox));
                sticky.y = Math.max(0, Math.min(window.innerHeight-50, ev.clientY-oy));
                el.style.left = sticky.x+'px'; el.style.top = sticky.y+'px';
            };
            const onUp = () => {
                el.classList.remove('sm-sticky-dragging');
                this.saveStickyNotes();
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
        el.querySelector('.sm-sticky-resize-handle')?.addEventListener('mousedown', e => {
            e.stopPropagation(); e.preventDefault();
            const sx=e.clientX, sw=el.offsetWidth;
            const onMove = ev => { el.style.width = Math.max(200, Math.min(600, sw+(ev.clientX-sx)))+'px'; };
            const onUp   = () => { sticky.width=el.offsetWidth; this.saveStickyNotes(); document.removeEventListener('mousemove',onMove); document.removeEventListener('mouseup',onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        el.querySelector('.sm-sk-expand')?.addEventListener('click', e => { e.stopPropagation(); sticky.expanded=!sticky.expanded; sticky.minimized=false; this._replaceStickyEl(el,sticky); this.saveStickyNotes(); });
        el.querySelector('.sm-sk-toggle')?.addEventListener('click', e => { e.stopPropagation(); sticky.minimized=!sticky.minimized; if(sticky.minimized)sticky.expanded=false; this._replaceStickyEl(el,sticky); this.saveStickyNotes(); });
        el.querySelector('.sm-sk-close')?.addEventListener('click', e => {
            e.stopPropagation();
            el.classList.add('sm-sticky-removing');
            setTimeout(() => { el.remove(); this.stickyNotes=this.stickyNotes.filter(s=>s.id!==sticky.id); this.saveStickyNotes(); if(this.panelVisible&&this.activePanelTab==='notes')this.renderNotesList(); }, 280);
        });
        const swatches = el.querySelector('.sm-sticky-swatches');
        el.querySelector('.sm-sk-color')?.addEventListener('click', e => { e.stopPropagation(); swatches.style.display=swatches.style.display==='none'?'flex':'none'; });
        swatches.querySelectorAll('button[data-color]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); sticky.color=btn.dataset.color; swatches.style.display='none'; this._replaceStickyEl(el,sticky); this.saveStickyNotes(); }));
        el.querySelectorAll('.sm-sticky-yt-thumb').forEach(thumb => thumb.addEventListener('click', () => {
            const ytId = thumb.dataset.ytId; if(!ytId) return;
            const wrap=document.createElement('div'); wrap.className='sm-sticky-yt-wrap';
            const iframe=document.createElement('iframe');
            iframe.src=`https://www.youtube.com/embed/${encodeURIComponent(ytId)}?autoplay=1`;
            iframe.frameBorder='0'; iframe.allowFullscreen=true;
            iframe.allow='accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture';
            wrap.appendChild(iframe); thumb.replaceWith(wrap);
        }));
        el.addEventListener('click', e => e.stopPropagation());
        el.addEventListener('mousedown', e => e.stopPropagation());
    }

    pinNoteAsSticky(note) {
        const existing = this.stickyNotes.find(s => s.noteId===note.id);
        if (existing) {
            const el = document.querySelector(`.sm-sticky-note[data-sticky-id="${existing.id}"]`);
            if (el) { el.classList.remove('sm-sticky-flash'); void el.offsetWidth; el.classList.add('sm-sticky-flash'); }
            this.showToast('📌 Already pinned'); return;
        }
        const offset = (this.stickyNotes.length % 7) * 24;
        const sticky = {
            id: this.nextStickyId++, noteId: note.id,
            noteTitle: note.title||'✏️ Sticky Note', noteContent: note.content||'',
            media: JSON.parse(JSON.stringify(note.media||[])),
            x: Math.min(window.innerWidth-290, 60+offset),
            y: Math.min(window.innerHeight-220, 100+offset),
            minimized: false, expanded: false, color: 'yellow'
        };
        this.stickyNotes.push(sticky);
        this.saveStickyNotes();
        const el = this._createStickyEl(sticky);
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('sm-sticky-visible'));
        this.showToast('📌 Note pinned to page!');
        if (this.panelVisible && this.activePanelTab==='notes') this.renderNotesList();
    }

    /* ── Render notes list ─────────────────────────────────────── */
    renderNotesList() {
        const toolbar = `
            <div class="scrollmap-notes-toolbar">
                <button class="scrollmap-add-note-btn" aria-label="Create new note">✏️ New Note</button>
                <input type="text" class="scrollmap-notes-search" placeholder="Search notes…" value="${escHtml(this.noteSearchQuery)}" aria-label="Search notes">
            </div>`;

        if (!this.notes.length) {
            this.notesList.innerHTML = toolbar + `<div class="scrollmap-empty">No notes yet<br><small>Click "New Note" to add one</small></div>`;
            this.notesList.querySelector('.scrollmap-add-note-btn')?.addEventListener('click', () => this.showNoteModal());
            return;
        }

        const q = this.noteSearchQuery;
        const filtered = q ? this.notes.filter(n => (n.title||'').toLowerCase().includes(q)||(n.content||'').toLowerCase().includes(q)) : this.notes;
        const sorted   = [...filtered].sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp));

        this.notesList.innerHTML = toolbar + (sorted.length===0 ? '<div class="scrollmap-empty">No notes match your search</div>' :
            sorted.map(note => {
                const date    = new Date(note.timestamp);
                const ts      = `${date.toLocaleDateString([],{month:'short',day:'numeric'})} ${date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
                const preview = note.content ? escHtml(note.content.substring(0,80))+(note.content.length>80?'…':'') : '<em style="opacity:0.5">No content</em>';
                const mediaCount = note.media?.length||0;
                const isPinned   = this.stickyNotes.some(s=>s.noteId===note.id);
                const firstImg   = note.media?.find(m=>m.type==='image'&&m.data?.startsWith('data:image/'));
                return `
                    <div class="scrollmap-note-item" data-id="${note.id}" tabindex="0" role="button" aria-label="Note: ${escHtml(note.title||'Untitled')}">
                        <div class="scrollmap-bookmark-actions" role="group">
                            <button class="scrollmap-action-btn note-pin-btn" aria-label="Pin to page">📌</button>
                            <button class="scrollmap-action-btn note-edit-btn" aria-label="Edit note">✎</button>
                            <button class="scrollmap-action-btn note-delete-btn" aria-label="Delete note">✕</button>
                        </div>
                        ${firstImg?`<div class="note-thumb"><img src="${escHtml(firstImg.data)}" alt="Note thumbnail" loading="lazy"></div>`:''}
                        <div class="note-inner">
                            <div class="note-title">${escHtml(note.title||'✏️ Untitled Note')}</div>
                            <div class="note-preview">${preview}</div>
                            <div class="note-footer">
                                <span class="scrollmap-bookmark-time">${escHtml(ts)}</span>
                                <div style="display:flex;gap:4px;align-items:center">
                                    ${isPinned?'<span class="note-pinned-badge">📌 Pinned</span>':''}
                                    ${mediaCount?`<span class="note-media-badge">🖼 ${mediaCount}</span>`:''}
                                </div>
                            </div>
                        </div>
                    </div>`;
            }).join(''));

        this.notesList.querySelector('.scrollmap-add-note-btn')?.addEventListener('click', () => this.showNoteModal());
        const searchInp = this.notesList.querySelector('.scrollmap-notes-search');
        if (searchInp) {
            searchInp.addEventListener('input', e => {
                this.noteSearchQuery = e.target.value.toLowerCase();
                const pos = e.target.selectionStart;
                this.renderNotesList();
                const ni = this.notesList.querySelector('.scrollmap-notes-search');
                if (ni) { ni.focus(); ni.setSelectionRange(pos, pos); }
            });
        }
        this.notesList.querySelectorAll('.scrollmap-note-item').forEach(item => {
            const id   = parseInt(item.dataset.id);
            const note = this.notes.find(n=>n.id===id);
            const open = e => { if (e.target.classList.contains('scrollmap-action-btn')) return; if(note) this.showNoteModal(note); };
            item.addEventListener('click', open);
            item.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); open(e); } });
            item.querySelector('.note-pin-btn')?.addEventListener('click', e => { e.stopPropagation(); if(note) this.pinNoteAsSticky(note); });
            item.querySelector('.note-edit-btn')?.addEventListener('click', e => { e.stopPropagation(); this.showNoteModal(note); });
            item.querySelector('.note-delete-btn')?.addEventListener('click', e => { e.stopPropagation(); this._deleteNote(id); });
        });
    }

    _deleteNote(id) {
        this.notes.splice(this.notes.findIndex(n=>n.id===id), 1);
        const si = this.stickyNotes.findIndex(s=>s.noteId===id);
        if (si >= 0) {
            const el = document.querySelector(`.sm-sticky-note[data-sticky-id="${this.stickyNotes[si].id}"]`);
            if (el) { el.classList.add('sm-sticky-removing'); setTimeout(()=>el.remove(), 280); }
            this.stickyNotes.splice(si, 1);
            this.saveStickyNotes();
        }
        this.saveNotes();
        this.showToast('🗑️ Note deleted');
    }

    /* ── Note modal ────────────────────────────────────────────── */
    showNoteModal(existingNote=null) {
        document.querySelector('.scrollmap-note-modal')?.remove();
        const isDark = this.panel.classList.contains('scrollmap-dark');
        const isEdit = !!existingNote;
        const media  = existingNote ? JSON.parse(JSON.stringify(existingNote.media||[])) : [];

        const modal = document.createElement('div');
        modal.className = 'scrollmap-note-modal' + (isDark?' scrollmap-dark':'');
        modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); modal.setAttribute('aria-label','Note editor');
        modal.innerHTML = `
            <div class="snm-box">
                <div class="snm-header">
                    <span>${isEdit?'✏️ Edit Note':'📝 New Note'}</span>
                    <button class="snm-close" aria-label="Close">✕</button>
                </div>
                <div class="snm-body">
                    <input type="text" class="snm-title-input" placeholder="Title (optional)" maxlength="200" value="${escHtml(existingNote?.title||'')}">
                    <textarea class="snm-content-input" placeholder="Write your note here…" rows="5" maxlength="10000">${escHtml(existingNote?.content||'')}</textarea>
                    <div class="snm-media-section">
                        <div class="snm-media-label">Attachments</div>
                        <div class="snm-media-toolbar">
                            <button class="snm-media-btn" id="snm-add-image">🖼 Add Image</button>
                            <button class="snm-media-btn" id="snm-add-video">🎬 Add Video URL</button>
                            <button class="snm-media-btn" id="snm-add-link">🔗 Add Link</button>
                        </div>
                        <input type="file" accept="image/*" multiple id="snm-image-input" style="display:none" aria-label="Upload images">
                        <div class="snm-media-list"></div>
                    </div>
                    <div class="snm-actions">
                        <button class="snm-save-btn">${isEdit?'Update Note':'Save Note'}</button>
                        <button class="snm-cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        requestAnimationFrame(() => modal.classList.add('exm-visible'));

        const closeModal = () => { modal.classList.remove('exm-visible'); setTimeout(()=>modal.remove(), 280); document.removeEventListener('keydown', onEsc); };
        const onEsc = e => { if(e.key==='Escape') closeModal(); };
        document.addEventListener('keydown', onEsc);

        const mediaList = modal.querySelector('.snm-media-list');

        const renderMedia = () => {
            const images = media.map((m,i)=>({...m,_idx:i})).filter(m=>m.type==='image'&&m.data?.startsWith('data:image/'));
            const others = media.map((m,i)=>({...m,_idx:i})).filter(m=>m.type!=='image');
            let html = '';
            if (images.length) {
                const gc = images.length===1?'snm-gallery-1':images.length===2?'snm-gallery-2':images.length===3?'snm-gallery-3':'snm-gallery-many';
                const shown=images.slice(0,4), overflow=images.length-4;
                html += `<div class="snm-image-gallery ${gc}">` + shown.map((m,si)=>`
                    <div class="snm-gallery-cell" data-img-index="${si}">
                        <img src="${escHtml(m.data)}" alt="${escHtml(m.name||'image')}" loading="lazy">
                        ${si===3&&overflow>0?`<div class="snm-gallery-overflow">+${overflow+1}</div>`:''}
                        <button class="snm-gallery-remove" data-index="${m._idx}" aria-label="Remove image">✕</button>
                    </div>`).join('') + '</div>';
                if (images.length>1) html+=`<div class="snm-gallery-footer"><span>${images.length} images</span><button class="snm-gallery-remove-all">Remove all</button></div>`;
            }
            others.forEach(m => {
                const i=m._idx;
                if (m.type==='video') {
                    const ytId=this._ytId(m.url||'');
                    if (ytId) html+=`<div class="snm-media-item"><div class="snm-yt-lazy-thumb" data-yt-id="${escHtml(ytId)}"><img src="https://img.youtube.com/vi/${escHtml(ytId)}/hqdefault.jpg" alt="YouTube thumbnail" loading="lazy"><div class="snm-yt-play-overlay"><span>▶</span></div></div><div class="snm-media-item-info"><span>🎬 ${escHtml(m.url.substring(0,40))}</span><button class="snm-remove-media" data-index="${i}">✕ Remove</button></div></div>`;
                    else if (isSafeUrl(m.url)) html+=`<div class="snm-media-item"><div class="snm-video-wrap"><video src="${escHtml(m.url)}" controls preload="metadata"></video></div><div class="snm-media-item-info"><span>🎬 ${escHtml(m.url.substring(0,40))}</span><button class="snm-remove-media" data-index="${i}">✕ Remove</button></div></div>`;
                } else if (m.type==='link'&&isSafeUrl(m.url)) {
                    html+=`<div class="snm-media-item snm-link-item"><div class="snm-link-preview">🔗 <a href="${escHtml(m.url)}" target="_blank" rel="noopener noreferrer">${escHtml(m.label||m.url)}</a></div><button class="snm-remove-media" data-index="${i}">✕ Remove</button></div>`;
                }
            });
            mediaList.innerHTML = html;
            mediaList.querySelectorAll('.snm-gallery-cell').forEach((cell,si)=>cell.addEventListener('click',e=>{if(e.target.classList.contains('snm-gallery-remove'))return;this._openGalleryLightbox(images,si);}));
            mediaList.querySelectorAll('.snm-gallery-remove, .snm-remove-media').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();media.splice(parseInt(btn.dataset.index),1);renderMedia();}));
            mediaList.querySelector('.snm-gallery-remove-all')?.addEventListener('click',()=>{for(let i=media.length-1;i>=0;i--){if(media[i].type==='image')media.splice(i,1);}renderMedia();});
            mediaList.querySelectorAll('.snm-yt-lazy-thumb').forEach(thumb=>thumb.addEventListener('click',()=>{const ytId=thumb.dataset.ytId;if(!ytId)return;const wrap=document.createElement('div');wrap.className='snm-video-wrap';const iframe=document.createElement('iframe');iframe.src=`https://www.youtube.com/embed/${encodeURIComponent(ytId)}?autoplay=1`;iframe.frameBorder='0';iframe.allowFullscreen=true;iframe.allow='accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture';wrap.appendChild(iframe);thumb.replaceWith(wrap);}));
        };
        renderMedia();

        modal.querySelector('#snm-add-image').addEventListener('click',()=>modal.querySelector('#snm-image-input').click());
        modal.querySelector('#snm-image-input').addEventListener('change',e=>{
            const files=Array.from(e.target.files).filter(f=>f.type.startsWith('image/'));
            const oversized=files.filter(f=>f.size>3*1024*1024);
            if(oversized.length)this.showToast(`❌ ${oversized.length} image(s) exceed 3MB limit`);
            const valid=files.filter(f=>f.size<=3*1024*1024);
            if(!valid.length){e.target.value='';return;}
            let loaded=0;
            valid.forEach(file=>{const r=new FileReader();r.onload=ev=>{if(ev.target.result?.startsWith('data:image/'))media.push({type:'image',data:ev.target.result,name:file.name.substring(0,100)});loaded++;if(loaded===valid.length){renderMedia();this.showToast(`🖼 ${valid.length} image${valid.length>1?'s':''} added`);}};r.onerror=()=>loaded++;r.readAsDataURL(file);});
            e.target.value='';
        });
        modal.querySelector('#snm-add-video').addEventListener('click',()=>this._inlinePrompt(modal,'Enter video URL (YouTube or .mp4):','',url=>{if(url?.trim()&&isSafeUrl(url.trim())){media.push({type:'video',url:url.trim().substring(0,2000)});renderMedia();this.showToast('🎬 Video added');}else if(url?.trim())this.showToast('❌ Invalid URL');}));
        modal.querySelector('#snm-add-link').addEventListener('click',()=>this._inlinePrompt(modal,'Enter URL:','',url=>{if(!url?.trim())return;if(!isSafeUrl(url.trim())){this.showToast('❌ Invalid URL');return;}this._inlinePrompt(modal,'Link label (optional):',url.trim(),label=>{media.push({type:'link',url:url.trim().substring(0,2000),label:(label?.trim()||url.trim()).substring(0,200)});renderMedia();this.showToast('🔗 Link added');});}));

        modal.querySelector('.snm-save-btn').addEventListener('click',()=>{
            const title   = modal.querySelector('.snm-title-input').value.trim().substring(0,200);
            const content = modal.querySelector('.snm-content-input').value.trim().substring(0,10000);
            if(!title&&!content&&!media.length){this.showToast('⚠️ Note is empty');return;}
            if(isEdit){
                existingNote.title=title;existingNote.content=content;existingNote.media=media;existingNote.editedAt=new Date().toISOString();
                const sticky=this.stickyNotes.find(s=>s.noteId===existingNote.id);
                if(sticky){sticky.noteTitle=title;sticky.noteContent=content;sticky.media=JSON.parse(JSON.stringify(media));this.saveStickyNotes();const el=document.querySelector(`.sm-sticky-note[data-sticky-id="${sticky.id}"]`);if(el)this._replaceStickyEl(el,sticky);}
            } else {
                this.notes.unshift({id:this.nextNoteId++,title,content,media,timestamp:new Date().toISOString()});
            }
            this.saveNotes();
            this.showToast(isEdit?'📝 Note updated':'✅ Note saved');
            closeModal();
        });
        modal.querySelector('.snm-close').addEventListener('click', closeModal);
        modal.querySelector('.snm-cancel-btn').addEventListener('click', closeModal);
        modal.addEventListener('click', e => { if(e.target===modal) closeModal(); });
    }

    _openGalleryLightbox(images, startIndex) {
        document.querySelector('.snm-gallery-lightbox')?.remove();
        let current = startIndex;
        const lb = document.createElement('div');
        lb.className = 'snm-gallery-lightbox';
        const render = () => {
            lb.innerHTML = `<div class="snm-glb-backdrop"></div><div class="snm-glb-content"><div class="snm-glb-header"><span class="snm-glb-counter">${current+1} / ${images.length}</span><button class="snm-glb-close" aria-label="Close">✕</button></div><div class="snm-glb-img-wrap">${images.length>1?'<button class="snm-glb-prev" aria-label="Previous">‹</button>':''}<img src="${escHtml(images[current].data)}" alt="${escHtml(images[current].name||'image')}">${images.length>1?'<button class="snm-glb-next" aria-label="Next">›</button>':''}</div></div>`;
            lb.querySelector('.snm-glb-close').addEventListener('click', close);
            lb.querySelector('.snm-glb-backdrop').addEventListener('click', close);
            lb.querySelector('.snm-glb-prev')?.addEventListener('click', e=>{e.stopPropagation();current=(current-1+images.length)%images.length;render();});
            lb.querySelector('.snm-glb-next')?.addEventListener('click', e=>{e.stopPropagation();current=(current+1)%images.length;render();});
        };
        const close = () => { lb.classList.remove('snm-glb-visible'); setTimeout(()=>lb.remove(),260); document.removeEventListener('keydown',onKey); };
        const onKey = e => { if(e.key==='Escape')close(); if(e.key==='ArrowLeft'){current=(current-1+images.length)%images.length;render();} if(e.key==='ArrowRight'){current=(current+1)%images.length;render();} };
        document.addEventListener('keydown', onKey);
        document.body.appendChild(lb);
        render();
        requestAnimationFrame(() => lb.classList.add('snm-glb-visible'));
    }

    _inlinePrompt(parentModal, label, defaultVal, callback) {
        parentModal.querySelector('.snm-inline-prompt')?.remove();
        const wrap = document.createElement('div');
        wrap.className = 'snm-inline-prompt';
        wrap.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:var(--sm-panel-bg);border-top:1.5px solid var(--sm-panel-border);padding:12px 16px;display:flex;flex-direction:column;gap:8px;z-index:10;border-radius:0 0 16px 16px;';
        wrap.innerHTML = `<div style="font-family:'Outfit',sans-serif;font-size:12.5px;font-weight:600;color:var(--sm-panel-text)">${escHtml(label)}</div><input type="text" value="${escHtml(defaultVal)}" maxlength="2000" aria-label="${escHtml(label)}" style="width:100%;padding:8px 11px;border:1.5px solid var(--sm-panel-border);border-radius:8px;font-size:13px;outline:none;background:var(--sm-panel-input-bg);color:var(--sm-panel-text);"><div style="display:flex;gap:7px"><button class="snm-inline-ok" style="flex:1;padding:7px;background:linear-gradient(135deg,#16a34a,#166534);color:white;border:none;border-radius:7px;font-family:'Outfit',sans-serif;font-weight:700;font-size:12px;cursor:pointer;">OK</button><button class="snm-inline-cancel" style="padding:7px 14px;background:var(--sm-panel-input-bg);color:var(--sm-panel-subtext);border:1.5px solid var(--sm-panel-border);border-radius:7px;font-family:'Outfit',sans-serif;font-size:12px;cursor:pointer;">Cancel</button></div>`;
        const box = parentModal.querySelector('.snm-box');
        box.style.position='relative'; box.appendChild(wrap);
        const input=wrap.querySelector('input'); input.focus(); input.select();
        const confirm=()=>{callback(input.value);wrap.remove();};
        const cancel=()=>wrap.remove();
        wrap.querySelector('.snm-inline-ok').addEventListener('click',confirm);
        wrap.querySelector('.snm-inline-cancel').addEventListener('click',cancel);
        input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();confirm();}if(e.key==='Escape')cancel();});
    }

    _ytId(url) {
        if (!url || typeof url!=='string') return null;
        for (const p of [/youtu\.be\/([^?&#]+)/,/[?&]v=([^?&#]+)/,/embed\/([^?&#]+)/]) {
            const m=url.match(p); if(m&&m[1]) return m[1].substring(0,11);
        }
        return null;
    }

    /* ── Export / Import ───────────────────────────────────────── */
    async exportAllData() {
        try {
            const all  = await chrome.storage.local.get(null);
            const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), version: SM_VERSION, data: all }, null, 2)], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `scrollmap-backup-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.showToast('📦 Data exported!');
        } catch (err) {
            this.showToast('❌ Export failed');
            ScrollMapDB.logError('export', err.message);
        }
    }

    async importData(file) {
        try {
            const text = await file.text();
            const obj  = JSON.parse(text);
            if (!obj.data || typeof obj.data !== 'object') { this.showToast('❌ Invalid backup file'); return; }
            const existing = await chrome.storage.local.get(null);
            const merged   = { ...obj.data, ...existing };
            await chrome.storage.local.set(merged);
            this.showToast('✅ Data imported! Reload to see changes.');
        } catch (err) {
            this.showToast('❌ Import failed — invalid file');
            ScrollMapDB.logError('import', err.message);
        }
    }

    /* ── Position tracking ─────────────────────────────────────── */
    checkLastPosition() {
        if (!this.showPrompt) return;
        chrome.runtime.sendMessage({ type: 'GET_LAST_POSITION' }, response => {
            if (chrome.runtime.lastError) return;
            if (response?.position && this.autoSaveEnabled && window.scrollY < 100)
                this._showContinuePrompt(response.position);
        });
    }

    _showContinuePrompt(lastPos) {
        if (document.querySelector('.scrollmap-continue-prompt')) return;
        const prompt = document.createElement('div');
        prompt.className = 'scrollmap-continue-prompt';
        prompt.setAttribute('role','dialog');
        prompt.setAttribute('aria-label','Continue reading prompt');
        prompt.innerHTML = `
            <div class="scrollmap-prompt-content">
                <span class="scrollmap-prompt-icon" aria-hidden="true">🔖</span>
                <div class="scrollmap-prompt-text">
                    <strong>Continue reading?</strong>
                    <small>You were at ${Math.round(lastPos.scrollPercent||0)}%</small>
                </div>
                <button class="scrollmap-prompt-btn scrollmap-prompt-yes" aria-label="Yes, continue reading">Yes</button>
                <button class="scrollmap-prompt-btn scrollmap-prompt-no" aria-label="No, stay at top">No</button>
            </div>`;
        document.body.appendChild(prompt);
        if (this.panelPosition==='left') { prompt.style.right='auto'; prompt.style.left='310px'; }
        const timer = setTimeout(()=>{ if(prompt.parentNode) prompt.remove(); }, 10000);
        prompt.querySelector('.scrollmap-prompt-yes').addEventListener('click',()=>{ clearTimeout(timer); window.scrollTo({top:lastPos.scrollY,behavior:'smooth'}); prompt.remove(); });
        prompt.querySelector('.scrollmap-prompt-no').addEventListener('click',()=>{ clearTimeout(timer); prompt.remove(); });
    }

    saveCurrentPosition() {
        if (!this.autoSaveEnabled) return;
        const scrollY = window.scrollY, dh=document.documentElement.scrollHeight, wh=window.innerHeight;
        const pct = dh>wh ? (scrollY/(dh-wh))*100 : 0;
        if (Math.abs(scrollY - this.lastSavedPosition) > 100) {
            chrome.runtime.sendMessage({ type:'UPDATE_LAST_POSITION', scrollY, scrollPercent:pct }, ()=>{ void chrome.runtime.lastError; });
            this.lastSavedPosition = scrollY;
        }
    }

    /* ── Event listeners ───────────────────────────────────────── */
    setupEventListeners() {
        window.addEventListener('scroll', () => {
            clearTimeout(this.scrollTimeout);
            this.scrollTimeout = setTimeout(() => { if(!this.isChatSite) this.updateBookmarkPositions(); this.saveCurrentPosition(); }, 100);
        }, { passive: true });

        window.addEventListener('resize', () => { if(!this.isChatSite) this.updateBookmarkPositions(); }, { passive: true });
        window.addEventListener('beforeunload', () => this.saveCurrentPosition());
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if(this.theme==='system') this.applyTheme(); });

        document.addEventListener('click', e => {
            if (this.panelVisible && !this.panel.contains(e.target) && !this.toggleBtn.contains(e.target) && !this.quickAddBtn.contains(e.target))
                this.hidePanel();
        });
    }

    updateBookmarkPositions() {
        const dh=document.documentElement.scrollHeight, wh=window.innerHeight;
        this.bookmarks.forEach(b => { if(b.type!=='message') b.scrollPercent = dh>wh ? (b.scrollY/(dh-wh))*100 : 0; });
        this.renderMiniMarkers();
    }

    setupKeyboardShortcut() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.key==='B') { e.preventDefault(); this.addBookmark(); }
            if (e.ctrlKey && e.shiftKey && e.key>='1' && e.key<='9') {
                e.preventDefault();
                const b=this.bookmarks[parseInt(e.key)-1];
                if(b) this.navigateToBookmark(b);
            }
        });
    }

    /* ── MutationObserver ──────────────────────────────────────── */
    setupMutationObserver() {
        if (!this.bookmarks.length && !this.isChatSite) return;
        const target = this._getObserveTarget();
        if (!target) return;
        this.observer = new MutationObserver(mutations => {
            if (mutations.some(m=>m.type==='childList'&&m.addedNodes.length>0)) {
                clearTimeout(this.updateTimeout);
                this.updateTimeout = setTimeout(() => {
                    if(!this.isChatSite) this.updateBookmarkPositions();
                    else this.renderMiniMarkers();
                }, 2000);
            }
        });
        this.observer.observe(target, { childList: true, subtree: this.isChatSite });
    }

    _getObserveTarget() {
        if (this.isChatSite) {
            for (const s of ['[role="log"]','[class*="conversation"]','main']) { const el=document.querySelector(s); if(el) return el; }
        }
        for (const s of ['main','article','[role="main"]','#content','.content']) { const el=document.querySelector(s); if(el) return el; }
        return document.body.firstElementChild||null;
    }

    cleanupObserver() {
        if (this.observer) { this.observer.disconnect(); this.observer=null; }
        clearTimeout(this.updateTimeout);
    }

    /* ── Message listener ──────────────────────────────────────── */
    setupMessageListener() {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (msg.type==='GET_SCROLL_POSITION')   { sendResponse({scrollY:window.scrollY}); return true; }
            if (msg.type==='SCROLL_TO_POSITION')    { window.scrollTo({top:msg.scrollY,behavior:'smooth'}); this._highlightArea(msg.scrollY); sendResponse({success:true}); return true; }
            if (msg.type==='NAVIGATE_TO_BOOKMARK')  { if(validateBookmark(msg.bookmark)) this.navigateToBookmark(msg.bookmark); sendResponse({success:true}); return true; }
            if (msg.type==='BOOKMARKS_UPDATED')     { this.loadBookmarks(); sendResponse({success:true}); return true; }
            if (msg.type==='SAVE_POSITION')         { this.saveCurrentPosition(); sendResponse({success:true}); return true; }
            if (msg.type==='EXPORT_DATA')           { this.exportAllData(); sendResponse({success:true}); return true; }
            if (msg.type==='SETTINGS_UPDATED') {
                this.autoSaveEnabled   = msg.settings.autoSave           !== false;
                this.showPrompt        = msg.settings.showPrompt         !== false;
                this.screenshotEnabled = msg.settings.screenshotEnabled  !== false;
                this.showToggleButton  = msg.settings.showToggleButton   !== false;
                this.showQuickAdd     = msg.settings.showQuickAdd       !== false;
                this.idleTransparent  = msg.settings.idleTransparent    !== false;
                this.panelPosition     = msg.settings.panelPosition      || 'right';
                this.theme             = msg.settings.theme              || 'light';
                this.applySettings();
                sendResponse({success:true}); return true;
            }
        });
    }

    /* ── Toast ─────────────────────────────────────────────────── */
    showToast(message) {
        document.querySelector('.scrollmap-toast')?.remove();
        const t = document.createElement('div');
        t.className   = 'scrollmap-toast';
        t.setAttribute('role', 'status');
        t.setAttribute('aria-live', 'polite');
        t.textContent = String(message).substring(0, 200);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }
}

/* ── Bootstrap ─────────────────────────────────────────────────── */
try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => new ScrollMap());
    else new ScrollMap();
} catch (e) {
    console.error('ScrollMap bootstrap error:', e);
}