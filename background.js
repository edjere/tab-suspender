'use strict';

// ─── Constants ───────────────────────────────────────────────────────

const CHECK_ALARM = 'check-inactive';
const PERSIST_ALARM = 'persist-timestamps';
const DEFAULT_TIMEOUT_MINUTES = 15;
const INTERNAL_URL_PREFIXES = [
  'chrome://', 'chrome-extension://', 'edge://', 'vivaldi://',
  'brave://', 'opera://', 'about:', 'devtools://'
];
const SUSPENDED_PAGE = chrome.runtime.getURL('suspended.html');

// ─── State ───────────────────────────────────────────────────────────

let lastActiveTimestamps = {};

// ─── Initialization ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  await initDefaults();
  setupAlarms();
  setupContextMenus();
  await initTimestampsForExistingTabs();
  await updateBadge();

  // On update: migrate any tabs still using old suspension method
  if (details.reason === 'update') {
    await migrateExistingTabs();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await restoreTimestamps();
  setupAlarms();
  await updateBadge();
});

async function initDefaults() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({
      settings: {
        timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
        suspendPinned: false,
        whitelist: [],
        useTitlePrefix: true,
        useTabGroups: false,
        tabGroupName: 'Suspended'
      }
    });
  } else {
    // Ensure new settings fields exist for upgrades
    let updated = false;
    if (settings.useTitlePrefix === undefined) { settings.useTitlePrefix = true; updated = true; }
    if (settings.useTabGroups === undefined) { settings.useTabGroups = false; updated = true; }
    if (settings.tabGroupName === undefined) { settings.tabGroupName = 'Suspended'; updated = true; }
    if (updated) await chrome.storage.local.set({ settings });
  }
}

function setupAlarms() {
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(PERSIST_ALARM, { periodInMinutes: 5 });
}

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'suspend-tab',
      title: 'Suspend this tab',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'whitelist-domain',
      title: 'Whitelist this domain',
      contexts: ['page']
    });
  });
}

async function initTimestampsForExistingTabs() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  for (const tab of tabs) {
    if (!lastActiveTimestamps[tab.id]) {
      lastActiveTimestamps[tab.id] = now;
    }
  }
  await persistTimestamps();
}

async function migrateExistingTabs() {
  // Find any tabs on old suspended.html URLs with a different extension ID
  // and refresh them to use the current extension's URL
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.url.includes('suspended.html?url=') &&
        tab.url.startsWith('chrome-extension://') &&
        !tab.url.startsWith(SUSPENDED_PAGE)) {
      const params = new URL(tab.url).searchParams;
      const url = params.get('url');
      if (url) {
        const newUrl = buildSuspendedUrl(url, params.get('title') || '', params.get('favicon') || '');
        try { await chrome.tabs.update(tab.id, { url: newUrl }); } catch { /* tab may have closed */ }
      }
    }
  }
}

// ─── Timestamp Management ────────────────────────────────────────────

async function restoreTimestamps() {
  const data = await chrome.storage.local.get('lastActiveTimestamps');
  lastActiveTimestamps = data.lastActiveTimestamps || {};
}

async function persistTimestamps() {
  await chrome.storage.local.set({ lastActiveTimestamps });
}

// ─── Settings & Matching ─────────────────────────────────────────────

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || {
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    suspendPinned: false,
    whitelist: [],
    useTitlePrefix: true,
    useTabGroups: false,
    tabGroupName: 'Suspended'
  };
}

function isInternalUrl(url) {
  if (!url) return true;
  return INTERNAL_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

function isSuspendedUrl(url) {
  return url && url.startsWith(SUSPENDED_PAGE);
}

function matchesWhitelist(url, whitelist) {
  if (!url || !whitelist || whitelist.length === 0) return false;
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return false; }

  for (const pattern of whitelist) {
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      if (hostname === domain || hostname.endsWith('.' + domain)) return true;
    } else {
      if (hostname === pattern) return true;
    }
  }
  return false;
}

