'use strict';

const params = new URLSearchParams(window.location.search);
const originalUrl = params.get('url');
const originalTitle = params.get('title') || 'Suspended Tab';
const faviconUrl = params.get('favicon') || '';

// Set page title with sleep prefix
(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  const usePrefix = settings?.useTitlePrefix !== false; // default true
  document.title = usePrefix ? '\uD83D\uDCA4 ' + originalTitle : originalTitle;
})();

// Set favicon
if (faviconUrl) {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = faviconUrl;
  document.head.appendChild(link);
}

// Populate UI
document.getElementById('tab-title').textContent = originalTitle;
document.getElementById('tab-url').textContent = originalUrl || '';
const faviconImg = document.getElementById('favicon');
if (faviconUrl) {
  faviconImg.src = faviconUrl;
  faviconImg.onerror = () => { faviconImg.style.display = 'none'; };
} else {
  faviconImg.style.display = 'none';
}

// Restore function — cleanup is handled by background.js onUpdated listener
function restore() {
  if (originalUrl) {
    location.replace(originalUrl);
  }
}

// Click anywhere to restore
document.getElementById('restore-trigger').addEventListener('click', restore);

// Keyboard: Enter or Space to restore
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    restore();
  }
});

// Focus the container for keyboard accessibility
document.getElementById('restore-trigger').focus();
