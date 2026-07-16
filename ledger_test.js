'use strict';
// Proof harness for the Character Ledger. Extracts the REAL functions from
// index.js (line-based top-level extraction — no reimplementation) and exercises
// them with stubs for getSettings/getChatStore/SillyTavern. Fails loudly.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.js', 'utf8');
const lines = src.split('\n');

// Extract a top-level `function NAME(` or `const NAME` declaration by grabbing
// lines from its header until the next top-level declaration/comment. All target
// functions are column-0 declarations separated by comments, so this sidesteps
// brace/regex/template-literal counting entirely.
function extractTopLevel(name) {
    const headerRe = new RegExp('^(?:async function|function|const|let|var)\\s+' + name + '\\b');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (headerRe.test(lines[i])) { start = i; break; }
    }
    if (start === -1) throw new Error('Could not find declaration: ' + name);
    const stopRe = /^(?:async function|function|const|let|var)\s+\w|^\/\//;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (stopRe.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join('\n');
}

const SRC_FULL = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
const names = ['stripMetaBlocks', 'buildPassageFromRange', '_ledgerDroppingPast', '_editRewindDecision', '_ledgerMissingCore', '_missingCoreNotice', '_synthesizeCheckpoint', 'computeLedgerCast', 'reindexAfterDeletion', '_computeLiveLedgerRange', '_NOTES_SOFT_CAP', '_NOTES_KEEP_TAIL', 'foldLedgerNotes', 'ledgerHistoryFor', '_histOpen', '_historyHtml', 'escapeHtml', 'notesCover', 'ensureLedgerNotes', 'appendLedgerNotes', 'rewindLedgerFromNotes', 'compactLedgerNotes', 'stripLeadingLabel', '_ledgerAuditTargets', '_pickEvidenceIndices', 'buildLedgerAuditEvidence', '_ambiguousTokens', '_ESC_RE', '_escapeRegex', 'characterAliases', 'wordPresentInText',
    'formatLedgerEntry', 'buildCharacterBlock', 'serializeLedgerForScribe',
    'resolveLedgerKey', '_LEDGER_LABEL_RE', 'stripLeadingLabel', 'mergeLedgerDeltas', 'subst', '_storeHasContent', '_computeLiveLedgerRange', '_selectRoster', '_composeRoster', 'getLedgerPins', '_pickCheckpoint', '_computeReplayChunks', '_selectCheckpointKeeps', '_contiguousRanges', '_selectStorageEvictions',
    'normalizeContinuityOutput', '_continuitySig', 'mergeContinuityFlags', 'reconcileSnippetFlags', '_findSnippetByTurnRange', '_findSnippetsCovering'];

const body = names.map(extractTopLevel).join('\n\n');

const sandbox = `
let __settings = {};
let __store = { ledger: {} };
let __chat = [];
let _rosterTick = 0;
function getSettings(){ return __settings; }
function getChatStore(){ return __store; }
function log(){}
const document = { createElement(){ let _v = ''; return { set textContent(x){ _v = String(x); }, get innerHTML(){ return _v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); } }; } };
function toastr_noop(){}
const SillyTavern = { getContext(){ return { chat: __chat }; } };
${body}
return {
  __setSettings: (v)=>{ __settings = v; },
  __setStore:    (v)=>{ __store = v; },
  __setChat:     (v)=>{ __chat = v; },
  stripMetaBlocks, buildPassageFromRange, _ledgerDroppingPast, _editRewindDecision, _ledgerMissingCore, _missingCoreNotice, _synthesizeCheckpoint, computeLedgerCast, reindexAfterDeletion, _computeLiveLedgerRange, foldLedgerNotes, ledgerHistoryFor, _historyHtml, _histOpen, notesCover, ensureLedgerNotes, appendLedgerNotes, rewindLedgerFromNotes, compactLedgerNotes, _ledgerAuditTargets, _pickEvidenceIndices, buildLedgerAuditEvidence, _ambiguousTokens,
  _escapeRegex, characterAliases, wordPresentInText, formatLedgerEntry,
  buildCharacterBlock, serializeLedgerForScribe, resolveLedgerKey, mergeLedgerDeltas,
  subst, _storeHasContent, _computeLiveLedgerRange, _selectRoster, _composeRoster, _pickCheckpoint, _computeReplayChunks, _selectCheckpointKeeps, _contiguousRanges, _selectStorageEvictions,
  normalizeContinuityOutput, _continuitySig, mergeContinuityFlags, reconcileSnippetFlags, _findSnippetByTurnRange, _findSnippetsCovering,
};
`;
const L = new Function(sandbox)();

