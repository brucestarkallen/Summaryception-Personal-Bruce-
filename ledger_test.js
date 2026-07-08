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

const names = ['_ESC_RE', '_escapeRegex', 'characterAliases', 'wordPresentInText',
    'formatLedgerEntry', 'buildCharacterBlock', 'serializeLedgerForScribe',
    'resolveLedgerKey', '_LEDGER_LABEL_RE', 'stripLeadingLabel', 'mergeLedgerDeltas', 'subst', '_storeHasContent', '_computeLiveLedgerRange'];

const body = names.map(extractTopLevel).join('\n\n');

const sandbox = `
let __settings = {};
let __store = { ledger: {} };
let __chat = [];
function getSettings(){ return __settings; }
function getChatStore(){ return __store; }
const SillyTavern = { getContext(){ return { chat: __chat }; } };
${body}
return {
  __setSettings: (v)=>{ __settings = v; },
  __setStore:    (v)=>{ __store = v; },
  __setChat:     (v)=>{ __chat = v; },
  _escapeRegex, characterAliases, wordPresentInText, formatLedgerEntry,
  buildCharacterBlock, serializeLedgerForScribe, resolveLedgerKey, mergeLedgerDeltas,
  subst, _storeHasContent, _computeLiveLedgerRange,
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
        ok(b.includes('Others in this story'), 'roster header present for off-screen cast');
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
    ok(b.indexOf('Mira') < b.indexOf('Others in this story'), 'active full cards come before the roster');
    // roster respects the cap
    L.__setSettings(Object.assign({}, defaultSettings, { ledgerRosterMax: 1 }));
    const b2 = L.buildCharacterBlock();
    const inRoster = (b2.match(/;/g) || []).length;
    ok(b2.includes('Others in this story'), 'roster still present at cap=1');
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

console.log('\n────────────────────────────────────────');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('\nFAILURES:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL CHARACTER-LEDGER ASSERTIONS PASS ✓');
