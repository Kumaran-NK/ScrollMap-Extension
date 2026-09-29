// background.js — ScrollMap v3.0 (production-ready)
// Service worker (MV3) — handles messages, screenshots, sessions, keep-alive

const SM_VERSION = '3.0.0';
const MAX_BOOKMARKS_PER_SESSION = 200;
const MAX_SESSIONS = 50;
const MAX_URL_LENGTH = 2000;
const MAX_TITLE_LENGTH = 500;
const MAX_SESSION_NAME = 200;
const QUOTA_WARN_MB = 7;
const QUOTA_HARD_MB = 9;

/* ─── URL safety ────────────────────────────────────────────────── */
function isSafeUrl(url) {
    if (!url || typeof url !== 'string' || url.length > MAX_URL_LENGTH) return false;
    try { const p = new URL(url); return p.protocol === 'https:' || p.protocol === 'http:'; }
    catch { return false; }
}

/* ─── Sanitize strings ──────────────────────────────────────────── */
function sanitizeStr(val, maxLen = 500) {
    if (val == null) return '';
    return String(val).substring(0, maxLen).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/* ─── Quota check ───────────────────────────────────────────────── */
async function getQuotaStatus() {
    try {
        const bytesUsed = await new Promise(resolve =>
            chrome.storage.local.getBytesInUse(null, b => resolve(chrome.runtime.lastError ? 0 : b)));
        const usedMB = bytesUsed / (1024 * 1024);
        return { usedMB, overWarn: usedMB >= QUOTA_WARN_MB, overHard: usedMB >= QUOTA_HARD_MB };
    } catch { return { usedMB: 0, overWarn: false, overHard: false }; }
}

/* ─── Error logger ──────────────────────────────────────────────── */
async function logError(context, message) {
    try {
        const r = await chrome.storage.local.get('sm_errors');
        const errs = Array.isArray(r.sm_errors) ? r.sm_errors : [];
        errs.push({ ts: Date.now(), context, message: sanitizeStr(message, 500) });
        if (errs.length > 100) errs.splice(0, errs.length - 100);
        await chrome.storage.local.set({ sm_errors: errs });
    } catch { /* non-fatal */ }
}

/* ═══════════════════════════════════════════════════════════════════
   Service Worker keep-alive
   MV3 SWs terminate after ~30 s of inactivity. Use chrome.alarms
   to ping every 25 s so long-running operations don't get dropped.
═══════════════════════════════════════════════════════════════════ */
chrome.alarms.create('scrollmap-keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'scrollmap-keepalive') {
        // No-op — just wakes the SW
    }
    if (alarm.name === 'scrollmap-gc') {
        runStorageGC();
    }
});

// Daily GC alarm
chrome.alarms.create('scrollmap-gc', { periodInMinutes: 1440 });

/* ─── Install / update lifecycle ───────────────────────────────── */
chrome.runtime.onInstalled.addListener(async details => {
    if (details.reason === 'install') {
        await chrome.storage.local.set({
            sm_schema_version: 1,
            settings: {
                autoSave: true, showPrompt: true, screenshotEnabled: true,
                showToggleButton: true, showQuickAdd: true, idleTransparent: true,
                panelPosition: 'right', theme: 'light',
            },
            sm_install_date: new Date().toISOString(),
            sm_version: SM_VERSION,
            // Usage tracking for review prompt
            sm_usage: {
                bookmarkCount: 0,
                sessionCount: 0,
                installDate: Date.now(),
            },
            // Review state: 'pending' | 'asked' | 'done' | 'never'
            sm_review_state: 'pending',
        });

        // Open the animated onboarding page immediately after install
        chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }

    if (details.reason === 'update') {
        await chrome.storage.local.set({
            sm_version: SM_VERSION,
            sm_last_update: new Date().toISOString()
        });
    }
});

/* ─── Storage GC ────────────────────────────────────────────────── */
async function runStorageGC() {
    try {
        const all = await chrome.storage.local.get(null);
        const staleThreshold = Date.now() - (365 * 24 * 60 * 60 * 1000); // 1 year
        const toRemove = [];
        for (const [key, value] of Object.entries(all)) {
            if (key.startsWith('metadata_')) {
                const meta = value;
                if (meta?.lastVisited && new Date(meta.lastVisited).getTime() < staleThreshold) {
                    const pageKey = key.replace('metadata_', '');
                    const bmKey = `bookmarks_${pageKey}`;
                    const noteKey = `notes_${pageKey}`;
                    const stickyKey = `sticky_notes_${pageKey}`;
                    const hashKey = `content_hash_${pageKey}`;
                    const bms = all[bmKey];
                    if (!Array.isArray(bms) || bms.length === 0) {
                        toRemove.push(key, bmKey, noteKey, stickyKey, hashKey);
                    }
                }
            }
        }
        if (toRemove.length) await chrome.storage.local.remove(toRemove);
    } catch (err) {
        logError('gc', err.message);
    }
}