// ── tiny assert framework ──
let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) { pass++; } else { fail++; fails.push(msg); console.log('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + `  [got ${JSON.stringify(a)} want ${JSON.stringify(b)}]`); }
function section(t) { console.log('\n== ' + t + ' =='); }

const defaultSettings = {
    ledgerEnabled: true, ledgerActiveWindow: 12, ledgerMaxActive: 6,
    ledgerMaxCharsPerChar: 600, ledgerContextMaxChars: 6000,
    ledgerInjectTemplate: '\n\n<characters>\nCanon:\n{{characters}}\n</characters>\n',
};
function freshStore(ledger) { L.__setStore({ ledger: ledger || {} }); return () => (new Function('return 0'))(); }
function getLedger() { return JSON.parse(JSON.stringify(currentStore().ledger)); }
let _store;
function currentStore() { return _store; }
function setStore(ledger) { _store = { ledger: ledger || {} }; L.__setStore(_store); }

// ─────────────────────────────────────────────────────────────────────
section('resolveLedgerKey');
{
    const led = { 'Mara': {}, 'Stella Vermillion': {} };
    eq(L.resolveLedgerKey(led, 'Mara'), 'Mara', 'exact match');
    eq(L.resolveLedgerKey(led, 'mara'), 'Mara', 'case-insensitive match resolves to existing key');
    eq(L.resolveLedgerKey(led, 'MARA'), 'Mara', 'uppercase resolves');
    eq(L.resolveLedgerKey(led, 'Alexia'), 'Alexia', 'no match returns input unchanged');
    eq(L.resolveLedgerKey(led, 'stella vermillion'), 'Stella Vermillion', 'multi-word case-insensitive');
}

// ─────────────────────────────────────────────────────────────────────
section('mergeLedgerDeltas — partial-field merge semantics');
{
    setStore({});
    let n = L.mergeLedgerDeltas([{ name: 'Mara', core: 'terse; never shouts; deflects with sarcasm', state: 'flustered', threads: ['wrong-name slip unaddressed'] }]);
    eq(n, 1, 'fresh insert reports 1 changed');
    let m = currentStore().ledger.Mara;
    eq(m.core, 'terse; never shouts; deflects with sarcasm', 'core stored');
    eq(m.state, 'flustered', 'state stored');
    eq(m.threads, ['wrong-name slip unaddressed'], 'threads stored');
    ok(typeof m.updatedAt === 'number' && m.updatedAt > 0, 'updatedAt stamped');

    // Omitted field kept; present field replaced.
    L.mergeLedgerDeltas([{ name: 'Mara', state: 'calmer, guard back up' }]);
    m = currentStore().ledger.Mara;
    eq(m.core, 'terse; never shouts; deflects with sarcasm', 'core UNCHANGED when omitted');
    eq(m.state, 'calmer, guard back up', 'state REPLACED when present');
    eq(m.threads, ['wrong-name slip unaddressed'], 'threads UNCHANGED when omitted');

    // threads present replaces the whole list.
    L.mergeLedgerDeltas([{ name: 'Mara', threads: ['owes MC an apology', 'suspicious of Alexia'] }]);
    eq(currentStore().ledger.Mara.threads, ['owes MC an apology', 'suspicious of Alexia'], 'threads REPLACED (full list) when present');

    // threads:[] clears.
    L.mergeLedgerDeltas([{ name: 'Mara', threads: [] }]);
    eq(currentStore().ledger.Mara.threads, [], 'threads:[] CLEARS the list');
    eq(currentStore().ledger.Mara.core, 'terse; never shouts; deflects with sarcasm', 'core survives a threads-only clear');

    // arc update.
    L.mergeLedgerDeltas([{ name: 'Mara', arc: 'thawing toward MC despite herself' }]);
    eq(currentStore().ledger.Mara.arc, 'thawing toward MC despite herself', 'arc set independently');
}

section('mergeLedgerDeltas — case-insensitive key (no duplicate entries)');
{
    setStore({ 'Mara': { core: 'x', updatedAt: 1 } });
    L.mergeLedgerDeltas([{ name: 'mara', state: 'y' }]);
    eq(Object.keys(currentStore().ledger), ['Mara'], 'lowercase delta updates existing key, no split');
    eq(currentStore().ledger.Mara.state, 'y', 'state applied to canonical key');
    eq(currentStore().ledger.Mara.core, 'x', 'core preserved on canonical key');
}

section('mergeLedgerDeltas — malformed / empty rejected');
{
    setStore({ 'Keep': { core: 'safe', updatedAt: 5 } });
    const before = getLedger();
    let n = L.mergeLedgerDeltas([null, undefined, {}, 42, 'str', [], { name: '' }, { name: '   ' }, { core: 'no name' }, { name: 'Bob', core: '   ', state: '' }]);
    eq(n, 0, 'no valid deltas → 0 changed');
    eq(currentStore().ledger, before, 'ledger byte-identical after all-garbage merge');
    ok(!('Bob' in currentStore().ledger), 'character with only whitespace fields not created');
    // non-array input
    eq(L.mergeLedgerDeltas(null), 0, 'null input → 0');
    eq(L.mergeLedgerDeltas({ name: 'X' }), 0, 'non-array input → 0');
}

section('mergeLedgerDeltas — threads sanitised');
{
    setStore({});
    L.mergeLedgerDeltas([{ name: 'Cid', threads: ['ok', '', '   ', 42, null, undefined, 'two', '  trim me  '] }]);
    eq(currentStore().ledger.Cid.threads, ['ok', 'two', 'trim me'], 'threads filters non-strings/blanks and trims');
}

// ─────────────────────────────────────────────────────────────────────
section('characterAliases — given & surname tokens');
{
    eq(L.characterAliases('Mara'), ['Mara'], 'single token → just full');
    eq(L.characterAliases('Stella Vermillion'), ['Stella Vermillion', 'Stella', 'Vermillion'], 'first (given) + last (surname) both captured');
    eq(L.characterAliases('Alexia Valois'), ['Alexia Valois', 'Alexia', 'Valois'], 'two-token name');
    eq(L.characterAliases('Jo Vo'), ['Jo Vo'], 'tokens <=2 chars excluded (only full kept)');
    eq(L.characterAliases('Honami Ichinose'), ['Honami Ichinose', 'Honami', 'Ichinose'], 'romaji name');
    eq(L.characterAliases('  '), [], 'blank → empty');
    // 3-token: first + last, middle skipped if short
    eq(L.characterAliases('Alexia von Valois'), ['Alexia von Valois', 'Alexia', 'Valois'], '3-token uses first+last, short middle skipped');
}

section('wordPresentInText — whole-word, no substrings');
{
    ok(L.wordPresentInText('stella walked into room 313', 'stella'), 'matches present given name');
    ok(!L.wordPresentInText('the constellation shimmered', 'stella'), 'NO substring match (stella in constellation)');
    ok(L.wordPresentInText('"vermillion, report," she said', 'vermillion'), 'matches with adjacent punctuation');
    ok(!L.wordPresentInText('he announced the plan', 'ann'), 'NO substring (ann in announced)');
    ok(L.wordPresentInText('stella vermillion arrived', 'stella vermillion'), 'multi-word phrase match');
    ok(!L.wordPresentInText('stella arrived', 'stella vermillion'), 'phrase absent when only given name present');
    ok(!L.wordPresentInText('anything', 'a'), 'needle <2 chars → false');
}

// ─────────────────────────────────────────────────────────────────────
section('formatLedgerEntry — format, order, periods');
{
    const e = { core: 'terse; never shouts', state: 'flustered', threads: ['a', 'b'], arc: 'warming' };
    eq(L.formatLedgerEntry('Mara', e, 600), 'Mara — Nature: terse; never shouts. Now: flustered. Open: a; b. Arc: warming.', 'full entry, correct order & single periods');
    eq(L.formatLedgerEntry('Bob', { core: 'stoic' }, 600), 'Bob — Nature: stoic.', 'partial (core only)');
    eq(L.formatLedgerEntry('X', {}, 600), '', 'empty entry → empty string');
    eq(L.formatLedgerEntry('X', { threads: [] }, 600), '', 'only empty threads → empty string');
    eq(L.formatLedgerEntry('X', { core: 'a', threads: [] }, 600), 'X — Nature: a.', 'empty threads produces no Open segment');
    // double-period avoidance
    eq(L.formatLedgerEntry('Y', { core: 'ends with period.', state: 'also.' }, 600), 'Y — Nature: ends with period. Now: also.', 'trailing periods in fields do not double up');
    // whitespace normalisation
    eq(L.formatLedgerEntry('Z', { core: 'multi\n  line\ttext' }, 600), 'Z — Nature: multi line text.', 'internal whitespace collapsed');
}

section('formatLedgerEntry — truncation trims Arc first, respects cap');
{
    const e = {
        core: 'CORE_' + 'x'.repeat(40),
        state: 'STATE_' + 'y'.repeat(40),
        threads: ['THREAD_' + 'z'.repeat(30)],
        arc: 'ARC_' + 'w'.repeat(200),
    };
    const cap = 140;
    const out = L.formatLedgerEntry('Nm', e, cap);
    ok(out.length <= cap, `output within cap (${out.length} <= ${cap})`);
    ok(out.endsWith('…'), 'truncated output ends with ellipsis');
    ok(out.includes('Nature:'), 'Nature (highest priority) retained under truncation');
    ok(!out.includes('w'.repeat(200)), 'Arc (lowest priority) is the field cut');
}

// ─────────────────────────────────────────────────────────────────────
section('serializeLedgerForScribe — ordering, budget, empty');
{
    eq(L.serializeLedgerForScribe({}, 6000), '(empty — no characters recorded yet)', 'empty ledger message');
    eq(L.serializeLedgerForScribe(null, 6000), '(empty — no characters recorded yet)', 'null ledger message');
    const led = {
        'Old': { core: 'a', updatedAt: 1 },
        'New': { core: 'b', updatedAt: 100 },
        'Mid': { core: 'c', updatedAt: 50 },
    };
    const out = L.serializeLedgerForScribe(led, 6000);
    const order = ['New', 'Mid', 'Old'].map(n => out.indexOf(n));
    ok(order[0] < order[1] && order[1] < order[2] && order[0] !== -1, 'most-recently-updated first');
    // budget: tiny budget keeps at least the newest and notes omissions
    const tiny = L.serializeLedgerForScribe(led, 12);
    ok(tiny.includes('New'), 'newest kept even under tiny budget');
    ok(/omitted for brevity/.test(tiny), 'omission notice present when truncated by budget');
}

// ─────────────────────────────────────────────────────────────────────
section('buildCharacterBlock — active-cast detection & caps (end-to-end injection)');
{
    L.__setSettings(Object.assign({}, defaultSettings, { ledgerInjectRoster: false }));
    setStore({
        'Stella Vermillion': { core: 'fiery; proud', state: 'annoyed', threads: ['rivalry with MC'], updatedAt: 30 },
        'Alexia Valois': { core: 'analytical; cool', state: 'curious', updatedAt: 20 },
        'Ghost McAbsent': { core: 'never here', state: 'offscreen', updatedAt: 99 },
    });
    // Recent chat mentions Stella (given) and Valois (surname), NOT the ghost.
    L.__setChat([
        { mes: 'The corridor was quiet.' },
        { mes: 'Stella crossed her arms as Valois studied the board.' },
        { mes: 'MC hesitated.' },
    ]);
    const block = L.buildCharacterBlock();
    ok(block.includes('Stella Vermillion'), 'active character (given-name hit) injected');
    ok(block.includes('Alexia Valois'), 'active character (surname hit) injected');
    ok(!block.includes('Ghost McAbsent'), 'off-screen character NOT injected (even though most-recently-updated)');
    ok(block.includes('<characters>'), 'wrapped in template');
    ok(block.includes('rivalry with MC'), 'threads rendered in injection');

    // maxActive cap
    const s2 = Object.assign({}, defaultSettings, { ledgerMaxActive: 1, ledgerInjectRoster: false });
    L.__setSettings(s2);
    const capped = L.buildCharacterBlock();
    const hasStella = capped.includes('Stella'), hasAlexia = capped.includes('Alexia');
    ok((hasStella ? 1 : 0) + (hasAlexia ? 1 : 0) === 1, 'maxActive=1 injects exactly one character');

    // disabled → empty
    L.__setSettings(Object.assign({}, defaultSettings, { ledgerEnabled: false }));
    eq(L.buildCharacterBlock(), '', 'ledgerEnabled=false → empty block');

    // a ledger character OFF-screen → roster keeps them present (identity only)
    L.__setSettings(Object.assign({}, defaultSettings));
    setStore({ 'Stella': { core: 'proud knight; blunt but loyal', state: 'anxious and pacing', updatedAt: 3 } });
    L.__setChat([{ mes: 'nobody named here at all' }]);
    {
        const b = L.buildCharacterBlock();
        ok(b.includes('Stella'), 'off-screen ledger character still injected via roster');
        ok(b.includes('Other people in this world'), 'roster header present for off-screen cast');
        ok(!b.includes('anxious'), 'roster is identity-only — off-screen volatile state NOT injected');
    }

    // roster OFF + no active cast → empty
    L.__setSettings(Object.assign({}, defaultSettings, { ledgerInjectRoster: false }));
    setStore({ 'Stella': { core: 'x', updatedAt: 1 } });
    L.__setChat([{ mes: 'nobody named here at all' }]);
    eq(L.buildCharacterBlock(), '', 'roster off + no on-screen character → empty block');

    // empty ledger → empty
    setStore({});
    L.__setChat([{ mes: 'Stella here' }]);
    eq(L.buildCharacterBlock(), '', 'empty ledger → empty block');
}

section('buildCharacterBlock — the tsundere scenario (regression for the reported bug)');
{
    // Mira is flustered with an unresolved wrong-name thread and a core that
    // forbids outbursts. As long as she is on screen, her anchor must inject.
    L.__setSettings(Object.assign({}, defaultSettings));
    setStore({
        'Mira': {
            core: 'cynical, guarded tsundere; masks embarrassment with clipped sarcasm; NEVER raises her voice',
            state: 'still rattled after MC called her the wrong name; overcompensating with extra bite',
            threads: ['wrong-name slip unaddressed — waiting to see if MC notices'],
            updatedAt: 10,
        },
    });
    L.__setChat([{ mes: 'Mira looked away, jaw tight.' }, { mes: 'MC said something.' }]);
    const b = L.buildCharacterBlock();
    ok(b.includes('NEVER raises her voice'), 'behavioral anchor (no-outburst core) present in injection');
    ok(b.includes('still rattled'), 'volatile state persists into the injection');
    ok(b.includes('wrong-name slip unaddressed'), 'open thread kept alive until story resolves it');
}

// ─────────────────────────────────────────────────────────────────────
section('_computeLiveLedgerRange — live-pass window');
{
    eq(L._computeLiveLedgerRange(-1, -1, 5), [0, 5], 'fresh: cover turns 0..latest');
    eq(L._computeLiveLedgerRange(-1, 5, 5), null, 'caught up: nothing new');
    eq(L._computeLiveLedgerRange(-1, 3, 6), [4, 6], 'advance: only new turns since pointer');
    eq(L._computeLiveLedgerRange(10, 3, 15), [11, 15], 'skips summarized turns (start = summarizedUpTo+1)');
    eq(L._computeLiveLedgerRange(10, 12, 15), [13, 15], 'pointer ahead of summarized: continue from pointer');
    eq(L._computeLiveLedgerRange(2, 99, 5), [3, 5], 'stale-high pointer (post-deletion) resyncs to summarized+1');
    eq(L._computeLiveLedgerRange(2, 99, 1), null, 'stale-high pointer, chat shorter than summarized: nothing');
    eq(L._computeLiveLedgerRange(-1, -1, -1), null, 'no turns yet');
}

// ─────────────────────────────────────────────────────────────────────
section('buildCharacterBlock — roster (off-screen cast never vanishes)');
{
    L.__setSettings(Object.assign({}, defaultSettings));
    setStore({
        'Mira': { core: 'guarded tsundere; clipped sarcasm', state: 'flustered', updatedAt: 30 },
        'Professor Halden': { core: 'stern academy mentor; speaks in measured warnings', state: 'absent from the room', updatedAt: 5 },
        'Kai': { core: 'reckless rival; goads everyone', state: 'went home early', updatedAt: 8 },
    });
    L.__setChat([{ mes: 'Mira glared across the courtyard.' }]);
    const b = L.buildCharacterBlock();
    ok(b.includes('flustered'), 'on-screen character gets a FULL card (volatile state present)');
    ok(b.includes('Professor Halden'), 'off-screen professor kept alive in the roster');
    ok(b.includes('Kai'), 'off-screen rival kept alive in the roster');
    ok(!b.includes('absent from the room') && !b.includes('went home early'), 'roster entries are identity-only, not volatile state');
    ok(b.indexOf('Mira') < b.indexOf('Other people in this world'), 'active full cards come before the roster');
    // roster respects the cap
    L.__setSettings(Object.assign({}, defaultSettings, { ledgerRosterMax: 1 }));
    const b2 = L.buildCharacterBlock();
    const inRoster = (b2.match(/;/g) || []).length;
    ok(b2.includes('Other people in this world'), 'roster still present at cap=1');
}

// ─────────────────────────────────────────────────────────────────────
section('_selectRoster — capped rotating roster');
{
    const cast = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];   // most-recent first
    eq(L._selectRoster(['A', 'B', 'C'], 6, 0), ['A', 'B', 'C'], 'cast <= cap: show everyone (no rotation)');
    eq(L._selectRoster([], 6, 0), [], 'empty cast → empty');
    eq(L._selectRoster(['A', 'B'], 0, 5), [], 'cap 0 → empty');
    // cast > cap: warm = ceil(cap/2) anchored, cold rotates
    eq(L._selectRoster(cast, 6, 0), ['A', 'B', 'C', 'D', 'E', 'F'], 'tick 0: warm A,B,C + cold D,E,F');
    eq(L._selectRoster(cast, 6, 1), ['A', 'B', 'C', 'E', 'F', 'G'], 'tick 1: cold window advances to E,F,G');
    eq(L._selectRoster(cast, 6, 2), ['A', 'B', 'C', 'F', 'G', 'H'], 'tick 2: cold window advances to F,G,H');
    const t0 = L._selectRoster(cast, 6, 0), t1 = L._selectRoster(cast, 6, 1), t2 = L._selectRoster(cast, 6, 2);
    ok(['A', 'B', 'C'].every(n => t0.includes(n) && t1.includes(n) && t2.includes(n)), 'warm (recent) anchored every tick');
    ok(new Set(t1).size === t1.length, 'no duplicate entries in a pick');
    const seen = new Set();
    for (let k = 0; k < 5; k++) L._selectRoster(cast, 6, k).forEach(n => seen.add(n));
    ok(['D', 'E', 'F', 'G', 'H'].every(n => seen.has(n)), 'all cold characters cycle through within a full rotation');
    // tick wraps cleanly (no crash / stable set) at large tick
    eq(L._selectRoster(cast, 6, 5), L._selectRoster(cast, 6, 0), 'tick wraps at coldPool length (5) back to start');
}

// ─────────────────────────────────────────────────────────────────────
section('_composeRoster — pins: always present, uncapped, no rotation, no dup');
{
    const cast = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];   // off-screen, most-recent first
    eq(L._composeRoster(cast, [], 6, 0, true), L._selectRoster(cast, 6, 0), 'no pins: identical to plain rotation');
    // pin a cold character rotation would NOT pick at tick 0 → still present, and first
    const r = L._composeRoster(cast, ['H'], 6, 0, true);
    ok(r.includes('H'), 'pinned cold character present even when rotation would skip it');
    ok(r[0] === 'H', 'pinned characters listed first');
    ok(new Set(r).size === r.length, 'no duplicate entries');
    // pin a character rotation WOULD also pick (D at tick 0) → appears exactly once
    const r2 = L._composeRoster(cast, ['D'], 6, 0, true);
    ok(r2.filter(n => n === 'D').length === 1, 'pinned + rotation-picked character appears exactly once (no dup)');
    // pins are uncapped: three pins under a cap of 2 → all three still present
    const r3 = L._composeRoster(cast, ['F', 'G', 'H'], 2, 0, true);
    ok(['F', 'G', 'H'].every(n => r3.includes(n)), 'all pins present even when they exceed the cap');
    // rotation still runs over the NON-pinned remainder alongside pins
    ok(r3.length > 3, 'non-pinned rotation slots still filled alongside pins');
    // a pin for someone NOT off-screen (on-screen/absent) never appears in the roster
    ok(!L._composeRoster(['A', 'B'], ['Zed'], 6, 0, true).includes('Zed'), 'pin for an on-screen/absent character does not surface in the roster (no redundancy with full cards)');
    // case-insensitive pin match against the ledger name
    ok(L._composeRoster(['Akane', 'Bob'], ['akane'], 6, 0, true).includes('Akane'), 'pin matches ledger name case-insensitively');
}