function isTabProtected(tab, settings) {
  return (
    tab.active ||
    tab.audible ||
    isSuspendedUrl(tab.url) ||
    (tab.pinned && !settings.suspendPinned) ||
    isInternalUrl(tab.url) ||
    matchesWhitelist(tab.url, settings.whitelist)
  );
}

// ─── Suspended Page URL Builder ──────────────────────────────────────

function buildSuspendedUrl(url, title, favIconUrl) {
  const params = new URLSearchParams();
  params.set('url', url);
  params.set('title', title || '');
  if (favIconUrl) params.set('favicon', favIconUrl);
  return SUSPENDED_PAGE + '?' + params.toString();
}

// ─── Tab Grouping ────────────────────────────────────────────────────

async function moveToSuspendedGroup(tabId, windowId) {
  if (!chrome.tabGroups) return;
  const settings = await getSettings();
  if (!settings.useTabGroups) return;

  try {
    const groupName = settings.tabGroupName || 'Suspended';

    // Find existing suspended group in this window
    const groups = await chrome.tabGroups.query({ windowId });
    let groupId = groups.find(g => g.title === groupName)?.id;

    if (groupId) {
      await chrome.tabs.group({ tabIds: tabId, groupId });
    } else {
      groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, {
        title: groupName,
        color: 'grey',
        collapsed: true
      });
    }
  } catch {
    // Tab grouping may fail if tab was closed
  }
}

async function removeFromSuspendedGroup(tabId) {
  if (!chrome.tabGroups) return;
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // Tab may not be in a group or may have closed
  }
}

// ─── Alarm Handler ───────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CHECK_ALARM) {
    await restoreTimestamps();
    await checkAndDiscardInactiveTabs();
    await cleanupYouTubeTimestamps();
  } else if (alarm.name === PERSIST_ALARM) {
    await persistTimestamps();
  }
});

async function checkAndDiscardInactiveTabs() {
  const settings = await getSettings();
  const timeoutMs = settings.timeoutMinutes * 60 * 1000;
  const now = Date.now();
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (isTabProtected(tab, settings)) continue;

    const lastActive = lastActiveTimestamps[tab.id];
    if (!lastActive) {
      lastActiveTimestamps[tab.id] = now;
      continue;
    }

    if (now - lastActive >= timeoutMs) {
      await suspendTab(tab);
    }
  }
}

// ─── Suspension (navigate to suspended.html) ─────────────────────────

async function suspendTab(tab) {
  try {
    if (isYouTubeWatch(tab.url)) await saveYouTubeTimestamp(tab);

    const suspendedUrl = buildSuspendedUrl(tab.url, tab.title, tab.favIconUrl);

    // Store suspended tab data
    const { suspendedTabs = {} } = await chrome.storage.local.get('suspendedTabs');
    suspendedTabs[tab.id] = {
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      suspendedAt: Date.now()
    };
    await chrome.storage.local.set({ suspendedTabs });

    // Navigate to suspended page
    await chrome.tabs.update(tab.id, { url: suspendedUrl });

    // Move to suspended group if enabled
    await moveToSuspendedGroup(tab.id, tab.windowId);

    await updateBadge();
  } catch {
    // Tab may have been closed
  }
}

// ─── Manual Actions ──────────────────────────────────────────────────

async function suspendCurrentTab(windowId) {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (!activeTab || isInternalUrl(activeTab.url) || isSuspendedUrl(activeTab.url)) return;

  // Save YouTube timestamp before switching away
  if (isYouTubeWatch(activeTab.url)) await saveYouTubeTimestamp(activeTab);

  const suspendedUrl = buildSuspendedUrl(activeTab.url, activeTab.title, activeTab.favIconUrl);

  // Store suspended tab data
  const { suspendedTabs = {} } = await chrome.storage.local.get('suspendedTabs');
  suspendedTabs[activeTab.id] = {
    url: activeTab.url,
    title: activeTab.title,
    favIconUrl: activeTab.favIconUrl,
    suspendedAt: Date.now()
  };
  await chrome.storage.local.set({ suspendedTabs });

  // Navigate tab to suspended page — user stays on it to see the "click to restore" view
  try {
    await chrome.tabs.update(activeTab.id, { url: suspendedUrl });
    await moveToSuspendedGroup(activeTab.id, windowId);
  } catch (err) {
    // Tab may have closed — clean up stored data
    delete suspendedTabs[activeTab.id];
    await chrome.storage.local.set({ suspendedTabs });
  }
  await updateBadge();
}

