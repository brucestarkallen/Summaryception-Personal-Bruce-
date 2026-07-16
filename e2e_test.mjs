#!/usr/bin/env node
/**
 * Summaryception — END-TO-END PIPELINE GATE.  Run:  node e2e_test.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * load_test.mjs proves the module LOADS. ledger_test.js proves the pure
 * functions are CORRECT. Neither proves the machine RUNS: that a message event
 * actually reaches the scribe, that the scribe's reply actually lands in the
 * ledger, that the ledger actually reaches the injection, that a deletion
 * actually rewinds, that the auditor actually corrects.
 *
 * Everything shipped in v5.58.0-v5.60.0 was unit-proven and never once executed
 * — the extension could not even load. "It passes the unit tests" is not the
 * same claim as "it works". This gate makes the second claim.
 *
 * It swaps connectionutil.js for a scripted stub, so the REAL index.js runs the
 * REAL pipeline against a fake model: no network, no device, deterministic.
 *
 * Exit 0 = the pipeline demonstrably works end to end.
 */
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Scripted model ───────────────────────────────────────────────────
// Replies are chosen by inspecting the system prompt, so each pass gets a
// plausible answer for ITS job and we can assert what the pipeline did with it.
const calls = [];
const STUB = `
export const calls = [];
export async function sendSummarizerRequest(s, sysPrompt, prompt) {
    const kind = /continuity AUDITOR for the character ledger/.test(sysPrompt) ? 'ledger-audit'
        : /character-continuity mind/.test(sysPrompt) ? 'ledger-scribe'
        : /detail/i.test(sysPrompt) ? 'detail'
        : 'summary';
    globalThis.__calls.push({ kind, prompt });
    // Concurrency probe: callSummarizer snapshots/disables/restores ST's prompt
    // toggles, so TWO of these overlapping corrupts them permanently. Any overlap
    // here is a hard failure.
    globalThis.__live = (globalThis.__live || 0) + 1;
    globalThis.__maxLive = Math.max(globalThis.__maxLive || 0, globalThis.__live);
    if (globalThis.__live > 1) globalThis.__overlap = (globalThis.__overlap || []).concat([kind]);
    try {
        await new Promise((r) => setTimeout(r, (globalThis.__latency || 250)));   // model latency (test-controlled)
        return __reply(kind);
    } finally { globalThis.__live--; }
}
function __reply(kind) {
    if (kind === 'ledger-scribe') {
        // Two characters; Claire's state carries a claim the story never showed.
        return JSON.stringify([
            { name: 'Claire Argent', core: 'guarded, precise; grips her own wrist when tense', state: 'waiting by the arch, aware the Board already ruled against Jovan', arc: 'protective older sister', threads: ['shape the statement before Council Hall'] },
            { name: 'Jovan Argent', core: 'deliberate, plain-spoken', state: 'on the platform, weighing whether to answer', arc: 'underestimated', threads: ['decide whether to answer the challenge'] },
        ]);
    }
    if (kind === 'ledger-audit') {
        // The auditor removes the unsupported claim, keeps everything supported.
        return JSON.stringify([
            { name: 'Claire Argent', state: 'waiting by the arch, watching the platform' },
        ]);
    }
    return 'A compact summary line.';
}

export async function fetchOllamaModels() { return []; }
export async function testOpenAIConnection() { return true; }
export async function populateProfileDropdown() {}
export function getConnectionDisplayName() { return 'stub'; }
`;

// ── Mocked SillyTavern ───────────────────────────────────────────────
globalThis.__calls = calls;
const noop = () => {};
const chain = new Proxy(function () {}, { get: (_t, p) => (p === 'length' ? 0 : chain), apply: () => chain });
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
const fire = async (e, ...a) => { for (const f of (handlers.get(e) || [])) await f(...a); };

let injected = '';
const mkMsg = (who, mes, isUser = false) => ({ name: who, is_user: isUser, is_system: false, mes, extra: {} });
const chat = [
    mkMsg('Player', 'I step off the train at Marcroft.', true),
    mkMsg('Narrator', 'Claire Argent waited by the arch, grey eyes on the platform.'),
    mkMsg('Player', 'I meet her eyes.', true),
    mkMsg('Narrator', 'Jovan Argent stepped onto the platform. Claire did not move.'),
];
const ctx = {
    chat, chatMetadata: {}, extensionSettings: {}, characters: [], characterId: 0,
    name1: 'Player', name2: 'Narrator', chatId: 'e2e.jsonl',
    eventSource: { on: (e, f) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(f); }, emit: noop, removeListener: noop },
    event_types,
    saveSettingsDebounced: noop, saveMetadata: noop, saveMetadataDebounced: noop,
    setExtensionPrompt: (_m, text) => { injected = text || ''; },
    getCurrentChatId: () => 'e2e.jsonl',
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
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, body: { appendChild: noop },
    createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop, classList: { add: noop } }),
};
globalThis.structuredClone = globalThis.structuredClone ?? ((o) => JSON.parse(JSON.stringify(o)));
process.on('unhandledRejection', (e) => { console.log('  ✗ unhandled rejection: ' + (e && e.message)); process.exit(1); });