// ─────────────────────────────────────────────────────────────────────
section('_pickCheckpoint — nearest snapshot at/before target');
{
    const cks = [{ atTurn: 0 }, { atTurn: 5 }, { atTurn: 10 }, { atTurn: 15 }];
    eq(L._pickCheckpoint(cks, 12) && L._pickCheckpoint(cks, 12).atTurn, 10, 'newest checkpoint <= target');
    eq(L._pickCheckpoint(cks, 15) && L._pickCheckpoint(cks, 15).atTurn, 15, 'exact match allowed');
    eq(L._pickCheckpoint(cks, 100) && L._pickCheckpoint(cks, 100).atTurn, 15, 'clamps to newest when target is beyond all');
    eq(L._pickCheckpoint(cks, 3) && L._pickCheckpoint(cks, 3).atTurn, 0, 'earliest when target is low');
    eq(L._pickCheckpoint(cks, -1), null, 'nothing at/before a negative target');
    eq(L._pickCheckpoint([], 10), null, 'empty list -> null');
    eq(L._pickCheckpoint([{ atTurn: 10 }, { atTurn: 2 }, { atTurn: 7 }], 8).atTurn, 7, 'unsorted list handled');
}

// ─────────────────────────────────────────────────────────────────────
section('mergeLedgerDeltas — explicit target isolation (staging rebuilds)');
{
    const a = {}, b = {};
    eq(L.mergeLedgerDeltas([{ name: 'Asari', core: 'calm strategist', state: 'wary' }], a), 1, 'merge into explicit target A');
    eq(L.mergeLedgerDeltas([{ name: 'Asari', core: 'furious', threads: ['find the mole'] }], b), 1, 'merge into explicit target B');
    eq(a['Asari'].core, 'calm strategist', 'target A holds its own value');
    eq(b['Asari'].core, 'furious', 'target B holds its own value — zero cross-talk');
    ok(!a['Asari'].threads, 'A never received B\'s threads');
    eq(b['Asari'].threads.length, 1, 'B kept its threads');
    // staging semantics: repeated merges into the same target evolve it in place
    L.mergeLedgerDeltas([{ name: 'Asari', state: 'resolved' }], b);
    eq(b['Asari'].state, 'resolved', 'later chunk replaces the field on the same target');
    eq(b['Asari'].core, 'furious', 'untouched fields survive later chunks');
}

// ─────────────────────────────────────────────────────────────────────
section('_selectStorageEvictions — bounded checkpoint/backup footprint');
{
    const E = (key, bytes, at) => ({ key, bytes, at });
    eq(L._selectStorageEvictions([E('a',100,1),E('b',100,2)], 500).length, 0, 'under budget -> evict nothing');
    eq(JSON.stringify(L._selectStorageEvictions([E('old',300,1),E('mid',300,2),E('new',300,3)], 600)), JSON.stringify(['old']), 'oldest evicted first, stops at budget');
    eq(JSON.stringify(L._selectStorageEvictions([E('old',300,1),E('mid',300,2),E('new',300,3)], 300)), JSON.stringify(['old','mid']), 'evicts as many as needed');
    eq(JSON.stringify(L._selectStorageEvictions([E('nots',200,0),E('dated',200,5)], 250)), JSON.stringify(['nots']), 'missing timestamp counts as oldest');
    // per-group protection: an idle chat's newest snapshots survive pressure from active chats
    const G = (key, bytes, at, group) => ({ key, bytes, at, group });
    const idle = [G('i1',100,1,'chatA'),G('i2',100,2,'chatA'),G('i3',100,3,'chatA')];
    const busy = [G('b1',100,10,'chatB'),G('b2',100,11,'chatB'),G('b3',100,12,'chatB'),G('b4',100,13,'chatB')];
    const evicted = new Set(L._selectStorageEvictions([...idle, ...busy], 400, 2));
    ok(!evicted.has('i2') && !evicted.has('i3'), 'idle chat keeps its 2 newest snapshots despite being globally oldest');
    ok(evicted.has('i1'), 'idle chat\'s excess-beyond-floor is still evictable');
    ok(!evicted.has('b3') && !evicted.has('b4'), 'busy chat keeps its 2 newest too');
    // floor can force staying over budget — protection wins over budget
    const tight = L._selectStorageEvictions([...idle, ...busy], 100, 2);
    ok(!tight.includes('i2') && !tight.includes('i3') && !tight.includes('b3') && !tight.includes('b4'), 'protected entries never evicted even when budget cannot be met');
    eq(L._selectStorageEvictions([], 100).length, 0, 'empty -> empty');
    // never evicts more than necessary: after eviction the survivors fit
    const mix = [E('a',400,4),E('b',400,1),E('c',400,3),E('d',400,2)];
    const gone = new Set(L._selectStorageEvictions(mix, 900));
    const left = mix.filter(e => !gone.has(e.key)).reduce((n,e)=>n+e.bytes,0);
    ok(left <= 900 && left + 400 > 900, 'evicts exactly enough (survivors fit; one fewer eviction would not)');
    ok(gone.has('b') && gone.has('d'), 'the two oldest were the ones evicted');
}

// ─────────────────────────────────────────────────────────────────────
section('_contiguousRanges — O(runs) hide/unhide batching');
{
    eq(JSON.stringify(L._contiguousRanges([0,1,2,3])), JSON.stringify([[0,3]]), 'one contiguous run');
    eq(JSON.stringify(L._contiguousRanges([5,6,9,10,11,20])), JSON.stringify([[5,6],[9,11],[20,20]]), 'gaps split runs; singleton kept');
    eq(JSON.stringify(L._contiguousRanges([3,1,2,1,0])), JSON.stringify([[0,3]]), 'unsorted + duplicate input normalized');
    eq(L._contiguousRanges([]).length, 0, 'empty -> empty');
    eq(JSON.stringify(L._contiguousRanges([-2,-1,0,1])), JSON.stringify([[0,1]]), 'negative indices filtered out');
    eq(JSON.stringify(L._contiguousRanges([7])), JSON.stringify([[7,7]]), 'single index -> single-point range');
    // a 280-message unghost collapses to ONE call instead of 280 chat-file writes
    const big = []; for (let i = 0; i <= 279; i++) big.push(i);
    eq(JSON.stringify(L._contiguousRanges(big)), JSON.stringify([[0,279]]), '280 messages -> 1 range call');
    // every input index is covered by exactly one range, nothing extra
    const scattered = [0,1,4,5,6,9,50,51,52,53,99];
    const rs = L._contiguousRanges(scattered);
    const covered = new Set(); for (const [a,b] of rs) for (let i=a;i<=b;i++) covered.add(i);
    ok(scattered.every(i => covered.has(i)) && covered.size === scattered.length, 'ranges cover exactly the input set');
}

// ─────────────────────────────────────────────────────────────────────
section('_computeReplayChunks — bounded background rewind batches');
{
    eq(JSON.stringify(L._computeReplayChunks(287, 292, 3)), JSON.stringify([[288, 290], [291, 292]]), 'delta split into summarizer-sized chunks');
    eq(JSON.stringify(L._computeReplayChunks(290, 292, 5)), JSON.stringify([[291, 292]]), 'small delta -> single chunk');
    eq(L._computeReplayChunks(292, 292, 5).length, 0, 'empty span -> no chunks');
    eq(L._computeReplayChunks(293, 292, 5).length, 0, 'inverted span -> no chunks');
    const big = L._computeReplayChunks(-1, 291, 3);   // full 292-turn replay
    eq(big.length, Math.ceil(292 / 3), 'full-history replay is fully chunked');
    eq(JSON.stringify(big[0]), JSON.stringify([0, 2]), 'first chunk starts at fromExclusive+1');
    eq(big[big.length - 1][1], 291, 'last chunk ends exactly at target');
    ok(big.every(([a, b]) => b - a + 1 <= 3 && a <= b), 'every chunk within step and well-formed');
    // contiguity: no turn skipped, none doubled
    ok(big.every((c, i) => i === 0 || c[0] === big[i - 1][1] + 1), 'chunks are contiguous');
    eq(L._computeReplayChunks(0, 10, 0).length, Math.ceil(10 / 1), 'step 0 clamps to 1');
    eq(L._computeReplayChunks(null, 10, 3).length, 0, 'non-numeric input -> no chunks');
}

// ─────────────────────────────────────────────────────────────────────
section('_selectCheckpointKeeps — dense recent + thinned tail');
{
    const turns = []; for (let t = 5; t <= 290; t += 5) turns.push(t);   // 58 checkpoints, cadence 5
    const keeps = L._selectCheckpointKeeps(turns, 16, 25);
    for (let t = 215; t <= 290; t += 5) ok(keeps.has(t), `dense window keeps turn ${t}`);
    ok(keeps.size > 16, 'tail is thinned, not dropped');
    ok(keeps.size <= 16 + Math.ceil(215 / 25) + 1, 'tail stays sparse (roughly one per bucket)');
    // every old turn (past the first bucket) is within one bucket of a kept checkpoint
    // -> a deep branch rewinds from a nearby snapshot instead of full-rebuilding
    for (let target = 25; target <= 290; target += 5) {
        const nearest = Math.max(...[...keeps].filter(t => t <= target), -1);
        ok(nearest >= 0 && target - nearest < 30, `branch to ${target} finds a checkpoint within a bucket (got ${nearest})`);
    }
    // below the first bucket's kept snapshot there's nothing to restore — but the
    // fallback rebuild there covers at most a bucket's worth of turns, which is cheap
    ok(Math.min(...keeps) <= 25, 'oldest kept checkpoint sits inside the first bucket');
    eq([...L._selectCheckpointKeeps([10, 20, 30], 16, 25)].length, 3, 'fewer than keepRecent -> all kept');
    const hard = L._selectCheckpointKeeps(turns, 8, 0);
    eq(hard.size, 8, 'sparseEvery 0 -> hard prune, tail dropped (quota path)');
    ok(hard.has(290) && hard.has(255), 'hard prune keeps the newest');
    eq(L._selectCheckpointKeeps([], 16, 25).size, 0, 'empty -> empty');
}

