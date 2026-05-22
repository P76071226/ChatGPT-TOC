const DEFAULT_OPTIONS = {
  sidebarMode: 'expanded',
  appearance: 'system',
};

const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
const statusEl = document.querySelector('.save-status');
let statusTimer = null;

function setStatus(message) {
  statusEl.textContent = message;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = '';
  }, 1400);
}

function setCheckedValues(options) {
  OPTION_KEYS.forEach((key) => {
    const value = options[key] || DEFAULT_OPTIONS[key];
    const input = document.querySelector(`input[name="${key}"][value="${value}"]`);
    if (input) input.checked = true;
  });
}

function saveOption(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    setStatus('已儲存');
  });
}

chrome.storage.sync.get(DEFAULT_OPTIONS, (options) => {
  setCheckedValues(options);
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (!target.matches('input[type="radio"]')) return;
  if (!OPTION_KEYS.includes(target.name)) return;

  saveOption(target.name, target.value);
});