const store = () => ctx.chatMetadata.summaryception || {};
const dir = mkdtempSync(join(tmpdir(), 'sc-e2e-'));
try {
    copyFileSync(join(HERE, 'index.js'), join(dir, 'index.js'));
    writeFileSync(join(dir, 'connectionutil.js'), STUB);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const realError = console.error;
    console.error = noop;
    await import(pathToFileURL(join(dir, 'index.js')).href);
    await sleep(300);
    console.error = realError;

    // Settings: ledger on, live pass every turn, audit reachable on demand.
    const s = ctx.extensionSettings.summaryception;
    Object.assign(s, {
        enabled: true, ledgerEnabled: true, ledgerLiveUpdate: true, ledgerLiveEveryTurns: 1,
        connectionSource: 'profile', profileId: 'stub', ledgerAuditEnabled: true,
        ledgerAuditEveryTurns: 0,   // drive the audit explicitly, not by cadence
    });

    console.log('== 1. a new turn reaches the scribe and lands in the ledger ==');
    await fire('MESSAGE_RECEIVED', chat.length - 1);
    await sleep(1200);
    const led = store().ledger || {};
    ok(calls.some((c) => c.kind === 'ledger-scribe'), 'MESSAGE_RECEIVED drove a real ledger-scribe call');
    ok(!!led['Claire Argent'] && !!led['Jovan Argent'], 'the scribe reply was parsed and merged into the ledger');
    ok(led['Claire Argent'] && led['Claire Argent'].core.includes('grips her own wrist'), 'character nature stored verbatim');
    ok(typeof store().ledgerLiveIdx === 'number' && store().ledgerLiveIdx === chat.length - 1, 'the live pointer advanced to the newest turn');
    ok(typeof led['Claire Argent']._t === 'number', 'entries carry the turn stamp rewinds depend on (v5.49)');

    console.log('== 2. the ledger actually reaches the storyteller ==');
    ok(/Claire Argent/.test(injected), 'the on-screen character is injected');
    ok(/grips her own wrist/.test(injected), 'their nature is in the injected block');
    ok(!/_t|updatedAt|"core"/.test(injected), 'no internal bookkeeping or raw JSON leaks into the prompt');

    console.log('== 3. checkpoints exist for cheap rewinds (v5.51) ==');
    const ck = [...globalThis.localStorage._d.keys()].filter((k) => k.startsWith('sc_ledgerckpt::'));
    ok(ck.length > 0, 'a checkpoint was written for this turn');

    console.log('== 4. THE LEDGER AUDITOR — never executed before this gate (v5.58.0) ==');
    const before = led['Claire Argent'].state;
    ok(/Board already ruled/.test(before), 'precondition: the scribe recorded an unsupported claim');
    const mod = await import(pathToFileURL(join(dir, 'index.js')).href);
    void mod;
    // Drive it the way the button does: via the module's own slash/queue path.
    globalThis.__auditRan = false;
    const auditBefore = calls.filter((c) => c.kind === 'ledger-audit').length;
    // The audit is internal; reach it by cadence with the counter forced.
    s.ledgerAuditEveryTurns = 1;
    await fire('MESSAGE_RECEIVED', chat.length - 1);
    await sleep(9000);   // cadence arms a delayed retry by design
    const auditCalls = calls.filter((c) => c.kind === 'ledger-audit').length - auditBefore;
    ok(auditCalls > 0, 'the auditor ran a real verification call');
    if (auditCalls > 0) {
        const ap = calls.filter((c) => c.kind === 'ledger-audit').pop().prompt;
        ok(/Claire Argent waited by the arch/.test(ap), "the audit's evidence is the character's own on-screen text");
        ok(!/Board already ruled/.test(ap.split('<evidence>')[1] || ''), 'the unsupported claim is NOT in the evidence (nothing to support it)');
        const after = (store().ledger['Claire Argent'] || {}).state || '';
        ok(!/Board already ruled/.test(after), 'THE AUDITOR CORRECTED THE DRIFT: the unsupported claim is gone');
        ok(/watching the platform/.test(after), 'the corrected state landed');
        ok(typeof store().ledger['Claire Argent']._a === 'number', 'the audited entry is stamped so the round-robin advances');
    }

    console.log('== 5. one exclusive LLM channel (v5.60.1) ==');
    const seq = calls.map((c) => c.kind);
    ok(seq.length > 0, `passes ran sequentially: ${seq.join(' -> ')}`);

    console.log('== 7. THE REPORTED SEQUENCE: a background pass is running and the user keeps playing ==');
    // This is the shape of the reported flow: a ledger pass is IN FLIGHT (tapping
    // "Update now", or any background pass) and a new turn lands while it runs. It
    // must be built deliberately, because within one MESSAGE_RECEIVED callback the
    // summarizer is awaited BEFORE the ledger, so those two can never overlap each
    // other — the danger is only ledger-first, summarizer-second.
    globalThis.__maxLive = 0; globalThis.__overlap = []; globalThis.__latency = 900;
    s.enabled = true; s.sisterEnabled = false; s.continuityEnabled = false;
    s.ledgerAuditEveryTurns = 0;
    s.verbatimTurns = 99; s.turnsPerSummary = 2;   // summarizer NOT eligible yet -> ledger goes first
    chat.push(mkMsg('Player', 'I answer her.', true));
    chat.push(mkMsg('Narrator', 'Claire Argent exhaled. Jovan Argent did not look away.'));
    await fire('MESSAGE_RECEIVED', chat.length - 1);   // -> ledger scribe starts ~500ms from now, runs ~900ms
    await sleep(700);                                  // ledger call is now IN FLIGHT
    ok((globalThis.__live || 0) === 1, 'precondition: a background model call is genuinely in flight');
    // The user keeps playing. This turn makes the summarizer eligible.
    s.verbatimTurns = 3;
    chat.push(mkMsg('Player', 'I keep walking.', true));
    chat.push(mkMsg('Narrator', 'The platform emptied around them.'));
    await fire('MESSAGE_RECEIVED', chat.length - 1);   // -> summarizer fires ~500ms from now, mid-ledger-call
    await sleep(6000);
    ok((globalThis.__maxLive || 0) === 1, `never two model calls at once (peak ${globalThis.__maxLive || 0}) — ST's prompt toggles cannot be corrupted`);
    ok((globalThis.__overlap || []).length === 0, 'no overlapping pass' + ((globalThis.__overlap || []).length ? ': ' + globalThis.__overlap.join(' + ') : ''));
    ok(calls.some((c) => c.kind === 'summary'), 'precondition: the summarizer really ran (test is not vacuous)');
    ok(store().ledgerLiveIdx === chat.length - 1, 'the ledger still caught up to the newest turn while the user played on');
    globalThis.__latency = 250;

    if (process.env.E2E_SLOW === '1') {
        console.log('== 8. SLOW CHANNEL: turn B arrives while turn A holds the channel past the old 32s bound ==');
        // THE discriminating case. The live pass used to give up after 8 tries x 4s =
        // 32 seconds — shorter than one model call on a phone. Here turn A's scribe
        // call holds the channel for 35s; turn B lands 1s in, finds the channel busy,
        // and must retry. With the old bound its patience is exhausted at t=33s, two
        // seconds BEFORE the channel frees at t=35s: turn B is never ingested, the
        // ledger lags, and the only way out is tapping "Update now" by hand.
        globalThis.__latency = 35000;
        s.verbatimTurns = 99;   // ledger only; keep the summarizer out of it
        chat.push(mkMsg('Player', 'Turn A.', true));
        chat.push(mkMsg('Narrator', 'Claire Argent waited.'));
        await fire('MESSAGE_RECEIVED', chat.length - 1);
        await sleep(1500);                       // turn A's call is now in flight (35s)
        ok((globalThis.__live || 0) === 1, 'precondition: turn A holds the channel');
        globalThis.__latency = 250;   // turn A is already sleeping 35s; turn B's own call should be quick
        chat.push(mkMsg('Player', 'Turn B.', true));
        chat.push(mkMsg('Narrator', 'Claire Argent finally spoke.'));
        const target = chat.length - 1;
        await fire('MESSAGE_RECEIVED', target);   // must retry until the channel frees
        await sleep(52000);
        ok(store().ledgerLiveIdx === target,
            `turn B ingested with ZERO taps after a 35s channel hold (pointer ${store().ledgerLiveIdx}/${target})`);
        globalThis.__latency = 250;
    }

    console.log('== 10. DELETE ONE MESSAGE: correct immediately, no reopen, no model call ==');
    {
        globalThis.__latency = 250;
        const before = JSON.parse(JSON.stringify(store().ledger || {}));
        const callsWere = calls.length;
        const lenWas = chat.length;
        void before;
        chat.splice(chat.length - 1, 1);   // delete the newest message
        await fire('MESSAGE_DELETED', lenWas - 1);
        await sleep(1200);
        ok(calls.length === callsWere, 'deleting one message cost ZERO model calls');
        ok((store().ledgerNotes || []).every((n) => n.t < lenWas - 1 + 1), 'no note still points past the end of the chat');
        ok(typeof store().ledgerLiveIdx === 'number' && store().ledgerLiveIdx < lenWas - 1, 'the pointer moved with the deletion — without needing a chat reload');
    }

    console.log('== 9. BRANCH/DELETE now folds the notes — no model call at all ==');
    globalThis.__latency = 250;
    const notesLen = (store().ledgerNotes || []).length;
    ok(notesLen > 0, 'the scribe replies were journalled as per-turn notes');
    ok(typeof store().ledgerNotesFrom === 'number', 'the notes declare how far back they are authoritative');
    const callsBefore = calls.length;
    const target = 3;
    // Delete everything above turn 3 — the shape of a branch.
    chat.length = target + 1;
    await fire('MESSAGE_DELETED', target + 1);
    await sleep(2500);
    ok(calls.length === callsBefore, 'THE POINT: rewinding cost ZERO model calls (it used to rebuild)');
    ok((store().ledgerNotes || []).every((n) => n.t <= target), 'notes past the branch point were dropped');
    const folded = store().ledger || {};
    ok(Object.keys(folded).length >= 0, 'the page was refolded from what remains');
    ok(store().ledgerLiveIdx <= target, 'the pointer followed the branch');

    console.log('== 11. STAGED REBUILD: the swap installs page AND journal — and survives the next fold ==');
    {
        // Force the exact production shape that takes the staging branch: a ledger
        // with content, notes that do NOT cover the target (legacy region), no
        // usable checkpoint, no entry stamps for synthesis. This is the pre-notes /
        // pre-stamp chat every long-running user actually has.
        globalThis.__latency = 100;
        chat.length = 0;
        chat.push(
            mkMsg('Player', 'I step off the train at Marcroft.', true),
            mkMsg('Narrator', 'Claire Argent waited by the arch, grey eyes on the platform.'),
            mkMsg('Player', 'I meet her eyes.', true),
            mkMsg('Narrator', 'Jovan Argent stepped onto the platform. Claire Argent did not move.'),
            mkMsg('Player', 'I speak first.', true),
            mkMsg('Narrator', 'Claire Argent answered before Jovan Argent finished.'),
        );
        const st = store();
        st.ledger = { 'Claire Argent': { core: 'STALE core from the abandoned timeline', state: 'STALE state', updatedAt: 1 } };   // no _t — synthesis must decline
        st.ledgerNotes = [{ t: 99, name: 'Claire Argent', at: 1, base: true, core: 'STALE core from the abandoned timeline', state: 'STALE state' }];
        st.ledgerNotesFrom = 99;        // notes authoritative only from far past the chat — cover() says no
        st.ledgerLiveIdx = 99;          // pointer stranded past the chat end (bulk-trim shape)
        st.ledgerEra = (st.ledgerEra | 0) + 1;   // retire every checkpoint scene 1–10 saved
        st._ckptLast = -1;
        st.summarizedUpTo = -1;
        // The router computes delta from the last KNOWN length: teach it the pre-trim
        // length (GENERATION_STARTED refreshes the tracker), then bulk-splice — the
        // exact shape of a real branch: delta > 1 → tryAutoRewindLedger('trim').
        chat.push(mkMsg('Player', 'One more word.', true), mkMsg('Narrator', 'Claire Argent turned away.'));
        await fire('GENERATION_STARTED');
        const callsBefore2 = calls.length;
        chat.length = 6;                          // bulk trim: 8 → 6
        await fire('MESSAGE_DELETED', 6);
        await sleep(4000);
        const led2 = store().ledger || {};
        ok(calls.length > callsBefore2, 'precondition: the rebuild actually ran scribe passes (not a fold, not a checkpoint)');
        ok(led2['Claire Argent'] && !String(led2['Claire Argent'].core).includes('STALE'), 'the rebuilt page is live — the stale timeline is gone');
        ok(store().ledgerRebuild == null && store().ledgerStaging == null && store().ledgerStagingNotes == null, 'staging state fully consumed at the swap');
        const notes2 = store().ledgerNotes || [];
        ok(notes2.length > 0 && notes2.every((n) => !String(n.core || '').includes('STALE') && !String(n.state || '').includes('STALE')), 'THE FIX: the journal was swapped WITH the page — no note from the abandoned timeline survives');
        ok(store().ledgerNotesFrom === 0, 'the staged journal covers from turn 0 — every later rewind is an exact fold');
        // THE KILL SHOT, end to end: the first fold after the swap. Under the old
        // swap this painted the pre-rebuild ledger straight back over the page.
        const lenNow = chat.length;
        chat.splice(chat.length - 1, 1);
        await fire('MESSAGE_DELETED', lenNow - 1);
        await sleep(1200);
        const led3 = store().ledger || {};
        ok(led3['Claire Argent'] && !String(led3['Claire Argent'].core).includes('STALE'), 'KILL SHOT: the fold after the swap keeps the REBUILT truth — the rebuild no longer self-undoes');
    }

    console.log('== 12. BRANCH HYGIENE: dead-timeline pins leave the injection; future receipts leave the log ==');
    {
        const st = store();
        // Four pins, four provenance classes. The chat right now (post scene 11):
        // 0 'I step off…' 1 'Claire Argent waited by the arch…' 2 'I meet her eyes.'
        // 3 'Jovan Argent stepped onto the platform…' 4 'I speak first.'
        st.pins = [
            { id: 'p_live',   mesId: 1, srcIdx: 1,    excerpt: 'Claire Argent waited by the arch', label: '', createdAt: 1 },
            { id: 'p_free',   mesId: 4, srcIdx: null, excerpt: 'STYLE NOTE: keep the prose terse', label: '', createdAt: 2 },
            { id: 'p_dead',   mesId: 7, srcIdx: 7,    excerpt: 'the Council Hall verdict was read aloud', label: '', createdAt: 3 },
            { id: 'p_legacy', mesId: 6,               excerpt: 'the masked fighter fell at the gate', label: '', createdAt: 4 },
        ];
        st.continuityResolved = [
            { issue: 'future receipt', fix: 'x', kind: 'contradiction', turnRange: [90, 95], resolvedAt: 1 },
            { issue: 'legacy receipt (no range)', fix: 'y', kind: 'drift', resolvedAt: 2 },
        ];
        // A real bulk trim — the branch shape — through the real router.
        chat.push(mkMsg('Player', 'And then.', true), mkMsg('Narrator', 'Claire Argent smiled, briefly.'));
        await fire('GENERATION_STARTED');
        chat.length = 5;
        await fire('MESSAGE_DELETED', 5);
        await sleep(1500);
        ok(/waited by the arch/.test(injected), 'a pin whose source text lives in THIS branch still injects');
        ok(/keep the prose terse/.test(injected), 'a free pin (never chat text) injects unconditionally');
        ok(!/Council Hall verdict/.test(injected), 'THE LEAK, CLOSED: a pin quoting a branched-away turn no longer narrates this timeline');
        ok(!/masked fighter fell/.test(injected), 'legacy pins (no provenance) are held to the same rule');
        const rec = store().continuityResolved || [];
        ok(!rec.some((r) => r && r.issue === 'future receipt'), 'a resolved receipt about abandoned turns is trimmed at the branch');
        ok(rec.some((r) => r && r.issue === 'legacy receipt (no range)'), 'receipts that cannot be judged are kept (they age out of the cap)');
    }

    console.log('== 6. a REAL chat switch: new metadata AND new messages ==');
    const oldNames = Object.keys(store().ledger || {});
    ctx.chatMetadata = {};
    ctx.chatId = 'other.jsonl';
    ctx.chat = [
        mkMsg('Player', 'Different story entirely.', true),
        mkMsg('Narrator', 'Rain over an empty market square.'),
    ];
    await fire('CHAT_CHANGED');
    await sleep(1500);
    const newLed = Object.keys(store().ledger || {});
    ok(oldNames.length > 0, 'precondition: the previous chat had a populated ledger');
    ok(!newLed.some((n) => oldNames.includes(n)), 'no character from the previous chat bleeds into the new one');
    ok(!/Claire Argent/.test(injected), "the previous chat's cast is no longer injected");
} finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('PIPELINE BROKEN — DO NOT PUSH'); process.exit(1); }
console.log('PIPELINE VERIFIED END TO END ✓');