// ─────────────────────────────────────────────────────────────────────
section('Continuity — normalizeContinuityOutput');
{
    eq(L.normalizeContinuityOutput('NONE').length, 0, 'NONE -> empty');
    eq(L.normalizeContinuityOutput('').length, 0, 'empty -> empty');
    const a = L.normalizeContinuityOutput('[{"issue":"Alexia on train","fix":"she is at the academy","kind":"continuity"}]');
    eq(a.length, 1, 'one flag parsed');
    eq(a[0].kind, 'continuity', 'kind preserved');
    const b = L.normalizeContinuityOutput('```json\n[{"issue":"x","fix":"y","kind":"drift"}]\n```');
    eq(b.length, 1, 'fenced json parsed');
    eq(b[0].kind, 'drift', 'drift kind preserved');
    const c = L.normalizeContinuityOutput('here you go [{"issue":"z","fix":"w"}] thanks');
    eq(c.length, 1, 'salvaged array from surrounding noise');
    eq(c[0].kind, 'continuity', 'kind defaults to continuity');
    const d = L.normalizeContinuityOutput('{"issue":"solo","fix":"obj"}');
    eq(d.length, 1, 'single object coerced to array');
    eq(L.normalizeContinuityOutput('[{"kind":"drift"}]').length, 0, 'object with no issue/fix dropped');
}

// ─────────────────────────────────────────────────────────────────────
section('Continuity — where classification (snippet vs source)');
{
    const w = L.normalizeContinuityOutput('[{"issue":"i1","fix":"f1","kind":"drift"},{"issue":"i2","fix":"f2","kind":"continuity","where":"source"},{"issue":"i3","fix":"f3","kind":"continuity"},{"issue":"i4","fix":"f4","kind":"continuity","where":"snippet"}]');
    eq(w.length, 4, 'four parsed');
    eq(w[0].where, 'snippet', 'drift defaults to where=snippet (always snippet-level)');
    eq(w[1].where, 'source', 'explicit where=source preserved');
    eq(w[2].where, 'source', 'continuity w/o where defaults to source (conservative — no snippet auto-edit)');
    eq(w[3].where, 'snippet', 'explicit where=snippet preserved for a continuity flag');
    // merge carries where onto the stored flag
    const store = { continuityFlags: [], continuityDismissed: [] };
    L.mergeContinuityFlags(store, [3, 5], [{ issue: 'X', fix: 'x', kind: 'continuity', where: 'source' }]);
    eq(store.continuityFlags[0].where, 'source', 'stored flag keeps where');
}

// ─────────────────────────────────────────────────────────────────────
section('Continuity — _continuitySig + mergeContinuityFlags');
{
    eq(L._continuitySig({ issue: 'Alexia On  TRAIN', kind: 'continuity' }),
       L._continuitySig({ issue: 'alexia on train', kind: 'continuity' }),
       'sig normalizes case + whitespace');
    ok(L._continuitySig({ issue: 'x', kind: 'drift' }) !== L._continuitySig({ issue: 'x', kind: 'continuity' }),
       'sig distinguishes kind');
    eq(L._continuitySig({ kind: 'drift' }), '', 'no issue -> empty sig');
    const store = { continuityFlags: [], continuityDismissed: [] };
    eq(L.mergeContinuityFlags(store, [3, 5], [{ issue: 'A', fix: 'a', kind: 'continuity' }]), 1, 'adds a new flag');
    eq(L.mergeContinuityFlags(store, [3, 5], [{ issue: 'A', fix: 'a', kind: 'continuity' }]), 0, 'dedups an identical open flag');
    eq(store.continuityFlags.length, 1, 'only one flag stored');
    store.continuityDismissed.push(L._continuitySig({ issue: 'B', kind: 'continuity' }));
    eq(L.mergeContinuityFlags(store, [1, 2], [{ issue: 'B', fix: 'b', kind: 'continuity' }]), 0, 'skips a dismissed sig');
    eq(L.mergeContinuityFlags(store, [6, 7], [{ issue: 'C', fix: 'c', kind: 'drift' }]), 1, 'adds a genuinely different flag');
    eq(store.continuityFlags.length, 2, 'two flags total');
    ok(store.continuityFlags[0].id && store.continuityFlags[0].status === 'open' && store.continuityFlags[0].turnRange[0] === 3,
       'stored flag has id, open status, and turnRange');
}

// ─────────────────────────────────────────────────────────────────────
section('Continuity — reconcileSnippetFlags (re-check clears fixed, keeps valid)');
{
    const store = { continuityFlags: [], continuityDismissed: [] };
    L.mergeContinuityFlags(store, [3, 5], [{ issue: 'A', fix: 'a', kind: 'continuity' }, { issue: 'B', fix: 'b', kind: 'drift' }]);
    eq(store.continuityFlags.length, 2, 'two flags to start');
    const idA = store.continuityFlags.find(f => f.issue === 'A').id;
    // fresh pass still reports A only -> B cleared, A kept without churn, nothing new
    const r = L.reconcileSnippetFlags(store, [3, 5], [{ issue: 'A', fix: 'a', kind: 'continuity' }]);
    eq(r.cleared, 1, 'B (no longer reported) cleared');
    eq(r.added, 0, 'A already open -> not re-added');
    eq(store.continuityFlags.length, 1, 'only A remains');
    eq(store.continuityFlags[0].id, idA, 'A kept its id (no churn)');
    // fresh pass reports nothing -> A cleared (issue fixed)
    const r2 = L.reconcileSnippetFlags(store, [3, 5], []);
    eq(r2.cleared, 1, 'A cleared when the fresh pass is clean');
    eq(store.continuityFlags.length, 0, 'snippet now flag-free');
    // reconcile only touches the matching turnRange
    L.mergeContinuityFlags(store, [10, 12], [{ issue: 'Z', fix: 'z', kind: 'continuity' }]);
    const r3 = L.reconcileSnippetFlags(store, [3, 5], []);
    eq(r3.cleared, 0, 'a different snippet\'s flags are untouched');
    eq(store.continuityFlags.length, 1, 'Z on [10,12] preserved');
    // a dismissed issue is never (re-)added by a reconcile (real dismiss = flag removed + sig recorded)
    const store2 = { continuityFlags: [], continuityDismissed: [L._continuitySig({ issue: 'Z', kind: 'continuity' })] };
    const r4 = L.reconcileSnippetFlags(store2, [10, 12], [{ issue: 'Z', fix: 'z', kind: 'continuity' }]);
    eq(r4.added, 0, 'dismissed Z not added even though re-reported');
    eq(store2.continuityFlags.length, 0, 'dismissed Z stays gone');
}

// ─────────────────────
section('Continuity — _findSnippetByTurnRange');
{
    const store = {
        layers: [
            [{ turnRange: [0, 2], text: 'a' }, { turnRange: [3, 5], text: 'b' }],
            [{ turnRange: [6, 10], text: 'c' }],
        ],
    };
    eq(L._findSnippetByTurnRange(store, [3, 5]).snippet.text, 'b', 'finds snippet in layer 0');
    eq(L._findSnippetByTurnRange(store, [6, 10]).snippet.text, 'c', 'finds snippet in a higher layer');
    eq(L._findSnippetByTurnRange(store, [3, 4]), null, 'no exact match -> null');
    eq(L._findSnippetByTurnRange(store, null), null, 'null turnRange -> null');
    eq(L._findSnippetByTurnRange({}, [0, 2]), null, 'no layers -> null');
}

// ─────────────────────
section('Continuity — _findSnippetsCovering (which snippet owns an edited message)');
{
    const store = {
        layers: [
            [{ turnRange: [0, 2], text: 'a' }, { turnRange: [3, 5], text: 'b' }],
            [{ turnRange: [6, 10], text: 'c' }],
        ],
    };
    eq(L._findSnippetsCovering(store, 4).length, 1, 'index 4 -> one snippet');
    eq(L._findSnippetsCovering(store, 4)[0].text, 'b', 'index 4 is inside [3,5]');
    eq(L._findSnippetsCovering(store, 3)[0].text, 'b', 'range inclusive at the start');
    eq(L._findSnippetsCovering(store, 8)[0].text, 'c', 'index 8 is inside [6,10]');
    eq(L._findSnippetsCovering(store, 99).length, 0, 'beyond all snippets -> none (recent verbatim, ignored)');
    eq(L._findSnippetsCovering({}, 1).length, 0, 'no layers -> none');
}

// ─────────────────────────────────────────────────────────────────────
section('subst — $-sequence safety (regression: String.replace(token, string) corrupts $)');
{
    const tpl = 'A {{X}} B';
    eq(L.subst(tpl, '{{X}}', '$$'), 'A $$ B', 'literal $$ preserved');
    eq(L.subst(tpl, '{{X}}', '$&'), 'A $& B', 'literal $& preserved (not the matched token)');
    eq(L.subst(tpl, '{{X}}', '$`'), 'A $` B', 'literal $backtick preserved (not the prefix)');
    eq(L.subst(tpl, '{{X}}', "$'"), "A $' B", 'literal $prime preserved (not the suffix)');
    eq(L.subst(tpl, '{{X}}', 'they paid $500, maybe $$'), 'A they paid $500, maybe $$ B', 'money/prose with $ preserved intact');
    eq(L.subst(tpl, '{{X}}', null), 'A  B', 'null value -> empty, no throw');
    eq(L.subst(tpl, '{{X}}', 42), 'A 42 B', 'non-string value coerced to string');
    eq(L.subst(null, '{{X}}', 'z'), '', 'null template -> empty string');
    // Sanity: prove the OLD plain-string path WAS broken, so a regression back to it fails here.
    ok('A {{X}} B'.replace('{{X}}', '$$') !== 'A $$ B', 'sanity: plain String.replace DID corrupt $$ (the bug this fixes)');
    ok('A {{X}} B'.replace('{{X}}', '$`') !== 'A $` B', 'sanity: plain String.replace DID corrupt $backtick');
}

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
section('_storeHasContent — backup/recovery gating');
{
    ok(L._storeHasContent(null) === false, 'null -> no content');
    ok(L._storeHasContent(undefined) === false, 'undefined -> no content');
    ok(L._storeHasContent({}) === false, 'empty object -> no content');
    ok(L._storeHasContent({ layers: [], ledger: {}, notepad: '', pins: [] }) === false, 'fully-empty store -> no content');
    ok(L._storeHasContent({ layers: [[]] }) === false, 'empty layer array -> no content');
    ok(L._storeHasContent({ layers: [[{ text: 'x' }]] }) === true, 'a snippet -> has content');
    ok(L._storeHasContent({ ledger: { Emilia: { core: 'x' } } }) === true, 'a ledger entry -> has content');
    ok(L._storeHasContent({ notepad: '  hi  ' }) === true, 'non-empty notepad -> has content');
    ok(L._storeHasContent({ notepad: '    ' }) === false, 'whitespace-only notepad -> no content');
    ok(L._storeHasContent({ pins: [{ id: 'p1' }] }) === true, 'a pin -> has content');
    ok(L._storeHasContent({ ledger: [] }) === false, 'ledger as array (malformed) -> no content');
}

