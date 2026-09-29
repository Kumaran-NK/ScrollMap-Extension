// popup.js — ScrollMap v3.0 (production-ready)

/* ─── State ─────────────────────────────────────────────────────── */
let currentTab = 'bookmarks';
let bookmarks  = [];
let queue      = [];
let sessions   = [];
let currentBookmarkForComment = null;
let _activeTab  = null; // cached current tab

/* ═══════════════════════════════════════════════════════════════════
   BOOT
═══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    setupTabs();
    setupEventListeners();
    renderCurrentTab();
    checkQuotaWarning();

    // Keep popup in sync when storage changes from content script
    chrome.storage.onChanged.addListener((changes) => {
        const prefixes = ['bookmarks_', 'readLaterQueue', 'savedSessions', 'settings'];
        if (Object.keys(changes).some(k => prefixes.some(p => k.startsWith(p)))) loadData();
    });
});

/* ─── Theme ─────────────────────────────────────────────────────── */
async function applyTheme() {
    try {
        const r     = await chrome.storage.local.get('settings');
        const theme = r.settings?.theme || 'light';
        const dark  = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.body.classList.toggle('dark', dark);
    } catch { /* default light */ }
}

/* ─── Quota warning ─────────────────────────────────────────────── */
async function checkQuotaWarning() {
    try {
        const { usedMB, overWarn, overHard } = await new Promise(resolve =>
            chrome.runtime.sendMessage({ type: 'GET_QUOTA' }, r => resolve(r || {})));
        const banner = document.getElementById('quotaBanner');
        if (!banner) return;
        if (overHard) {
            banner.textContent = `❌ Storage almost full (${usedMB.toFixed(1)} MB / 10 MB). Delete data or export a backup.`;
            banner.className = 'quota-banner quota-hard';
            banner.style.display = 'block';
        } else if (overWarn) {
            banner.textContent = `⚠️ Storage at ${usedMB.toFixed(1)} MB. Consider exporting a backup.`;
            banner.className = 'quota-banner quota-warn';
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    } catch { /* non-fatal */ }
}

/* ─── Load data ─────────────────────────────────────────────────── */
async function loadData() {
    try {
        await applyTheme();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;
        _activeTab = tab;

        const bmResult = await chrome.storage.local.get(`bookmarks_${tab.url}`);
        bookmarks = (bmResult[`bookmarks_${tab.url}`] || []).filter(b =>
            b && typeof b.id === 'number' && b.timestamp && !isNaN(new Date(b.timestamp).getTime()));

        const qResult = await chrome.storage.local.get('readLaterQueue');
        queue = (qResult.readLaterQueue || []).filter(item => item && isSafeUrl(item.url));

        const sResult = await chrome.storage.local.get('savedSessions');
        sessions = sResult.savedSessions || [];

        const badge = document.getElementById('queueCount');
        if (badge) { badge.textContent = queue.length; badge.className = 'tab-badge' + (queue.length === 0 ? ' zero' : ''); }

        renderCurrentTab();
    } catch (e) {
        console.error('ScrollMap popup loadData error:', e);
    }
}

/* ─── Helpers ───────────────────────────────────────────────────── */
function isSafeUrl(url) {
    if (!url || typeof url !== 'string' || url.length > 2000) return false;
    try { const p = new URL(url); return p.protocol === 'https:' || p.protocol === 'http:'; }
    catch { return false; }
}

function escHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function escAttr(str) {
    return String(str == null ? '' : str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function showNotification(msg) {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className   = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.textContent = String(msg).substring(0, 200);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
}

function getCurrentScrollPosition(tabId) {
    return new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_SCROLL_POSITION' }, r => {
            if (chrome.runtime.lastError || !r) resolve({ scrollY: 0 });
            else resolve(r);
        });
    });
}

/* ─── Tabs ──────────────────────────────────────────────────────── */
function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            currentTab = tab.dataset.tab;
            renderCurrentTab();
        });
    });
}

