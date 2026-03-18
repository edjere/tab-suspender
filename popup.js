'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const windowId = currentTab.windowId;
  const { settings } = await chrome.storage.local.get('settings');

  const SUSPENDED_PAGE = chrome.runtime.getURL('suspended.html');

  function isSuspendedUrl(url) {
    return url && url.startsWith(SUSPENDED_PAGE);
  }

  // ─── Gather tab data ──────────────────────────────────────────────

  const tabs = await chrome.tabs.query({ windowId });
  const totalTabs = tabs.length;
  const suspendedCount = tabs.filter(t => isSuspendedUrl(t.url)).length;

  // ─── Header stats ─────────────────────────────────────────────────

  document.getElementById('stats').textContent =
    `${suspendedCount} suspended / ${totalTabs}`;

  // ─── Search bar (auto-shown when >= 8 tabs) ───────────────────────

  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  if (totalTabs >= 8) {
    searchBar.style.display = '';
  }

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => filterTabs(), 200);
  });

  // ─── Filter chips ─────────────────────────────────────────────────

  let activeFilter = 'all';
  const chips = document.querySelectorAll('.chip');

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      filterTabs();
    });
  });

  function filterTabs() {
    const query = searchInput.value.toLowerCase().trim();
    const items = document.querySelectorAll('.tab-item');

    items.forEach(item => {
      const status = item.dataset.status;
      const searchText = item.dataset.searchText;

      let matchesFilter = true;
      if (activeFilter !== 'all') {
        matchesFilter = status === activeFilter;
      }

      let matchesSearch = true;
      if (query) {
        matchesSearch = searchText.includes(query);
      }

      item.classList.toggle('hidden', !(matchesFilter && matchesSearch));
    });
  }

  // ─── Multi-tab selection state ─────────────────────────────────────

  const selectedTabs = new Set();
  let lastCheckedIndex = -1;

  function getTabStatus(tab) {
    if (tab.active) return 'active';
    if (isSuspendedUrl(tab.url)) return 'suspended';
    const urlToCheck = getOriginalUrl(tab);
    if (tab.pinned || tab.audible || matchesWhitelist(urlToCheck, settings?.whitelist)) {
      return 'protected';
    }
    return 'active'; // idle tabs show as "active" for filter purposes
  }

  function getStatusLabel(tab) {
    if (tab.active) return 'Active';
    if (isSuspendedUrl(tab.url)) return 'Suspended';
    if (tab.pinned) return 'Pinned';
    if (tab.audible) return 'Audio';
    const urlToCheck = getOriginalUrl(tab);
    if (matchesWhitelist(urlToCheck, settings?.whitelist)) return 'Safe';
    return 'Idle';
  }

  function getStatusClass(tab) {
    if (tab.active) return 'status-active';
    if (isSuspendedUrl(tab.url)) return 'status-suspended';
    const urlToCheck = getOriginalUrl(tab);
    if (tab.pinned || tab.audible || matchesWhitelist(urlToCheck, settings?.whitelist)) {
      return 'status-protected';
    }
    return 'status-idle';
  }

  function getOriginalUrl(tab) {
    if (isSuspendedUrl(tab.url)) {
      try {
        return new URL(tab.url).searchParams.get('url') || tab.url;
      } catch { return tab.url; }
    }
    return tab.url;
  }

  function getOriginalTitle(tab) {
    if (isSuspendedUrl(tab.url)) {
      try {
        return new URL(tab.url).searchParams.get('title') || tab.title || 'Suspended Tab';
      } catch { return tab.title; }
    }
    return tab.title || tab.url || 'New Tab';
  }

  // ─── Render tab list ──────────────────────────────────────────────

  const tabList = document.getElementById('tab-list');

  tabs.forEach((tab, index) => {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.dataset.tabId = tab.id;
    item.dataset.index = index;

    const status = getTabStatus(tab);
    item.dataset.status = status;

    const displayTitle = getOriginalTitle(tab);
    const displayUrl = getOriginalUrl(tab);
    item.dataset.searchText = (displayTitle + ' ' + displayUrl).toLowerCase();

    if (tab.active) item.classList.add('is-active');
    if (isSuspendedUrl(tab.url)) item.classList.add('is-suspended');

    // Checkbox
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tab-checkbox';
    checkbox.title = 'Select tab';
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      handleCheckboxClick(tab.id, index, e.shiftKey);
    });
    checkbox.addEventListener('change', (e) => {
      // Sync state in case browser toggled it
      if (e.target.checked) {
        selectedTabs.add(tab.id);
      } else {
        selectedTabs.delete(tab.id);
      }
      updateSelectionUI();
    });

    // Status pill
    const pill = document.createElement('span');
    pill.className = 'status-pill ' + getStatusClass(tab);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = getStatusLabel(tab);
    pill.appendChild(dot);
    pill.appendChild(label);

    // Favicon
    const favicon = document.createElement('img');
    favicon.className = 'favicon';
    if (isSuspendedUrl(tab.url)) {
      try {
        const favUrl = new URL(tab.url).searchParams.get('favicon');
        favicon.src = favUrl || 'icons/icon16.png';
      } catch { favicon.src = 'icons/icon16.png'; }
    } else {
      favicon.src = tab.favIconUrl || 'icons/icon16.png';
    }
    favicon.onerror = () => { favicon.src = 'icons/icon16.png'; };

    // Title
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = displayTitle;

    item.appendChild(checkbox);
    item.appendChild(pill);
    item.appendChild(favicon);
    item.appendChild(title);

    // Click on tab body: switch to that tab
    item.addEventListener('click', async (e) => {
      // Don't switch if clicking checkbox
      if (e.target === checkbox) return;

      if (isSuspendedUrl(tab.url)) {
        // For suspended tabs, restore them by navigating to original URL
        const originalUrl = getOriginalUrl(tab);
        await chrome.tabs.update(tab.id, { active: true, url: originalUrl });
      } else {
        await chrome.tabs.update(tab.id, { active: true });
      }
      window.close();
    });

    tabList.appendChild(item);
  });

  // ─── Checkbox + shift-click logic ─────────────────────────────────

  function handleCheckboxClick(tabId, index, isShiftKey) {
    if (isShiftKey && lastCheckedIndex !== -1) {
      const start = Math.min(lastCheckedIndex, index);
      const end = Math.max(lastCheckedIndex, index);
      const items = tabList.querySelectorAll('.tab-item');

      // Determine desired state from the clicked item
      const shouldSelect = !selectedTabs.has(tabId);

      for (let i = start; i <= end; i++) {
        if (items[i].classList.contains('hidden')) continue; // skip filtered-out tabs
        const itemTabId = parseInt(items[i].dataset.tabId, 10);
        const cb = items[i].querySelector('.tab-checkbox');
        if (shouldSelect) {
          selectedTabs.add(itemTabId);
          cb.checked = true;
        } else {
          selectedTabs.delete(itemTabId);
          cb.checked = false;
        }
        items[i].classList.toggle('is-selected', shouldSelect);
      }
    } else {
      if (selectedTabs.has(tabId)) {
        selectedTabs.delete(tabId);
      } else {
        selectedTabs.add(tabId);
      }
    }

    lastCheckedIndex = index;
    updateSelectionUI();
  }

  function updateSelectionUI() {
    const count = selectedTabs.size;
    const actionsNormal = document.getElementById('actions-normal');
    const actionsSelection = document.getElementById('actions-selection');
    const selectionCount = document.getElementById('selection-count');
    const selectAllCheckbox = document.getElementById('select-all');

    if (count > 0) {
      actionsNormal.style.display = 'none';
      actionsSelection.style.display = '';
      selectionCount.textContent = `${count} selected`;
      selectAllCheckbox.checked = count === tabs.length;
      selectAllCheckbox.indeterminate = count > 0 && count < tabs.length;
    } else {
      actionsNormal.style.display = '';
      actionsSelection.style.display = 'none';
    }

    // Update visual state on tab items
    tabList.querySelectorAll('.tab-item').forEach(item => {
      const tabId = parseInt(item.dataset.tabId, 10);
      const cb = item.querySelector('.tab-checkbox');
      const isSelected = selectedTabs.has(tabId);
      cb.checked = isSelected;
      item.classList.toggle('is-selected', isSelected);
    });
  }

  // ─── Select All ───────────────────────────────────────────────────

  document.getElementById('select-all').addEventListener('change', (e) => {
    if (e.target.checked) {
      tabs.forEach(t => selectedTabs.add(t.id));
    } else {
      selectedTabs.clear();
    }
    updateSelectionUI();
  });

  // ─── Clear selection ──────────────────────────────────────────────

  document.getElementById('clear-selection').addEventListener('click', () => {
    selectedTabs.clear();
    lastCheckedIndex = -1;
    updateSelectionUI();
  });

  // ─── Suspend Selected ─────────────────────────────────────────────

  document.getElementById('suspend-selected').addEventListener('click', async () => {
    const tabIds = [...selectedTabs];
    await chrome.runtime.sendMessage({ action: 'suspend-selected', tabIds });
    window.close();
  });

  // ─── Normal action buttons ─────────────────────────────────────────

  document.getElementById('suspend-current').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'suspend-current', windowId });
    window.close();
  });

  document.getElementById('suspend-others').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'suspend-others', windowId });
    window.close();
  });

  document.getElementById('suspend-all').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'suspend-all' });
    window.close();
  });

  document.getElementById('restore-all').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'restore-all', windowId });
    window.close();
  });

  // ─── Whitelist quick toggle ─────────────────────────────────────────

  const whitelistBtn = document.getElementById('whitelist-btn');
  if (currentTab.url && !isSuspendedUrl(currentTab.url)) {
    try {
      const hostname = new URL(currentTab.url).hostname;
      const isWhitelisted = matchesWhitelist(currentTab.url, settings?.whitelist);
      whitelistBtn.textContent = isWhitelisted
        ? `\u2212 Remove ${hostname} from whitelist`
        : `+ Whitelist ${hostname}`;
      if (isWhitelisted) whitelistBtn.classList.add('is-whitelisted');
    } catch {
      // Internal/invalid URL — hide button
    }
  }

  whitelistBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'toggle-whitelist', windowId });
    window.close();
  });

  // ─── Settings button ─────────────────────────────────────────────

  document.getElementById('settings-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────

function matchesWhitelist(url, whitelist) {
  if (!url || !whitelist) return false;
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return false; }
  return whitelist.some(pattern => {
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      return hostname === domain || hostname.endsWith('.' + domain);
    }
    return hostname === pattern;
  });
}