// ─── stripMetaBlocks: planned-intent meta must never become memory fact ───
section('stripMetaBlocks / buildPassageFromRange input hygiene');
L.__setSettings({ inputStripTags: ['plot_momentum', 'watchlist', 'edits'], inputStripHeaders: ['PLOT MOMENTUM', 'WATCHLIST'] });
{
    const prose = 'Stella raised one finger. Honami froze, toast halfway to her mouth.';
    const tagged = prose + '\n<plot_momentum>\nBoard notice arrives in three days; Silas runs cheat-or-prodigy bets.\n</plot_momentum>';
    const out = L.stripMetaBlocks(tagged);
    ok(out.includes('Stella raised one finger'), 'prose survives tag strip');
    ok(!out.includes('Board notice'), 'tag block content removed');

    const fenced = prose + '\n```watchlist\nAlaric | cold satisfaction | spin the narrative\n```';
    ok(!L.stripMetaBlocks(fenced).includes('Alaric |'), 'matching code fence removed');

    const headered = prose + '\n\n[WATCHLIST — active agendas]\nAlaric | ensure assessment confirms fraud narrative\nSilas | monetize gossip\n\nShe finally bit the toast.';
    const h = L.stripMetaBlocks(headered);
    ok(!h.includes('fraud narrative') && !h.includes('monetize gossip'), 'bracket-header section removed to blank line');
    ok(h.includes('She finally bit the toast'), 'prose after the blank line survives');

    const headerAtEnd = prose + '\n\nPLOT MOMENTUM: pending\nThe duel fallout compounds tomorrow.';
    ok(!L.stripMetaBlocks(headerAtEnd).includes('compounds tomorrow'), 'header block at end-of-text removed');

    const marked = 'The hall emptied. [EPISODE_END]';
    ok(L.stripMetaBlocks(marked) === 'The hall emptied.', 'EPISODE_END marker removed');

    const commented = 'He bowed. <!-- director: escalate next scene --> She did not.';
    const c = L.stripMetaBlocks(commented);
    ok(!c.includes('escalate') && c.includes('He bowed.') && c.includes('She did not.'), 'HTML comment removed, prose intact');

    const mathy = 'He whispered: 2<3, always. <b>Bold claim.</b>';
    ok(L.stripMetaBlocks(mathy) === mathy, 'non-configured tags and inequalities untouched');

    const edits = 'Sure.\n<edits>[{"id":5,"find":"x","replace":"y"}]</edits>';
    ok(L.stripMetaBlocks(edits) === 'Sure.', 'copilot edits block removed');
}
{
    const chat = [
        { is_user: true, mes: 'I check the notice board.' },
        { is_user: false, name: 'Narrator', mes: '<plot_momentum>Planned: expulsion threat</plot_momentum>' },
        { is_user: false, name: 'Narrator', mes: 'The board is bare.\n<watchlist>Silas | bets</watchlist>' },
    ];
    const passage = L.buildPassageFromRange(chat, 0, 2);
    ok(passage.includes('Player: I check the notice board.'), 'passage keeps player line');
    ok(!passage.includes('expulsion threat'), 'pure-meta message contributes nothing');
    ok(passage.split('\n').length === 2, 'pure-meta message skipped entirely (no empty speaker line)');
    ok(passage.includes('Narrator: The board is bare.'), 'mixed message keeps its prose');
    ok(!passage.includes('Silas | bets'), 'mixed message sheds its meta');
}

// ─── ledger currency: edit/swipe policy, decontamination, stamping, tiered GC ───
section('ledger currency — edits, swipes, rewind hygiene');
{
    ok(L._editRewindDecision(50, 40, 10) === 'ignore', 'edit past live pointer -> ignore (live pass ingests it)');
    ok(L._editRewindDecision(38, 40, 10) === 'rewind', 'recent edit within depth -> rewind');
    ok(L._editRewindDecision(40, 40, 10) === 'rewind', 'edit AT the live pointer -> rewind');
    ok(L._editRewindDecision(20, 40, 10) === 'deep', 'deep edit -> no re-derivation (canon-correction)');
    ok(L._editRewindDecision(38, 40, 0) === 'ignore', 'depth 0 disables the feature');
    ok(L._editRewindDecision(5, -1, 10) === 'ignore', 'no ledger yet -> ignore');
}
{
    const led = {
        Stella:  { core: 'x', _t: 35 },
        Silas:   { core: 'y', _t: 78 },
        Honami:  { core: 'z' },            // legacy, unstamped
    };
    const served = L._ledgerDroppingPast(led, 40);
    ok('Stella' in served, 'entry shaped before the target survives');
    ok(!('Silas' in served), 'entry shaped past the target dropped from serving copy');
    ok('Honami' in served, 'unstamped legacy entry kept (cannot judge)');
    ok(Object.keys(L._ledgerDroppingPast(null, 10)).length === 0, 'null ledger -> empty object');
}
{
    const tgt = {};
    L.mergeLedgerDeltas([{ name: 'Stella', state: 'furious' }], tgt, 41);
    ok(tgt.Stella && tgt.Stella._t === 41, 'merge stamps touched entry with the shaping turn');
    L.mergeLedgerDeltas([{ name: 'Stella', state: 'calm' }], tgt);
    ok(tgt.Stella._t === 41, 'merge without a turn leaves the stamp untouched');
}
{
    const mk = (key, at, tiered, group) => ({ key, at, tiered, group, bytes: 100 });
    const entries = [
        mk('ck::A::5', 5, true, 'ck::A'), mk('ck::A::30', 30, true, 'ck::A'),
        mk('ck::A::76', 76, true, 'ck::A'), mk('ck::A::80', 80, true, 'ck::A'),
        mk('ck::A::84', 84, true, 'ck::A'), mk('ck::A::88', 88, true, 'ck::A'),
        mk('bak::B::1', 1000, false, 'bak::B'), mk('bak::B::2', 2000, false, 'bak::B'),
    ];
    const evict = new Set(L._selectStorageEvictions(entries, 1, 4, 25));   // impossible budget: evict all unprotected
    ok(!evict.has('ck::A::88') && !evict.has('ck::A::84') && !evict.has('ck::A::80') && !evict.has('ck::A::76'), 'tiered: newest 4 checkpoints protected');
    ok(!evict.has('ck::A::5') && !evict.has('ck::A::30'), 'tiered: sparse far-back anchors protected (branch rewind targets)');
    ok(!evict.has('bak::B::2'), 'non-tiered group: newest protected');
    const evictOld = new Set(L._selectStorageEvictions(entries, 1, 4));   // legacy 3-arg call: old newest-only behavior
    ok(evictOld.has('ck::A::5'), 'backward compat: without sparseEvery, far-back anchors are not specially protected');
}

// ─── missing-core self-heal ───
section('missing-core detection + establish-order');
{
    const led = {
        Claire: { state: 'in the infirmary', arc: 'converging', threads: ['statement'] },   // the reported hole
        Jovan:  { core: 'guarded, deliberate; speaks plainly', state: 'cornered' },
        Aldith: { core: '   ', state: 'observing' },                                        // whitespace core = hole
        Renn:   { core: 'dutiful scribe' },
    };
    const missing = L._ledgerMissingCore(led);
    ok(missing.length === 2 && missing[0] === 'Aldith' && missing[1] === 'Claire', 'detects coreless + whitespace-core entries, sorted');
    ok(L._ledgerMissingCore({}).length === 0 && L._ledgerMissingCore(null).length === 0, 'empty/null ledger -> none');
    const notice = L._missingCoreNotice(missing);
    ok(notice.includes('Aldith, Claire') && notice.includes('establish their FULL core now'), 'notice names the holes and orders establishment');
    ok(notice.includes('do not wait for a "new trait"'), 'notice overrides the only-on-new-trait rule');
    ok(L._missingCoreNotice([]) === '', 'no holes -> no notice');
    const many = L._missingCoreNotice(['A','B','C','D','E','F','G','H','I','J']);
    ok(many.includes('(+2 more)') && !many.includes(' I,') && !many.includes('J.'), 'notice caps at 8 names');
}

// ─── dense checkpoint retention: delete-one cost = only the turns after it ───
section('every-turn checkpoints — retention shape');
{
    // Every ledgered turn 1..40 saved a checkpoint; retention keeps 16 recent dense + sparse anchors.
    const turns = Array.from({ length: 40 }, (_, i) => i + 1);
    const keeps = L._selectCheckpointKeeps(turns, 16, 25);
    for (let t2 = 25; t2 <= 40; t2++) ok(keeps.has(t2), `dense window: turn ${t2} has an exact restore point`);
    ok(keeps.has(25), 'sparse anchor at 25 retained for deep rewinds');
    ok(!keeps.has(12) || keeps.size <= 18, 'mid-history non-anchor turns pruned (storage capped)');
    // The practical claim: deleting message at turn N in the dense window finds a
    // checkpoint at exactly N-1 — replay = head - N turns only, zero cadence tax.
    const head = 40;
    for (const delAt of [40, 38, 30, 26]) {
        const target = delAt - 1;
        const nearest = Math.max(...[...keeps].filter(x => x <= target));
        ok(nearest === target, `delete at ${delAt}: nearest checkpoint is exactly ${target} (replay ${head - delAt} turn(s), was up to ${head - delAt + 4} with cadence 5)`);
    }
}

// ─── synthesized restore points (no snapshot that far back) ───
section('checkpoint synthesis from entry stamps');
{
    const led = { A: { core: 'x', _t: 20 }, B: { core: 'y', _t: 45 }, C: { core: 'legacy' } };
    const s1 = L._synthesizeCheckpoint(led, 30);
    ok(s1 && s1.synthetic === true && s1.atTurn === 30, 'synth: produces a synthetic snapshot at the ceiling');
    ok('A' in s1.ledger && !('B' in s1.ledger), 'synth: drops entries shaped past the ceiling, keeps earlier ones');
    ok('C' in s1.ledger, 'synth: unstamped legacy entry kept in a stamp-active ledger');
    ok(L._synthesizeCheckpoint({ C: { core: 'legacy' } }, 30) === null, 'synth: declines on an all-legacy ledger (no lineage to trust)');
    ok(L._synthesizeCheckpoint(led, -1) === null && L._synthesizeCheckpoint(null, 5) === null, 'synth: invalid inputs -> null');
}
ok(!SRC_FULL.includes('_lastCkptTurn'), 'global checkpoint cursor fully removed (per-chat store cursor everywhere)');

// ─── ledger eras: clear must never be resurrect-able ───
section('ledger eras + rebuild stamping (source contracts)');
ok(SRC_FULL.includes("era: (store.ledgerEra | 0)"), 'save: snapshots stamped with the chat store era');
ok(SRC_FULL.includes("((v.era | 0) !== (store.ledgerEra | 0))) continue;"), 'list: snapshots from other eras invisible to this chat');
ok(SRC_FULL.includes("store.ledgerEra = (store.ledgerEra | 0) + 1;"), 'clear: bumps the era (old snapshots retired, branches keep theirs)');
ok(SRC_FULL.includes("store.ledgerStaging = null;\n        _ledgerQueue = [];\n        _ledgerGen++;") , 'clear: invalidates in-flight jobs and staged rebuilds');
ok(SRC_FULL.includes("mergeLedgerDeltas(deltas, undefined, b.endIdx)"), 'backfill: merges stamped with chunk end turn');
ok(SRC_FULL.includes("sn.turnRange[1] === 'number') ? sn.turnRange[1] : undefined"), 'snippet path: merges stamped with scene end turn');
ok(SRC_FULL.includes('head snapshot: the very next edit/deletion restores instantly'), 'backfill completion: explicit head checkpoint');

