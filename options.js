// options.js — ScrollMap Settings

document.addEventListener('DOMContentLoaded', async () => {

    // ── Load saved settings ─────────────────────────────────────────
    try {
        const result = await chrome.storage.local.get('settings');
        const settings = result.settings || {};

        document.getElementById('autoSave').checked          = settings.autoSave           !== false;
        document.getElementById('showPrompt').checked        = settings.showPrompt         !== false;
        document.getElementById('screenshotEnabled').checked = settings.screenshotEnabled  !== false;
        document.getElementById('panelPosition').value       = settings.panelPosition      || 'right';
        document.getElementById('theme').value               = settings.theme              || 'light';
    } catch (e) {
        console.error('ScrollMap: failed to load settings', e);
    }

    // Toggle screenshot note visibility
    const screenshotToggle = document.getElementById('screenshotEnabled');
    const screenshotNote   = document.getElementById('screenshotNote');
    const updateNote = () => {
        screenshotNote.style.display = screenshotToggle.checked ? 'flex' : 'none';
    };
    updateNote();
    screenshotToggle.addEventListener('change', updateNote);

    // ── Save button ─────────────────────────────────────────────────
    const saveBtn = document.getElementById('saveSettings');

    saveBtn.addEventListener('click', async () => {
        const settings = {
            autoSave:           document.getElementById('autoSave').checked,
            showPrompt:         document.getElementById('showPrompt').checked,
            screenshotEnabled:  document.getElementById('screenshotEnabled').checked,
            panelPosition:      document.getElementById('panelPosition').value,
            theme:              document.getElementById('theme').value,
            lastUpdated:        new Date().toISOString()
        };

        try {
            await chrome.storage.local.set({ settings });

            const originalText = saveBtn.textContent;
            saveBtn.textContent = '✅ Saved!';
            saveBtn.classList.add('saved');
            saveBtn.disabled = true;

            setTimeout(() => {
                saveBtn.textContent = originalText;
                saveBtn.classList.remove('saved');
                saveBtn.disabled = false;
            }, 2000);

            // Notify all open tabs
            const tabs = await chrome.tabs.query({});
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    type: 'SETTINGS_UPDATED',
                    settings
                }).catch(() => {});
            });

        } catch (e) {
            console.error('ScrollMap: failed to save settings', e);
            saveBtn.textContent = '❌ Error — try again';
            setTimeout(() => {
                saveBtn.textContent = 'Save Settings';
                saveBtn.disabled = false;
            }, 2500);
        }
    });

});