#!/usr/bin/env node
/**
 * Summaryception — MODULE INTEGRITY GATE.  Run:  node load_test.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * SillyTavern loads index.js as an ES MODULE. `node --check index.js` parses a
 * .js file as CommonJS, which silently ACCEPTS things ESM rejects — most
 * importantly a duplicate top-level `let`. That false pass let v5.58.0 ship a
 * redeclared `_auditActive`, and the extension failed to load AT ALL from
 * v5.58.0 through v5.60.0 while every gate reported green.
 *
 * A parse check is also the weakest possible test: it cannot see TDZ errors,
 * undefined references, or anything the module body actually DOES at import
 * time. So this gate really executes the module against mocked SillyTavern
 * globals and then asserts the extension wired itself up.
 *
 * This runs the file from a temp directory with {"type":"module"}, so the
 * shipped repo needs no package.json and the real artifact is tested verbatim.
 *
 * Exit code 0 = safe to ship. Non-zero = DO NOT PUSH.
 */
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
};

// ── Mocked SillyTavern surface ───────────────────────────────────────
const noop = () => {};
const chain = new Proxy(function () {}, {
    get: (_t, p) => (p === 'length' ? 0 : chain),
    apply: () => chain,
});
globalThis.$ = new Proxy(function () { return chain; }, { get: () => chain, apply: () => chain });
globalThis.jQuery = globalThis.$;
globalThis.toastr = { info: noop, success: noop, warning: noop, error: noop, clear: noop };
globalThis.localStorage = {
    _d: new Map(),
    get length() { return this._d.size; },
    key(i) { return [...this._d.keys()][i] ?? null; },
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
};
const event_types = {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', CHAT_CHANGED: 'CHAT_CHANGED', CHAT_RENAMED: 'CHAT_RENAMED',
    GENERATION_STARTED: 'GENERATION_STARTED', MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED', GENERATION_ENDED: 'GENERATION_ENDED', APP_READY: 'APP_READY',
};
const handlers = new Map();
const ctx = {
    chat: [], chatMetadata: {}, extensionSettings: {}, characters: [], characterId: 0,
    name1: 'Player', name2: 'Narrator', chatId: 'gate.jsonl',
    eventSource: {
        on: (e, f) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(f); },
        emit: noop, removeListener: noop,
    },
    event_types,
    saveSettingsDebounced: noop, saveMetadata: noop, saveMetadataDebounced: noop,
    setExtensionPrompt: noop, getCurrentChatId: () => 'gate.jsonl',
    renderExtensionTemplateAsync: async () => '<div></div>',
    registerSlashCommand: noop,
    SlashCommandParser: { addCommandObject: noop },
    SlashCommand: { fromProps: () => ({}) },
    SlashCommandArgument: { fromProps: () => ({}) },
    SlashCommandNamedArgument: { fromProps: () => ({}) },
    ARGUMENT_TYPE: { STRING: 'string' },
    executeSlashCommandsWithOptions: async () => ({}),
    generateQuietPrompt: async () => '',
    substituteParams: (s) => s,
    extensionPrompts: {},
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.window = globalThis;
globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop, classList: { add: noop } }),
    body: { appendChild: noop },
};
globalThis.structuredClone = globalThis.structuredClone ?? ((o) => JSON.parse(JSON.stringify(o)));

// Init is wrapped in try/catch by design, so a real defect could hide in a
// console.error. Capture them and fail on anything that is not the known,
// mock-only DOM gap.
const realError = console.error;
const errors = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

process.on('unhandledRejection', (e) => {
    console.error = realError;
    console.log('  ✗ unhandled rejection during load: ' + (e && e.message));
    process.exit(1);
});

const dir = mkdtempSync(join(tmpdir(), 'sc-load-'));
try {
    copyFileSync(join(HERE, 'index.js'), join(dir, 'index.js'));
    copyFileSync(join(HERE, 'connectionutil.js'), join(dir, 'connectionutil.js'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');

    console.log('== module integrity ==');
    let loaded = false, loadErr = '';
    try {
        await import(pathToFileURL(join(dir, 'index.js')).href);
        loaded = true;
    } catch (e) {
        loadErr = (e && e.message) || String(e);
    }
    ok(loaded, 'index.js loads as an ES module and executes' + (loaded ? '' : ' — ' + loadErr));
    if (!loaded) { console.error = realError; console.log(`\nRESULT: ${pass} passed, ${fail} failed`); process.exit(1); }

    await new Promise((r) => setTimeout(r, 400));   // let the init IIFE settle
    console.error = realError;

    console.log('== event wiring ==');
    for (const e of ['MESSAGE_RECEIVED', 'CHAT_CHANGED', 'GENERATION_STARTED', 'MESSAGE_DELETED',
        'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'GENERATION_ENDED']) {
        ok(handlers.has(e), `${e} handler bound`);
    }
    // MESSAGE_UPDATED regressed once by being an else-if on MESSAGE_SWIPED: with both
    // present in event_types, only SWIPED bound and programmatic edits vanished.
    ok(handlers.has('MESSAGE_SWIPED') && handlers.has('MESSAGE_UPDATED'),
        'SWIPED and UPDATED are both bound (neither shadows the other)');

    console.log('== init errors ==');
    const unexpected = errors.filter((e) => !/getElementById|Settings panel failed to load/.test(e));
    ok(unexpected.length === 0, 'no unexpected errors during init' + (unexpected.length ? ' — ' + unexpected[0].slice(0, 160) : ''));
} finally {
    console.error = realError;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log('== v5.82.0: notepad starting-canon doctrine ==');
{
    const SRCW = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    const n = (SRCW.match(/STARTING canon/g) || []).length;
    ok(n === 6, `all six notepad consumers (auditor, editor sys+template, continuity record, transplant, brief dump) carry the starting-canon doctrine (found ${n}, need 6)`);
    ok(SRCW.includes('never a CONTINUITY finding'), 'the continuity auditor is told outgrown opening-state is progression, not a finding');
    const MDW = readFileSync(new URL('./MEMORY_AUDITOR.md', import.meta.url), 'utf8');
    ok(MDW.includes('STARTING canon') && MDW.includes('never a finding'), 'the auditor brief documents the deliberately-static notepad');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('MODULE INTEGRITY FAILED — DO NOT PUSH'); process.exit(1); }
console.log('MODULE INTEGRITY OK ✓');