// ─── live-pass busy retry + manual update ───
section('live pass: busy self-retry + Update now (source contracts)');
ok(SRC_FULL.includes("return 'busy';"), 'live pass: busy is a distinct tri-state, not a silent false');
ok(SRC_FULL.includes("else if (r === 'busy') _armLiveRetry();"), 'cadence gate: busy skips arm a self-retry');
ok(SRC_FULL.includes("const _LIVE_RETRY_MAX = 300;"), 'live retry patience outlasts any real model call (was 8 tries / 32s — shorter than one call on a phone)');
ok(SRC_FULL.includes("if (r === false) { _liveRetryLeft = 0; return; }   // nothing left to ingest"), 'live retry stops immediately when there is nothing to ingest (cannot spin)');
ok(/if \(--_liveRetryLeft > 0\) _armLiveRetry\(\);/.test(SRC_FULL), 'live retry keeps re-arming while the channel is busy');
ok(SRC_FULL.includes('_summarizeRetryLeft = 300;'), 'summarize retry never abandons a pending summarization');
ok(SRC_FULL.includes('_auditRetryLeft = 200;'), 'audit retry outlasts a slow model call');
ok(SRC_FULL.includes('_turnsSinceLive = 0;   // cadence is per-chat'), 'live cadence counter reset per chat');
ok(/_clearLiveRetry\(\);\s*\n\s*_clearAuditRetry\(\);/.test(SRC_FULL), 'retry: live + audit retries both cleared on chat change');
ok(SRC_FULL.includes("#sc_ledger_now"), 'Update-now button wired');
const H = require('fs').readFileSync(__dirname + '/settings.html', 'utf8');
ok(H.includes('id="sc_ledger_now"'), 'Update-now button present in settings UI');

// ─── Update-now visibility loop (source contracts) ───
section('manual pass feedback + failure surfacing');
ok(SRC_FULL.includes("queueLiveLedgerUpdate({ manual: true })"), 'button: passes manual flag');
ok(SRC_FULL.includes("staging: _staging, manual });"), 'job: carries the manual flag');
ok(SRC_FULL.includes("refreshed through turn ${job.liveEnd}"), 'manual success: completion toast with turn');
ok(SRC_FULL.includes("no character changes to record"), 'manual no-change: honest toast');
ok(SRC_FULL.includes("the pointer stayed put so nothing is skipped"), 'manual failure: surfaced with reason + retry hint');
ok(SRC_FULL.includes("_liveFailStreak === 3"), 'auto failures: streak breaker reports after 3 in a row');
ok(SRC_FULL.includes("if (job.live) _liveFailStreak = 0;"), 'streak resets on any successful live pass');
ok(SRC_FULL.includes("failures will be reported"), 'manual replay path: catch-up announced');

// ─── discard self-heal + surgical gen bump ───
section('stale-result discards heal themselves');
ok(SRC_FULL.includes("re-deriving automatically.');"), 'gen-mismatch discard: logged as self-healing');
ok(SRC_FULL.includes("That read was discarded — the chat changed (edit/delete/swipe) while it ran"), 'manual discard: user told why');
ok(SRC_FULL.includes("if (job.live) _armLiveRetry();"), 'discard: live retry armed — pointer catches up with no tap');
ok(SRC_FULL.includes("if (D > _li) _genStale = false;"), 'single delete above the live pointer: no gen bump, completed passes survive');
ok(SRC_FULL.includes("if (_genStale) _ledgerGen++;"), 'gen bump is conditional, not unconditional');

// ─── computeLedgerCast: the single injection-selection truth ───
section('computeLedgerCast — panel mirrors injection by construction');
{
    const mkE = (u) => ({ core: 'x', updatedAt: u });
    const led = { Jovan: mkE(50), Claire: mkE(40), Stella: mkE(30), Silas: mkE(20), Renn: mkE(10), Emilia: mkE(5) };
    const s = { ledgerMaxActive: 2, ledgerInjectRoster: true, ledgerRosterMax: 2, ledgerRosterRotate: false };
    const recent = 'jovan glanced at claire while stella watched'.toLowerCase();
    const cast = L.computeLedgerCast(led, s, recent, [], 0);
    ok(cast.shown.length === 2 && cast.shown[0].name === 'Jovan' && cast.shown[1].name === 'Claire', 'on-screen full entries: recency order, capped');
    ok(cast.roster.length === 2, 'roster: capped slice of the off-screen');
    ok(cast.roster.includes('Stella'), 'on-screen overflow (Stella, beyond maxActive) falls to the roster line');
    ok(cast.out.length === 6 - 2 - 2, 'out = everyone not injected this turn');
    ok(!cast.out.includes('Jovan') && !cast.out.includes('Claire'), 'injected never in out');
    const pinned = L.computeLedgerCast(led, s, recent, ['Emilia'], 0);
    ok(pinned.roster.includes('Emilia'), 'pins ride the roster ahead of rotation');
    const noRoster = L.computeLedgerCast(led, { ...s, ledgerInjectRoster: false }, recent, [], 0);
    ok(noRoster.roster.length === 0 && noRoster.out.length === 4, 'roster off: only on-screen injected');
    const empty = L.computeLedgerCast({}, s, recent, [], 0);
    ok(empty.shown.length === 0 && empty.roster.length === 0 && empty.out.length === 0, 'empty ledger -> empty cast');
}

ok(SRC_FULL.split('computeLedgerCast(ledger, s, recentLower, getLedgerPins(), _rosterTick)').length >= 3, 'panel + injection (+ audit) all call the SAME selector with identical inputs — no duplicated selection logic');
ok(SRC_FULL.includes('Injected this turn:'), 'panel header states the injection count');
ok(SRC_FULL.includes('not injected this turn'), 'non-injected entries say so explicitly');

// ─── ledger self-audit ───
section('ledger self-audit — targets, evidence, scope');
{
    const mk = (a) => (a === undefined ? { core: 'x' } : { core: 'x', _a: a });
    const led = { Jovan: mk(30), Claire: mk(), Stella: mk(10), Silas: mk(25), Renn: mk(5) };
    const t1 = L._ledgerAuditTargets(led, ['Jovan'], 3);
    ok(t1[0] === 'Jovan', 'targets: injected characters audited first (their errors are live)');
    ok(t1[1] === 'Claire', 'targets: never-audited entry next (_a absent = -1)');
    ok(t1[2] === 'Renn', 'targets: then least-recently-audited');
    ok(L._ledgerAuditTargets(led, [], 2).length === 2, 'targets: capped per run');
    ok(L._ledgerAuditTargets({}, [], 4).length === 0, 'targets: empty ledger -> none');
    const t2 = L._ledgerAuditTargets(led, ['Jovan'], 3);
    ok(JSON.stringify(t1) === JSON.stringify(t2), 'targets: deterministic for identical input');
}
{
    L.__setSettings({ inputStripTags: ['plot_momentum'], inputStripHeaders: [] });
    const chat = [
        { is_user: true, mes: 'I greet Claire at the gate.' },
        { is_user: false, name: 'Narrator', mes: 'Silas counts coins, alone.' },
        { is_user: false, name: 'Narrator', mes: 'Claire studies the notice.\n<plot_momentum>PLANNED: Board summons Claire</plot_momentum>' },
        { is_user: false, name: 'Narrator', mes: 'Rain on the quad.' },
    ];
    const ci = L._pickEvidenceIndices(chat, 'Claire', 6);
    ok(JSON.stringify(ci) === '[0,2]', 'evidence: finds every message featuring the character');
    ok(JSON.stringify(L._pickEvidenceIndices(chat, 'Claire', 1)) === '[2]', 'evidence: keeps only the most recent K appearances');
    ok(L._pickEvidenceIndices(chat, 'Emilia', 6).length === 0, 'evidence: absent character -> no appearances');

    const ev = L.buildLedgerAuditEvidence(chat, ['Claire', 'Silas'], 6, 9000);
    ok(ev.includes('#0 Player: I greet Claire') && ev.includes('#1 Narrator: Silas counts coins'), 'evidence: unions the audited characters\' appearances');
    ok(ev.indexOf('#0') < ev.indexOf('#1') && ev.indexOf('#1') < ev.indexOf('#2'), 'evidence: chronological order');
    ok(!ev.includes('PLANNED: Board summons'), 'evidence: planner meta stripped — plans are not events the audit can confirm');
    ok(!ev.includes('Rain on the quad'), 'evidence: messages without the audited cast excluded');

    // Budget pressure (the cap floors at 500, so exercise it with real-sized messages).
    const big = [
        { is_user: false, name: 'N', mes: 'Claire waited. ' + 'a'.repeat(400) },
        { is_user: false, name: 'N', mes: 'Claire moved. ' + 'b'.repeat(400) },
    ];
    const tight = L.buildLedgerAuditEvidence(big, ['Claire'], 6, 500);
    ok(tight.includes('b'.repeat(400)) && !tight.includes('a'.repeat(400)), 'evidence: under budget pressure the NEWEST evidence wins');
    ok(L.buildLedgerAuditEvidence(big, ['Claire'], 6, 99999).includes('a'.repeat(400)), 'evidence: with budget, older appearances included too');
}
ok(SRC_FULL.includes('const inScope = deltas.filter'), 'audit: corrections outside the audited set are ignored (scope guard)');
ok(SRC_FULL.includes("ledger[key]._a = stampAt"), 'audit: every audited entry stamped so the round-robin advances');
ok(SRC_FULL.includes("if (_ledgerGen !== startGen)") && SRC_FULL.includes("if (_chatEpoch !== startEpoch) { log('Ledger audit"), 'audit: epoch + generation guards before landing');
ok(SRC_FULL.includes('absence is not contradiction'), 'audit prompt: never strips long-standing traits the window merely omits');
ok(SRC_FULL.includes('KNOWLEDGE THE CHARACTER NEVER RECEIVED'), 'audit prompt: epistemic-leak check');
ok(SRC_FULL.includes('PLANNED, NOT PLAYED'), 'audit prompt: planned-but-unplayed check');
ok(SRC_FULL.includes('INFERENCE HARDENED INTO FACT'), 'audit prompt: inference-as-certainty check');
ok(SRC_FULL.includes('LEAVE IT ALONE'), 'audit prompt: unjudgeable claims are left alone');
ok(SRC_FULL.includes('maybeAuditLedger();'), 'audit: wired into the per-turn cadence');

// ─── audit must never cost speed or safety ───
section('audit concurrency: exclusive scribe channel, freshness first');
ok(SRC_FULL.includes("if (_llmChannelBusy()) { setTimeout(() => { processLedgerQueue(); }, 2000); return; }"), 'scribe queue defers while ANY pass holds the channel (jobs kept, not dropped)');
ok(/queueLiveLedgerUpdate[\s\S]{0,400}_llmChannelBusy\(\) \|\| _ledgerQueue\.length > 0\) return 'busy';/.test(SRC_FULL), 'live pass yields to ANY pass holding the LLM channel');
ok(SRC_FULL.includes("if (_turns.length && _computeLiveLedgerRange(store.summarizedUpTo, store.ledgerLiveIdx, _turns[_turns.length - 1].index)) return 'busy';"), 'audit yields: never runs while story is un-ingested');
ok(SRC_FULL.includes("if (s.ledgerLiveUpdate !== false) {"), 'yield skipped when the live pass is off (pointer would lag forever)');
ok(SRC_FULL.includes('const seenRev = new Map();'), 'audit snapshots each entry revision before thinking');
ok(SRC_FULL.includes('seenRev.get(k) === rev;'), 'stale corrections dropped — newer state never clobbered by an older audit');
ok(SRC_FULL.includes('mergeLedgerDeltas(fresh, undefined, liveIdx)'), 'only fresh corrections merge');

