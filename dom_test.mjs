// dom_test.mjs — REAL-DOM smoke gate (jsdom + real jQuery).
// The stub-based gates prove logic; they cannot prove that UI wiring survives a
// real DOM (event delegation, element construction, inline styles, focus). This
// harness slices the SHIPPED handler blocks verbatim out of index.js and runs
// them under jsdom, so "green" means the exact production code opened, edited,
// mirrored, saved, and closed a real overlay. Run: node dom_test.mjs
// Deps are dev-only (npm install --no-save jsdom jquery); the gate SKIPS with
// exit 0 if they are absent so CI-less devices aren't blocked.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// jQuery's entry throws at import time without a window; the CJS export is the
// FACTORY when no global window exists. So: jsdom first, then require('jquery')
// and hand it the jsdom window.
const require = createRequire(import.meta.url);
let JSDOM, jqueryFactory;
try {
    ({ JSDOM } = await import('jsdom'));
    jqueryFactory = require('jquery/factory').jQueryFactory;   // the windowless entry — plain 'jquery' throws without a global window
} catch (e) {
    const missing = /Cannot find (package|module)/.test(String(e && e.message));
    console.log('dom_test: ' + (missing ? 'jsdom/jquery not installed — SKIP (npm install --no-save jsdom jquery to enable)' : 'DEP LOAD FAILED — ' + (e && e.message)));
    process.exit(missing ? 0 : 1);
}

let pass = 0, fail = 0; const fails = [];
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; fails.push(m); console.log('  ✗ ' + m); } };

const SRC = readFileSync(new URL('./index.js', import.meta.url), 'utf8');

// slice a verbatim block out of index.js between two unique markers
function slice(fromMarker, toMarker) {
    const a = SRC.indexOf(fromMarker);
    const b = SRC.indexOf(toMarker, a);
    if (a === -1 || b === -1) throw new Error('marker not found: ' + (a === -1 ? fromMarker : toMarker));
    return SRC.slice(a, b);
}

const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="panel"><textarea id="sc_notepad"></textarea>'
    + '<button type="button" id="sc_notepad_fullscreen">⛶</button></div>'
    + '</body></html>', { pretendToBeVisual: true });
const { window } = dom;
const $ = jqueryFactory(window);

// ── stubs for the block's outer dependencies (state-bearing, assertable) ──
const store = { notepad: 'Marcroft canon: the arch faces east.' };
let saved = 0, injected = 0;
const sandboxGlobals = {
    $, window, document: window.document,
    getChatStore: () => store,
    saveChatStore: async () => { saved++; },
    updateInjection: () => { injected++; },
};

// the shipped blocks, verbatim
const notepadInputBlock = slice("$(document).on('input', '#sc_notepad', function () {", "// ── Notepad full-screen editor ──");
const fsBlock = slice("$(document).on('click', '#sc_notepad_fullscreen', function () {", "// ── Detail Auditor (sister) ──");
const syncFn = slice('function _syncNotepadUi(v) {', 'function getChatStore() {');

const runner = new Function(...Object.keys(sandboxGlobals), notepadInputBlock + '\n' + fsBlock + '\n' + syncFn + '\nreturn { _syncNotepadUi };');
const exportsObj = runner(...Object.values(sandboxGlobals));

console.log('== full-screen notepad: the SHIPPED wiring, in a real DOM ==');

// open
$('#sc_notepad').val(store.notepad);
$('#sc_notepad_fullscreen').trigger('click');
ok($('#sc_notepad_fs').length === 1, 'click opens the overlay');
ok($('#sc_notepad_fs_text').val() === store.notepad, 'editor seeds from the store');
ok($('#sc_notepad_fs_count').text() === store.notepad.length + ' ch', 'char count seeds');
const ovEl = $('#sc_notepad_fs')[0];
ok(ovEl.style.position === 'fixed' && ovEl.style.zIndex === '2147483000', 'SELF-CONTAINED: geometry set by direct JS assignment — no stylesheet, no string parsing to disagree about');
ok(/^\d+px$/.test(ovEl.style.width) && /^\d+px$/.test(ovEl.style.height) && parseInt(ovEl.style.height, 10) === window.innerHeight, 'MEASURED PIXELS: height taken from the live viewport, not from percentage units');
ok(ovEl.style.flexDirection === 'column', 'column layout assigned');
ok($('#sc_notepad_fs_text')[0].style.flex === '1 1 auto', 'textarea fills the measured screen');
ok(typeof window._scNotepadFsFit === 'function', 'a live re-fit is registered for viewport/keyboard changes');
{
    // the keyboard scenario: viewport shrinks → the overlay must follow
    const h0 = parseInt(ovEl.style.height, 10);
    Object.defineProperty(window, 'innerHeight', { value: h0 - 300, configurable: true });
    window._scNotepadFsFit();
    ok(parseInt(ovEl.style.height, 10) === h0 - 300, 'KEYBOARD-PROOF: viewport change re-fits the overlay to measured pixels');
    Object.defineProperty(window, 'innerHeight', { value: h0, configurable: true });
    window._scNotepadFsFit();
}

// second click: no duplicate
$('#sc_notepad_fullscreen').trigger('click');
ok($('#sc_notepad_fs').length === 1, 'double-open guarded');

// type in the editor → one pipeline: panel, store, save, injection, count
$('#sc_notepad_fs_text').val('Marcroft canon: the arch faces WEST.').trigger('input');
ok($('#sc_notepad').val() === 'Marcroft canon: the arch faces WEST.', 'keystrokes flow through the panel textarea');
ok(store.notepad === 'Marcroft canon: the arch faces WEST.', 'the store is written by the ONE pipeline');
ok(saved > 0 && injected > 0, 'save + injection refresh fired');
ok($('#sc_notepad_fs_count').text() === '36 ch', 'count follows typing');

// programmatic write while open → both views (callers set the store, THEN sync the views)
store.notepad = 'replaced by import';
exportsObj._syncNotepadUi('replaced by import');
ok($('#sc_notepad').val() === 'replaced by import' && $('#sc_notepad_fs_text').val() === 'replaced by import', 'programmatic sync updates both views');

// close paths
$('#sc_notepad_fs_close').trigger('click');
ok($('#sc_notepad_fs').length === 0, '✕ closes');
$('#sc_notepad_fullscreen').trigger('click');
$('#sc_notepad_fs_min').trigger('click');
ok($('#sc_notepad_fs').length === 0, '⤡ Default closes');
$('#sc_notepad_fullscreen').trigger('click');
$(window.document).trigger($.Event('keydown', { key: 'Escape' }));
ok($('#sc_notepad_fs').length === 0, 'Escape closes');
ok(window._scNotepadFsFit === undefined, 'close unbinds the viewport listeners — no leak, no ghost re-fits');
ok(store.notepad === 'replaced by import', 'closing never discards — the store holds the last text');

console.log('\n────────────────────────────────────────');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('\nFAILURES:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('REAL-DOM WIRING OK ✓');
