const DEFAULT_OPTIONS = {
  sidebarMode: 'expanded',
  sidebarPosition: 'right',
  appearance: 'system',
  questionSort: 'oldest',
  listFontSize: 'medium',
  backgroundOpacity: 100,
};

const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
const statusEl = document.querySelector('.save-status');
const backgroundOpacityInput = document.querySelector('input[name="backgroundOpacity"]');
const backgroundOpacityValue = document.querySelector('#background-opacity-value');
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
    if (key === 'backgroundOpacity') return;
    const value = options[key] || DEFAULT_OPTIONS[key];
    const input = document.querySelector(`input[name="${key}"][value="${value}"]`);
    if (input) input.checked = true;
  });
}

function setBackgroundOpacityValue(value) {
  const numericValue = Number(value);
  const safeValue = Number.isFinite(numericValue) ? numericValue : DEFAULT_OPTIONS.backgroundOpacity;

  backgroundOpacityInput.value = String(safeValue);
  backgroundOpacityValue.textContent = `${safeValue}%`;
}

function saveOption(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    setStatus('已儲存');
  });
}

chrome.storage.sync.get(DEFAULT_OPTIONS, (options) => {
  setCheckedValues(options);
  setBackgroundOpacityValue(options.backgroundOpacity);
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.name !== 'backgroundOpacity') return;

  setBackgroundOpacityValue(target.value);
  saveOption(target.name, Number(target.value));
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (!target.matches('input[type="radio"]')) return;
  if (!OPTION_KEYS.includes(target.name)) return;

  saveOption(target.name, target.value);
});
