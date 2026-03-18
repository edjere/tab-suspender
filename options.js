'use strict';

const timeoutSelect = document.getElementById('timeout');
const suspendPinnedCheckbox = document.getElementById('suspend-pinned');
const whitelistInput = document.getElementById('whitelist-add');
const whitelistAddBtn = document.getElementById('whitelist-add-btn');
const whitelistUl = document.getElementById('whitelist');
const shortcutsLink = document.getElementById('shortcuts-link');

// New settings elements
const useTitlePrefixCheckbox = document.getElementById('use-title-prefix');
const useTabGroupsCheckbox = document.getElementById('use-tab-groups');
const tabGroupNameInput = document.getElementById('tab-group-name');
const groupNameRow = document.getElementById('group-name-row');
const tabGroupsLabel = document.getElementById('tab-groups-label');

// ─── Feature detection ──────────────────────────────────────────────

if (!chrome.tabGroups) {
  tabGroupsLabel.style.display = 'none';
  groupNameRow.style.display = 'none';
}

// ─── Load settings ───────────────────────────────────────────────────

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) return;

  timeoutSelect.value = String(settings.timeoutMinutes);
  suspendPinnedCheckbox.checked = settings.suspendPinned;
  useTitlePrefixCheckbox.checked = settings.useTitlePrefix !== false;
  useTabGroupsCheckbox.checked = !!settings.useTabGroups;
  tabGroupNameInput.value = settings.tabGroupName || 'Suspended';
  groupNameRow.style.display = settings.useTabGroups && chrome.tabGroups ? '' : 'none';
  renderWhitelist(settings.whitelist || []);
}

// ─── Auto-save on change ─────────────────────────────────────────────

async function saveSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const updated = settings || {};
  updated.timeoutMinutes = parseInt(timeoutSelect.value, 10);
  updated.suspendPinned = suspendPinnedCheckbox.checked;
  updated.useTitlePrefix = useTitlePrefixCheckbox.checked;
  updated.useTabGroups = useTabGroupsCheckbox.checked;
  updated.tabGroupName = tabGroupNameInput.value.trim() || 'Suspended';
  await chrome.storage.local.set({ settings: updated });
}

// ─── Whitelist management ─────────────────────────────────────────────

function renderWhitelist(whitelist) {
  while (whitelistUl.firstChild) {
    whitelistUl.removeChild(whitelistUl.firstChild);
  }

  if (whitelist.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No whitelisted domains';
    whitelistUl.appendChild(li);
    return;
  }

  for (const domain of whitelist) {
    const li = document.createElement('li');

    const span = document.createElement('span');
    span.textContent = domain;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => removeDomain(domain));

    li.appendChild(span);
    li.appendChild(removeBtn);
    whitelistUl.appendChild(li);
  }
}

async function addDomain() {
  const domain = whitelistInput.value.trim().toLowerCase();
  if (!domain) return;

  const { settings } = await chrome.storage.local.get('settings');
  if (!settings.whitelist) settings.whitelist = [];
  if (settings.whitelist.includes(domain)) {
    whitelistInput.value = '';
    return;
  }

  settings.whitelist.push(domain);
  await chrome.storage.local.set({ settings });
  renderWhitelist(settings.whitelist);
  whitelistInput.value = '';
}

async function removeDomain(domain) {
  const { settings } = await chrome.storage.local.get('settings');
  settings.whitelist = settings.whitelist.filter(d => d !== domain);
  await chrome.storage.local.set({ settings });
  renderWhitelist(settings.whitelist);
}

// ─── Event listeners ──────────────────────────────────────────────────

timeoutSelect.addEventListener('change', saveSettings);
suspendPinnedCheckbox.addEventListener('change', saveSettings);
useTitlePrefixCheckbox.addEventListener('change', saveSettings);
useTabGroupsCheckbox.addEventListener('change', () => {
  if (!chrome.tabGroups) return;
  groupNameRow.style.display = useTabGroupsCheckbox.checked ? '' : 'none';
  saveSettings();
});
tabGroupNameInput.addEventListener('input', saveSettings);
whitelistAddBtn.addEventListener('click', addDomain);
whitelistInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addDomain();
});

shortcutsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ─── Initialize ───────────────────────────────────────────────────────

loadSettings();