/* ─── Event listeners ───────────────────────────────────────────── */
function setupEventListeners() {
    document.getElementById('refreshBtn')?.addEventListener('click', async () => {
        await loadData();
        checkQuotaWarning();
        showNotification('🔄 Refreshed');
    });
    document.getElementById('addToQueueBtn')?.addEventListener('click', addToQueue);
    document.getElementById('settingsBtn')?.addEventListener('click',  () => chrome.runtime.openOptionsPage());
    document.getElementById('settingsLink')?.addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    document.getElementById('searchInput')?.addEventListener('input',  e => filterBookmarks(e.target.value.toLowerCase()));
    document.getElementById('closeCommentModal')?.addEventListener('click', () => {
        const m = document.getElementById('commentModal');
        if (m) m.style.display = 'none';
    });
    document.getElementById('saveComment')?.addEventListener('click', saveCommentHandler);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

    // Export / import
    document.getElementById('exportBtn')?.addEventListener('click', exportData);
    document.getElementById('importInput')?.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (file) importData(file);
        e.target.value = '';
    });
    document.getElementById('importBtn')?.addEventListener('click', () =>
        document.getElementById('importInput')?.click());
}

/* ─── Tab rendering ─────────────────────────────────────────────── */
function renderCurrentTab() {
    ['bookmarksContainer','readLaterContainer','sessionsContainer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const sc = document.getElementById('searchContainer');
    if (sc) sc.style.display = currentTab === 'bookmarks' ? 'block' : 'none';

    if      (currentTab === 'bookmarks')  { document.getElementById('bookmarksContainer').style.display  = 'block'; renderBookmarksList(); }
    else if (currentTab === 'readlater')  { document.getElementById('readLaterContainer').style.display  = 'block'; renderReadLaterList(); }
    else if (currentTab === 'sessions')   { document.getElementById('sessionsContainer').style.display   = 'block'; renderSessionsList();  }
}

/* ═══════════════════════════════════════════════════════════════════
   BOOKMARKS
═══════════════════════════════════════════════════════════════════ */
function renderBookmarksList(bookmarksToShow = null) {
    const container = document.getElementById('bookmarksContainer');
    const list      = bookmarksToShow || bookmarks;

    if (!list || !list.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔖</div>
                <div class="empty-title">${bookmarks.length === 0 ? 'No bookmarks yet' : 'No matching bookmarks'}</div>
                <div class="empty-desc">${bookmarks.length === 0 ? 'Press Ctrl+Shift+B or click the + button to add one' : 'Try a different search term'}</div>
            </div>`;
        return;
    }

    const sorted = [...list].sort((a, b) => {
        if (a.type === 'message' && b.type === 'message') return (a.messageIndex||0) - (b.messageIndex||0);
        return (a.scrollY||0) - (b.scrollY||0);
    });

    const icons = { message: '💬', highlight: '✨' };

    container.innerHTML = sorted.map((bm, idx) => {
        const date    = new Date(bm.timestamp);
        const ts      = `${date.toLocaleDateString([],{month:'short',day:'numeric'})} ${date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
        const icon    = icons[bm.type] || '📍';
        const title   = bm.customTitle || (bm.type === 'message' ? `Message ${(bm.messageIndex||0)+1}` : `Bookmark ${idx+1}`);
        const preview = escHtml(bm.preview || 'No preview');
        const commentBadge = bm.comments?.length ? `<span class="comment-pill" aria-label="${bm.comments.length} comments">💬 ${bm.comments.length}</span>` : '';

        return `
            <div class="bookmark-item" data-id="${bm.id}" tabindex="0" role="button" aria-label="Bookmark: ${escHtml(title)}">
                <div class="bookmark-actions" role="group" aria-label="Bookmark actions">
                    <button class="action-btn comment-btn" data-id="${bm.id}" aria-label="Comments">💬</button>
                    <button class="action-btn edit-btn"    data-id="${bm.id}" aria-label="Edit title">✎</button>
                    <button class="action-btn delete-btn"  data-id="${bm.id}" aria-label="Delete">✕</button>
                </div>
                <div class="bookmark-header">
                    <span class="bookmark-num" aria-hidden="true">${idx+1}</span>
                    <span class="bookmark-title">${icon} ${escHtml(title)}</span>
                </div>
                <div class="bookmark-preview">${preview}</div>
                <div class="bookmark-footer">
                    <span class="bookmark-time">${escHtml(ts)}</span>
                    ${commentBadge}
                </div>
            </div>`;
    }).join('');

    attachBookmarkEventListeners();
}

function attachBookmarkEventListeners() {
    document.querySelectorAll('.comment-btn').forEach(btn =>
        btn.addEventListener('click', e => { e.stopPropagation(); showCommentModal(parseInt(btn.dataset.id)); }));
    document.querySelectorAll('.edit-btn').forEach(btn =>
        btn.addEventListener('click', e => { e.stopPropagation(); editBookmarkTitle(parseInt(btn.dataset.id), btn); }));
    document.querySelectorAll('.delete-btn').forEach(btn =>
        btn.addEventListener('click', e => { e.stopPropagation(); deleteBookmarkWithUndo(parseInt(btn.dataset.id)); }));

    document.querySelectorAll('.bookmark-item').forEach(item => {
        const navigate = async e => {
            if (e.target.classList.contains('action-btn')) return;
            const bm = bookmarks.find(b => b.id === parseInt(item.dataset.id));
            if (!bm || !_activeTab) return;
            chrome.tabs.sendMessage(_activeTab.id, { type: 'NAVIGATE_TO_BOOKMARK', bookmark: bm }, () => { void chrome.runtime.lastError; });
            window.close();
        };
        item.addEventListener('click', navigate);
        item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(e); } });
    });
}