/* ═══════════════════════════════════════════════════════════════════
   Message handler
═══════════════════════════════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const respond = (payload) => {
        try { sendResponse(payload); } catch { /* tab may have closed */ }
    };

    (async () => {
        try {
            switch (message.type) {

                /* ── Screenshot ─────────────────────────────────── */
                case 'CAPTURE_SCREENSHOT': {
                    if (!sender.tab?.id) { respond({ error: 'No tab' }); break; }
                    try {
                        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 65 });
                        respond({ dataUrl });
                    } catch (err) {
                        respond({ error: String(err.message) });
                    }
                    break;
                }

                /* ── Last position ──────────────────────────────── */
                case 'UPDATE_LAST_POSITION': {
                    if (!isSafeUrl(sender.tab?.url || '')) { respond({ success: false }); break; }
                    const scrollY = typeof message.scrollY === 'number' ? message.scrollY : 0;
                    const scrollPercent = typeof message.scrollPercent === 'number' ? message.scrollPercent : 0;
                    try {
                        await chrome.storage.local.set({
                            [`last_position_${sender.tab.url}`]: {
                                scrollY, scrollPercent,
                                url: sender.tab.url,
                                title: sanitizeStr(sender.tab.title, MAX_TITLE_LENGTH),
                                savedAt: Date.now()
                            }
                        });
                        respond({ success: true });
                    } catch (err) {
                        logError('UPDATE_LAST_POSITION', err.message);
                        respond({ success: false, error: err.message });
                    }
                    break;
                }

                case 'GET_LAST_POSITION': {
                    if (!sender.tab?.url) { respond({ position: null }); break; }
                    try {
                        const r = await chrome.storage.local.get(`last_position_${sender.tab.url}`);
                        respond({ position: r[`last_position_${sender.tab.url}`] || null });
                    } catch {
                        respond({ position: null });
                    }
                    break;
                }

                /* ── Sessions ───────────────────────────────────── */
                case 'SAVE_SESSION': {
                    const sessionName = sanitizeStr(message.sessionName, MAX_SESSION_NAME) || 'Session';
                    const rawBms      = Array.isArray(message.bookmarks) ? message.bookmarks : [];
                    const bookmarks   = rawBms
                        .filter(b => b && typeof b === 'object' && isSafeUrl(b.url || ''))
                        .map(b => ({
                            id:        b.id || `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                            url:       sanitizeStr(b.url, MAX_URL_LENGTH),
                            title:     sanitizeStr(b.title, MAX_TITLE_LENGTH),
                            scrollY:   typeof b.scrollY === 'number' ? b.scrollY : 0,
                            favicon:   b.favicon || null,
                            timestamp: typeof b.timestamp === 'string' && !isNaN(new Date(b.timestamp)) ? b.timestamp : new Date().toISOString(),
                        }))
                        .slice(0, MAX_BOOKMARKS_PER_SESSION);

                    try {
                        const { overHard } = await getQuotaStatus();
                        if (overHard) { respond({ success: false, error: 'Storage full' }); break; }
                        const r        = await chrome.storage.local.get(['savedSessions', 'sessions']);
                        let sessions   = Array.isArray(r.savedSessions) ? r.savedSessions : (Array.isArray(r.sessions) ? r.sessions : []);
                        const newSession = {
                            id: Date.now(),
                            name: sessionName,
                            bookmarks,
                            tabCount: bookmarks.length,
                            timestamp: new Date().toISOString(),
                            savedAt: new Date().toISOString()
                        };
                        sessions.push(newSession);
                        if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(-MAX_SESSIONS);
                        await chrome.storage.local.set({ savedSessions: sessions });
                        respond({ success: true, session: newSession });
                    } catch (err) {
                        logError('SAVE_SESSION', err.message);
                        respond({ success: false, error: err.message });
                    }
                    break;
                }

                case 'GET_SESSIONS': {
                    try {
                        const r = await chrome.storage.local.get(['savedSessions', 'sessions']);
                        let sessions = Array.isArray(r.savedSessions) ? r.savedSessions : (Array.isArray(r.sessions) ? r.sessions : []);
                        respond({ sessions });
                    } catch {
                        respond({ sessions: [] });
                    }
                    break;
                }

                case 'DELETE_SESSION': {
                    const sessionId = message.id ?? message.index;
                    try {
                        const r        = await chrome.storage.local.get(['savedSessions', 'sessions']);
                        let sessions   = Array.isArray(r.savedSessions) ? r.savedSessions : (Array.isArray(r.sessions) ? r.sessions : []);
                        if (typeof sessionId === 'number') {
                            sessions = sessions.filter((s, idx) => s.id !== sessionId && idx !== sessionId);
                        } else if (typeof message.index === 'number' && message.index >= 0 && message.index < sessions.length) {
                            sessions.splice(message.index, 1);
                        }
                        await chrome.storage.local.set({ savedSessions: sessions });
                        respond({ success: true });
                    } catch (err) {
                        logError('DELETE_SESSION', err.message);
                        respond({ success: false });
                    }
                    break;
                }

                case 'RENAME_SESSION': {
                    const { id, index, name } = message;
                    const cleanName = sanitizeStr(name, MAX_SESSION_NAME);
                    if (!cleanName) { respond({ success: false }); break; }
                    try {
                        const r        = await chrome.storage.local.get(['savedSessions', 'sessions']);
                        let sessions   = Array.isArray(r.savedSessions) ? r.savedSessions : (Array.isArray(r.sessions) ? r.sessions : []);
                        const session  = sessions.find((s, idx) => (id !== undefined && s.id === id) || idx === index);
                        if (session) {
                            session.name = cleanName;
                            await chrome.storage.local.set({ savedSessions: sessions });
                        }
                        respond({ success: true });
                    } catch (err) {
                        logError('RENAME_SESSION', err.message);
                        respond({ success: false });
                    }
                    break;
                }

                /* ── Tab helpers ────────────────────────────────── */
                case 'OPEN_URL': {
                    const url = message.url;
                    if (!isSafeUrl(url)) { respond({ success: false, error: 'Unsafe URL' }); break; }
                    try {
                        await chrome.tabs.create({ url });
                        respond({ success: true });
                    } catch (err) {
                        respond({ success: false, error: err.message });
                    }
                    break;
                }

                case 'GET_ALL_TABS': {
                    try {
                        const tabs = await chrome.tabs.query({ currentWindow: true });
                        respond({ tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title })) });
                    } catch {
                        respond({ tabs: [] });
                    }
                    break;
                }

                /* ── Quota ──────────────────────────────────────── */
                case 'GET_QUOTA': {
                    respond(await getQuotaStatus());
                    break;
                }

                /* ── Storage export ─────────────────────────────── */
                case 'GET_ALL_DATA': {
                    try {
                        const all = await chrome.storage.local.get(null);
                        respond({ data: all });
                    } catch {
                        respond({ data: {} });
                    }
                    break;
                }

                case 'IMPORT_DATA': {
                    const imported = message.data;
                    if (!imported || typeof imported !== 'object') { respond({ success: false }); break; }
                    try {
                        const existing = await chrome.storage.local.get(null);
                        const merged = { ...existing, ...imported };
                        await chrome.storage.local.set(merged);
                        respond({ success: true });
                    } catch (err) {
                        logError('IMPORT_DATA', err.message);
                        respond({ success: false });
                    }
                    break;
                }

                /* ── Error log ──────────────────────────────────── */
                case 'GET_ERRORS': {
                    try {
                        const r = await chrome.storage.local.get('sm_errors');
                        respond({ errors: r.sm_errors || [] });
                    } catch {
                        respond({ errors: [] });
                    }
                    break;
                }

                case 'CLEAR_ERRORS': {
                    try {
                        await chrome.storage.local.remove('sm_errors');
                        respond({ success: true });
                    } catch {
                        respond({ success: false });
                    }
                    break;
                }

                /* ── Usage tracking + review prompt trigger ─────── */
                case 'TRACK_USAGE': {
                    try {
                        const r = await chrome.storage.local.get(['sm_usage', 'sm_review_state']);
                        const usage = r.sm_usage || {
                            bookmarkCount: 0,
                            sessionCount: 0,
                            installDate: Date.now(),
                        };
                        const reviewState = r.sm_review_state || 'pending';

                        // Increment the relevant counter
                        if (message.action === 'bookmark_added') usage.bookmarkCount++;
                        if (message.action === 'session_saved') usage.sessionCount++;

                        await chrome.storage.local.set({ sm_usage: usage });

                        // Show review prompt when:
                        //   - state is still 'pending' (never asked before)
                        //   - user has added 5+ bookmarks (proven value)
                        //   - at least 3 days have passed since install (not spammy)
                        const daysSinceInstall = (Date.now() - (usage.installDate || Date.now())) / 86400000;
                        const shouldShowReview = reviewState === 'pending'
                            && usage.bookmarkCount >= 5
                            && daysSinceInstall >= 3;

                        // Mark as 'asked' so we don't trigger again until they respond
                        if (shouldShowReview) {
                            await chrome.storage.local.set({ sm_review_state: 'asked' });
                        }

                        respond({ success: true, shouldShowReview });
                    } catch (err) {
                        logError('TRACK_USAGE', err.message);
                        respond({ success: false, shouldShowReview: false });
                    }
                    break;
                }

                /* ── Review state ───────────────────────────────── */
                case 'SET_REVIEW_STATE': {
                    // Valid states: 'pending' | 'asked' | 'done' | 'never'
                    const validStates = ['pending', 'asked', 'done', 'never'];
                    const state = validStates.includes(message.state) ? message.state : 'asked';
                    try {
                        await chrome.storage.local.set({ sm_review_state: state });
                        respond({ success: true });
                    } catch (err) {
                        logError('SET_REVIEW_STATE', err.message);
                        respond({ success: false });
                    }
                    break;
                }

                default:
                    respond({ error: `Unknown message type: ${message.type}` });
            }
        } catch (err) {
            logError('messageHandler', err.message);
            respond({ success: false, error: String(err.message) });
        }
    })();

    return true; // keep channel open for async sendResponse
});