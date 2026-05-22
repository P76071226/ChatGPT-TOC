const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const manifest = JSON.parse(read('manifest.json'));

assert.strictEqual(manifest.action.default_popup, 'options.html', 'extension icon should open options.html');
assert.ok(manifest.permissions.includes('storage'), 'storage permission is required for persisted options');

const optionsHtml = read('options.html');
assert.match(optionsHtml, /name="sidebarMode"/, 'options page should expose sidebar display mode');
assert.match(optionsHtml, /name="sidebarPosition"/, 'options page should expose sidebar position');
assert.match(optionsHtml, /name="appearance"/, 'options page should expose appearance');
assert.match(optionsHtml, /name="questionSort"/, 'options page should expose question sorting');
assert.match(optionsHtml, /name="listFontSize"/, 'options page should expose list font size');
assert.match(optionsHtml, /name="backgroundOpacity"/, 'options page should expose background opacity slider');
assert.match(optionsHtml, /min="30"/, 'background opacity slider should start at 30%');
assert.match(optionsHtml, /max="100"/, 'background opacity slider should end at 100%');
assert.match(optionsHtml, /options.js/, 'options page should load options.js');

const optionsJs = read('options.js');
assert.match(optionsJs, /chrome\.storage\.sync/, 'options script should persist settings with chrome.storage.sync');
assert.match(optionsJs, /sidebarMode/, 'options script should manage sidebar display mode');
assert.match(optionsJs, /sidebarPosition/, 'options script should manage sidebar position');
assert.match(optionsJs, /appearance/, 'options script should manage appearance');
assert.match(optionsJs, /questionSort/, 'options script should manage question sorting');
assert.match(optionsJs, /listFontSize/, 'options script should manage list font size');
assert.match(optionsJs, /backgroundOpacity/, 'options script should manage background opacity');

const contentJs = read('content.js');
assert.match(contentJs, /chrome\.storage\.sync/, 'content script should read persisted settings');
assert.match(contentJs, /chrome\.storage\.local/, 'content script should cache conversation indexes in local storage');
assert.match(contentJs, /sidebarMode/, 'content script should apply sidebar display mode');
assert.match(contentJs, /sidebarPosition/, 'content script should apply sidebar position');
assert.match(contentJs, /appearance/, 'content script should apply appearance');
assert.match(contentJs, /questionSort/, 'content script should apply question sorting');
assert.match(contentJs, /listFontSize/, 'content script should apply list font size');
assert.match(contentJs, /backgroundOpacity/, 'content script should apply background opacity');
assert.match(contentJs, /--cgpt-bg-alpha/, 'content script should set sidebar background alpha variable');
assert.match(contentJs, /MAX_ITEMS_PER_CONVERSATION = 300/, 'cache should cap items per conversation');
assert.match(contentJs, /MAX_CACHED_CONVERSATIONS = 50/, 'cache should cap cached conversations');
assert.match(contentJs, /CACHE_MAX_AGE_MS/, 'cache should expire old conversation indexes');
assert.match(contentJs, /getConversationKey/, 'content script should scope cache by conversation');
assert.match(contentJs, /mergeCachedItems/, 'content script should merge live DOM items into cache');
assert.match(contentJs, /getNodeSignature/, 'content script should detect lazy-loaded content changes even when DOM count is unchanged');

const stylesCss = read('styles.css');
assert.match(stylesCss, /cgpt-position-left/, 'styles should support left sidebar position');
assert.match(stylesCss, /cgpt-mode-tab/, 'styles should support tab sidebar mode');
assert.match(stylesCss, /cgpt-theme-dark/, 'styles should support explicit dark appearance');
assert.match(stylesCss, /cgpt-font-small/, 'styles should support small list font size');
assert.match(stylesCss, /cgpt-font-large/, 'styles should support large list font size');
assert.match(stylesCss, /--cgpt-bg-alpha/, 'styles should use sidebar background alpha variable');

console.log('Options feature checks passed');