function filterBookmarks(term) {
    if (!term) { renderBookmarksList(bookmarks); return; }
    renderBookmarksList(bookmarks.filter(b =>
        (b.customTitle||'').toLowerCase().includes(term) ||
        (b.preview||'').toLowerCase().includes(term) ||
        (b.messageContent||'').toLowerCase().includes(term)));
}

/* ─── Bookmark CRUD ─────────────────────────────────────────────── */
function deleteBookmarkWithUndo(id) {
    const bm = bookmarks.find(b => b.id === id);
    if (!bm) return;
    const snapshot = JSON.parse(JSON.stringify(bm));

    bookmarks = bookmarks.filter(b => b.id !== id);
    _persistBookmarks();
    renderBookmarksList();
    _notifyContentScript({ type: 'BOOKMARKS_UPDATED' });

    // Undo toast
    document.querySelector('.popup-undo-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'popup-undo-toast';
    t.innerHTML = `<span>🗑️ Bookmark deleted</span><button class="popup-undo-btn">Undo</button>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('popup-undo-visible'));
    const timer = setTimeout(() => dismiss(), 5000);
    const dismiss = () => { clearTimeout(timer); t.classList.remove('popup-undo-visible'); setTimeout(() => t.remove(), 300); };
    t.querySelector('.popup-undo-btn').addEventListener('click', () => {
        bookmarks.push(snapshot);
        _persistBookmarks();
        renderBookmarksList();
        _notifyContentScript({ type: 'BOOKMARKS_UPDATED' });
        showNotification('↩️ Bookmark restored');
        dismiss();
    });
}

function editBookmarkTitle(id, btn) {
    const bm   = bookmarks.find(b => b.id === id);
    if (!bm) return;
    const span = btn.closest('.bookmark-item')?.querySelector('.bookmark-title');
    if (!span || span.querySelector('input')) return;

    const icon  = bm.type === 'message' ? '💬' : '📍';
    const input = document.createElement('input');
    input.type     = 'text';
    input.value    = bm.customTitle || '';
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Edit bookmark title');
    input.style.cssText = 'width:100%;padding:3px 7px;border:1.5px solid var(--green-400,#4ade80);border-radius:6px;font-size:13px;font-family:inherit;outline:none;';
    span.innerHTML = '';
    span.appendChild(input);
    input.focus();

    let saved = false;
    const save = () => {
        if (saved) return; saved = true;
        bm.customTitle = (input.value.trim() || `Bookmark ${id}`).substring(0, 200);
        _persistBookmarks();
        span.textContent = `${icon} ${bm.customTitle}`;
        showNotification('📝 Title updated');
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); save(); }
        if (e.key === 'Escape') { saved = true; span.textContent = `${icon} ${bm.customTitle||''}`; }
    });
    input.addEventListener('blur', save);
}

function showCommentModal(bookmarkId) {
    const bm = bookmarks.find(b => b.id === bookmarkId);
    if (!bm) return;
    currentBookmarkForComment = bm;

    const comments = bm.comments || [];
    const commentList = document.getElementById('commentList');
    const commentModal = document.getElementById('commentModal');
    if (!commentList || !commentModal) return;

    commentList.innerHTML = comments.length
        ? comments.map(c => `
            <div class="comment-item">
                <div class="comment-text">${escHtml(c.text)}</div>
                <div class="comment-time">${escHtml(new Date(c.timestamp).toLocaleString())}</div>
            </div>`).join('')
        : '<div class="comment-empty">No comments yet</div>';

    const inp = document.getElementById('commentInput');
    if (inp) inp.value = '';
    commentModal.style.display = 'flex';
    inp?.focus();
}

async function saveCommentHandler() {
    if (!currentBookmarkForComment) return;
    const text = (document.getElementById('commentInput')?.value?.trim() || '').substring(0, 2000);
    if (!text) return;
    if (!currentBookmarkForComment.comments) currentBookmarkForComment.comments = [];
    currentBookmarkForComment.comments.push({ id: Date.now(), text, timestamp: new Date().toISOString() });
    await _persistBookmarks();
    document.getElementById('commentModal').style.display = 'none';
    renderBookmarksList();
    showNotification('💬 Comment added');
}

async function _persistBookmarks() {
    if (!_activeTab?.url) return;
    await chrome.storage.local.set({ [`bookmarks_${_activeTab.url}`]: bookmarks });
}

function _notifyContentScript(msg) {
    if (!_activeTab?.id) return;
    chrome.tabs.sendMessage(_activeTab.id, msg, () => { void chrome.runtime.lastError; });
}

/* ═══════════════════════════════════════════════════════════════════
   READ LATER
═══════════════════════════════════════════════════════════════════ */
async function addToQueue() {
    try {
        if (!_activeTab?.url || !isSafeUrl(_activeTab.url)) { showNotification('❌ Cannot save this page'); return; }
        if (queue.some(i => i.url === _activeTab.url)) { showNotification('⚠️ Already in Read Later'); return; }

        const scrollResult = await getCurrentScrollPosition(_activeTab.id);
        const item = {
            id:      Date.now(),
            url:     _activeTab.url.substring(0, 2000),
            title:   (_activeTab.title || 'Untitled').substring(0, 500),
            addedAt: new Date().toISOString(),
            favicon: _activeTab.favIconUrl || null,
            scrollY: scrollResult?.scrollY || 0
        };
        queue.unshift(item);
        await chrome.storage.local.set({ readLaterQueue: queue });

        const badge = document.getElementById('queueCount');
        if (badge) { badge.textContent = queue.length; badge.className = 'tab-badge'; }
        if (currentTab === 'readlater') renderReadLaterList();
        showNotification('✅ Added to Read Later');
    } catch { showNotification('❌ Failed to add'); }
}

function renderReadLaterList() {
    const container = document.getElementById('readLaterContainer');
    if (!queue.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📖</div>
                <div class="empty-title">Your reading list is empty</div>
                <div class="empty-desc">Click <strong>Save for Later</strong> to add the current page</div>
            </div>`;
        return;
    }

    container.innerHTML = queue.map((item, idx) => {
        const ts = new Date(item.addedAt).toLocaleDateString([], { month:'short', day:'numeric' });
        let host = 'unknown';
        try { host = new URL(item.url).hostname.replace('www.',''); } catch {}
        const favicon = item.favicon && isSafeUrl(item.favicon) ? `<img class="queue-favicon" src="${escAttr(item.favicon)}" alt="" width="14" height="14" onerror="this.style.display='none'">` : '';
        return `
            <div class="queue-item" data-url="${escAttr(item.url)}" data-scroll="${Number(item.scrollY)||0}"
                tabindex="0" role="button" aria-label="${escHtml(item.title||'Untitled')}">
                <div class="queue-main">
                    <span class="queue-num" aria-hidden="true">${idx+1}</span>
                    <div class="queue-content">
                        <div class="queue-title">${favicon} ${escHtml(item.title||'Untitled')}</div>
                        <div class="queue-meta">
                            <span>${escHtml(ts)}</span>
                            <span class="queue-dot" aria-hidden="true"></span>
                            <span>${escHtml(host)}</span>
                        </div>
                    </div>
                </div>
                <div class="queue-btn-row">
                    <button class="q-open-btn"   data-url="${escAttr(item.url)}" data-scroll="${Number(item.scrollY)||0}" aria-label="Open and read">↗ Open &amp; Read</button>
                    <button class="q-remove-btn" data-url="${escAttr(item.url)}" aria-label="Remove from list">✕ Remove</button>
                </div>
            </div>`;
    }).join('');

    attachQueueEventListeners();
}