// ─── deep audit: event coverage + per-chat lifecycle ───
section('deep audit — event wiring, timer lifecycle, reset coverage');
ok(/if \(event_types\.MESSAGE_SWIPED\) eventSource\.on\(event_types\.MESSAGE_SWIPED, onMessageSwiped\);\s*\n\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(event_types\.MESSAGE_UPDATED\)/.test(SRC_FULL), 'MESSAGE_UPDATED registered unconditionally — no longer shadowed by an else-if on SWIPED');
ok(!/else if \(event_types\.MESSAGE_UPDATED\)/.test(SRC_FULL), 'the else-if that hid programmatic edits is gone');
ok(SRC_FULL.includes('clearTimeout(_ledgerEditTimer);          // same class'), 'chat change clears the armed ledger edit-rewind (would rewind the WRONG chat)');
ok(/_ledgerEditTimer = null;\s*\n\s*_ledgerEditMin = Infinity;/.test(SRC_FULL), 'chat change resets the coalesced edit floor with the timer');
ok(SRC_FULL.includes('if (_chatEpoch !== _epochAtArm) { _ledgerEditMin = Infinity; return; }'), 'edit debounce carries an epoch belt — fires only for the chat that armed it');
for (const k of ['ledgerEditRewindDepth', 'ledgerAuditEnabled', 'ledgerAuditEveryTurns', 'ledgerAuditMaxPerRun', 'ledgerAuditEvidenceMsgs', 'ledgerAuditEvidenceChars', 'ledgerAuditSystemPrompt', 'ledgerAuditUserPrompt']) {
    ok(SRC_FULL.includes(`s.${k} = defaultSettings.${k};`), `reset-to-defaults covers ${k}`);
}
// Internal bookkeeping must never reach the model.
{
    const line = L.formatLedgerEntry('Claire', { core: 'guarded', state: 'waiting', arc: 'a', threads: ['t'], _t: 41, _a: 38, updatedAt: 123 }, 600);
    ok(!line.includes('_t') && !line.includes('_a') && !line.includes('41') && !line.includes('updatedAt'), 'injection text carries no internal stamps (_t/_a/updatedAt)');
    ok(line.startsWith('Claire — Nature: guarded'), 'injection text is the character, nothing else');
}

// ─── shared surnames: siblings must not mark each other on screen ───
section('ambiguous name tokens — the sibling false-positive');
{
    const cast = ['Jovan Argent', 'Claire Argent', 'Stella Marchetti', 'Silas'];
    const amb = L._ambiguousTokens(cast);
    ok(amb.has('argent'), 'shared surname detected as ambiguous');
    ok(!amb.has('jovan') && !amb.has('claire'), 'distinct given names stay usable');
    ok(!amb.has('marchetti'), 'unshared surname stays usable');
    ok(L._ambiguousTokens(['Stella', 'Silas']).size === 0, 'single-token names contribute no ambiguity');
    ok(L._ambiguousTokens([]).size === 0 && L._ambiguousTokens(null).size === 0, 'empty/null cast -> no ambiguity');

    const cl = L.characterAliases('Claire Argent', amb);
    ok(cl.includes('Claire Argent') && cl.includes('Claire'), 'full name and given name remain aliases');
    ok(!cl.includes('Argent'), 'ambiguous surname dropped as a standalone alias');
    ok(L.characterAliases('Claire Argent').includes('Argent'), 'without an ambiguity set, behaviour is unchanged (backward compatible)');
    ok(L.characterAliases('Stella Marchetti', amb).includes('Marchetti'), 'unshared surname still matches');
    ok(JSON.stringify(L.characterAliases('Silas', amb)) === '["Silas"]', 'single-token name unaffected');
}
{
    const led = {
        'Jovan Argent':  { core: 'a', updatedAt: 3 },
        'Claire Argent': { core: 'b', updatedAt: 2 },
        'Stella Marchetti': { core: 'c', updatedAt: 1 },
    };
    const s = { ledgerMaxActive: 6, ledgerInjectRoster: true, ledgerRosterMax: 12, ledgerRosterRotate: false };
    const only = L.computeLedgerCast(led, s, 'jovan argent stepped onto the platform.', [], 0).shown.map(x => x.name);
    ok(only.includes('Jovan Argent'), 'the sibling who IS on screen is injected');
    ok(!only.includes('Claire Argent'), 'THE BUG: the absent sibling is no longer marked on screen by a shared surname');

    const byGiven = L.computeLedgerCast(led, s, 'claire studied the notice board.', [], 0).shown.map(x => x.name);
    ok(byGiven.includes('Claire Argent') && !byGiven.includes('Jovan Argent'), 'each sibling still detected by their own given name');

    const byFull = L.computeLedgerCast(led, s, 'claire argent said nothing.', [], 0).shown.map(x => x.name);
    ok(byFull.includes('Claire Argent'), 'full name still detects');

    const bySurname = L.computeLedgerCast(led, s, 'marchetti raised a hand.', [], 0).shown.map(x => x.name);
    ok(bySurname.includes('Stella Marchetti'), 'an UNSHARED surname still detects — the fix is surgical, not blanket');

    const both = L.computeLedgerCast(led, s, 'jovan and claire argued in the hall.', [], 0).shown.map(x => x.name);
    ok(both.includes('Jovan Argent') && both.includes('Claire Argent'), 'both siblings detected when both are named');
}
{
    // Audit evidence must not treat a sibling's scenes as this character's evidence,
    // or the auditor would "verify" Claire against text she never appeared in.
    const chat = [
        { is_user: false, name: 'N', mes: 'Jovan Argent stepped onto the platform.' },
        { is_user: false, name: 'N', mes: 'Claire waited by the arch.' },
    ];
    const amb = L._ambiguousTokens(['Jovan Argent', 'Claire Argent']);
    ok(JSON.stringify(L._pickEvidenceIndices(chat, 'Claire Argent', 6, amb)) === '[1]', "evidence: only Claire's own scenes");
    ok(JSON.stringify(L._pickEvidenceIndices(chat, 'Jovan Argent', 6, amb)) === '[0]', "evidence: only Jovan's own scenes");
    ok(L._pickEvidenceIndices(chat, 'Claire Argent', 6).length === 2, 'without the ambiguity set the old over-match is reproducible (regression witness)');
}