async function suspendOtherTabs(windowId) {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({ windowId });
  for (const tab of tabs) {
    if (!isTabProtected(tab, settings)) await suspendTab(tab);
  }
}

async function suspendAllTabs() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!isTabProtected(tab, settings)) await suspendTab(tab);
  }
}

async function suspendSelectedTabs(tabIds) {
  const settings = await getSettings();
  let suspended = 0;
  let skipped = 0;
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isTabProtected(tab, settings)) {
        skipped++;
      } else {
        await suspendTab(tab);
        suspended++;
      }
    } catch {
      skipped++;
    }
  }
  return { suspended, skipped };
}

async function restoreAllTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const restoredTabIds = [];
  for (const tab of tabs) {
    if (isSuspendedUrl(tab.url)) {
      const params = new URL(tab.url).searchParams;
      const originalUrl = params.get('url');
      if (originalUrl) {
        try {
          await removeFromSuspendedGroup(tab.id);
          await chrome.tabs.update(tab.id, { url: originalUrl });
          restoredTabIds.push(tab.id);
        } catch { /* tab may have closed */ }
      }
    }
  }
  // Eagerly clean up storage for tabs we just restored
  if (restoredTabIds.length > 0) {
    const { suspendedTabs = {} } = await chrome.storage.local.get('suspendedTabs');
    restoredTabIds.forEach(id => delete suspendedTabs[id]);
    await chrome.storage.local.set({ suspendedTabs });
  }
  await updateBadge();
}

// ─── Tab Event Listeners ─────────────────────────────────────────────

let persistDebounce = null;

chrome.tabs.onActivated.addListener(({ tabId }) => {
  lastActiveTimestamps[tabId] = Date.now();

  // Debounce storage writes to avoid excessive I/O during rapid tab switching
  if (persistDebounce) clearTimeout(persistDebounce);
  persistDebounce = setTimeout(() => persistTimestamps(), 2000);

  // Badge update after a short delay
  setTimeout(() => updateBadge(), 500);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  delete lastActiveTimestamps[tabId];

  // Clean up suspended tab data
  const { suspendedTabs = {} } = await chrome.storage.local.get('suspendedTabs');
  if (suspendedTabs[tabId]) {
    delete suspendedTabs[tabId];
    await chrome.storage.local.set({ suspendedTabs });
  }

  updateBadge();
});

chrome.tabs.onCreated.addListener((tab) => {
  lastActiveTimestamps[tab.id] = Date.now();
  updateBadge();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    // Detect restoration: tab navigated away from suspended.html
    if (tab.url && !isSuspendedUrl(tab.url)) {
      const { suspendedTabs = {} } = await chrome.storage.local.get('suspendedTabs');
      if (suspendedTabs[tabId]) {
        delete suspendedTabs[tabId];
        await chrome.storage.local.set({ suspendedTabs });
        await removeFromSuspendedGroup(tabId);
      }
    }

    if (isYouTubeWatch(tab.url)) await restoreYouTubeTimestamp(tab);
    updateBadge();
  }
});

// ─── Badge ───────────────────────────────────────────────────────────

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(t => isSuspendedUrl(t.url)).length;
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#607D8B' });
  } catch {
    // Ignore — may fire before extension is fully initialized
  }
}