function attachQueueEventListeners() {
    document.querySelectorAll('.q-open-btn').forEach(btn =>
        btn.addEventListener('click', e => { e.stopPropagation(); openQueueItem(btn.dataset.url, parseInt(btn.dataset.scroll)||0); }));
    document.querySelectorAll('.q-remove-btn').forEach(btn =>
        btn.addEventListener('click', e => { e.stopPropagation(); removeFromQueue(btn.dataset.url); }));
    document.querySelectorAll('.queue-item').forEach(item => {
        const open = e => { if (e.target.closest('.q-open-btn,.q-remove-btn')) return; openQueueItem(item.dataset.url, parseInt(item.dataset.scroll)||0); };
        item.addEventListener('click', open);
        item.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); open(e); } });
    });
}

function openQueueItem(url, scrollY) {
    if (!isSafeUrl(url)) { showNotification('❌ Invalid URL'); return; }
    chrome.tabs.create({ url, active: true }, tab => {
        if (chrome.runtime.lastError || !tab) return;
        if (scrollY > 0) {
            const listener = (tabId, info) => {
                if (tabId === tab.id && info.status === 'complete') {
                    setTimeout(() => {
                        chrome.tabs.sendMessage(tabId, { type: 'SCROLL_TO_POSITION', scrollY }, () => { void chrome.runtime.lastError; });
                    }, 600);
                    chrome.tabs.onUpdated.removeListener(listener);
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        }
    });
    removeFromQueue(url, false);
    window.close();
}

async function removeFromQueue(url, notify = true) {
    queue = queue.filter(i => i.url !== url);
    await chrome.storage.local.set({ readLaterQueue: queue });
    const badge = document.getElementById('queueCount');
    if (badge) { badge.textContent = queue.length; badge.className = 'tab-badge' + (queue.length === 0 ? ' zero' : ''); }
    if (currentTab === 'readlater') renderReadLaterList();
    if (notify) showNotification('🗑️ Removed from list');
}

/* ═══════════════════════════════════════════════════════════════════
   SESSIONS
═══════════════════════════════════════════════════════════════════ */
function renderSessionsList() {
    const container = document.getElementById('sessionsContainer');
    const newBtn = `<button class="new-session-btn" id="bookmarkAllTabsBtn" aria-label="Save current session">📑 Save Current Session</button>`;

    if (!sessions.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📑</div>
                <div class="empty-title">No saved sessions</div>
                <div class="empty-desc">Save all your open tabs as a named session to restore later</div>
            </div>${newBtn}`;
        document.getElementById('bookmarkAllTabsBtn')?.addEventListener('click', bookmarkAllTabs);
        return;
    }

    container.innerHTML = [...sessions].reverse().map(session => {
        const date = new Date(session.timestamp);
        const ts   = `${date.toLocaleDateString([],{month:'short',day:'numeric'})} at ${date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
        return `
            <div class="session-card" data-session-id="${session.id}">
                <div class="session-header">
                    <div class="session-icon" aria-hidden="true">📑</div>
                    <div class="session-info">
                        <div class="session-name-wrap">
                            <div class="session-name" data-id="${session.id}">${escHtml(session.name)}</div>
                            <button class="session-rename-btn" data-id="${session.id}" aria-label="Rename session">✎</button>
                        </div>
                        <div class="session-time">🕐 ${escHtml(ts)}</div>
                    </div>
                    <span class="session-badge" aria-label="${session.tabCount} tabs">${session.tabCount} tabs</span>
                </div>
                <div class="session-divider"></div>
                <div class="session-btns">
                    <button class="btn-restore" data-id="${session.id}" aria-label="Restore session tabs">↺ Restore Tabs</button>
                    <button class="btn-del-session" data-id="${session.id}" aria-label="Delete session">✕ Delete</button>
                </div>
            </div>`;
    }).join('') + newBtn;

    document.querySelectorAll('.btn-restore').forEach(btn =>
        btn.addEventListener('click', () => restoreSession(parseInt(btn.dataset.id))));
    document.querySelectorAll('.btn-del-session').forEach(btn =>
        btn.addEventListener('click', () => deleteSession(parseInt(btn.dataset.id))));
    document.querySelectorAll('.session-rename-btn').forEach(btn =>
        btn.addEventListener('click', e => { e.stopPropagation(); renameSession(parseInt(btn.dataset.id), btn); }));
    document.getElementById('bookmarkAllTabsBtn')?.addEventListener('click', bookmarkAllTabs);
}

function renameSession(sessionId, btn) {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    const nameEl = btn.closest('.session-name-wrap')?.querySelector('.session-name');
    if (!nameEl || nameEl.querySelector('input')) return;

    const current = session.name;
    const input   = document.createElement('input');
    input.type    = 'text';
    input.value   = current;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Session name');
    input.style.cssText = 'width:100%;padding:3px 7px;border:1.5px solid var(--green-400,#4ade80);border-radius:6px;font-size:13px;font-family:inherit;font-weight:600;outline:none;';
    nameEl.innerHTML = '';
    nameEl.appendChild(input);
    input.focus(); input.select();
    btn.style.display = 'none';

    let saved = false;
    const save = async () => {
        if (saved) return; saved = true;
        const newName = input.value.trim().substring(0, 200);
        if (newName && newName !== current) {
            session.name = newName;
            await chrome.storage.local.set({ savedSessions: sessions });
            showNotification('✏️ Session renamed');
        }
        renderSessionsList();
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { saved = true; renderSessionsList(); }
    });
    input.addEventListener('blur', save);
}

async function bookmarkAllTabs() {
    try {
        const tabs     = await chrome.tabs.query({ currentWindow: true });
        const timestamp = new Date().toISOString();
        const tabBms    = tabs
            .filter(t => t.url && isSafeUrl(t.url))
            .map((t, i) => ({
                id:        `${Date.now()}-${i}`,
                url:       t.url.substring(0, 2000),
                title:     (t.title || 'Untitled').substring(0, 500),
                favicon:   t.favIconUrl || null,
                timestamp
            }));
        if (!tabBms.length) { showNotification('❌ No saveable tabs'); return; }

        const session = {
            id:        Date.now(),
            name:      `Session — ${new Date().toLocaleString()}`.substring(0, 200),
            bookmarks: tabBms,
            tabCount:  tabBms.length,
            timestamp
        };
        sessions.push(session);
        if (sessions.length > 50) sessions = sessions.slice(-50);
        await chrome.storage.local.set({ savedSessions: sessions });
        showNotification(`✅ Saved ${tabBms.length} tabs`);
        if (currentTab === 'sessions') renderSessionsList();
    } catch { showNotification('❌ Failed to save session'); }
}

async function restoreSession(sessionId) {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    const safe = session.bookmarks.filter(b => isSafeUrl(b.url));
    safe.forEach((b, i) => chrome.tabs.create({ url: b.url, active: i === 0 }));
    showNotification(`📑 Restored ${safe.length} tabs`);
    window.close();
}

async function deleteSession(sessionId) {
    sessions = sessions.filter(s => s.id !== sessionId);
    await chrome.storage.local.set({ savedSessions: sessions });
    if (currentTab === 'sessions') renderSessionsList();
    showNotification('🗑️ Session deleted');
}

/* ═══════════════════════════════════════════════════════════════════
   EXPORT / IMPORT
═══════════════════════════════════════════════════════════════════ */
async function exportData() {
    try {
        const all  = await chrome.storage.local.get(null);
        const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), version: '3.0.0', data: all }, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `scrollmap-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showNotification('📦 Data exported!');
    } catch { showNotification('❌ Export failed'); }
}

async function importData(file) {
    try {
        const text = await file.text();
        const obj  = JSON.parse(text);
        if (!obj.data || typeof obj.data !== 'object') { showNotification('❌ Invalid backup file'); return; }
        const response = await new Promise(resolve =>
            chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data: obj.data }, r => resolve(r)));
        if (response?.success) {
            showNotification('✅ Imported! Reload to see changes.');
            await loadData();
        } else {
            showNotification('❌ Import failed');
        }
    } catch { showNotification('❌ Invalid file'); }
}