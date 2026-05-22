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
assert.match(optionsHtml, /options.js/, 'options page should load options.js');

const optionsJs = read('options.js');
assert.match(optionsJs, /chrome\.storage\.sync/, 'options script should persist settings with chrome.storage.sync');
assert.match(optionsJs, /sidebarMode/, 'options script should manage sidebar display mode');
assert.match(optionsJs, /sidebarPosition/, 'options script should manage sidebar position');
assert.match(optionsJs, /appearance/, 'options script should manage appearance');

const contentJs = read('content.js');
assert.match(contentJs, /chrome\.storage\.sync/, 'content script should read persisted settings');
assert.match(contentJs, /sidebarMode/, 'content script should apply sidebar display mode');
assert.match(contentJs, /sidebarPosition/, 'content script should apply sidebar position');
assert.match(contentJs, /appearance/, 'content script should apply appearance');

const stylesCss = read('styles.css');
assert.match(stylesCss, /cgpt-position-left/, 'styles should support left sidebar position');
assert.match(stylesCss, /cgpt-mode-tab/, 'styles should support tab sidebar mode');
assert.match(stylesCss, /cgpt-theme-dark/, 'styles should support explicit dark appearance');

console.log('Options feature checks passed');