// ─── Context Menus ───────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'suspend-tab') {
    await suspendCurrentTab(tab.windowId);
  } else if (info.menuItemId === 'whitelist-domain' && tab.url) {
    try {
      const hostname = new URL(tab.url).hostname;
      const settings = await getSettings();
      if (!settings.whitelist.includes(hostname)) {
        settings.whitelist.push(hostname);
        await chrome.storage.local.set({ settings });
      }
    } catch {
      // Invalid URL
    }
  }
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab) return;

  if (command === 'suspend-current') await suspendCurrentTab(activeTab.windowId);
  else if (command === 'suspend-others') await suspendOtherTabs(activeTab.windowId);
  else if (command === 'toggle-whitelist') await toggleWhitelist(activeTab);
});

async function toggleWhitelist(tab) {
  if (!tab.url) return;
  try {
    const hostname = new URL(tab.url).hostname;
    const settings = await getSettings();
    const idx = settings.whitelist.indexOf(hostname);
    if (idx === -1) settings.whitelist.push(hostname);
    else settings.whitelist.splice(idx, 1);
    await chrome.storage.local.set({ settings });
  } catch {
    // Invalid URL
  }
}

// ─── YouTube Timestamp Preservation ──────────────────────────────────

function isYouTubeWatch(url) {
  return url && /https?:\/\/(www\.)?youtube\.com\/watch/.test(url);
}

async function saveYouTubeTimestamp(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelector('video')?.currentTime ?? null
    });
    if (results?.[0]?.result != null) {
      const { youtubeTimestamps = {} } = await chrome.storage.local.get('youtubeTimestamps');
      youtubeTimestamps[tab.url] = {
        time: results[0].result,
        savedAt: Date.now()
      };
      await chrome.storage.local.set({ youtubeTimestamps });
    }
  } catch {
    // Script injection may fail on restricted pages
  }
}

async function restoreYouTubeTimestamp(tab) {
  try {
    const { youtubeTimestamps = {} } = await chrome.storage.local.get('youtubeTimestamps');
    const saved = youtubeTimestamps[tab.url];
    if (!saved) return;

    // Discard timestamps older than 7 days
    if (Date.now() - saved.savedAt > 7 * 24 * 60 * 60 * 1000) {
      delete youtubeTimestamps[tab.url];
      await chrome.storage.local.set({ youtubeTimestamps });
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (time) => {
        const video = document.querySelector('video');
        if (video) {
          if (video.readyState >= 2) {
            video.currentTime = time;
          } else {
            video.addEventListener('canplay', () => {
              video.currentTime = time;
            }, { once: true });
          }
        }
      },
      args: [saved.time]
    });

    // Clean up after restore
    delete youtubeTimestamps[tab.url];
    await chrome.storage.local.set({ youtubeTimestamps });
  } catch {
    // Script injection may fail
  }
}

async function cleanupYouTubeTimestamps() {
  const { youtubeTimestamps = {} } = await chrome.storage.local.get('youtubeTimestamps');
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [url, data] of Object.entries(youtubeTimestamps)) {
    if (data.savedAt < cutoff) {
      delete youtubeTimestamps[url];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ youtubeTimestamps });
}

// ─── Message Handler (popup communication) ───────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case 'suspend-current':
        await suspendCurrentTab(message.windowId);
        break;
      case 'suspend-others':
        await suspendOtherTabs(message.windowId);
        break;
      case 'suspend-all':
        await suspendAllTabs();
        break;
      case 'restore-all':
        await restoreAllTabs(message.windowId);
        break;
      case 'suspend-selected': {
        const result = await suspendSelectedTabs(message.tabIds || []);
        sendResponse({ ok: true, ...result });
        return;
      }
      case 'toggle-whitelist': {
        const [tab] = await chrome.tabs.query({ active: true, windowId: message.windowId });
        if (tab) await toggleWhitelist(tab);
        break;
      }
      case 'tab-restored':
        // Cleanup handled by onUpdated listener
        break;
    }
    sendResponse({ ok: true });
  })();
  return true; // Keep message channel open for async response
});