// ─── THE gate that was missing: this file must parse as an ES MODULE ───
// SillyTavern loads index.js as an ES module. `node --check index.js` parses it as
// CommonJS and silently ACCEPTS duplicate top-level `let` declarations — which is how
// a redeclared _auditActive shipped in v5.58.0 and left the extension unloadable
// through v5.60.0. The suite now proves the real parse on every run.
section('module integrity');
{
    const { execFileSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), 'sc_esm_gate_' + process.pid + '.mjs');
    let esmOk = true, esmErr = '';
    try {
        require('fs').writeFileSync(tmp, SRC_FULL);
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
        esmOk = false;
        esmErr = String((e && e.stderr) || (e && e.message) || '').split('\n').map(x => x.trim()).filter(Boolean).find(x => /Error/.test(x)) || 'parse failed';
    } finally { try { require('fs').unlinkSync(tmp); } catch (_) {} }
    ok(esmOk, 'index.js parses as an ES MODULE (the way SillyTavern loads it)' + (esmOk ? '' : ' — ' + esmErr));
}
ok(/function _llmChannelBusy\(\)[\s\S]{0,400}isSummarizing \|\| _ledgerActive \|\| _auditActive \|\| _ledgerAuditActive \|\| _continuityActive \|\| _editRecheckActive/.test(SRC_FULL), 'one channel predicate covers every LLM pass');
ok(!/let _auditActive[\s\S]*let _auditActive/.test(SRC_FULL), 'the sister auditor and the ledger auditor no longer share a flag name');
ok(SRC_FULL.includes('let _ledgerAuditActive = false;'), 'ledger audit owns a distinct flag');
ok(/processContinuityQueue\(\) \{\s*\n\s*if \(_continuityActive\) return;\s*\n\s*if \(_llmChannelBusy\(\)\)/.test(SRC_FULL), 'continuity queue joins the exclusive channel');
ok(/processAuditQueue\(\) \{\s*\n\s*if \(_auditActive\) return;\s*\n\s*if \(_llmChannelBusy\(\)\)/.test(SRC_FULL), 'sister auditor joins the exclusive channel');
ok(SRC_FULL.includes("if (_chatEpoch !== _epoch) { log('edit-recheck: chat switched — abandoning the remaining snippet(s).'); break; }"), 'edit re-check stops spending LLM calls on a chat that is gone');

// ─── per-turn notes: the ledger's own history ───
section('ledger notes — fold, rewind by reading fewer notes, history');
{
    // Claire's real shape: Nature written once and never touched again, Now moving
    // constantly, Arc moving occasionally, threads replaced wholesale.
    const notes = [
        { t: 12, name: 'Claire Argent', at: 1, core: 'guarded, precise; grips her wrist when tense', state: 'in the corridor' },
        { t: 30, name: 'Claire Argent', at: 2, state: 'at the gallery rail', arc: 'protective older sister', threads: ['get Jovan out before the crowd forms'] },
        { t: 47, name: 'Claire Argent', at: 3, state: 'waiting by the arch', threads: ['shape the statement', 'tell him about Ivar'] },
        { t: 47, name: 'Jovan Argent', at: 4, core: 'deliberate, plain-spoken', state: 'on the platform' },
    ];
    const now = L.foldLedgerNotes(notes, Infinity);
    ok(now['Claire Argent'].core === 'guarded, precise; grips her wrist when tense', 'Nature survives from turn 12 — never rewritten, still true');
    ok(now['Claire Argent'].state === 'waiting by the arch', 'Now takes the newest note');
    ok(now['Claire Argent'].arc === 'protective older sister', 'Arc keeps turn 30 (nothing moved it since)');
    ok(JSON.stringify(now['Claire Argent'].threads) === '["shape the statement","tell him about Ivar"]', 'threads replaced wholesale by the newest list');
    ok(now['Claire Argent']._t === 47, 'entry stamped with the last turn that touched it');
    ok(!!now['Jovan Argent'], 'every character folds independently');

    // THE branch case, per field.
    const at20 = L.foldLedgerNotes(notes, 20);
    ok(at20['Claire Argent'].core.startsWith('guarded'), 'branch to 20: Nature from turn 12 still hers');
    ok(at20['Claire Argent'].state === 'in the corridor', 'branch to 20: Now reverts to turn 12 exactly');
    ok(at20['Claire Argent'].arc === undefined, 'branch to 20: Arc had not been written yet — correctly absent');
    ok(!at20['Jovan Argent'], 'branch to 20: a character not yet seen does not exist');
    const at35 = L.foldLedgerNotes(notes, 35);
    ok(at35['Claire Argent'].state === 'at the gallery rail' && at35['Claire Argent'].arc === 'protective older sister', 'branch to 35: exactly turn 30 state, per field');
    ok(JSON.stringify(L.foldLedgerNotes(notes, 100)) === JSON.stringify(L.foldLedgerNotes(notes, Infinity)), 'folding past the end == folding everything');
    ok(Object.keys(L.foldLedgerNotes([], 50)).length === 0 && Object.keys(L.foldLedgerNotes(null, 50)).length === 0, 'empty/null notes -> empty page');

    const hist = L.ledgerHistoryFor(notes, 'Claire Argent');
    ok(hist.length === 3 && hist[0].t === 12 && hist[2].t === 47, "the wiki view: a character's own timeline, oldest first");
    ok(L.ledgerHistoryFor(notes, 'Nobody').length === 0, 'history of an unknown character is empty');
}
{
    // Rewind by reading fewer notes — the reported turn-100 -> turn-50 case.
    const store = { ledger: {}, ledgerLiveIdx: 100, ledgerNotesFrom: 0, ledgerNotes: [] };
    for (let i = 1; i <= 100; i++) store.ledgerNotes.push({ t: i, name: 'Claire Argent', at: i, state: 'scene ' + i });
    store.ledgerNotes.push({ t: 4, name: 'Claire Argent', at: 0, core: 'guarded, precise' });
    L.__setStore(store);
    ok(L.notesCover(store, 50) === true, 'notes reach back to turn 50');
    ok(L.rewindLedgerFromNotes(50) === true, 'rewind to 50 succeeds with ZERO model calls');
    ok(store.ledger['Claire Argent'].state === 'scene 50', 'the page is exactly what it was at turn 50');
    ok(store.ledger['Claire Argent'].core === 'guarded, precise', 'Nature written at turn 4 survives the rewind');
    ok(store.ledgerLiveIdx === 50, 'the pointer follows the rewind');
    ok(store.ledgerNotes.every(n => n.t <= 50), 'notes past the branch point are dropped');
    ok(store.ledgerRebuild === null && store.ledgerStaging === null, 'no rebuild is scheduled — there is nothing to rebuild');
}
{
    // Legacy chat: notes only become authoritative from their base.
    const store = { ledger: { Stella: { core: 'brash', updatedAt: 5 } }, ledgerLiveIdx: 80 };
    L.__setStore(store);
    L.ensureLedgerNotes(store);
    ok(store.ledgerNotesFrom === 80, 'an existing page is adopted as a base note at the current pointer');
    ok(store.ledgerNotes.length === 1 && store.ledgerNotes[0].base === true && store.ledgerNotes[0].core === 'brash', 'the base note carries the page verbatim — no history lost');
    ok(L.notesCover(store, 90) === true, 'rewinds above the base fold exactly');
    ok(L.notesCover(store, 40) === false, 'rewinds below the base honestly decline — the old path handles them');
    ok(L.rewindLedgerFromNotes(40) === false, 'declining is explicit, never a wrong answer');
    const fresh = { ledger: {}, ledgerLiveIdx: -1 };
    L.ensureLedgerNotes(fresh);
    ok(fresh.ledgerNotesFrom === 0, 'a NEW chat bases at turn 0 — exactly foldable forever');
}
{
    // Appending: only what the scribe actually said gets recorded.
    const store = { ledger: {}, ledgerLiveIdx: -1 };
    L.__setStore(store);
    L.ensureLedgerNotes(store);
    L.mergeLedgerDeltas([{ name: 'Claire Argent', core: 'guarded', state: 'corridor' }], undefined, 12);
    L.mergeLedgerDeltas([{ name: 'Claire Argent', state: 'the arch' }], undefined, 47);
    ok(store.ledgerNotes.length === 2, 'one note per scribe reply per character');
    ok(store.ledgerNotes[1].state === 'the arch' && store.ledgerNotes[1].core === undefined, 'the note holds ONLY the changed field — that is why it is small');
    ok(store.ledger['Claire Argent'].core === 'guarded', 'the materialized page keeps the unchanged Nature');
    ok(JSON.stringify(L.foldLedgerNotes(store.ledgerNotes, Infinity)['Claire Argent'].state) === '"the arch"', 'fold(notes) reproduces the live page');
    const staged = {};
    const n0 = store.ledgerNotes.length;
    L.mergeLedgerDeltas([{ name: 'Claire Argent', state: 'staged only' }], staged, 48);
    ok(store.ledgerNotes.length === n0, 'a STAGED merge writes no notes (it is not the live timeline)');
}
{
    // Growth is bounded without losing truth.
    const store = { ledger: {}, ledgerLiveIdx: 2000, ledgerNotesFrom: 0, ledgerNotes: [] };
    for (let i = 1; i <= 1600; i++) store.ledgerNotes.push({ t: i, name: 'Claire Argent', at: i, state: 's' + i });
    L.__setStore(store);
    L.compactLedgerNotes(store);
    ok(store.ledgerNotes.length < 1600, 'over the cap, old notes compact into a base');
    ok(store.ledgerNotesFrom === 2000 - 300, 'exact history is retained for the recent tail');
    ok(L.foldLedgerNotes(store.ledgerNotes, Infinity)['Claire Argent'].state === 's1600', 'compaction preserves the current page exactly');
}

// ─── the wiki view ───
section('per-character history view');
{
    const store = {
        ledgerNotesFrom: 0,
        ledgerNotes: [
            { t: 12, name: 'Claire Argent', at: 1, core: 'guarded, precise', state: 'in the corridor' },
            { t: 30, name: 'Claire Argent', at: 2, state: 'at the gallery rail', arc: 'protective older sister' },
            { t: 47, name: 'Claire Argent', at: 3, threads: ['shape the statement'] },
            { t: 47, name: 'Jovan Argent', at: 4, state: 'on the platform' },
        ],
    };
    const h = L._historyHtml(store, 'Claire Argent');
    ok(h.includes('turn 12') && h.includes('turn 30') && h.includes('turn 47'), 'history lists every turn that changed them');
    ok(!h.includes('on the platform'), "another character's notes never appear in this history");
    ok(h.indexOf('turn 12') < h.indexOf('turn 30') && h.indexOf('turn 30') < h.indexOf('turn 47'), 'oldest first — a development timeline, not a dump');
    ok(h.includes('Nature') && h.includes('guarded, precise'), 'the turn a trait was established is visible');
    ok((h.match(/Nature/g) || []).length === 1, 'Nature appears once — at the turn it was written, not repeated forever');
    ok(h.includes('Exact history kept from turn 0'), 'the view states how far back it is authoritative');
    const empty = L._historyHtml({ ledgerNotes: [], ledgerNotesFrom: 0 }, 'Nobody');
    ok(empty.includes('No recorded history yet'), 'a character with no notes says so plainly');
    ok(L._historyHtml({}, 'Claire Argent').includes('No recorded history') || L._historyHtml({}, 'Claire Argent').includes('unavailable'), 'a malformed store never throws');
    const based = L._historyHtml({ ledgerNotesFrom: 80, ledgerNotes: [{ t: 80, name: 'Stella', at: 1, base: true, core: 'brash' }] }, 'Stella');
    ok(based.includes('carried over'), 'a migrated base note is labelled as carried over, not as a turn that happened');
}
ok(SRC_FULL.includes("$(document).on('click', '.sc-ledger-hist'"), 'history toggle is wired to the card button');

ok(/_llmChannelBusy\(\)[\s\S]{0,300}_autoRecallBusy/.test(SRC_FULL), 'verbatim recall is enrolled in the exclusive channel (it calls callSummarizer too)');
ok(!/let _recallRemaining=0; let _lastRecallText=''; let _autoRecallBusy=false;/.test(SRC_FULL), 'the recall flag no longer sits below the predicate that reads it (TDZ)');
ok(SRC_FULL.indexOf('let _autoRecallBusy = false;') > 0 && SRC_FULL.indexOf('let _autoRecallBusy = false;') < SRC_FULL.indexOf('function _llmChannelBusy'), 'recall flag is DECLARED BEFORE the predicate that reads it — no temporal dead zone');
ok(SRC_FULL.includes("if (_llmChannelBusy()) {\n        if (opts.silent) { log('auto-recall: channel busy — skipping this turn.'); return; }"), 'auto-recall skips a busy channel; manual recall explains itself');
ok(SRC_FULL.includes("if(s.recallAuto && s.enabled && !_llmChannelBusy()){"), 'the auto-recall trigger checks the channel, not just its own flag');

// ─── deleting one message: the notes ARE the rewind ───
section('single deletion — notes reindexed, page refolded, no replay');
{
    const store = {
        ledgerLiveIdx: 9, summarizedUpTo: -1, layers: [], ledgerNotesFrom: 0,
        ledger: {},
        ledgerNotes: [
            { t: 3, name: 'Claire Argent', at: 1, core: 'guarded', state: 'corridor' },
            { t: 5, name: 'Claire Argent', at: 2, state: 'the arch' },        // this turn gets deleted
            { t: 7, name: 'Claire Argent', at: 3, threads: ['statement'] },
        ],
    };
    L.__setStore(store);
    L.reindexAfterDeletion(store, 5);
    ok(!store.ledgerNotes.some(n => n.t === 5), "the deleted turn's own note is gone with it");
    ok(store.ledgerNotes.some(n => n.t === 6 && Array.isArray(n.threads)), 'later notes shifted down by one — still aligned with the chat');
    ok(store.ledgerNotes.some(n => n.t === 3 && n.core === 'guarded'), 'earlier notes untouched');
    ok(store.ledgerLiveIdx === 8, 'the live pointer shifted with them');
    ok(store.ledger['Claire Argent'].state === 'corridor', 'THE REWIND: Now reverted to before the deleted turn — instantly, with no model call');
    ok(store.ledger['Claire Argent'].core === 'guarded', 'unrelated fields survive the deletion');
    ok(JSON.stringify(store.ledger['Claire Argent'].threads) === '["statement"]', 'a later turn\'s contribution survives');
}
{
    // Deleting a turn the ledger never read must change nothing but indices.
    const store = {
        ledgerLiveIdx: 4, summarizedUpTo: -1, layers: [], ledgerNotesFrom: 0, ledger: {},
        ledgerNotes: [{ t: 3, name: 'Stella', at: 1, core: 'brash', state: 'in the hall' }],
    };
    L.__setStore(store);
    L.reindexAfterDeletion(store, 9);
    ok(store.ledger['Stella'] && store.ledger['Stella'].state === 'in the hall', 'deleting an un-read turn leaves the page intact');
    ok(store.ledgerNotes[0].t === 3 && store.ledgerLiveIdx === 4, 'nothing shifts below the deletion point');
}
{
    // A base note is a snapshot of everything up to its turn, not a record OF it.
    const store = {
        ledgerLiveIdx: 8, summarizedUpTo: -1, layers: [], ledgerNotesFrom: 5, ledger: {},
        ledgerNotes: [{ t: 5, name: 'Silas', at: 1, base: true, core: 'showman' }],
    };
    L.__setStore(store);
    L.reindexAfterDeletion(store, 5);
    ok(store.ledgerNotes.length === 1 && store.ledgerNotes[0].t === 4, 'a base note shifts instead of vanishing — carried-over history is never lost');
    ok(store.ledger['Silas'] && store.ledger['Silas'].core === 'showman', 'and its content survives');
}
ok(SRC_FULL.includes("} else if (!_bulkTrim && newLen > 0) {"), 'a single deletion is handled, not skipped');
ok(!SRC_FULL.includes('deletion (delta === 1) skips this and stays INSTANT'), 'the obsolete "skip the rewind" rationale is gone');

// ─── the freshness indicator must agree with the reader ───
section('freshness indicator — no phantom backlog');
{
    // The reported screenshot: summarization has read far past the live pointer, so
    // NOTHING is unread — the old indicator computed latest-ledgerLiveIdx anyway.
    ok(L._computeLiveLedgerRange(95, 73, 95) === null, 'the reader says: nothing unread when summarizedUpTo covers the latest turn');
    ok(L._computeLiveLedgerRange(-1, 73, 95)[0] === 74, 'and says [74,95] when only the live pointer is behind');
    ok(L._computeLiveLedgerRange(90, 73, 95)[0] === 91, 'the watermark is max(summarizedUpTo, ledgerLiveIdx) — not the pointer alone');
    ok(L._computeLiveLedgerRange(-1, 999, 95) !== null, 'a pointer past the chat end resyncs rather than reporting negative work');
    ok(SRC_FULL.includes('const _range = _computeLiveLedgerRange(store.summarizedUpTo, store.ledgerLiveIdx, _latest);'), 'the panel asks the reader instead of reinventing the rule');
    ok(SRC_FULL.includes("const _behind = _range ? _turns.filter(t => t.index >= _range[0]).length : 0;"), 'it counts real assistant TURNS, not a message-index difference');
    ok(!SRC_FULL.includes('const _behind = (_latest >= 0 && _li < _latest) ? (_latest - _li) : 0;'), 'the index-arithmetic version that produced the phantom backlog is gone');
}

console.log('\n────────────────────────────────────────');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('\nFAILURES:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL CHARACTER-LEDGER ASSERTIONS PASS ✓');
