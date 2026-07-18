/**
 * Summaryception v5.5.3 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

// ─── Imports ─────────────────────────────────────────────────────────
import {
    sendSummarizerRequest,
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
    getConnectionDisplayName,
} from './connectionutil.js';

const MODULE_NAME = 'summaryception';
const SC_VERSION = '5.80.1';   // real version — keep in sync with manifest.json on every release
const LOG_PREFIX = '[Summaryception]';
// const TRACE_MODE = true;  // ultra-verbose logging

// ─── Default Settings ────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    verbatimTurns: 9,
    turnsPerSummary: 3,
    snippetsPerLayer: 100,
    snippetsPerPromotion: 2,
    maxLayers: 9,
    injectionTemplate: '[Story memory continuation after brief plot essential — oldest → newest. Established canon; do not contradict.]\n{{summary}}',

    // ── Injection placement (previously hardcoded to IN_PROMPT / system) ──
    injectionPosition: 1,   // 0 = in-prompt (merged w/ system) · 1 = in-chat @ depth · 2 = before-prompt
    injectionDepth: 4,      // messages up from newest; only used when position = 1
    injectionRole: 0,       // 0 = system · 1 = user · 2 = assistant

    // ── Injection contents: which assembled sections are actually sent to the
    //    storyteller. All default ON (current behavior). These gate ONLY the
    //    injection — they do not stop the background passes from running, so you
    //    can keep the ledger/auditor building while excluding them from context. ──
    injectNotepad: true,
    injectPinned: true,
    injectLedger: true,
    injectSummary: true,
    injectDetails: true,

    // ── Manual notepad wrapper (the note text itself is stored per-chat, in chat metadata) ──
    notepadTemplate: '\n\n<notes>\n{{notes}}\n</notes>\n',

    // ── Detail Auditor ("sister"): a SECOND pass, per batch, that checks whether the
    //    compact snippet dropped important specifics the storyteller would need, and if
    //    so records ONLY the omissions as a short director's-note attached to that
    //    snippet. Empty (NONE) for routine batches. Never touches the snippet itself. ──
    sisterEnabled: true,
    sisterInjectTemplate: '\n\n<details>\nSpecifics behind recent events (canon — do not contradict):\n{{details}}\n</details>\n',

    // ── Continuity Auditor: a focused pass that checks each snippet against BOTH its
    //    source passage (drift) and the established record (contradictions), and files
    //    concise flags into a visible work-queue you or the copilot resolve. ──
    continuityEnabled: false,      // opt-in (adds a background LLM pass per snippet)
    continuityNudge: false,        // global "nudge the story" toggle: inject unresolved fixes as OOC corrections so the Storyteller self-corrects
    continuityNudgeMax: 6,         // cap how many unresolved fixes are injected at once
    continuitySystemPrompt:
        `Role: continuity auditor for an ongoing collaborative fiction. You receive the exact recent PASSAGE, the compact SNIPPET written from it, and the established RECORD (character ledger, notepad, earlier summaries). Your ONLY job is to catch genuine continuity problems of two kinds: (1) DRIFT — the SNIPPET distorts, misattributes, or drops something materially important from the PASSAGE; (2) CONTINUITY — the PASSAGE or SNIPPET contradicts the established RECORD: a character in the wrong place, someone knowing or referencing something they never witnessed, a broken timeline or sequence, an inconsistent relationship or stat, or a confused/renamed entity. Report ONLY real contradictions or material distortions — never style, pacing, speculation, or trivial omissions, and never processing directives. Do NOT invent facts; base every finding strictly on the given text. If everything is consistent, output exactly: NONE. Otherwise output ONLY a compact JSON array, each element {"issue":"<what contradicts what>","fix":"<the correction>","kind":"drift"|"continuity","where":"snippet"|"source"}. Set "where":"snippet" when the SNIPPET is the wrong one (it misrepresents a correct SOURCE, or states something the SOURCE does not) — fixable by rewriting the snippet to match the source. Set "where":"source" when the SOURCE passage itself is wrong (it contradicts the RECORD and the snippet only faithfully repeats it) — that needs a message edit; a snippet rewrite would just make the snippet disagree with its source. No preamble, no markdown, no commentary.`,
    continuityUserPrompt:
        `<player_name>{{player_name}}</player_name>\n<record>{{context_str}}</record>\n<passage>{{story_txt}}</passage>\n<snippet>{{snippet}}</snippet>\n\n<snippet> is the compact memory line recorded for <passage>. <record> is what the story has already established elsewhere.\n\nCheck for exactly two things:\n1) DRIFT — does <snippet> distort, misattribute, or omit something materially important that IS in <passage>?\n2) CONTINUITY — does anything in <passage> or <snippet> CONTRADICT <record> — wrong location/presence, knowledge a character could not have, broken timeline, inconsistent relationship/stat, confused identity?\n\nFlag ONLY genuine problems, grounded in the text. Ignore style, pacing, and trivial detail. Do not invent.\n\nFor each problem set "where": "snippet" if the SNIPPET is the wrong one (it misrepresents a correct <passage> — fixable by rewriting the snippet), or "source" if <passage> itself is wrong (it contradicts <record> and the snippet only repeats it — needs a message edit, not a snippet rewrite).\n\nIf all consistent, output exactly:\nNONE\n\nOtherwise output ONLY a JSON array, e.g.:\n[{"issue":"Snippet says Alexia boarded the train, but the passage says she stayed at the academy","fix":"Alexia stayed at the academy; she did not board the train","kind":"drift","where":"snippet"},{"issue":"The passage itself puts Alexia on the train, but the record establishes she is at the academy and never left","fix":"Alexia is at the academy, not on the train","kind":"continuity","where":"source"}]`,
    continuityAutoFix: false,       // when on, apply snippet-level fixes automatically (oldest -> newest) as issues are found, instead of leaving them as flags to review
    continuityFixSystemPrompt:
        `Role: you correct a single memory-snippet to remove a continuity error. You get the current SNIPPET and a CORRECTION (the established truth). Rewrite the snippet so it is fully consistent with the correction, changing ONLY what the correction requires and preserving everything else — length, tone, and all other facts. Do not add commentary or new events. Output ONLY the corrected snippet text — no preamble, no quotes, no labels. If the snippet already matches the correction, output it unchanged.`,
    continuityFixUserPrompt:
        `<snippet>{{snippet}}</snippet>\n<correction>{{story_txt}}</correction>\n<record>{{context_str}}</record>\n\nRewrite <snippet> so it is consistent with <correction>, changing only what is needed and keeping everything else intact. Output only the corrected snippet text.`,
    // ── Pinned Memories + Verbatim Recall ──
    pinMaxChars: 1500,
    pinsMaxTotalChars: 6000,
    recallMaxSnippets: 4,
    recallMaxChars: 12000,
    recallPersist: 1,
    recallPosition: 1,
    recallDepth: 6,
    recallRole: 0,
    recallAuto: false,
    recallSystemPrompt: 'Role: memory index selector. You receive a query and a catalog of memory snippets (JSON array of {id,text,detail}). Output STRICT JSON ONLY: an array of the snippet id strings most relevant to the query, most relevant first, maximum {{k}} ids, e.g. ["L0#3","L1#0"]. No prose, no markdown, no explanation. If nothing is relevant output [].',

    sisterSystemPrompt:
        'Role: continuity auditor for an ongoing fiction. You receive a compact summary snippet and the exact passage it was made from. Your ONLY job: decide whether the snippet dropped important, hard-to-reconstruct information a future storyteller would need — exact numbers, named plans or tactics, specific commitments or conditions, precise capabilities, identity details, or background canon (character backstory, family structure, separations/divorces, custody or legal situations, hidden truths, world rules, relationships, motives). Pure processing directives ("keep it short", "stay in character", "analyze before the header") are NOT information — never flag them as omissions. The passage may include out-of-character material — parentheticals, analysis requests, or verification blocks before/after the scene; facts established there COUNT as part of the passage. Words like "Confirmed" or OOC framing do NOT make a fact already-established — only actual presence in the prior context does. If the snippet already captures everything important, output exactly: NONE. Otherwise output a single "DETAIL:" line containing ONLY the missing information, as terse director\'s notes (breaking the fourth wall is fine). Never repeat anything the snippet or prior context already contains. No preamble, no markdown, no commentary.',
    sisterUserPrompt:
        `<player_name>{{player_name}}</player_name>\n<prior_context>{{context_str}}</prior_context>\n<passage>{{story_txt}}</passage>\n<snippet>{{snippet}}</snippet>\n\n<snippet> is the compact memory line already recorded for <passage>.\n\nDecide: does <snippet> omit any important information from <passage> that a storyteller would need and could NOT reconstruct from the gist alone? Consider: exact quantities/counts, named tactics or plans, specific conditional promises ("if X then Y"), precise capabilities or limits, identity/title details, and background canon (character backstory, family structure, separations/divorces, custody or legal situations, hidden truths, world rules, relationships, motives). Pure processing directives ("keep it short", "stay in character", "analyze before the header") are NOT information — never flag them as omissions.\n\n<passage> may contain out-of-character material — parenthetical notes, analysis requests, or verification blocks (e.g. "Family Logic Confirmed") before or after the scene. Background facts established in such OOC material COUNT as present in <passage>. OOC framing or words like "Confirmed" do NOT make a fact already-established — only actual presence in <prior_context> does.\n\nRecord ONLY omissions that are ALL of: (a) present in <passage>, (b) NOT already in <snippet>, (c) NOT already in <prior_context>.\n\nIf <snippet> already captures everything important, output exactly:\nNONE\n\nOtherwise output ONE line:\nDETAIL: <only the missing information, short phrases separated by semicolons>`,

    // ── Character Ledger ("psychologist"): a THIRD background pass, per batch,
    //    that maintains a living per-character model — stable nature (core),
    //    current mood (state), relationship trajectory (arc), and open loose ends
    //    (threads) — so characters stay in-voice and evolve realistically across
    //    many turns. Only the ACTIVE cast (characters present in the recent
    //    window) is injected. ──
    ledgerEnabled: true,
    ledgerActiveWindow: 12,        // recent messages scanned to decide who is "on screen"
    ledgerMaxActive: 6,            // max characters injected at once
    ledgerMaxCharsPerChar: 1000,   // per-character injection cap (chars) — sized for a dense CURRENT card (behavioral anchor + whereabouts + compressed arc), not for saving tokens. The cap's real job is bounding accumulation so stale/redundant detail can't pile into noise that drifts the model; keep cards dense and current, not merely small.
    ledgerContextMaxChars: 6000,   // ledger context budget handed to the scribe
    ledgerLiveUpdate: true,        // update the ledger over the recent (not-yet-summarized) window every turn, not only when a batch is summarized — keeps "Now"/arcs/threads tracking the current scene instead of lagging ~verbatimTurns behind
    ledgerLiveEveryTurns: 1,       // run the live pass every N assistant turns (1 = every turn = freshest)
    ledgerInjectRoster: true,      // also inject a compact one-line-per-character roster of EVERYONE off-screen, so long-absent characters are never forgotten and return consistently
    ledgerRosterMax: 12,           // cap on how many off-screen characters the roster lists at once (most-recently-updated first)
    ledgerRosterRotate: true,      // when the off-screen cast exceeds the cap: keep the most-recent anchored and ROTATE the rest through the remaining slots one step per turn, so a small cap still refreshes everyone over time
    ledgerAutoRewind: true,        // on branch/bulk-trim, auto-rewind the ledger from a periodic checkpoint and re-derive only the small delta, instead of rebuilding from the whole history

    // ── Ledger self-audit ──
    // Re-DERIVING a misread reproduces it: the scribe reads the same passage the same
    // way. VERIFYING is different cognition — "does the source support this claim?"
    // catches the inventions generation produced. This is how the ledger corrects its
    // own drift without any other extension.
    ledgerAuditEnabled: true,
    ledgerAuditEveryTurns: 12,      // auto-audit cadence in assistant turns (0 = manual only)
    ledgerAuditMaxPerRun: 4,        // characters checked per run — injected first, then least-recently-audited (round-robin)
    ledgerAuditEvidenceMsgs: 6,     // most recent messages featuring each audited character, used as evidence
    ledgerAuditEvidenceChars: 9000, // evidence budget per run (newest evidence wins)
    ledgerAuditSystemPrompt:
        `You are a continuity AUDITOR for the character ledger of an ongoing work of collaborative fiction. You do not write fiction and you never invent. Your one job: catch claims the ledger records that the STORY ITSELF never supports — the drift that creeps in when a character-scribe infers too much, credits a character with knowledge they never received, or records something that was planned but never played on screen.

You receive ENTRIES UNDER AUDIT (the ledger's current record for a few characters), EVIDENCE (verbatim story text where those characters appear), and PRIOR CONTEXT (compressed established story).

Judge each claim against the evidence, field by field:
- state and threads describe the character's CURRENT situation and open loose ends, so they must be traceable to the evidence. If a claim describes a specific event, situation, or piece of knowledge the evidence does not show happening, it is UNSUPPORTED — correct the field to what the evidence does support, dropping the unsupported part.
- core is the character's STABLE nature, built across the whole story. Correct it ONLY if the evidence directly CONTRADICTS it. Never remove a trait merely because this evidence window does not happen to show it — absence is not contradiction.
- arc is relationship HISTORY. Same rule as core: correct only on direct contradiction, never on absence.

The specific failures you exist to catch:
- KNOWLEDGE THE CHARACTER NEVER RECEIVED — the entry says they are aware of something the story never showed them witnessing, being told, or plausibly inferring. This is the most damaging error: it makes characters act on information they cannot have.
- PLANNED, NOT PLAYED — the entry describes an event, notice, meeting, or confrontation that no evidence shows happening on screen. Story plans and author notes are not events.
- INFERENCE HARDENED INTO FACT — the entry states as certain what the evidence only suggests (a mood read from behavior, a motive guessed at). Correct it to a read ("seems", "reads as"), not a certainty.
- INVENTED DETAIL — names, places, objects, or history the evidence does not contain.

RULES:
- If the evidence does not let you JUDGE a claim, LEAVE IT ALONE. You are looking only for claims you can positively show the story does not support. Not seeing something is not the same as disproving it.
- Correct, do not rewrite. Preserve the entry's wording and every supported detail; change only what fails the audit. Never improve prose, never reorganize, never add.
- When you correct a field, output the FULL corrected field — it replaces the old one.
- For threads, output the FULL corrected list: keep every supported thread, drop only the unsupported ones.

OUTPUT — a single JSON array and NOTHING else (no code fence, no prose before or after). One element per character needing a correction, containing ONLY the fields you are correcting:
{"name":"<exact name>","state":"<corrected>","threads":["<...>"]}
If every entry under audit is fully supported by the evidence, output exactly: []`,
    ledgerAuditUserPrompt:
        `<player_name>{{player_name}}</player_name>

<entries_under_audit>
{{ledger}}
</entries_under_audit>

<prior_context>
{{context_str}}
</prior_context>

<evidence>
{{story_txt}}
</evidence>

Audit the entries under audit against the evidence now. Output ONLY the JSON array.`,
    ledgerInjectTemplate: '\n\n<characters>\nWho these people are and where they stand right now — keep them consistent and in character; do not contradict:\n{{characters}}\n</characters>\n',
    ledgerSystemPrompt:
        `You are the character-continuity mind for an ongoing work of collaborative fiction — part novelist, part psychologist. You maintain a living ledger of the people in the story so a separate storyteller AI, often working many turns later from compressed memory, can keep every character the SAME PERSON — consistent in voice, values, and behavior — while letting them change the way real people do: gradually, believably, and only for reasons the story earned. The failures you exist to prevent are (1) a character acting out of nowhere against who they are (a guarded cynic suddenly gushing; a gentle soul suddenly cruel), and (2) a real, felt emotion vanishing the instant the scene is compressed.

You receive the CURRENT LEDGER (what is already known about each character), the PRIOR CONTEXT (established story), and a NEW PASSAGE (what just happened). For every character who appears or is materially involved in the NEW PASSAGE, output an updated entry. Do NOT output characters who are absent from the passage.

Each entry tracks four fields. A character PRESENT in the passage must never be left describing an EARLIER scene: if the story has moved and their state field still reads like a previous moment, that is an ERROR - refresh it to where they are and what they want NOW, even when the change is small. Standing in a room that has changed IS a change of state. Update ONLY what the passage changes; OMIT any field that is unchanged.

- core — the character's STABLE nature: temperament, values, and above all HOW THEY EXPRESS THEMSELVES. Capture what a writer needs to keep them in character: their default emotional register; how they behave under stress, embarrassment, or threat; their tells and defense mechanisms; how they speak (formal or plain, blunt or indirect, verbal habits) and specifically how they ADDRESS {{player_name}} and others (by name, nickname, title, coldly, teasingly); and the lines they would NOT cross. This is the anchor that keeps them recognizable across the whole story. Write it once when a character is established, then change it only when the passage reveals a genuinely NEW stable trait — never for a passing mood. When you do touch core, restate the FULL stable picture (everything already established plus the new trait) so nothing is lost. Favor concrete, actable specifics: "when flustered, goes clipped and sarcastic and changes the subject; never raises her voice" beats "proud but shy."
- state — the character's CURRENT, volatile condition right after this passage. LEAD with WHERE they are and what they are physically doing or their immediate situation, then their mood, what is on their mind, what they want in this moment, and how they are carrying themselves — written as prose, never a labelled field. Their WHEREABOUTS is part of state: whenever the passage relocates them or reveals where they are, even in a brief off-page mention (waiting in the library, gone to the dorms), update it so the ledger always reflects where each person currently is. This is overwritten each time they act, but it is NOT a blank slate — emotions have momentum. Carry forward the mood the ledger already records and evolve it realistically: a shock lingers and eases only with time or reassurance; a slight festers until addressed; warmth or anger set earlier still colors how they act now. If a character re-enters after being off-page, their last recorded state is where they resume unless the passage changes it. Record what would still be true a few beats later, not just the instant snapshot.
- arc — the SLOW trajectory of this character's key relationships, above all with {{player_name}}, kept as a brief PROGRESSION: where the relationship began, the specific turns that moved it, and where it is heading now — and for EACH turn, WHY it moved: what {{player_name}} did that they will not forget (a kindness, a betrayal, a moment of being truly seen or let down). This is the relationship's HISTORY, not just its current temperature — a later storyteller should be able to read how these two got HERE. If the story tracks a relationship score, THIS is where its movement is explained: the number itself lives in the summary, the reason lives here. Keep it a tight two to four sentences — append the newest turn and COMPRESS older ones into a phrase so the arc never balloons and the most recent development is never the part that gets cut. Update only when the passage actually moves it; evolve the existing arc, never restart it.
- threads — the character's CURRENTLY OPEN loose ends: concrete, unresolved things that will shape how they behave next (a promise pending, a lie unconfessed, an unaddressed slight, a confession half-made, a question left hanging, a debt owed either way). Output the CURRENT open list: KEEP threads still unresolved, DROP any this passage resolved, ADD any it opened. A thread stays open until the STORY resolves it — never merely because time passed. Omit the field entirely if nothing changed; use an empty array [] ONLY to signal that all previously-open threads are now resolved.

DISCIPLINE — this is a continuity record, not new fiction:
- Record ONLY what the passage (with the prior context) EVIDENCES. Never invent traits, motives, feelings, or backstory the text does not support. Inventing is the worst failure — it corrupts the character.
- Separate observation from inference. State what a character DID as fact; when you read their inner state from behavior, mark it as read ("seems", "reads as", "appears to"), not as certainty.
- Respect what each character can plausibly know. Do not credit them with knowledge of events they did not witness or were not told; their state and choices follow from their own perspective, not the reader's.
- Do NOT restate what the CURRENT LEDGER or PRIOR CONTEXT already holds. Add or evolve only.
- Use each character's exact name as already established. Do not rename or merge distinct characters, and do not invent a name for an unnamed figure — skip anyone unnamed.
- Terse, concrete director's notes. No markdown, no preamble, no meta-commentary.

OUTPUT — a single JSON array and NOTHING else (no code fence, no prose before or after). Each element:
{"name":"<exact name>","core":"<...>","state":"<...>","arc":"<...>","threads":["<...>","<...>"]}
Include only the fields you are updating for that character. If no character in the passage needs any update, output exactly: []`,
    ledgerUserPrompt:
        `<player_name>{{player_name}}</player_name>

<current_ledger>
{{ledger}}
</current_ledger>

<prior_context>
{{context_str}}
</prior_context>

<new_passage>
{{story_txt}}
</new_passage>

Update the character ledger for EVERY character who appears or is materially involved in <new_passage>. Use the four-field model (core / state / arc / threads) and OMIT every field that is unchanged.

- Evolve existing entries; do not restate them. Carry each character's recorded mood forward and move it realistically — emotions have momentum and do not reset between scenes.
- State must say WHERE each character now is and what they are doing (their immediate situation), then their mood — update whereabouts whenever the passage moves or reveals it, even off-page.
- Arc is a compressed progression: append the newest relationship turn and WHY it moved, compressing older turns; a relationship score's number lives in the summary, its reason lives in arc.
- Change core only for a genuinely new STABLE trait, never for a passing mood; when you touch it, keep everything already established.
- Keep unresolved threads open; drop only what the passage actually resolves.
- Ground every word in the passage and prior context — never invent, and never credit a character with knowledge they could not have.

Output ONLY the JSON array (or [] if nothing changed).`,

    // ── Continuity Editor ("Co-Writer / Master Novelist") prompts ──
    editorSystemPrompt:
        'Role: master continuity editor and co-writer for an ongoing roleplay. You receive the story\'s full memory — a notepad of established canon (plot-essential lore), an ordered list of summary snippets, and their detail notes — plus an instruction describing a problem or retcon. Determine the MINIMAL set of edits that resolves the problem and keeps everything internally consistent. Change only what must change; preserve each entry\'s terse style. Output STRICT JSON ONLY: a single array of edit operations — no prose, no markdown, no commentary. If nothing needs changing, output [].',
    editorUserPrompt:
        `<player_name>{{player_name}}</player_name>\n\n<instruction>\n{{command}}\n</instruction>\n\n<memory>\n{{memory}}\n</memory>\n\n<memory> has "notepad" (established canon) and "snippets" (each with an "id" like "L0#3", its "text", and optional "detail"). Apply <instruction> by editing memory so the whole story stays logical and consistent.\n\nReturn a JSON array of edit operations. Allowed ops:\n{"op":"edit_notepad","text":"<full new notepad>","reason":"<short why>"}\n{"op":"edit_snippet","id":"L0#3","text":"<new snippet text>","reason":"<short why>"}\n{"op":"delete_snippet","id":"L0#3","reason":"<short why>"}\n{"op":"edit_detail","id":"L0#3","text":"<new detail text>","reason":"<short why>"}\n{"op":"delete_detail","id":"L0#3","reason":"<short why>"}\n\nRules: reference snippets ONLY by their exact "id" from <memory>. Keep edits minimal — do not rewrite unaffected entries. Output ONLY the JSON array (or [] if nothing needs changing).`,

    summarizerSystemPrompt:
        'You are a precise narrative-state tracker for an ongoing fiction. Output one line of short phrases — no preamble, no commentary, no markdown. Record only what the passage states. Never infer, never guess. Out-of-character material inside the passage (parenthetical notes, analysis or verification blocks before/after the scene) counts as part of the record when it establishes background facts not already in prior context; OOC framing or words like "Confirmed" do not make a fact established.',

    summarizerUserPrompt:
        `<player_name>{{player_name}}</player_name>
<prior_context>{{context_str}}</prior_context>
<passage>{{story_txt}}</passage>

Write ONE line recording only what is NEW in <passage> relative to <prior_context>.

HARD EXCLUSIONS — do not record:
- Anything already stated in <prior_context>, even indirectly. If a fact, location, relationship, spec, stat, or character trait appears in <prior_context>, it is ESTABLISHED. Never restate it.
- CRITICAL: If <prior_context> already references an event, arrival, match, deployment, or location that <passage> now depicts in full scene form, treat the scene itself as established. Record ONLY the specific new details the prior reference did not contain.
- Atmosphere, weather, particulate haze, lighting, crowd noise, body language without narrative consequence.
- Repeated reactions ("X froze," "Y watched") unless they trigger a new action.
- Ongoing states (repeated locations, reactor levels, recurring postures) — state these ONCE, then never again.

RECORD (in priority order):
1. {{player_name}}'s decisions, declarations, and actions.
2. Other named characters' actions that change state, advance plot, or reveal information. In social or group scenes, each named character who approaches, addresses, or acts toward {{player_name}} or the focal character is a SEPARATE record — never collapse multiple participants into "others" or a single summary. Capture who did what, individually.
3. New facts: identities, numbers, titles, troop counts, match results, tactical details, scale shifts (crowd size, social attraction, popularity, odds, distances). When multiple characters contribute personal knowledge about a previously unmentioned character or entity, treat the combined profile as high-priority canon — preserve the character's identity, key achievements, and each contributor's unique connection to them.
4. Plans and strategy: the problem, the proposed solution, who proposed it. Include stated intentions, conditional promises, and "if-then" commitments.
5. Character self-declarations and diagnostic reads: when a named character explicitly states their own motivation, principle, boundary, self-assessment, method, capability, or knowledge source in dialogue — OR delivers a strategic assessment of another character's transformation, capability, or position — record the substance (paraphrased, not quoted).
6. Information asymmetries: when the text explicitly flags that one character knows or witnessed something another character doesn't know they know, record who saw/knows what.
7. Temporal markers: if the passage states a specific day, date, month, season, or time-of-day transition (morning/afternoon/evening/night, Day 4, Tuesday, Mar 15, late March, etc.), you MUST prefix the ENTIRE line with the earliest such marker in compact form (e.g., "[Sept 1, 08:24] Jovan did X;..."). A temporal marker is a PREFIX ONLY — it is never by itself a reason to generate content. Omit if no temporal marker appears.
8. Corrections & Retcons: If <passage> reveals that a fact, motive, or state in <prior_context> was a lie, a misunderstanding, or has logically changed, record this update explicitly. Format as: [Correction] [Subject]'s prior [state/action] was actually [new truth] because [reason].
9. System & Stat Deltas: Extract any changed stats, tags, or UI variables (e.g., P:, R:, S:). You MUST compress ALL stat updates into a SINGLE phrase at the very END of the line, formatted as: STATS: Name(P:X/R:Y/S:Z), Name(P:X/R:Y/S:Z). Do not use multiple phrases for stats.
10. Out-of-character canon: <passage> may include author asides, parentheticals, or OOC notes (often in parentheses, marked as background/context/note, or verification blocks like "Family Logic Confirmed") that state canonical facts — character backstory, family structure, separations/divorces, custody or legal situations, hidden truths, world rules, relationships, or motives. Record their substance as priority-3 facts, even when framed as an instruction to "analyze," "confirm," or "check." OOC framing or words like "Confirmed" do NOT make a fact established — only actual presence in <prior_context> does. Distinguish canonical facts (RECORD them) from pure processing directives such as "keep it short," "stay in character," or "analyze before the header" (IGNORE those).

CAUSAL FIDELITY — record WHY, not only WHAT:
- When one recorded event CAUSES or triggers another, keep the link explicit with a connective (→, "so", "which", "because", "triggering", "forcing") — within a phrase or across adjacent phrases. Never split a cause from its effect into two unrelated items. e.g. "Jovan's knee shifted the desk → The Glass Season slid into the light → Emilia read it as manufactured evidence" preserves the mechanism; "Jovan moved desk; paperback exposed; Emilia suspicious" loses it.
- Preserve the MANNER of an action when the text marks it: involuntary, reflexive, against the character's control, "before judgment caught up," forced, reluctant, deliberate, coldly. The manner is often the whole point — "Emilia corrected the misquote involuntarily, faster than her own judgment" is the record; "Emilia corrected the quote" falsifies her. Never flatten a charged action into a neutral one.
- When a stat delta (P/R/S) has a clear cause in the passage, attach the triggering beat to that character's phrase; the number itself still bundles at the end per rule 9. A relationship's movement rides with the event that caused it — never a bare number with no reason.

VERBATIM PRESERVATION — quote exactly when the exact words ARE the fact:
Default is paraphrase (rule 5). Override it with a SHORT exact quotation (in "double quotes", 15 words maximum) ONLY when the precise wording itself carries meaning paraphrase would destroy:
- a line a character will be held to or that becomes a callback: an oath, a promise, a threat, a name spoken, a signature phrase;
- a quotation being corrected, misremembered, or contested — record BOTH the wrong and the right wording verbatim; the discrepancy IS the point;
- an exact phrase from earlier that a character echoes, alters, or throws back.
Keep it minimal: the shortest exact span that preserves the meaning; everything around the quote stays paraphrased.

ACTOR RULES:
- Every action needs an EXPLICIT actor named in the text. Presence ≠ actorship.
- If no actor is named, write passive voice. Never guess.
- ABSOLUTE PRONOUN BAN: Use character names everywhere. You must replace ALL pronouns (he, him, his, she, her, hers, they, them, their, it) with the specific character's name.
- If the passage uses second-person ("you", "your") to refer to the player, replace with {{player_name}}.
- Past events referenced in <passage> belong to whoever the text says performed them.

FORMAT:
- One line. Short phrases separated by semicolons.
- HARD LIMIT: 15 phrases. For dense scenes with 4+ named participants, 18 phrases maximum. The bundled STATS phrase counts as ONE phrase. If you exceed the limit, cut lowest-priority items first (priority order above) — never cut to fit by dropping high-priority canon or by collapsing distinct named participants together.
- If <passage> has nothing new beyond <prior_context>, output exactly: (no new state)

BEFORE OUTPUTTING, verify: (1) the line starts with a temporal prefix if available; (2) no phrase duplicates anything in <prior_context>; (3) NO PRONOUNS remain — all replaced with names; (4) phrase count within limit; (5) every action has an explicit actor or is passive voice; (6) every named character who acted toward {{player_name}} or the focal character is recorded individually, not merged; (7) any canonical facts stated in OOC asides or parentheticals are captured — not skipped as "already confirmed" — while pure processing directives are ignored; (8) TIMELINE LOGIC — new facts do not create unexplained paradoxes with <prior_context>; if a paradox exists, resolve it with a [Correction] tag; (9) ALL stats are bundled into ONE phrase at the end; (10) causal links between events are explicit, not flattened into parallel facts; (11) the manner of any charged or involuntary action is preserved; (12) load-bearing exact wording is quoted (15 words max), not paraphrased away. If any check fails, revise.`,

    promptPreset: 'custom',  // 'narrative' | 'gamestate' | 'custom'
    savedCustomPrompts: {},        // { name: promptText } — named custom prompt slots
    lastCustomPrompt: '',          // Auto-saved when switching away from custom
    pauseSummarization: false,  // true = stop processing, keep injecting
    disableGhosting: false,  // true = mark as summarized but don't hide messages

    stripPatterns: [
        '<|channel>thought',
        '<channel|>',
        '<output>',
        '</output>',
        '<thinking>',
        '</thinking>',
    ],

    // Machine-note blocks removed from STORY INPUT before any summarizer / ledger
    // scribe / auditor pass. Planned-intent meta (director momentum notes,
    // watchlists, copilot edit blocks) lives inside message text but was never
    // narrated — ingesting it poisons memory with planned-but-unplayed "facts".
    inputStripTags: ['plot_momentum', 'watchlist', 'director', 'edits', 'memedits', 'wiedits', 'fetch', 'supersede'],
    inputStripHeaders: ['PLOT MOMENTUM', 'WATCHLIST'],

    // When a message within this many turns of the ledger's live pointer is edited or
    // swiped, auto-rewind to a checkpoint that PRECEDES the change and re-derive the
    // small delta — the ledger tracks the corrected text instead of the original.
    // Deeper edits are treated as corrections toward established canon and are NOT
    // re-derived (0 disables edit/swipe rewinds entirely).
    ledgerEditRewindDepth: 10,

    debugMode: false,
    traceMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default',          // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerResponseLength: 0,          // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
    connectionProfileId: '',              // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [],                // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0,                   // 0 = no limit (provider default)
});

// ─── Prompt Presets ──────────────────────────────────────────────────

const PROMPT_PRESETS = {
    narrative: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`,

    gamestate: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

Focus on: story progression, plot points, plans, tasks, quests; location changes and current location (reference by name); location interactables encountered, used, or discovered; significant changes to player, NPCs, locations, world, or setting.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

    custom: null, // Uses whatever is in the textarea
};

const DEFAULT_PROMPT_PRESET = 'narrative';

// ─── Retry Configuration ─────────────────────────────────────────────

const RETRY_CONFIG = {
    maxRetries: 5,
    baseDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(error) {
    try {
        const retryAfter = error?.response?.headers?.['retry-after']
            || error?.retryAfter
            || error?.data?.retry_after;
        if (!retryAfter) return null;
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (e) { /* ignore */ }
    return null;
}

function isRetryableError(error) {
    if (error?.name === 'AbortError') return false;

    // ConnectionError from connectionutil.js carries an explicit retryable flag.
    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }

    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) return true;
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('server error')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('overloaded')) return true;
    if (msg.includes('capacity')) return true;
    return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function trace(...args) {
    const s = getSettings();
    if (s.debugMode && s.traceMode) {
        const normalized = args.map((arg, idx) => (idx === 0 && typeof arg === 'string')
            ? arg.toUpperCase()
            : arg);
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

function debugVisibleTurns(chat, store) {
    trace('=== DEBUG VISIBLE TURNS ===');
    trace('  store.summarizedUpTo:', store.summarizedUpTo);
    trace('  Total chat messages:', chat.length);

    let visibleCount = 0;
    let ghostedCount = 0;
    let hiddenCount = 0;
    let visibleIndices = [];

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes?.trim()?.length > 0) {
            visibleCount++;
            visibleIndices.push(i);
        }
        if (m.extra?.sc_ghosted) ghostedCount++;
        if (m.is_hidden || m.is_system) hiddenCount++;
    }

    trace('  Visible non-ghosted turns:', visibleCount);
    trace('  Ghosted turns:', ghostedCount);
    trace('  Hidden/System turns:', hiddenCount);
    trace('  First 10 visible indices:', visibleIndices.slice(0, 10));
    trace('  Last 10 visible indices:', visibleIndices.slice(-10));

    // Check for messages that should have been ghosted but aren't
    const unghosteredSummarized = visibleIndices.filter(idx => idx <= store.summarizedUpTo);
    if (unghosteredSummarized.length > 0) {
        trace('  ⚠️ WARNING: Found ' + unghosteredSummarized.length + ' visible messages that are BEFORE summarizedUpTo!');
        trace('  First 5 unghostered summarized indices:', unghosteredSummarized.slice(0, 5));
    }
    trace('=== END DEBUG ===');
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

// ─── Prompt migration ───────────────────────────────────
// getSettings() only fills MISSING keys, so a prompt already persisted in a
// user's settings never picks up an improved default on its own. For each prompt
// below we keep the EXACT prior shipped default(s); on load, if the stored value
// still equals one of them verbatim, replace it with the current default. A prompt
// the user customized (no verbatim match) is left untouched. Idempotent: after the
// upgrade the stored value equals the new default and matches no prior. Memory DATA
// (snippets, ledger, notepad) is never touched.
const PRIOR_PROMPT_DEFAULTS = {
    summarizerUserPrompt: ["<player_name>{{player_name}}</player_name>\n<prior_context>{{context_str}}</prior_context>\n<passage>{{story_txt}}</passage>\n\nWrite ONE line recording only what is NEW in <passage> relative to <prior_context>.\n\nHARD EXCLUSIONS \u2014 do not record:\n- Anything already stated in <prior_context>, even indirectly. If a fact, location, relationship, spec, stat, or character trait appears in <prior_context>, it is ESTABLISHED. Never restate it.\n- CRITICAL: If <prior_context> already references an event, arrival, match, deployment, or location that <passage> now depicts in full scene form, treat the scene itself as established. Record ONLY the specific new details the prior reference did not contain.\n- Atmosphere, weather, particulate haze, lighting, crowd noise, body language without narrative consequence.\n- Repeated reactions (\"X froze,\" \"Y watched\") unless they trigger a new action.\n- Ongoing states (repeated locations, reactor levels, recurring postures) \u2014 state these ONCE, then never again.\n\nRECORD (in priority order):\n1. {{player_name}}'s decisions, declarations, and actions.\n2. Other named characters' actions that change state, advance plot, or reveal information. In social or group scenes, each named character who approaches, addresses, or acts toward {{player_name}} or the focal character is a SEPARATE record \u2014 never collapse multiple participants into \"others\" or a single summary. Capture who did what, individually.\n3. New facts: identities, numbers, titles, troop counts, match results, tactical details, scale shifts (crowd size, social attraction, popularity, odds, distances). When multiple characters contribute personal knowledge about a previously unmentioned character or entity, treat the combined profile as high-priority canon \u2014 preserve the character's identity, key achievements, and each contributor's unique connection to them.\n4. Plans and strategy: the problem, the proposed solution, who proposed it. Include stated intentions, conditional promises, and \"if-then\" commitments.\n5. Character self-declarations and diagnostic reads: when a named character explicitly states their own motivation, principle, boundary, self-assessment, method, capability, or knowledge source in dialogue \u2014 OR delivers a strategic assessment of another character's transformation, capability, or position \u2014 record the substance (paraphrased, not quoted).\n6. Information asymmetries: when the text explicitly flags that one character knows or witnessed something another character doesn't know they know, record who saw/knows what.\n7. Temporal markers: if the passage states a specific day, date, month, season, or time-of-day transition (morning/afternoon/evening/night, Day 4, Tuesday, Mar 15, late March, etc.), you MUST prefix the ENTIRE line with the earliest such marker in compact form (e.g., \"[Sept 1, 08:24] Jovan did X;...\"). A temporal marker is a PREFIX ONLY \u2014 it is never by itself a reason to generate content. Omit if no temporal marker appears.\n8. Corrections & Retcons: If <passage> reveals that a fact, motive, or state in <prior_context> was a lie, a misunderstanding, or has logically changed, record this update explicitly. Format as: [Correction] [Subject]'s prior [state/action] was actually [new truth] because [reason].\n9. System & Stat Deltas: Extract any changed stats, tags, or UI variables (e.g., P:, R:, S:). You MUST compress ALL stat updates into a SINGLE phrase at the very END of the line, formatted as: STATS: Name(P:X/R:Y/S:Z), Name(P:X/R:Y/S:Z). Do not use multiple phrases for stats.\n10. Out-of-character canon: <passage> may include author asides, parentheticals, or OOC notes (often in parentheses, marked as background/context/note, or verification blocks like \"Family Logic Confirmed\") that state canonical facts \u2014 character backstory, family structure, separations/divorces, custody or legal situations, hidden truths, world rules, relationships, or motives. Record their substance as priority-3 facts, even when framed as an instruction to \"analyze,\" \"confirm,\" or \"check.\" OOC framing or words like \"Confirmed\" do NOT make a fact established \u2014 only actual presence in <prior_context> does. Distinguish canonical facts (RECORD them) from pure processing directives such as \"keep it short,\" \"stay in character,\" or \"analyze before the header\" (IGNORE those).\n\nACTOR RULES:\n- Every action needs an EXPLICIT actor named in the text. Presence \u2260 actorship.\n- If no actor is named, write passive voice. Never guess.\n- ABSOLUTE PRONOUN BAN: Use character names everywhere. You must replace ALL pronouns (he, him, his, she, her, hers, they, them, their, it) with the specific character's name.\n- If the passage uses second-person (\"you\", \"your\") to refer to the player, replace with {{player_name}}.\n- Past events referenced in <passage> belong to whoever the text says performed them.\n\nFORMAT:\n- One line. Short phrases separated by semicolons.\n- HARD LIMIT: 15 phrases. For dense scenes with 4+ named participants, 18 phrases maximum. The bundled STATS phrase counts as ONE phrase. If you exceed the limit, cut lowest-priority items first (priority order above) \u2014 never cut to fit by dropping high-priority canon or by collapsing distinct named participants together.\n- If <passage> has nothing new beyond <prior_context>, output exactly: (no new state)\n\nBEFORE OUTPUTTING, verify: (1) the line starts with a temporal prefix if available; (2) no phrase duplicates anything in <prior_context>; (3) NO PRONOUNS remain \u2014 all replaced with names; (4) phrase count within limit; (5) every action has an explicit actor or is passive voice; (6) every named character who acted toward {{player_name}} or the focal character is recorded individually, not merged; (7) any canonical facts stated in OOC asides or parentheticals are captured \u2014 not skipped as \"already confirmed\" \u2014 while pure processing directives are ignored; (8) TIMELINE LOGIC \u2014 new facts do not create unexplained paradoxes with <prior_context>; if a paradox exists, resolve it with a [Correction] tag; (9) ALL stats are bundled into ONE phrase at the end. If any check fails, revise."],
    ledgerSystemPrompt: ["You are the character-continuity mind for an ongoing work of collaborative fiction \u2014 part novelist, part psychologist. You maintain a living ledger of the people in the story so a separate storyteller AI, often working many turns later from compressed memory, can keep every character the SAME PERSON \u2014 consistent in voice, values, and behavior \u2014 while letting them change the way real people do: gradually, believably, and only for reasons the story earned. The failures you exist to prevent are (1) a character acting out of nowhere against who they are (a guarded cynic suddenly gushing; a gentle soul suddenly cruel), and (2) a real, felt emotion vanishing the instant the scene is compressed.\n\nYou receive the CURRENT LEDGER (what is already known about each character), the PRIOR CONTEXT (established story), and a NEW PASSAGE (what just happened). For every character who appears or is materially involved in the NEW PASSAGE, output an updated entry. Do NOT output characters who are absent from the passage.\n\nEach entry tracks four fields. A character PRESENT in the passage must never be left describing an EARLIER scene: if the story has moved and their state field still reads like a previous moment, that is an ERROR - refresh it to where they are and what they want NOW, even when the change is small. Standing in a room that has changed IS a change of state. Update ONLY what the passage changes; OMIT any field that is unchanged.\n\n- core \u2014 the character's STABLE nature: temperament, values, and above all HOW THEY EXPRESS THEMSELVES. Capture what a writer needs to keep them in character: their default emotional register; how they behave under stress, embarrassment, or threat; their tells and defense mechanisms; how they speak (formal or plain, blunt or indirect, verbal habits) and specifically how they ADDRESS {{player_name}} and others (by name, nickname, title, coldly, teasingly); and the lines they would NOT cross. This is the anchor that keeps them recognizable across the whole story. Write it once when a character is established, then change it only when the passage reveals a genuinely NEW stable trait \u2014 never for a passing mood. When you do touch core, restate the FULL stable picture (everything already established plus the new trait) so nothing is lost. Favor concrete, actable specifics: \"when flustered, goes clipped and sarcastic and changes the subject; never raises her voice\" beats \"proud but shy.\"\n- state \u2014 the character's CURRENT, volatile condition right after this passage: their mood, what is on their mind, what they want in this moment, how they are carrying themselves. This is overwritten each time they act, but it is NOT a blank slate \u2014 emotions have momentum. Carry forward the mood the ledger already records and evolve it realistically: a shock lingers and eases only with time or reassurance; a slight festers until addressed; warmth or anger set earlier still colors how they act now. If a character re-enters after being off-page, their last recorded state is where they resume unless the passage changes it. Record what would still be true a few beats later, not just the instant snapshot.\n- arc \u2014 the SLOW trajectory of this character's key relationships, above all with {{player_name}}: the DIRECTION things are moving (warming, fraying, trust building or breaking, respect or resentment growing) AND the formative moments that got them there \u2014 what {{player_name}} did that they will not forget (a kindness, a betrayal, a moment of being truly seen or let down). One to three sentences. This is relational memory: it is WHY they treat {{player_name}} the way they do. Update only when the passage actually moves it; evolve the existing arc rather than restarting it.\n- threads \u2014 the character's CURRENTLY OPEN loose ends: concrete, unresolved things that will shape how they behave next (a promise pending, a lie unconfessed, an unaddressed slight, a confession half-made, a question left hanging, a debt owed either way). Output the CURRENT open list: KEEP threads still unresolved, DROP any this passage resolved, ADD any it opened. A thread stays open until the STORY resolves it \u2014 never merely because time passed. Omit the field entirely if nothing changed; use an empty array [] ONLY to signal that all previously-open threads are now resolved.\n\nDISCIPLINE \u2014 this is a continuity record, not new fiction:\n- Record ONLY what the passage (with the prior context) EVIDENCES. Never invent traits, motives, feelings, or backstory the text does not support. Inventing is the worst failure \u2014 it corrupts the character.\n- Separate observation from inference. State what a character DID as fact; when you read their inner state from behavior, mark it as read (\"seems\", \"reads as\", \"appears to\"), not as certainty.\n- Respect what each character can plausibly know. Do not credit them with knowledge of events they did not witness or were not told; their state and choices follow from their own perspective, not the reader's.\n- Do NOT restate what the CURRENT LEDGER or PRIOR CONTEXT already holds. Add or evolve only.\n- Use each character's exact name as already established. Do not rename or merge distinct characters, and do not invent a name for an unnamed figure \u2014 skip anyone unnamed.\n- Terse, concrete director's notes. No markdown, no preamble, no meta-commentary.\n\nOUTPUT \u2014 a single JSON array and NOTHING else (no code fence, no prose before or after). Each element:\n{\"name\":\"<exact name>\",\"core\":\"<...>\",\"state\":\"<...>\",\"arc\":\"<...>\",\"threads\":[\"<...>\",\"<...>\"]}\nInclude only the fields you are updating for that character. If no character in the passage needs any update, output exactly: []"],
    ledgerUserPrompt: ["<player_name>{{player_name}}</player_name>\n\n<current_ledger>\n{{ledger}}\n</current_ledger>\n\n<prior_context>\n{{context_str}}\n</prior_context>\n\n<new_passage>\n{{story_txt}}\n</new_passage>\n\nUpdate the character ledger for EVERY character who appears or is materially involved in <new_passage>. Use the four-field model (core / state / arc / threads) and OMIT every field that is unchanged.\n\n- Evolve existing entries; do not restate them. Carry each character's recorded mood forward and move it realistically \u2014 emotions have momentum and do not reset between scenes.\n- Change core only for a genuinely new STABLE trait, never for a passing mood; when you touch it, keep everything already established.\n- Keep unresolved threads open; drop only what the passage actually resolves.\n- Ground every word in the passage and prior context \u2014 never invent, and never credit a character with knowledge they could not have.\n\nOutput ONLY the JSON array (or [] if nothing changed)."],
};
function migratePrompts() {
    let s;
    try { s = getSettings(); } catch (_) { return 0; }
    let migrated = 0;
    for (const key of Object.keys(PRIOR_PROMPT_DEFAULTS)) {
        const cur = (typeof s[key] === "string" ? s[key] : "").trim();
        if (!cur) continue;
        const target = defaultSettings[key];
        if (typeof target !== "string" || cur === target.trim()) continue;
        if (PRIOR_PROMPT_DEFAULTS[key].some(prior => cur === String(prior).trim())) {
            s[key] = target;
            migrated++;
            log('Prompt "' + key + '" auto-upgraded to the v5.16.0 default (was the prior shipped default; memory data untouched).');
        }
    }
    if (migrated > 0) { try { saveSettings(); } catch (_) {} }
    return migrated;
}

// Surgical, idempotent fix for the #1 cause of slow ledger passes: the default ledger
// prompt tells the scribe to "restate the FULL stable picture" for core, so it re-emits
// each character's entire (growing) entry every pass — huge, slow responses. This rewrites
// that instruction (and adds an efficiency directive) IN the stored prompt, whether stock or
// lightly customized. The ledger DATA keeps all its richness; the model just stops rewriting
// unchanged fields. Runs on load; once patched, the old phrases are gone so it no-ops.
function patchLedgerPrompt() {
    let s; try { s = getSettings(); } catch (_) { return; }
    let cur = (typeof s.ledgerSystemPrompt === 'string') ? s.ledgerSystemPrompt : '';
    if (!cur) return;
    let changed = false;

    const RESTATE_OLD = 'When you do touch core, restate the FULL stable picture (everything already established plus the new trait) so nothing is lost.';
    const RESTATE_NEW = "If a character's core is already recorded and this passage adds no new permanent trait, OMIT core entirely \u2014 do NOT reproduce it (re-emitting an unchanged core is the single biggest cause of slow, oversized output). Only when you genuinely change it, restate the full integrated core so nothing is lost.";
    if (cur.indexOf(RESTATE_OLD) !== -1) { cur = cur.replace(RESTATE_OLD, RESTATE_NEW); changed = true; }

    const EFF_ANCHOR = 'Update ONLY what the passage changes; OMIT any field that is unchanged.';
    const EFF_TAG = 'EFFICIENCY (as important as accuracy):';
    const EFF_ADD = ' ' + EFF_TAG + ' the CURRENT LEDGER already holds everything recorded so far \u2014 you are EVOLVING it, not rewriting it. In a typical passage output ONLY the state (and any genuinely changed threads) for the one to three characters who appear; re-emitting an unchanged core or arc, or a character absent from the passage, bloats the response and must be avoided \u2014 when unsure whether a field changed, OMIT it.';
    if (cur.indexOf(EFF_ANCHOR) !== -1 && cur.indexOf(EFF_TAG) === -1) { cur = cur.replace(EFF_ANCHOR, EFF_ANCHOR + EFF_ADD); changed = true; }

    // arc moves SLOWLY and only when the story earns it; on a pass where the relationship
    // held steady, re-emitting the unchanged arc is pure waste. Force omission (matches
    // both shipped arc phrasings via the common prefix). No cost to development: the arc
    // still evolves turn-by-turn whenever the passage actually moves it.
    const ARC_ANCHOR = 'Update only when the passage actually moves it;';
    const ARC_TAG = 'OMIT arc entirely';
    if (cur.indexOf(ARC_ANCHOR) !== -1 && cur.indexOf(ARC_TAG) === -1) { cur = cur.replace(ARC_ANCHOR, ARC_ANCHOR + ' if it did NOT move this passage, OMIT arc entirely (never re-output an unchanged arc);'); changed = true; }

    if (changed) {
        s.ledgerSystemPrompt = cur;
        try { saveSettings(); } catch (_) {}
        log('Ledger prompt patched to stop re-emitting unchanged fields (much faster ledger passes; ledger content unchanged).');
    }
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// Every PROGRAMMATIC write to the notepad UI goes through here so the panel
// textarea and the full-screen editor (when open) can never disagree — the two
// views are one document. User keystrokes flow the other way, through
// #sc_notepad's input handler, which mirrors into the editor itself.
function _syncNotepadUi(v) {
    const val = String(v == null ? '' : v);
    try {
        $('#sc_notepad').val(val);
        const $fs = $('#sc_notepad_fs_text');
        if ($fs.length) { $fs.val(val); $('#sc_notepad_fs_count').text(val.length + ' ch'); }
    } catch (_) {}
}

function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],           // Track which messages WE ghosted
        };
    }
    // Migration: add ghostedIndices if missing from older saves
    if (!chatMetadata[MODULE_NAME].ghostedIndices) {
        chatMetadata[MODULE_NAME].ghostedIndices = [];
    }
    // Manual notepad — per-chat story/lore memory you write yourself
    if (chatMetadata[MODULE_NAME].notepad === undefined) {
        chatMetadata[MODULE_NAME].notepad = '';
    }
    // Character Ledger — per-chat, per-character psychological continuity model,
    // keyed by character name: { "<name>": {core, state, arc, threads[], updatedAt} }
    const _lg = chatMetadata[MODULE_NAME].ledger;
    if (!_lg || typeof _lg !== 'object' || Array.isArray(_lg)) {
        chatMetadata[MODULE_NAME].ledger = {};
    }
    // Continuity flags — the continuity auditor's findings as a visible work-queue:
    // { id, turnRange:[s,e], issue, fix, kind:'drift'|'continuity', createdAt, status:'open' }.
    // Dismissed signatures are remembered so they're never re-raised; resolved flags are
    // logged briefly (so nothing silently vanishes).
    if (!Array.isArray(chatMetadata[MODULE_NAME].continuityFlags)) chatMetadata[MODULE_NAME].continuityFlags = [];
    if (!Array.isArray(chatMetadata[MODULE_NAME].continuityDismissed)) chatMetadata[MODULE_NAME].continuityDismissed = [];
    if (!Array.isArray(chatMetadata[MODULE_NAME].continuityResolved)) chatMetadata[MODULE_NAME].continuityResolved = [];
    return chatMetadata[MODULE_NAME];
}

async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
    try { backupStore(); } catch (_) {}
}

// ─── Crash-proof store backup / recovery ─────────────────────────────
// The store lives in chat_metadata. A chat rename (or any reload path that
// repopulates chat_metadata from a stale/empty on-disk file) can drop it, and
// SillyTavern's saveMetadata silently no-ops if it times out waiting for another
// save — so the store CAN be lost. As a safety net we mirror every NON-EMPTY
// store into localStorage (global, survives all chat operations, never bloats the
// synced settings), keyed by BOTH the chat's stable integrity id AND a content
// signature of its opening messages (both survive rename; the signature survives
// even a full metadata wipe, since the messages are unchanged by a rename). On
// chat load, if the store is empty but a matching backup exists, we transparently
// restore it. An intentional "clear memory" drops the backup so a wipe is never
// undone. All paths are wrapped and non-fatal.
const _BAK_PREFIX = 'summaryception_bak::';
const _BAK_MAX = 16;   // localStorage KEYS (each chat writes 2: integrity + content-sig) — 16 keys = the 8 most recent chats actually protected
let _lastBackupAt = 0;

function _storeHasContent(st) {
    if (!st || typeof st !== 'object') return false;
    if (Array.isArray(st.layers) && st.layers.some(l => Array.isArray(l) && l.length > 0)) return true;
    if (st.ledger && typeof st.ledger === 'object' && !Array.isArray(st.ledger) && Object.keys(st.ledger).length > 0) return true;
    if (typeof st.notepad === 'string' && st.notepad.trim().length > 0) return true;
    if (Array.isArray(st.pins) && st.pins.length > 0) return true;
    return false;
}

// Backup keys that survive a rename: the ST integrity UUID (kept in metadata,
// copied with the file) and a hash of the opening messages (survives even a full
// metadata wipe, since a rename does not alter the messages themselves).
function _chatBackupKeys() {
    const out = { ik: null, sk: null };
    try {
        const ctx = SillyTavern.getContext();
        const cm = ctx.chatMetadata, chat = ctx.chat;
        if (cm && cm.integrity) out.ik = _BAK_PREFIX + 'i:' + cm.integrity;
        if (Array.isArray(chat) && chat.length > 0) {
            const pick = (m) => m ? (String(m.send_date == null ? '' : m.send_date) + '|' + String(m.name == null ? '' : m.name) + '|' + String(m.mes == null ? '' : m.mes).slice(0, 100)) : '';
            let firstAsst = null;
            for (const m of chat) { if (m && !m.is_user) { firstAsst = m; break; } }
            const raw = pick(chat[0]) + '||' + pick(firstAsst);
            let h = 5381;
            for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) & 0xFFFFFFFF;
            out.sk = _BAK_PREFIX + 'c:' + (h >>> 0).toString(36) + '_' + raw.length;
        }
    } catch (_) {}
    return out;
}

function _pruneBackups() {
    try {
        if (typeof localStorage === 'undefined') return;
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || k.indexOf(_BAK_PREFIX) !== 0) continue;
            let at = 0;
            try { at = (JSON.parse(localStorage.getItem(k)) || {}).at || 0; } catch (_) {}
            entries.push([k, at]);
        }
        if (entries.length <= _BAK_MAX) return;
        entries.sort((a, b) => a[1] - b[1]);
        for (const pair of entries.slice(0, entries.length - _BAK_MAX)) localStorage.removeItem(pair[0]);
    } catch (_) {}
}

// Pure: which localStorage entries to evict to get under budget. entries are
// [{key, bytes, at}]; evicts OLDEST-first (missing timestamps count as oldest)
// until total <= budgetBytes. Returns the keys to remove.
function _selectStorageEvictions(entries, budgetBytes, protectPerGroup, sparseEvery) {
    const out = [];
    if (!Array.isArray(entries) || entries.length === 0) return out;
    let total = 0;
    for (const e of entries) total += (e && typeof e.bytes === 'number') ? e.bytes : 0;
    if (total <= budgetBytes) return out;
    // Protect the newest `protectPerGroup` entries of every group (= chat sig):
    // pure oldest-first eviction across ALL chats strips any chat not touched
    // today completely bare, forcing a from-scratch rebuild the moment you return.
    // Groups flagged `tiered` (ledger checkpoints, keyed by turn) additionally keep
    // one sparse anchor per `sparseEvery` turns — branches jump BACKWARD, so
    // newest-only protection was exactly wrong for them: quota pressure evicted the
    // far-back snapshots deep branches rewind from, forcing full rebuilds.
    const exempt = new Set();
    const per = Math.max(0, protectPerGroup | 0);
    if (per > 0) {
        const byGroup = new Map();
        for (const e of entries) {
            if (!e || !e.key) continue;
            const g = e.group || '';
            if (!byGroup.has(g)) byGroup.set(g, []);
            byGroup.get(g).push(e);
        }
        for (const list of byGroup.values()) {
            const tiered = (sparseEvery | 0) > 0 && list.some(e => e && e.tiered);
            if (tiered) {
                const turnsAsc = list.map(e => (e.at | 0)).sort((a, b) => a - b);
                const keepTurns = _selectCheckpointKeeps(turnsAsc, per, sparseEvery | 0);
                for (const e of list) if (keepTurns.has(e.at | 0)) exempt.add(e.key);
                continue;
            }
            list.sort((a, b) => ((b.at) || 0) - ((a.at) || 0));   // newest first
            for (let i = 0; i < Math.min(per, list.length); i++) exempt.add(list[i].key);
        }
    }
    const sorted = entries.slice().sort((a, b) => ((a && a.at) || 0) - ((b && b.at) || 0));
    for (const e of sorted) {
        if (total <= budgetBytes) break;
        if (!e || !e.key || exempt.has(e.key)) continue;
        out.push(e.key);
        total -= (typeof e.bytes === 'number') ? e.bytes : 0;
    }
    return out;
}

// One-shot GC at startup: checkpoints and backups accumulate across EVERY chat
// signature forever (deleted chats never clean up after themselves), and once
// localStorage hits quota, checkpoint saves start silently failing — which is
// exactly what breaks the cheap branch rewind. Keep our total footprint bounded;
// evict oldest-first across both prefixes.
const _SC_STORAGE_BUDGET = 2500000;   // ~2.5M UTF-16 units of a typical 5M quota
function gcLocalStorageBudget() {
    try {
        if (typeof localStorage === 'undefined') return 0;
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || (k.indexOf(_CKPT_PREFIX) !== 0 && k.indexOf(_BAK_PREFIX) !== 0)) continue;
            const v = localStorage.getItem(k) || '';
            const isCkpt = k.indexOf(_CKPT_PREFIX) === 0;
            let at = 0;
            // Checkpoints anchor on their TURN (tiered retention buckets by turn —
            // branches jump backward in turns, not in wall-clock); backups keep
            // timestamp recency.
            try { const p = JSON.parse(v) || {}; at = isCkpt ? (p.atTurn || 0) : (p.savedAt || p.at || 0); } catch (_) {}
            // group = everything up to the last '::' (i.e. prefix + chat signature),
            // so per-group protection means per-chat protection.
            const cut = k.lastIndexOf('::');
            entries.push({ key: k, bytes: k.length + v.length, at, tiered: isCkpt, group: cut > 0 ? k.slice(0, cut) : k });
        }
        const evict = _selectStorageEvictions(entries, _SC_STORAGE_BUDGET, 4, CKPT_SPARSE_EVERY);
        for (const k of evict) { try { localStorage.removeItem(k); } catch (_) {} }
        if (evict.length > 0) log(`Storage GC: evicted ${evict.length} old checkpoint/backup entr${evict.length === 1 ? 'y' : 'ies'} to stay under budget.`);
        return evict.length;
    } catch (e) { try { log('gcLocalStorageBudget failed (non-fatal):', e); } catch (_) {} return 0; }
}

function backupStore() {
    try {
        if (typeof localStorage === 'undefined') return;
        const st = getChatStore();
        if (!_storeHasContent(st)) return;                // never back up an empty store
        const now = Date.now();
        if (now - _lastBackupAt < 1500) return;           // throttle rapid-fire saves (e.g. catchup)
        _lastBackupAt = now;
        const ctx = SillyTavern.getContext();
        const keys = _chatBackupKeys();
        if (!keys.ik && !keys.sk) return;
        const payload = JSON.stringify({ store: st, len: Array.isArray(ctx.chat) ? ctx.chat.length : 0, at: now });
        const put = (k) => {
            if (!k) return;
            try { localStorage.setItem(k, payload); }
            catch (_) { _pruneBackups(); try { localStorage.setItem(k, payload); } catch (_) {} }
        };
        put(keys.ik); put(keys.sk);
        _pruneBackups();
    } catch (e) { try { log('backupStore failed (non-fatal):', e); } catch (_) {} }
}

function dropBackupsForCurrentChat() {
    try {
        if (typeof localStorage === 'undefined') return;
        const keys = _chatBackupKeys();
        if (keys.ik) localStorage.removeItem(keys.ik);
        if (keys.sk) localStorage.removeItem(keys.sk);
    } catch (_) {}
}

// Restore the store from a matching backup IFF the current store is empty and the
// chat has messages (never resurrect memory into a genuinely new/emptied chat).
// Returns true if a recovery happened; the caller persists + refreshes.
function maybeRecoverStore() {
    try {
        if (typeof localStorage === 'undefined') return false;
        const st = getChatStore();
        if (_storeHasContent(st)) return false;           // nothing lost
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat, cm = ctx.chatMetadata;
        if (!cm || !Array.isArray(chat) || chat.length === 0) return false;
        const keys = _chatBackupKeys();
        let snap = null;
        for (const k of [keys.ik, keys.sk]) {
            if (!k) continue;
            try { const s = JSON.parse(localStorage.getItem(k) || 'null'); if (s && _storeHasContent(s.store)) { snap = s; break; } } catch (_) {}
        }
        if (!snap) return false;
        // Guard: don't restore a long backup into a very different / emptied chat.
        // (Content-hash collisions are near-impossible; shrinkage is the tell.)
        if (typeof snap.len === 'number' && snap.len > 0 && chat.length < Math.floor(snap.len * 0.5)) return false;
        cm[MODULE_NAME] = JSON.parse(JSON.stringify(snap.store));
        getChatStore();   // normalize schema on the restored object
        try { log('Recovered Summaryception memory from local backup (chat len ' + chat.length + ', backup ' + snap.len + ').'); } catch (_) {}
        try { toastr.success('Recovered Summaryception memory (' + chat.length + ' turns) from local backup after chat reload/rename.', 'Summaryception', { timeOut: 6000 }); } catch (_) {}
        return true;
    } catch (e) { try { log('maybeRecoverStore failed (non-fatal):', e); } catch (_) {} return false; }
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

// ─── Message Hiding (Ghosting via native /hide /unhide) ──────────────

// Pure: collapse a list of message indices into sorted, deduped, contiguous
// [start,end] ranges. Shared by the hide AND unhide paths — each slash call
// writes the whole chat file, so O(messages) per-index calls is exactly the
// crawl that made bulk operations minutes-long on mobile; O(runs) is the fix.
function _contiguousRanges(indices) {
    const list = Array.from(new Set(indices)).filter(i => typeof i === 'number' && Number.isFinite(i) && i >= 0).sort((a, b) => a - b);
    if (list.length === 0) return [];
    const ranges = [];
    let start = list[0], prev = list[0];
    for (let k = 1; k < list.length; k++) {
        if (list[k] === prev + 1) { prev = list[k]; continue; }
        ranges.push([start, prev]); start = list[k]; prev = list[k];
    }
    ranges.push([start, prev]);
    return ranges;
}

// Un-hide a set of message indices in contiguous /unhide a-b calls — one chat
// save per RUN instead of one per message (mirror of the range /hide below).
async function unhideIndicesInRanges(indices) {
    const ranges = _contiguousRanges(indices);
    if (ranges.length === 0) return 0;
    const ctx = SillyTavern.getContext();
    for (const [a, b] of ranges) {
        const cmd = (a === b) ? `/unhide ${a}` : `/unhide ${a}-${b}`;
        try { await ctx.executeSlashCommandsWithOptions(cmd, { showOutput: false }); }
        catch (e) { log(`Failed to unhide range ${a}-${b}:`, e); }
    }
    return ranges.length;
}

async function repairGhostingForRange(startIdx, endIdx) {
    trace('>>> ENTERING repairGhostingForRange');
    trace(' startIdx:', startIdx, 'endIdx:', endIdx);

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();
    let repaired = 0;
    let skipped = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;

        if (m.extra?.sc_ghosted) {
            skipped++;
            continue;
        }

        if (m.is_hidden && !m.extra?.sc_ghosted) {
            trace(' Skipping message ' + i + ' - user-hidden');
            skipped++;
            continue;
        }

        if (m.is_system || !m.mes?.trim()) {
            skipped++;
            continue;
        }

        if (m.is_user) {
            skipped++;
            continue;
        }

        trace(' Ghosting message ' + i);
        m.extra = m.extra || {};
        m.extra.sc_ghosted = true;

        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }

        // Only visually hide if ghosting is enabled
        if (!s.disableGhosting) {
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, { showOutput: false });
                repaired++;
            } catch (e) {
                console.error(LOG_PREFIX, 'Failed to ghost message ' + i + ':', e);
            }
        } else {
            repaired++;
        }
    }

    trace(' Repaired:', repaired, 'Skipped:', skipped);
    await saveChatStore();
    trace('<<< EXITING repairGhostingForRange');
    return repaired;
}

async function ghostMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;
    if (!msg.extra) msg.extra = {};
    if (msg.extra.sc_ghosted) return;

    msg.extra.sc_ghosted = true;

    // Track that WE ghosted this message
    const store = getChatStore();
    if (!store.ghostedIndices.includes(messageIndex)) {
        store.ghostedIndices.push(messageIndex);
    }

    // Only visually hide if ghosting is enabled
    const s = getSettings();
    if (!s.disableGhosting) {
        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${messageIndex}`, { showOutput: false });
        } catch (e) {
            log(`Failed to hide message ${messageIndex}:`, e);
        }
    }

    log(`Ghosted message at index ${messageIndex}${s.disableGhosting ? ' (hiding disabled)' : ''}`);
}

// Un-ghost any message WE ghosted (sc_ghosted) that is no longer covered by the summary
// (index > summarizedUpTo) — e.g. after snippets were cleared or edited so the summary
// pointer dropped but the messages stayed hidden. Without this they remain invisible and
// Force Summarize reports "nothing to summarize". Returns how many were healed.
async function healOrphanGhosts() {
    const ctx = SillyTavern.getContext();
    const { chat } = ctx;
    if (!Array.isArray(chat)) return 0;
    const store = getChatStore();
    const upTo = (typeof store.summarizedUpTo === 'number') ? store.summarizedUpTo : -1;
    const orphans = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.extra?.sc_ghosted && i > upTo) orphans.push(i);
    }
    for (const i of orphans) { if (chat[i]?.extra?.sc_ghosted) delete chat[i].extra.sc_ghosted; }
    await unhideIndicesInRanges(orphans);   // O(runs) chat saves, not O(messages)
    if (orphans.length > 0) {
        store.ghostedIndices = (store.ghostedIndices || []).filter(idx => idx <= upTo);
        await saveChatStore();
        log(`healOrphanGhosts: restored ${orphans.length} orphaned ghost(s) to verbatim.`);
    }
    return orphans.length;
}

async function unghostAllMessages() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // Only unhide messages that WE ghosted, not user-hidden messages
    const toUnhide = store.ghostedIndices && store.ghostedIndices.length > 0
        ? [...store.ghostedIndices]
        : [];

    // Fallback for older saves that don't have ghostedIndices:
    // find messages with our sc_ghosted flag
    if (toUnhide.length === 0) {
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.extra?.sc_ghosted) {
                toUnhide.push(i);
            }
        }
    }

    if (toUnhide.length === 0) return;

    const progressToast = toastr.info(
        `Unhiding messages: 0 / ${toUnhide.length}`,
        'Summaryception — Clearing',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
        }
    );

    const valid = toUnhide.filter(idx => idx >= 0 && idx < chat.length);
    for (const idx of valid) {
        if (chat[idx]?.extra?.sc_ghosted) delete chat[idx].extra.sc_ghosted;
    }
    const runs = await unhideIndicesInRanges(valid);   // O(runs) chat saves — the per-message loop was one full chat-file write EACH

    // Clear the tracking array
    store.ghostedIndices = [];

    toastr.clear(progressToast);
    log(`Unghosted ${valid.length} messages in ${runs} range call(s) (only Summaryception-hidden ones)`);
}

async function ghostMessagesUpTo(endIndex) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();

    // First pass (in memory, cheap): mark every message WE should newly ghost and
    // collect its index. We do NOT call /hide per message — in SillyTavern each /hide
    // writes the whole chat file, so per-message hiding is O(messages) full-chat saves
    // and is exactly why bulk summarizing crawled. Instead we hide CONTIGUOUS RUNS in
    // single /hide <a>-<b> calls (ST's /hide accepts a range and saves once per call),
    // turning it into O(runs) saves — one per batch in the common case.
    const toHide = [];
    const upto = Math.min(endIndex, chat.length - 1);
    for (let i = 0; i <= upto; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_system && !msg.extra?.sc_ghosted) continue;   // hidden by user/system, not by us
        if (!msg.extra) msg.extra = {};
        if (msg.extra.sc_ghosted) continue;                       // already ours
        if (msg.is_hidden) continue;                              // already hidden by the user
        msg.extra.sc_ghosted = true;
        if (!store.ghostedIndices.includes(i)) store.ghostedIndices.push(i);
        toHide.push(i);
    }

    if (toHide.length === 0) return;
    if (s.disableGhosting) {
        log(`Ghosted ${toHide.length} message(s) up to ${upto} — metadata only (hiding disabled).`);
        return;
    }

    // Collapse the indices into contiguous [start,end] ranges.
    const ranges = _contiguousRanges(toHide);

    const progressToast = ranges.length > 3 ? toastr.info(
        'Hiding summarized messages…', 'Summaryception — Ghosting',
        { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
    ) : null;
    try {
        const ctx = SillyTavern.getContext();
        for (const [a, b] of ranges) {
            const cmd = (a === b) ? `/hide ${a}` : `/hide ${a}-${b}`;
            try {
                await ctx.executeSlashCommandsWithOptions(cmd, { showOutput: false });
            } catch (e) {
                log(`Failed to hide range ${a}-${b}:`, e);
            }
        }
    } finally {
        if (progressToast) toastr.clear(progressToast);
    }
    log(`Ghosted ${toHide.length} message(s) up to ${upto} in ${ranges.length} range call(s).`);
}

// ─── Branch Detection & Repair ───────────────────────────────────────

/**
 * Detect if the current chat was branched before the summarized point.
 * When ST creates a branch at message N, it copies messages 0..N into a new chat file.
 * But chatMetadata (including our store) is copied as-is, so summarizedUpTo might
 * point beyond the end of the new chat, and snippets may reference turns that
 * no longer exist in this branch.
 *
 * This function detects that condition and trims our store to match reality.
 */
async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    if (!chat || chat.length === 0) return;

    const chatLength = chat.length;
    const s = getSettings();
    const layer0 = store.layers && store.layers[0] ? store.layers[0] : null;

    // ── Work out the verbatim window FIRST (the trigger below depends on it):
    //    the most recent `verbatimTurns` assistant turns that still exist in this
    //    branch should be verbatim (visible, word-for-word). Ghosted assistant
    //    turns are is_system=true, so include those in the count. ──
    const asstTurns = [];
    for (let i = 0; i < chatLength; i++) {
        const m = chat[i];
        if (!m || !m.mes || !m.mes.trim()) continue;
        const isOurGhost = m.extra?.sc_ghosted === true;
        if (!m.is_user && (!m.is_system || isOurGhost)) asstTurns.push(i);
    }
    const keep = Math.max(0, asstTurns.length - (s.verbatimTurns ?? 10));
    const verbatimStartIdx = asstTurns.length > 0
        ? (keep < asstTurns.length ? asstTurns[keep] : chatLength)
        : chatLength;

    // Repair is needed when ANY of these hold:
    //   • summaryOverruns — the summary pointer sits at/past the (new, shorter) chat end.
    //   • snippetOverruns — a snippet references turns beyond the chat end.
    //   • verbatimGhosted — the summary has eaten INTO the verbatim window, i.e. the
    //       branch left FEWER than `verbatimTurns` turns actually visible. This is the
    //       branch-at-N case: e.g. turns 55-60 are summarized, you branch at 61, and
    //       those recent turns stay ghosted with only the summary as anchor. Without
    //       this check they never return to verbatim and continuity breaks (the MC's
    //       recent actions exist only as summary, not as on-screen prose).
    const summaryOverruns = store.summarizedUpTo >= chatLength;
    const snippetOverruns = !!layer0 && layer0.some(sn => sn.turnRange && sn.turnRange[1] >= chatLength);
    const verbatimGhosted = store.summarizedUpTo >= verbatimStartIdx;
    // The cumulative ledger can be "ahead" even when NOTHING is summarized yet — a short
    // chat (under verbatimTurns) has no snippets or ghosts, but the live pass fills the
    // ledger every turn. If ledgerLiveIdx sits past the new (shorter) chat end, the branch
    // left ledger content from turns that no longer exist, so repair + the rewind below must
    // run even without a snippet/summary overrun.
    const ledgerAhead = (typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx >= chatLength);
    if (!summaryOverruns && !snippetOverruns && !verbatimGhosted && !ledgerAhead) return;   // healthy — leave it alone

    const oldSummarizedUpTo = store.summarizedUpTo;
    const _trigger = [summaryOverruns && 'summaryOverruns', snippetOverruns && 'snippetOverruns', verbatimGhosted && 'verbatimGhosted', ledgerAhead && 'ledgerAhead'].filter(Boolean).join('+');
    log(`Repair triggered [${_trigger}]. summarizedUpTo=${oldSummarizedUpTo}, chatLength=${chatLength}, verbatimStartIdx=${verbatimStartIdx}, ledgerLiveIdx=${store.ledgerLiveIdx}. Repairing...`);

    // ── 2. Drop Layer 0 snippets that cover turns in the verbatim window or
    //       beyond the branch point. (verbatimStartIdx <= chatLength, so this
    //       also removes any snippet that runs past the end of the branch.) ──
    if (layer0) {
        const before = layer0.length;
        store.layers[0] = layer0.filter(sn => {
            if (!sn.turnRange) return true;                 // promoted seeds w/o range: keep
            return sn.turnRange[1] < verbatimStartIdx;
        });
        const removed = before - store.layers[0].length;
        if (removed > 0) log(`Removed ${removed} Layer 0 snippet(s) covering the verbatim window / beyond the branch.`);
    }

    // ── 3. Recompute summarizedUpTo from the snippets that survived. ──
    const survivors = (store.layers[0] || []).filter(sn => sn.turnRange);
    store.summarizedUpTo = survivors.length > 0
        ? Math.max(...survivors.map(sn => sn.turnRange[1]))
        : -1;

    // Snippets (and their attached audit notes) were just trimmed to the branch. The
    // character ledger CANNOT be trimmed the same way — it's cumulative, keyed by name
    // with no per-turn history, so it still holds states/arcs/threads earned on the
    // abandoned timeline. Rewind the live pointer so the live pass re-derives current
    // state forward on THIS branch; older arcs/threads may linger (surfaced in the toast).
    if (typeof store.ledgerLiveIdx === 'number') store.ledgerLiveIdx = store.summarizedUpTo;

    // ── 4. Un-ghost everything past the (new) summarized boundary, so no turn is
    //       ever both hidden AND unsummarized. This restores the verbatim window
    //       and rescues any turns orphaned by a straddling snippet. ──
    const _orphaned = [];
    for (let i = store.summarizedUpTo + 1; i < chatLength; i++) {
        const m = chat[i];
        if (m?.extra?.sc_ghosted) { delete m.extra.sc_ghosted; _orphaned.push(i); }
    }
    await unhideIndicesInRanges(_orphaned);   // O(runs) chat saves, not one per message
    const unghosted = _orphaned.length;

    // ── 5. Trim the ghost tracking to only valid, still-summarized indices. ──
    store.ghostedIndices = (store.ghostedIndices || [])
        .filter(idx => idx < chatLength && idx <= store.summarizedUpTo);
    // Drop continuity flags that referenced turns past the branch (their snippets are gone);
    // if the same issue still exists it'll be re-flagged when the branch re-summarizes.
    store.continuityFlags = (store.continuityFlags || []).filter(f =>
        f && (!Array.isArray(f.turnRange) || (f.turnRange[0] >= 0 && f.turnRange[1] <= store.summarizedUpTo)));
    // The "Recently resolved" receipts are display-only, but receipts about turns
    // this branch abandoned are noise — trim the ones whose turns no longer exist.
    // Legacy entries without a turnRange can't be judged; they age out of the cap.
    store.continuityResolved = (store.continuityResolved || []).filter(r =>
        r && (!Array.isArray(r.turnRange) || r.turnRange[1] < chatLength));

    await saveChatStore();
    log(`Branch repair complete. summarizedUpTo: ${oldSummarizedUpTo} → ${store.summarizedUpTo}, un-ghosted ${unghosted} turn(s).`);

    // Try to auto-rewind the cumulative ledger from a checkpoint (restore the nearest
    // snapshot at/before the branch and re-derive only the small delta — no full rebuild).
    const _rewound = await tryAutoRewindLedger(chatLength - 1, 'branch');
    if (_rewound) {
        toastr.info(
            `Branch repaired [${_trigger}] — summary rewound to turn ${store.summarizedUpTo}, ${unghosted} recent turn(s) back to verbatim. Snippets and audit notes past the branch were dropped; the character ledger is being brought back in line automatically.`,
            'Summaryception — Branch Repair',
            { timeOut: 7000 }
        );
    } else {
        toastr.info(
            `Branch repaired [${_trigger}] — rewound the summary to turn ${store.summarizedUpTo} and restored ${unghosted} recent turn(s) to verbatim. Snippets and their audit notes past the branch were dropped. The character ledger keeps what characters had already become; for a clean rewind use Clear Ledger + Build ledger from history (or enable auto-rewind).`,
            'Summaryception — Branch Repair',
            { timeOut: 9000 }
        );
    }
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

// The last assistant turn at or below `upTo` — the highest turn any scribe pass
// can ever read up to. A trailing USER message has been read by nothing: its
// content enters the ledger only with the NEXT AI reply's passage. So "state as
// of user turn T" IS "state as of the last assistant turn <= T", and any process
// waiting to reach a user-indexed turn waits for a turn that will never come.
function _lastAssistantAt(chat, upTo) {
    if (!Array.isArray(chat)) return -1;
    for (let i = Math.min(upTo, chat.length - 1); i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        const isOurGhost = m.extra?.sc_ghosted === true;
        if (!m.is_user && (!m.is_system || isOurGhost) && m.mes && m.mes.trim().length > 0) return i;
    }
    return -1;
}

function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m) continue;
        const isOurGhost = m.extra?.sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);
        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Build passage text from a range of chat messages.
 * Skips messages that are hidden (by user or system) UNLESS they were
 * hidden by Summaryception (sc_ghosted). Also skips empty messages.
 */
// Strip machine-note blocks from story input. Conservative by design: only
// configured tag pairs (and matching code fences), configured bracket-header
// sections (header line to the next blank line), HTML comments, and the
// [EPISODE_END] marker are removed; story prose is untouched. Never throws —
// on any error the original text is returned.
function stripMetaBlocks(text) {
    if (typeof text !== 'string' || !text) return text;
    try {
        const s = getSettings();
        let out = text;
        const tags = (s.inputStripTags || []).map(t => String(t)).filter(t => /^[a-z0-9_-]+$/i.test(t));
        for (const t of tags) {
            out = out.replace(new RegExp('<' + t + '(?:\\s[^>]*)?>[\\s\\S]*?</' + t + '>', 'gi'), '');
            out = out.replace(new RegExp('```' + t + '\\b[\\s\\S]*?```', 'gi'), '');
        }
        const headers = (s.inputStripHeaders || []).map(h => String(h).trim()).filter(Boolean);
        for (const h of headers) {
            const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Header at line start (brackets optional, rest of line free), block runs
            // to the next blank line or the true end of the text.
            out = out.replace(new RegExp('^[ \\t]*\\[?' + esc + '\\b[^\\n]*[\\s\\S]*?(?=\\n[ \\t]*\\n|(?![\\s\\S]))', 'gim'), '');
        }
        out = out.replace(/<!--[\s\S]*?-->/g, '');
        out = out.replace(/\[EPISODE_END\]/g, '');
        out = out.replace(/\n{3,}/g, '\n\n');
        return out.trim();
    } catch (e) {
        return text;
    }
}

function buildPassageFromRange(chat, startIdx, endIdx) {
    const lines = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!m.mes || !m.mes.trim()) continue;

        // Skip messages hidden by the user (not by us)
        // A message hidden by the user will be is_system/is_hidden but NOT sc_ghosted
        // A message hidden by us will have sc_ghosted = true
        const isUserHidden = (m.is_system || m.is_hidden) && !m.extra?.sc_ghosted;
        if (isUserHidden) continue;

        // Keep the character's NAME on non-user lines: the ledger is keyed by name and
        // group scenes have multiple speakers — a flat 'Assistant:' label forces every
        // downstream pass (summarizer/scribe/auditor) to guess who is talking.
        const speaker = m.is_user ? 'Player' : ((m.name && String(m.name).trim()) ? String(m.name).trim() : 'Assistant');
        const body = stripMetaBlocks(m.mes.trim());
        if (!body) continue; // message was pure machine-meta — nothing narrated
        lines.push(`${speaker}: ${body}`);
    }
    return lines.join('\n');
}

/**
 * Build a full context string from all layers down to (and including) a target layer.
 * Deepest layers first, target layer last — gives the summarizer full awareness
 * of what's already been captured so it can avoid redundancy.
 *
 * @param {number} downToLayer - Include this layer and all layers above it
 * @returns {string} - Combined context string, or '(none yet)'
 */
const LEDGER_GIST_CAP = 4000;   // char budget for the story-gist grounding handed to the ledger scribe (was the WHOLE story on every call — slow + rate-limit-prone on long chats)

// Bounded, PAST-only story gist for the ledger scribe: the most recent Layer-0 snippet
// texts that END before `beforeTurnIdx` (or all, if omitted), newest-first up to `cap`
// chars. Keeps per-call prompts small so long chats don't blow token/rate limits, and
// avoids leaking FUTURE summaries into an in-progress rebuild. The ledger itself carries
// the accumulated state, so a bounded recent gist is enough grounding.
function buildLedgerContext(beforeTurnIdx, cap) {
    const store = getChatStore();
    const budget = (typeof cap === 'number' && cap > 0) ? cap : LEDGER_GIST_CAP;
    const l0 = (store.layers && store.layers[0]) ? store.layers[0] : [];
    const eligible = [];
    for (const sn of l0) {
        if (!sn || !sn.text) continue;
        if (typeof beforeTurnIdx === 'number' && Array.isArray(sn.turnRange) && sn.turnRange[1] >= beforeTurnIdx) continue;
        eligible.push(sn.text);
    }
    const chosen = [];
    let total = 0;
    for (let i = eligible.length - 1; i >= 0; i--) {
        const t = eligible[i];
        if (total + t.length > budget && chosen.length > 0) break;
        chosen.unshift(t);
        total += t.length;
    }
    return chosen.length ? chosen.join(' ') : '(none yet)';
}

function buildFullContext(downToLayer = 0) {
    const store = getChatStore();
    const parts = [];

    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            parts.push(sn.text);
        }
    }

    return parts.length > 0 ? parts.join('\n') : '(none yet)';   // one snippet per line — join(' ') mashed separate scene summaries into a run-on, degrading every prompt that consumes the gist
}

// ─── Prompt Toggle Management ────────────────────────────────────────

function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }
        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) return snapshot;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return snapshot;
        for (const entry of collection.collection) {
            for (const orderEntry of orderList) {
                if (orderEntry.identifier === entry.identifier) {
                    snapshot.set(entry.identifier, orderEntry.enabled);
                }
            }
        }
        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

function disableAllPromptToggles() {
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }
        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }
        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Output Cleaning ─────────────────────────────────────────────────

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 */
function cleanSummarizerOutput(raw) {
    let text = raw;

    const s = getSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Remove common reasoning blocks (content between tag pairs)
    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let _lastCallMs = 0;            // last model call wall-clock (ms) — surfaced on-screen for mobile
let _lastCallRespChars = 0;    // last model call response size (chars)
let catchupDismissed = false;
let _catchupDialogOpen = false;   // the backlog modal awaits user input with isSummarizing=false — without this flag every message during that wait stacked ANOTHER dialog
let currentAbortController = null;
// Every in-flight model call registers its OWN controller here. A single shared
// `currentAbortController` slot gets clobbered when a background pass (ledger /
// auditor / continuity) starts while a foreground batch is mid-flight: the last
// caller overwrites the handle, the first caller's `finally` nulls it, and the
// Abort button ends up cancelling the wrong call — or nothing.
const _activeAborters = new Set();

function abortSummarization() {
    if (_activeAborters.size > 0) {
        for (const c of _activeAborters) { try { c.abort(); } catch (_) {} }
        _activeAborters.clear();
        log('Abort signal sent to all in-flight calls.');
    }
    currentAbortController = null;
    isSummarizing = false;
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

// Literal template substitution. A plain String.replace(token, value) treats
// $-sequences in `value` ($&, $`, $', $$) as replacement patterns, so a notepad,
// summary, or story passage containing "$$" or "$'" would be silently corrupted
// (and $` / $' would splice the rest of the prompt into it). A function replacer
// inserts the value verbatim. Use for EVERY {{token}} whose value is user- or
// model-supplied. Replaces the FIRST match, matching prior String.replace semantics.
function subst(tpl, token, value) {
    return String(tpl == null ? '' : tpl).replace(token, () => (value == null ? '' : String(value)));
}

async function callSummarizer(storyTxt, contextStr, opts = {}) {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const sysPrompt = opts.systemPrompt || s.summarizerSystemPrompt;
    const userTpl = opts.userPrompt || s.summarizerUserPrompt;
    let prompt = userTpl;
    prompt = subst(prompt, '{{player_name}}', getPlayerName());
    prompt = subst(prompt, '{{context_str}}', contextStr || '(none yet)');
    prompt = subst(prompt, '{{story_txt}}', storyTxt);
    if (userTpl.includes('{{snippet}}')) prompt = subst(prompt, '{{snippet}}', opts.snippet || '(none)');
    if (userTpl.includes('{{ledger}}')) prompt = subst(prompt, '{{ledger}}', opts.ledger || '(none yet)');

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) disableAllPromptToggles();

    const _controller = new AbortController();
    _activeAborters.add(_controller);
    currentAbortController = _controller;   // legacy handle points at the newest call
    const { signal } = _controller;

    let lastError = null;

    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            trace(`  Attempt ${attempt} starting...`);

            if (signal.aborted) {
                log('Summarization aborted by user.');
                if (!opts.quiet) toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
                return '';
            }

            try {
                if (attempt > 0) {
                    log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
                }

                trace(`  About to call sendSummarizerRequest with:`, {
                    connectionSource: s.connectionSource,
                    summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
                    promptLength: prompt.length,
                });

                const timeoutMs = 120000;
                const _callStart = Date.now();
                // The loser of this race must never become an unhandled rejection,
                // and the 120s timer must not outlive a fast success (zombie timer
                // firing a rejection into the void every single call).
                let _toTimer = null;
                const _reqP = sendSummarizerRequest(s, sysPrompt, prompt);
                _reqP.catch(() => {});   // handled via the race; this guards the late-loss case
                const _toP = new Promise((_, reject) => {
                    _toTimer = setTimeout(() => reject(new Error('Request timed out after 120s')), timeoutMs);
                    signal.addEventListener('abort', () => {
                        clearTimeout(_toTimer);
                        reject(new Error('Aborted by user'));
                    }, { once: true });
                });
                _toP.catch(() => {});    // same guard for the timeout side
                let result;
                try {
                    result = await Promise.race([_reqP, _toP]);
                } finally {
                    clearTimeout(_toTimer);
                }

                trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));
                _lastCallMs = Date.now() - _callStart;
                _lastCallRespChars = (result || '').length;
                if (getSettings().debugMode) console.log(`${LOG_PREFIX} ⏱ model call: ${(_lastCallMs / 1000).toFixed(1)}s | prompt ${prompt.length} chars (~${Math.round(prompt.length/4)} tok) | response ${_lastCallRespChars} chars (~${Math.round(_lastCallRespChars/4)} tok)`);   // gated: the rebuild toast shows timing on mobile

                let trimmed = (result || '').trim();
                trimmed = cleanSummarizerOutput(trimmed);

                if (!trimmed) {
                    log('Empty response from LLM, treating as retryable');
                    throw new Error('Empty response from summarizer');
                }

                log('Result:', trimmed);
                trace('<<< EXITING callSummarizer WITH SUCCESS');
                return trimmed;

            } catch (err) {
                lastError = err;
                trace(`  Caught error on attempt ${attempt}:`, {
                    name: err?.name,
                    message: err?.message,
                    retryable: err?.retryable,
                });

                if (signal.aborted || err.message === 'Aborted by user') {
                    log('Summarization aborted by user.');
                    if (!opts.quiet) toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
                    return '';
                }

                if (!isRetryableError(err)) {
                    trace('  ERROR IS NON-RETRYABLE, BREAKING');
                    console.error(LOG_PREFIX, 'Non-retryable error:', err);
                    break;
                }

                if (attempt >= RETRY_CONFIG.maxRetries) {
                    trace('  MAX RETRIES EXHAUSTED');
                    console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                    break;
                }

                let delay;
                const retryAfterMs = parseRetryAfter(err);
                if (retryAfterMs) {
                    delay = Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
                    log(`Server requested retry after ${delay}ms`);
                } else {
                    const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
                    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
                    delay = Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
                }

                const delaySec = (delay / 1000).toFixed(1);
                const status = err?.status || err?.response?.status || '?';

                console.warn(LOG_PREFIX, `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`, err.message || err);

                if (!opts.quiet) toastr.warning(
                    `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
                    'Summaryception',
                    { timeOut: delay }
                );

                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    }, { once: true });
                });
            }
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        if (!opts.quiet) toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
            'Summaryception',
            { timeOut: 8000 }
        );
        trace('<<< EXITING callSummarizer WITH FAILURE');
        return '';

    } finally {
        _activeAborters.delete(_controller);
        if (currentAbortController === _controller) currentAbortController = null;
        if (isDefaultMode && snapshot) {
            restorePromptToggles(snapshot);
        }
    }
}

// ─── Continuity Auditor helpers (pure — unit-tested) ─────────────────
// Parse the checker's output into flag objects. Accepts a JSON array (optionally
// fenced or embedded in noise), a single object, or the literal NONE. Never throws.
function normalizeContinuityOutput(raw) {
    let t = (raw || '').trim();
    if (!t) return [];
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (/^\(?\s*none\s*\)?[.!]?$/i.test(t)) return [];
    let arr = null;
    try { arr = JSON.parse(t); } catch (_) {
        const m = t.match(/\[[\s\S]*\]/);
        if (m) { try { arr = JSON.parse(m[0]); } catch (_) {} }
    }
    if (!Array.isArray(arr)) {
        if (arr && typeof arr === 'object') arr = [arr];
        else return [];
    }
    const out = [];
    for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const issue = String(it.issue == null ? '' : it.issue).trim();
        const fix = String(it.fix == null ? '' : it.fix).trim();
        if (!issue && !fix) continue;
        let kind = String(it.kind == null ? '' : it.kind).trim().toLowerCase();
        if (kind !== 'drift' && kind !== 'continuity') kind = 'continuity';
        let where = String(it.where == null ? '' : it.where).trim().toLowerCase();
        if (where !== 'snippet' && where !== 'source') where = (kind === 'drift') ? 'snippet' : 'source';   // drift is always snippet-level; otherwise assume source (conservative — no snippet auto-edit)
        out.push({ issue: issue || fix, fix: fix || issue, kind, where });
    }
    return out;
}

// Stable dedup/dismiss signature — issue text (normalized) + kind. Deliberately
// excludes turnRange so a dismissal survives reindexing after edits/branches.
function _continuitySig(flag) {
    if (!flag || typeof flag !== 'object') return '';
    const base = String(flag.issue == null ? '' : flag.issue).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!base) return '';
    return ((flag.kind === 'drift') ? 'd|' : 'c|') + base;
}

// Add new flags for a snippet's turnRange, skipping ones already open (by sig) and any
// the user dismissed. Returns how many were added.
function mergeContinuityFlags(store, turnRange, newFlags) {
    if (!store || !Array.isArray(newFlags)) return 0;
    if (!Array.isArray(store.continuityFlags)) store.continuityFlags = [];
    if (!Array.isArray(store.continuityDismissed)) store.continuityDismissed = [];
    const dismissed = new Set(store.continuityDismissed);
    const openSigs = new Set(store.continuityFlags.filter(f => f && f.status !== 'resolved').map(_continuitySig));
    let added = 0;
    for (const nf of newFlags) {
        const sig = _continuitySig(nf);
        if (!sig || dismissed.has(sig) || openSigs.has(sig)) continue;
        store.continuityFlags.push({
            id: 'cf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
            turnRange: Array.isArray(turnRange) ? [turnRange[0], turnRange[1]] : null,
            issue: nf.issue, fix: nf.fix, kind: nf.kind, where: nf.where || 'source',
            createdAt: Date.now(), status: 'open',
        });
        openSigs.add(sig);
        added++;
    }
    return added;
}

// Re-check reconcile for one snippet: clear its OPEN flags the fresh pass no longer
// reports (the issue was fixed), keep the ones still reported (same id, no churn), add
// any new ones, and never re-raise a dismissed sig. Returns {added, cleared}. Only
// touches flags whose turnRange matches this snippet.
function reconcileSnippetFlags(store, turnRange, freshFlags) {
    if (!store || !Array.isArray(turnRange)) return { added: 0, cleared: 0 };
    if (!Array.isArray(store.continuityFlags)) store.continuityFlags = [];
    const a = turnRange[0], b = turnRange[1];
    const freshSigs = new Set((freshFlags || []).map(_continuitySig));
    let cleared = 0;
    store.continuityFlags = store.continuityFlags.filter(f => {
        const sameRange = f && Array.isArray(f.turnRange) && f.turnRange[0] === a && f.turnRange[1] === b;
        if (sameRange && f.status !== 'resolved' && !freshSigs.has(_continuitySig(f))) { cleared++; return false; }
        return true;
    });
    const added = mergeContinuityFlags(store, turnRange, freshFlags || []);
    return { added, cleared };
}

// ─── Detail Auditor ("sister") ───────────────────────────────────────
// A second, per-batch pass that checks whether the compact snippet dropped
// important specifics from the same passage. Reuses callSummarizer's machinery
// via prompt overrides. Returns '' (no detail) or a short note. Non-fatal.

function normalizeAuditorOutput(raw) {
    let t = (raw || '').trim();
    if (!t) return '';
    // Strip an optional leading "DETAIL:" label the model may include.
    t = t.replace(/^\s*DETAIL\s*[:\-–]?\s*/i, '').trim();
    // Treat an explicit "nothing to add" as empty.
    if (/^\(?\s*(none|n\/?a|nothing|no( new)? detail[s]?( needed)?)\s*\)?[.!]?$/i.test(t)) return '';
    return t;
}

async function callAuditor(storyTxt, snippetText, contextStr) {
    const s = getSettings();
    const raw = await callSummarizer(storyTxt, contextStr, {
        systemPrompt: s.sisterSystemPrompt,
        userPrompt: s.sisterUserPrompt,
        snippet: snippetText,
        quiet: true,   // auditor failures are logged, never shown as summarizer errors
    });
    return normalizeAuditorOutput(raw);
}

// Queue the auditor for the snippet just pushed to Layer 0 and return IMMEDIATELY.
// The audit runs in the background (sequentially, one at a time) so the
// summarize→ghost cycle finishes at full speed — the detail note attaches when
// ready. If the snippet is promoted/deleted/chat-switched before the audit
// lands, the result is safely discarded. Never throws upward.
let _auditQueue = [];
let _auditActive = false;

function queueAuditDetail(storyTxt, snippetText, contextStr) {
    const s = getSettings();
    if (!s.sisterEnabled) return;
    const store = getChatStore();
    const layer0 = store.layers && store.layers[0];
    if (!layer0 || layer0.length === 0) return;
    _auditQueue.push({ snip: layer0[layer0.length - 1], storyTxt, snippetText, contextStr });
    processAuditQueue();   // fire and forget — deliberately NOT awaited
}

async function processAuditQueue() {
    if (_auditActive) return;
    if (_llmChannelBusy()) { setTimeout(() => { processAuditQueue(); }, 2000); return; }   // channel held by another pass; jobs stay queued
    _auditActive = true;
    try {
        while (_auditQueue.length > 0) {
            const job = _auditQueue.shift();
            try {
                const detail = await callAuditor(job.storyTxt, job.snippetText, job.contextStr);
                // Re-check the world: the snippet may have been promoted, deleted,
                // or we may have switched chats while the audit was in flight.
                const store = getChatStore();
                const layer0 = store.layers && store.layers[0];
                if (!layer0 || !layer0.includes(job.snip)) {
                    log('Detail auditor: snippet no longer in Layer 0 — result discarded.');
                    continue;
                }
                // External-editor guard: if another tool (e.g. Continuity Copilot)
                // rewrote this snippet's text while the audit was in flight, the
                // audit was computed against STALE text — discard rather than
                // attach a detail that may duplicate or contradict the correction.
                if (typeof job.snippetText === 'string' && job.snip.text !== job.snippetText) {
                    log('Detail auditor: snippet text changed externally mid-audit — result discarded.');
                    continue;
                }
                if (detail) {
                    job.snip.detail = detail;
                    await saveChatStore();
                    updateInjection();
                    log(`Detail auditor (background): attached ${detail.length} chars.`);
                } else {
                    log('Detail auditor (background): snippet already complete — no detail added.');
                }
            } catch (e) {
                log('Detail auditor (background) failed for one snippet — kept without detail:', e);
            }
        }
    } finally {
        _auditActive = false;
    }
}

// ─── Character Ledger ("psychologist") ───────────────────────────────
// A THIRD background pass, per batch, that maintains a living per-character
// model: stable nature (core), current mood (state), relationship trajectory
// (arc), and open loose ends (threads). Runs after the summarize/ghost cycle,
// non-blocking, and merges into chatMetadata. Only the ACTIVE cast (characters
// present in the recent window) is injected. Failures log; never throw upward.

let _chatEpoch = 0;      // bumped on chat change; guards ledger jobs in flight
let _ledgerGen = 0;      // bumped on rewind/trim/deletion; a scribe job that started BEFORE the ledger was rewritten must never merge its (stale-timeline) deltas or push ledgerLiveIdx back up afterwards — the epoch only guards chat SWITCHES, not same-chat rewrites
let _prevChatLen = -1;   // last-known chat length; used to detect deletions precisely
let _ledgerQueue = [];
let _ledgerActive = false;
// Recall's flag lives up here with the rest of the channel's flags: _llmChannelBusy
// reads it, and a `let` declared further down the file would be in the temporal dead
// zone for any early caller.
let _autoRecallBusy = false;

// THE LLM channel is EXCLUSIVE and shared by every background pass: summarizer,
// ledger scribe, sister/detail auditor, ledger auditor, continuity checker, and the
// edit re-check. callSummarizer snapshots SillyTavern's prompt toggles, disables
// them, and restores on finish — two concurrent calls interleave those snapshots and
// leave the user's toggles permanently wrong, on top of fighting the same rate limit.
// Each pass used to check an ad-hoc SUBSET of the others' flags: O(n^2) to maintain,
// and it failed twice (the ledger audit vs the live pass; the continuity re-check vs
// both). One predicate, one truth — a new pass adds its flag here and every existing
// pass instantly respects it.
function _llmChannelBusy() {
    return isSummarizing || _ledgerActive || _auditActive || _ledgerAuditActive || _continuityActive || _editRecheckActive || _autoRecallBusy;
}

// Compact, human-readable dump of the current ledger for the scribe's context,
// most-recently-updated first, bounded by a char budget. Uses formatLedgerEntry
// (no per-field cap) so the scribe sees the full established picture.
function serializeLedgerForScribe(ledger, budgetChars) {
    if (!ledger || typeof ledger !== 'object') return '(empty — no characters recorded yet)';
    const names = Object.keys(ledger);
    if (names.length === 0) return '(empty — no characters recorded yet)';
    const entries = names
        .map(name => ({ name, entry: ledger[name], u: (ledger[name] && ledger[name].updatedAt) || 0 }))
        .sort((a, b) => b.u - a.u);
    const budget = budgetChars || 6000;
    const lines = [];
    let used = 0, omitted = 0;
    for (const { name, entry } of entries) {
        const line = formatLedgerEntry(name, entry, 100000);
        if (!line) continue;
        if (lines.length > 0 && used + line.length > budget) { omitted++; continue; }
        lines.push(line);
        used += line.length + 1;
    }
    let out = lines.join('\n');
    if (omitted > 0) out += `\n(+${omitted} less-recently-updated character(s) omitted for brevity)`;
    return out || '(empty — no characters recorded yet)';
}

// Pure: names of ledger entries missing their stable-nature core. A character can
// enter the ledger sideways — a live delta that only recorded their state — and from
// then on every pass treats them as "established" and never writes core ("change
// core only for a genuinely new trait" + "omit unchanged fields" = permanent hole).
function _ledgerMissingCore(ledger) {
    const out = [];
    if (!ledger || typeof ledger !== 'object') return out;
    for (const [name, e] of Object.entries(ledger)) {
        if (!e || typeof e !== 'object') continue;
        if (typeof e.core === 'string' && e.core.trim()) continue;
        out.push(name);
    }
    return out.sort();
}

// Pure: the establish-order appended inside <current_ledger> when holes exist. Lives
// in CODE, not the prompt template, so customized prompts get the self-heal too.
function _missingCoreNotice(names) {
    if (!Array.isArray(names) || names.length === 0) return '';
    const cap = 8;
    const shown = names.slice(0, cap).join(', ');
    const more = names.length > cap ? ` (+${names.length - cap} more)` : '';
    return `\n\n!! MISSING CORE \u2014 these recorded characters have no stable-nature core yet: ${shown}${more}. For ANY of them who appears in <new_passage>, establish their FULL core now (temperament, expression under stress, speech habits, how they address people, hard lines) from everything the story has shown so far \u2014 do not wait for a "new trait".`;
}

async function callLedgerScribe(storyTxt, contextStr, ledgerStr) {
    const s = getSettings();
    let ledgerWithNotice = ledgerStr;
    try {
        // Self-heal: surface core-less entries to the scribe on every pass they might
        // appear in. Zero extra calls — rides the pass that was happening anyway.
        const notice = _missingCoreNotice(_ledgerMissingCore(getChatStore().ledger));
        if (notice) ledgerWithNotice = String(ledgerStr || '') + notice;
    } catch (_) {}
    const raw = await callSummarizer(storyTxt, contextStr, {
        systemPrompt: s.ledgerSystemPrompt,
        userPrompt: s.ledgerUserPrompt,
        ledger: ledgerWithNotice,
        quiet: true,   // ledger failures are logged, never shown as summarizer errors
    });
    return extractJsonArray(raw);   // [{name, core?, state?, arc?, threads?}] or null
}

// ─── Ledger self-audit ────────────────────────────────────────────────
// Summaryception owns the ledger, so Summaryception must be able to catch its own
// misreads. Re-deriving cannot: the scribe reads the same passage the same way and
// reproduces the error. Verification is a different question — "does the source
// support this claim?" — and it is the only thing that catches drift the scribe
// itself generated: epistemic leaks, planned-but-unplayed beats, inference hardened
// into fact, invented detail.

// Pure: who gets audited this run. Injected characters first (they are shaping the
// story RIGHT NOW, so their errors are live), then least-recently-audited, so the
// whole cast cycles through over time. `_a` = turn at which an entry was last audited.
function _ledgerAuditTargets(ledger, injectedNames, maxPerRun) {
    const names = Object.keys(ledger || {});
    if (names.length === 0) return [];
    const inj = new Set(injectedNames || []);
    return names
        .map(n => ({
            n,
            inj: inj.has(n) ? 0 : 1,
            a: (ledger[n] && typeof ledger[n]._a === 'number') ? ledger[n]._a : -1,
        }))
        .sort((x, y) => (x.inj - y.inj) || (x.a - y.a) || (x.n < y.n ? -1 : 1))
        .slice(0, Math.max(1, maxPerRun | 0))
        .map(x => x.n);
}

// Pure: indices of the most recent messages featuring this character — their actual
// screen time, which is what their state/threads must be traceable to.
function _pickEvidenceIndices(chat, name, maxMsgs, ambiguous) {
    const out = [];
    if (!Array.isArray(chat) || !name) return out;
    const aliases = characterAliases(name, ambiguous);
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || typeof m.mes !== 'string') continue;
        const low = m.mes.toLowerCase();
        if (aliases.some(a => wordPresentInText(low, a))) out.push(i);
    }
    return out.slice(-Math.max(1, maxMsgs | 0));
}

// Pure: the evidence packet — union of the audited characters' recent appearances,
// meta-stripped (planner blocks are not events), newest-first under the budget, then
// restored to chronological order so the auditor reads the story as it happened.
function buildLedgerAuditEvidence(chat, names, maxMsgsPerChar, capChars, ambiguous) {
    const idxs = new Set();
    for (const n of (names || [])) for (const i of _pickEvidenceIndices(chat, n, maxMsgsPerChar, ambiguous)) idxs.add(i);
    const desc = [...idxs].sort((a, b) => b - a);
    const cap = Math.max(500, capChars | 0);
    const kept = [];
    let used = 0;
    for (const i of desc) {
        const m = chat[i];
        const body = stripMetaBlocks(String((m && m.mes) || '').trim());
        if (!body) continue;
        const who = (m && m.is_user) ? 'Player' : ((m && m.name && String(m.name).trim()) || 'Assistant');
        const piece = '#' + i + ' ' + who + ': ' + body;
        if (used + piece.length > cap) continue;   // newest evidence wins the budget
        kept.push([i, piece]);
        used += piece.length + 2;
    }
    return kept.sort((a, b) => a[0] - b[0]).map(x => x[1]).join('\n\n');
}

async function callLedgerAuditor(evidenceTxt, contextStr, entriesStr) {
    const s = getSettings();
    const raw = await callSummarizer(evidenceTxt, contextStr, {
        systemPrompt: s.ledgerAuditSystemPrompt,
        userPrompt: s.ledgerAuditUserPrompt,
        ledger: entriesStr,
        quiet: true,   // audits are background bookkeeping; failures surface via the audit's own reporting
    });
    return extractJsonArray(raw);   // [{name, core?, state?, arc?, threads?}] or null
}

// NOT `_auditActive` — that name belongs to the sister/detail auditor (declared far
// above). v5.58.0 redeclared it here: a duplicate top-level `let`, i.e. a hard
// SyntaxError under ESM, which is how SillyTavern loads this file. The extension
// did not load at all from 5.58.0 to 5.60.0. The gate missed it because
// `node --check index.js` parses as CommonJS; ESM requires a .mjs copy.
let _ledgerAuditActive = false;

// Returns true (ran), 'busy' (deferred), or false (nothing to do / disabled).
async function auditLedgerEntries(opts = {}) {
    const manual = !!opts.manual;
    try {
        const s = getSettings();
        if (!s.ledgerEnabled) return false;
        if (!manual && s.ledgerAuditEnabled === false) return false;
        if (_llmChannelBusy() || _ledgerQueue.length > 0) return 'busy';
        const store = getChatStore();
        const ledger = store.ledger;
        if (!ledger || typeof ledger !== 'object' || Object.keys(ledger).length === 0) return false;
        const { chat } = SillyTavern.getContext();
        if (!Array.isArray(chat) || chat.length === 0) return false;

        // Freshness outranks hygiene: if any story is still un-ingested, let the live
        // pass have the channel and audit in the next quiet moment (the retry handles
        // it — no user action, no lost audit). Skipped when the live pass is off, or
        // the pointer could lag forever and the audit would never run.
        if (s.ledgerLiveUpdate !== false) {
            try {
                const _turns = getAssistantTurns(chat);
                if (_turns.length && _computeLiveLedgerRange(store.summarizedUpTo, store.ledgerLiveIdx, _turns[_turns.length - 1].index)) return 'busy';
            } catch (_) {}
        }

        // Injected characters first — the ones whose errors are reaching the
        // storyteller this very turn.
        let injected = [];
        try {
            const windowSize = Math.max(1, s.ledgerActiveWindow ?? 12);
            const _msgs = chat.slice(-windowSize).map(m => ((m && typeof m.mes === 'string') ? m.mes : '').toLowerCase());
            const recentLower = _msgs.join('\n');
            const cast = computeLedgerCast(ledger, s, recentLower, getLedgerPins(), _rosterTick, _msgs);
            injected = cast.shown.map(x => x.name);
        } catch (_) { injected = []; }

        const targets = _ledgerAuditTargets(ledger, injected, s.ledgerAuditMaxPerRun ?? 4);
        if (targets.length === 0) return false;

        // Ambiguity is a property of the whole cast, not of this run's subset: Claire
        // is ambiguous with Jovan even when Jovan is not being audited.
        const evidence = buildLedgerAuditEvidence(chat, targets, s.ledgerAuditEvidenceMsgs ?? 6, s.ledgerAuditEvidenceChars ?? 9000, _ambiguousTokens(Object.keys(ledger)));
        if (!evidence.trim()) {
            if (manual) toastr.info('No on-screen evidence found for those characters yet — nothing to audit against.', 'Summaryception', { timeOut: 4000 });
            return false;
        }

        const subLedger = {};
        for (const n of targets) subLedger[n] = ledger[n];
        const entriesStr = serializeLedgerForScribe(subLedger, s.ledgerContextMaxChars);
        const contextStr = buildLedgerContext(chat.length, LEDGER_GIST_CAP);

        _ledgerAuditActive = true;
        const startEpoch = _chatEpoch;
        const startGen = _ledgerGen;
        // Snapshot each target's revision: a correction is computed against the entry
        // as it was READ. If anything re-shapes that entry while the audit thinks, the
        // correction is stale — drop it rather than overwrite newer truth with older.
        const seenRev = new Map();
        for (const n of targets) { const k = resolveLedgerKey(ledger, n); seenRev.set(k, (ledger[k] && ledger[k].updatedAt) || 0); }
        if (manual) toastr.info(`Auditing ${targets.length} character entr${targets.length === 1 ? 'y' : 'ies'} against the story — corrections land automatically.`, 'Summaryception', { timeOut: 3500 });
        let deltas = null;
        try {
            deltas = await callLedgerAuditor(evidence, contextStr, entriesStr);
        } finally {
            _ledgerAuditActive = false;
        }

        // Same guards as every other flow: a result computed for a timeline that no
        // longer exists must never land.
        if (_chatEpoch !== startEpoch) { log('Ledger audit: chat switched mid-audit — result discarded.'); return false; }
        if (_ledgerGen !== startGen) {
            log('Ledger audit: timeline moved mid-audit — result discarded; will re-run on the next cadence.');
            if (manual) toastr.info('That audit was discarded — the chat changed (edit/delete/swipe) while it ran. Tap 🔍 Audit ledger to re-run.', 'Summaryception', { timeOut: 4500 });
            return false;
        }
        if (!deltas) {
            log('Ledger audit: no parseable output.');
            if (manual) toastr.warning('Audit produced no readable result — the ledger was left untouched. Tap 🔍 Audit ledger to retry.', 'Summaryception', { timeOut: 5000 });
            return false;
        }

        // Guard: the auditor may only CORRECT entries it was given. A delta naming a
        // character outside this run is out of scope by construction.
        const scope = new Set(targets.map(n => String(n).toLowerCase()));
        const inScope = deltas.filter(d => d && typeof d.name === 'string' && scope.has(resolveLedgerKey(ledger, d.name.trim()).toLowerCase()));
        const dropped = deltas.length - inScope.length;
        if (dropped > 0) log(`Ledger audit: ignored ${dropped} correction(s) for characters outside this run.`);
        const fresh = inScope.filter(d => {
            const k = resolveLedgerKey(ledger, String(d.name).trim());
            const rev = (ledger[k] && ledger[k].updatedAt) || 0;
            return !seenRev.has(k) || seenRev.get(k) === rev;
        });
        const stale = inScope.length - fresh.length;
        if (stale > 0) log(`Ledger audit: dropped ${stale} correction(s) for entries re-shaped mid-audit — they will be re-checked next cycle.`);

        const liveIdx = (typeof store.ledgerLiveIdx === 'number') ? store.ledgerLiveIdx : undefined;
        // A correction re-describes the story the entry already covered — its evidence
        // is drawn solely from the character's own past appearances — so it lands at
        // the entry's existing _t, NOT at "now". Stamping corrections at liveIdx (the
        // old behavior) falsified _t for every audited character: the roster told the
        // storyteller an absent character was "last seen (turn NOW)", and a branch
        // below the audit turn dropped the whole entry (_ledgerDroppingPast /
        // _synthesizeCheckpoint judge by _t) despite their legitimate older history.
        // The audit STAMP below already rides at the entry's own _t; corrections now
        // follow the same rule. Per-delta merge because each entry keeps its own turn.
        let changed = 0;
        for (const d of fresh) {
            const k = resolveLedgerKey(ledger, String(d.name).trim());
            const at = (ledger[k] && typeof ledger[k]._t === 'number') ? ledger[k]._t : liveIdx;
            changed += mergeLedgerDeltas([d], undefined, at);
        }

        // Stamp every audited entry (changed or not) so the round-robin advances and
        // the same characters are not re-checked forever.
        const stampAt = (typeof liveIdx === 'number') ? liveIdx : 0;
        for (const n of targets) {
            const key = resolveLedgerKey(ledger, n);
            if (!ledger[key]) continue;
            ledger[key]._a = stampAt;
            // The stamp must ride the journal too: page-only stamps were erased by
            // every fold, so the auditor re-checked the same characters forever.
            if (Array.isArray(store.ledgerNotes)) {
                const _t = (typeof ledger[key]._t === 'number') ? ledger[key]._t : stampAt;
                store.ledgerNotes.push({ t: _t, name: key, at: Date.now(), a: stampAt });
            }
        }

        await saveChatStore();
        if (changed > 0) { updateInjection(true); try { renderLedger(); } catch (_) {} }
        log(`Ledger audit: checked ${targets.join(', ')} — corrected ${changed}.`);
        if (changed > 0) {
            toastr.success(`Ledger audit corrected ${changed} entr${changed === 1 ? 'y' : 'ies'} (${fresh.map(d => d.name).join(', ')}) — claims the story does not support were removed.`, 'Summaryception', { timeOut: 6000 });
        } else if (manual) {
            toastr.success(`Audited ${targets.join(', ')} — every claim is supported by the story.`, 'Summaryception', { timeOut: 4000 });
        }
        return true;
    } catch (e) {
        _ledgerAuditActive = false;
        log('Ledger audit failed (non-fatal):', e);
        if (opts.manual) toastr.warning(`Audit failed (${(e && e.message) ? e.message : e}) — the ledger was left untouched.`, 'Summaryception', { timeOut: 5000 });
        return false;
    }
}

// Cadence gate + busy deferral, mirroring the live pass: an audit skipped because
// the summarizer was mid-flight retries itself instead of waiting for a user action.
let _turnsSinceAudit = 0;
let _auditRetryTimer = null;
let _auditRetryLeft = 0;
function _clearAuditRetry() { if (_auditRetryTimer) { clearTimeout(_auditRetryTimer); _auditRetryTimer = null; } _auditRetryLeft = 0; }
function _armAuditRetry() {
    if (_auditRetryTimer) return;
    if (_auditRetryLeft <= 0) _auditRetryLeft = 200;   // was 10 (~60s) — shorter than a slow model call
    _auditRetryTimer = setTimeout(async () => {
        _auditRetryTimer = null;
        const r = await auditLedgerEntries({});
        if (r === 'busy' && --_auditRetryLeft > 0) { _armAuditRetry(); return; }
        _turnsSinceAudit = 0;
        _auditRetryLeft = 0;
    }, 6000);
}
function maybeAuditLedger() {
    const s = getSettings();
    if (!s.ledgerEnabled || s.ledgerAuditEnabled === false) return;
    const every = Math.max(0, s.ledgerAuditEveryTurns | 0);
    if (every <= 0) return;   // manual only
    _turnsSinceAudit++;
    if (_turnsSinceAudit < every) return;
    _armAuditRetry();   // deliberately delayed: let the live pass have the turn first
}

// Case-insensitive key resolution so "mara" and "Mara" don't split into two
// entries. Distinct characters keep distinct names (no fuzzy merging).
function resolveLedgerKey(ledger, name) {
    const keys = Object.keys(ledger);
    // 1. exact match
    if (Object.prototype.hasOwnProperty.call(ledger, name)) return name;
    // 2. case-insensitive exact match ("mara" -> "Mara")
    const lower = name.toLowerCase();
    for (const k of keys) if (k.toLowerCase() === lower) return k;
    // 3. token-aware: unify a short/long form of the SAME character — the scribe
    //    sending "Alexia" when the ledger holds "Alexia Valois" (or vice-versa) —
    //    but ONLY when the match is unambiguous, so two characters who merely
    //    share a given name or surname are NEVER merged.
    const inTok = name.split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
    if (inTok.length === 0) return name;
    const candidates = keys.filter(k => {
        const kTok = k.split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
        if (!kTok.length) return false;
        // exactly one side must be a single token (the short form) …
        const oneSideShort = (inTok.length === 1) !== (kTok.length === 1);
        if (!oneSideShort) return false;
        // … and they must share the given name (first token) or surname (last).
        return kTok[0] === inTok[0] || kTok[kTok.length - 1] === inTok[inTok.length - 1];
    });
    if (candidates.length === 1) return candidates[0];   // unambiguous → same character
    return name;                                          // ambiguous or none → keep separate
}

// Defensive normalization: strip any field label a sloppy scribe model may have
// echoed into a VALUE (e.g. "Nature: terse", or a compounded "Nature: Nature: ...").
// The store must hold the bare value only; labels are presentation-only, added by
// formatLedgerEntry. Anchored to the start and only matches known labels, so real
// values (even ones containing a mid-string colon) are left untouched.
const _LEDGER_LABEL_RE = /^\s*(?:nature|now|open threads|open|arc|core|state|threads)\s*:\s*/i;
function stripLeadingLabel(v) {
    let s = String(v == null ? '' : v).trim();
    for (let i = 0; i < 6 && _LEDGER_LABEL_RE.test(s); i++) s = s.replace(_LEDGER_LABEL_RE, '').trim();
    return s;
}

// Merge scribe deltas into the store's ledger. Partial semantics: a field
// present on the delta REPLACES that field (the scribe emits the full evolved
// value); an omitted field is left untouched. `threads` present replaces the
// open list; [] clears it. Returns the count of characters changed.
// ─── Per-turn notes: the ledger's real history ───────────────────────
// A character's page (Nature / Now / Arc / Open threads) is CUMULATIVE — turn 47's
// page is turn 46's page with some fields overwritten. You cannot subtract turn 47
// from it, which is why rewinding used to need a stored snapshot ("photograph every
// page every turn") and, when the snapshot had been pruned for space, an AI rebuild.
//
// But the scribe already tells us exactly what changed — its instructions say to OMIT
// every unchanged field. That reply IS the history, and it was being thrown away. So
// we keep it: one small note per turn per character, recording only the fields that
// moved. The page is then COMPUTED — newest value of each field wins — and a rewind
// is "read fewer notes". Instant, exact, no model call, nothing to prune.
//
// The page itself (store.ledger) stays materialized so every consumer — injection,
// panel, roster, audit — is untouched. Notes are the source of truth for TIME.

// Pure: fold notes into a page-per-character. Newest value per field wins; a field
// nobody has rewritten keeps its value forever, which is correct (Claire's Nature
// from turn 12 is still true at turn 200 unless something changed it).
function foldLedgerNotes(notes, maxTurn) {
    const out = {};
    if (!Array.isArray(notes)) return out;
    const lim = (typeof maxTurn === 'number' && isFinite(maxTurn)) ? maxTurn : Infinity;
    const rows = notes
        .filter(n => n && typeof n.t === 'number' && n.t <= lim && typeof n.name === 'string' && n.name.trim())
        .sort((a, b) => (a.t - b.t) || ((a.at || 0) - (b.at || 0)));
    for (const n of rows) {
        const key = resolveLedgerKey(out, n.name.trim());
        if (n.gone === true) { delete out[key]; continue; }   // tombstone: deleted here; a LATER note lawfully re-introduces them
        const e = out[key] || {};
        if (typeof n.core === 'string') e.core = n.core;
        if (typeof n.state === 'string') e.state = n.state;
        if (typeof n.arc === 'string') e.arc = n.arc;
        if (Array.isArray(n.threads)) e.threads = n.threads.slice();
        if (typeof n.a === 'number') e._a = n.a;          // audit stamp rides the notes too
        e._t = n.t;
        e.updatedAt = n.at || e.updatedAt || 0;
        out[key] = e;
    }
    return out;
}

// Pure: the character's own timeline — every note that ever touched them, oldest
// first. This is the "wiki history" view: how they became who they are.
function ledgerHistoryFor(notes, name) {
    if (!Array.isArray(notes) || !name) return [];
    const want = String(name).trim().toLowerCase();
    return notes
        .filter(n => n && typeof n.name === 'string' && n.name.trim().toLowerCase() === want)
        .sort((a, b) => (a.t - b.t) || ((a.at || 0) - (b.at || 0)));
}

// Pure: notes are only authoritative back to their base turn. A chat that had a
// ledger before notes existed gets a base note capturing the page as it stood then;
// rewinds ABOVE that are exact folds, rewinds below still need the old machinery.
function notesCover(store, targetTurn) {
    if (!store || !Array.isArray(store.ledgerNotes) || store.ledgerNotes.length === 0) return false;
    const from = (typeof store.ledgerNotesFrom === 'number') ? store.ledgerNotesFrom : null;
    if (from === null) return false;
    return targetTurn >= from;
}

// Migration: adopt the existing page as a base note at the current pointer, so no
// history is lost and folding stays correct from here on. A fresh chat bases at 0
// and is therefore exactly foldable forever.
function ensureLedgerNotes(store) {
    if (Array.isArray(store.ledgerNotes)) return;
    store.ledgerNotes = [];
    const led = (store.ledger && typeof store.ledger === 'object') ? store.ledger : {};
    const at = (typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx >= 0) ? store.ledgerLiveIdx : 0;
    const names = Object.keys(led);
    for (const name of names) {
        const e = led[name];
        if (!e || typeof e !== 'object') continue;
        const note = { t: at, name, at: e.updatedAt || Date.now(), base: true };
        if (typeof e.core === 'string') note.core = e.core;
        if (typeof e.state === 'string') note.state = e.state;
        if (typeof e.arc === 'string') note.arc = e.arc;
        if (Array.isArray(e.threads)) note.threads = e.threads.slice();
        if (typeof e._a === 'number') note.a = e._a;
        store.ledgerNotes.push(note);
    }
    store.ledgerNotesFrom = names.length ? at : 0;
}

const _NOTES_SOFT_CAP = 1500;   // ~450 KB worst case; compaction keeps it bounded
const _NOTES_KEEP_TAIL = 300;   // turns of exact-fold history always retained

// Bound growth without losing truth: fold everything older than the tail into ONE
// base note per character at the cut turn. Rewinds inside the tail stay exact; older
// rewinds fall back to the existing path, exactly as they do for a legacy chat.
function compactLedgerNotes(store) {
    try {
        const notes = store.ledgerNotes;
        if (!Array.isArray(notes) || notes.length <= _NOTES_SOFT_CAP) return;
        const head = (typeof store.ledgerLiveIdx === 'number') ? store.ledgerLiveIdx : 0;
        const cut = head - _NOTES_KEEP_TAIL;
        if (cut <= (store.ledgerNotesFrom || 0)) return;
        const base = foldLedgerNotes(notes, cut);
        const kept = notes.filter(n => n && typeof n.t === 'number' && n.t > cut);
        const rebuilt = [];
        for (const [name, e] of Object.entries(base)) {
            const note = { t: cut, name, at: e.updatedAt || Date.now(), base: true };
            if (typeof e.core === 'string') note.core = e.core;
            if (typeof e.state === 'string') note.state = e.state;
            if (typeof e.arc === 'string') note.arc = e.arc;
            if (Array.isArray(e.threads)) note.threads = e.threads.slice();
            if (typeof e._a === 'number') note.a = e._a;
            rebuilt.push(note);
        }
        store.ledgerNotes = rebuilt.concat(kept);
        store.ledgerNotesFrom = cut;
        log(`Ledger notes compacted: ${notes.length} -> ${store.ledgerNotes.length} (exact history kept from turn ${cut}).`);
    } catch (e) { log('compactLedgerNotes failed (non-fatal):', e); }
}

// Pure: shape scribe deltas into journal notes at atTurn. Only fields the scribe
// actually sent are recorded — that is the whole point: the note is small because
// it is only the change. Shared by the live journal (appendLedgerNotes) and the
// staging journal (a staged rebuild journals its own reads per chunk), so there is
// exactly one place that decides what a note looks like.
function _notesFromDeltas(deltas, atTurn) {
    const out = [];
    if (!Array.isArray(deltas) || typeof atTurn !== 'number' || !isFinite(atTurn)) return out;
    for (const d of deltas) {
        if (!d || typeof d.name !== 'string' || !d.name.trim()) continue;
        const note = { t: Math.floor(atTurn), name: d.name.trim(), at: Date.now() };
        let has = false;
        if (typeof d.core === 'string')  { const v = stripLeadingLabel(d.core);  if (v) { note.core = v; has = true; } }
        if (typeof d.state === 'string') { const v = stripLeadingLabel(d.state); if (v) { note.state = v; has = true; } }
        if (typeof d.arc === 'string')   { const v = stripLeadingLabel(d.arc);   if (v) { note.arc = v; has = true; } }
        if (Array.isArray(d.threads)) {
            note.threads = d.threads.filter(t => typeof t === 'string' && t.trim()).map(t => stripLeadingLabel(t)).filter(Boolean);
            has = true;
        }
        if (has) out.push(note);
    }
    return out;
}

// Record what the scribe actually said this turn into the LIVE journal.
function appendLedgerNotes(deltas, atTurn) {
    const notes = _notesFromDeltas(deltas, atTurn);
    if (notes.length === 0) return 0;
    const store = getChatStore();
    ensureLedgerNotes(store);
    for (const n of notes) store.ledgerNotes.push(n);
    compactLedgerNotes(store);
    return notes.length;
}

// One shape for "the journal restarts as a snapshot of this page": base notes at
// atTurn carrying every field an entry has. Used wherever the page's provenance is
// NOT the journal (a checkpoint restore) so the invariant page == fold(notes) is
// re-established instead of silently violated.
function _baseNotesFromPage(page, atTurn) {
    const out = [];
    if (!page || typeof page !== 'object') return out;
    const at = (typeof atTurn === 'number' && isFinite(atTurn)) ? Math.max(0, Math.floor(atTurn)) : 0;
    for (const [nm, e] of Object.entries(page)) {
        if (!e || typeof e !== 'object') continue;
        const note = { t: at, name: nm, at: e.updatedAt || Date.now(), base: true };
        if (typeof e.core === 'string') note.core = e.core;
        if (typeof e.state === 'string') note.state = e.state;
        if (typeof e.arc === 'string') note.arc = e.arc;
        if (Array.isArray(e.threads)) note.threads = e.threads.slice();
        if (typeof e._a === 'number') note.a = e._a;
        out.push(note);
    }
    return out;
}

// External writers — the Chat Assistant's memory edits, its Undo restores, a
// console tweak — touch the PAGE; they cannot know the notes journal exists.
// Every fold then resolved page↔journal divergence as fold-wins: the copilot's
// correction survived until the next message deletion or rewind and silently
// reverted, and a page-side deletion resurrected. This reconciler makes the
// journal the complete record: any page-side difference is adopted as a note
// BEFORE folding, so external work survives folds exactly like the scribe's own.
// Deletion adoption is suppressed while a staged rebuild serves a deliberately
// trimmed page (_ledgerDroppingPast is temporary hygiene, not a user deletion).
function adoptExternalLedgerEdits(store, tFloor) {
    if (!store || !store.ledger || typeof store.ledger !== 'object') return 0;
    if (!Array.isArray(store.ledgerNotes)) return 0;   // pre-notes chat: nothing to reconcile against
    const page = store.ledger;
    const fold = foldLedgerNotes(store.ledgerNotes, Infinity);
    const rebuildActive = !!(store.ledgerRebuild && store.ledgerRebuild.staging);
    let tNow = (typeof tFloor === 'number' && isFinite(tFloor)) ? Math.max(0, Math.floor(tFloor)) : 0;
    if (!rebuildActive && typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx > tNow) tNow = store.ledgerLiveIdx;
    for (const n of store.ledgerNotes) if (n && typeof n.t === 'number' && n.t > tNow) tNow = n.t;
    let adopted = 0;
    for (const [name, e] of Object.entries(page)) {
        if (!e || typeof e !== 'object') continue;
        const fk = Object.prototype.hasOwnProperty.call(fold, name) ? name : resolveLedgerKey(fold, name);
        const f = Object.prototype.hasOwnProperty.call(fold, fk) ? fold[fk] : null;
        // A page entry whose last shaping turn is PROVABLY behind the journal's is
        // not an external edit — it is the persisted pre-v5.73 clobber (the page
        // saved 14 turns staler than its own history). Adopting it would freeze the
        // bug as truth; skipping lets the fold repair it. External editors never
        // touch _t, so a genuine copilot edit always compares equal here.
        if (f && typeof e._t === 'number' && typeof f._t === 'number' && e._t < f._t) continue;
        const note = { t: tNow, name, at: Date.now(), ext: true };
        let has = false;
        for (const fld of ['core', 'state', 'arc']) {
            const pv = (typeof e[fld] === 'string') ? e[fld] : undefined;
            const fv = (f && typeof f[fld] === 'string') ? f[fld] : undefined;
            if (pv !== undefined && pv !== fv) { note[fld] = pv; has = true; }
        }
        const pt = Array.isArray(e.threads) ? e.threads : undefined;
        const ft = (f && Array.isArray(f.threads)) ? f.threads : undefined;
        if (pt !== undefined && JSON.stringify(pt) !== JSON.stringify(ft)) { note.threads = pt.slice(); has = true; }
        if (typeof e._a === 'number' && (!f || f._a !== e._a)) { note.a = e._a; has = true; }
        if (has) { store.ledgerNotes.push(note); adopted++; }
    }
    // An EMPTY page is indistinguishable from a not-yet-materialized page (a fresh
    // store initializes ledger: {} while notes may already exist) — absence there
    // is never a deletion statement. Only a page with entries can testify that a
    // journal character was removed.
    if (!rebuildActive && Object.keys(page).length > 0) {
        for (const name of Object.keys(fold)) {
            const pk = Object.prototype.hasOwnProperty.call(page, name) ? name : resolveLedgerKey(page, name);
            if (Object.prototype.hasOwnProperty.call(page, pk)) continue;
            store.ledgerNotes.push({ t: tNow, name, at: Date.now(), gone: true, ext: true });
            adopted++;
        }
    }
    if (adopted) { try { log(`Adopted ${adopted} external ledger edit(s) into the journal (page \u2194 notes reconciled).`); } catch (e) { /* logging must never break a fold */ } }
    return adopted;
}

// THE swap — "the staged rebuild becomes the live ledger", page AND journal
// together. Installing the page alone (v5.73–v5.74) broke the one invariant the
// whole system rests on, page == fold(notes): the old journal still described the
// pre-rebuild timeline, so the very next fold — one message deletion, one branch
// rewind — painted the stale ledger straight back over the clean rebuild. That is
// why rebuilding "kept coming back stale": every rebuild silently undid itself at
// the first fold after it.
// The staged rebuild journals its own reads per chunk (ledgerStagingNotes); the
// swap installs that journal with the page, so folds after the swap reproduce the
// REBUILT truth at any turn (from = 0 — a staged rebuild reads from turn 0).
// External edits made to the LIVE page while the rebuild ran (the copilot fixing a
// card) are adopted off the pre-swap page first and re-landed on top of the staged
// journal at the swap pointer — v5.74's guarantee, external edits are journal
// truth, holds THROUGH a swap too. Everything else in the old journal describes
// content the rebuild replaced and dies with it, exactly like a checkpoint restore.
// A rebuild resumed from before the staging journal existed has no chunk notes;
// the fallback rebases as per-entry base notes at each entry's own _t (folds stay
// exact from the swap point; older rewinds use the dense staging checkpoints).
// Returns true iff a staged page was installed. Quiet: toasts belong to callers.
function _swapStagedLedgerIn(st) {
    if (!st || !st.ledgerStaging || typeof st.ledgerStaging !== 'object' || Object.keys(st.ledgerStaging).length === 0) return false;
    const upTo = (typeof st.ledgerLiveIdx === 'number' && st.ledgerLiveIdx >= 0) ? Math.floor(st.ledgerLiveIdx) : 0;
    // Unjournaled external work on the live page IS its diff against its own fold.
    // Adopt with the existing machinery, then carry exactly those new notes across.
    // ONLY when the old journal covers the swap horizon: the diff isolates external
    // edits only if fold(oldNotes) reproduces the served baseline. On an uncovered
    // journal (legacy chat, stranded pointer, retired era) the fold is empty-or-partial,
    // so the "diff" is the ENTIRE pre-rebuild page — adopting it would journal the very
    // timeline the rebuild just discarded, and any later rewind could resurrect it.
    let extNotes = [];
    if (Array.isArray(st.ledgerNotes) && notesCover(st, upTo)) {
        const _pre = st.ledgerNotes.length;
        try { adoptExternalLedgerEdits(st); } catch (e) { log('swap: external-edit adoption failed (non-fatal):', e); }
        extNotes = st.ledgerNotes.slice(_pre).map(n => Object.assign({}, n, { t: Math.min((typeof n.t === 'number' && isFinite(n.t)) ? n.t : upTo, upTo) }));
    }
    if (Array.isArray(st.ledgerStagingNotes) && st.ledgerStagingNotes.length > 0) {
        st.ledgerNotes = st.ledgerStagingNotes.concat(extNotes);
        st.ledgerNotesFrom = 0;
    } else {
        const base = [];
        for (const [nm, e] of Object.entries(st.ledgerStaging)) {
            if (!e || typeof e !== 'object') continue;
            const t0 = (typeof e._t === 'number' && isFinite(e._t)) ? Math.min(Math.max(0, Math.floor(e._t)), upTo) : upTo;
            const note = { t: t0, name: nm, at: e.updatedAt || Date.now(), base: true };
            if (typeof e.core === 'string') note.core = e.core;
            if (typeof e.state === 'string') note.state = e.state;
            if (typeof e.arc === 'string') note.arc = e.arc;
            if (Array.isArray(e.threads)) note.threads = e.threads.slice();
            if (typeof e._a === 'number') note.a = e._a;
            base.push(note);
        }
        st.ledgerNotes = base.concat(extNotes);
        st.ledgerNotesFrom = upTo;   // per-entry stamps, not per-turn history — exact folds start at the swap point; older rewinds fall back to checkpoints
    }
    st.ledger = foldLedgerNotes(st.ledgerNotes, Infinity);
    st.ledgerStaging = null;
    st.ledgerStagingNotes = null;
    return true;
}

// Rewind by READING FEWER NOTES. No snapshot, no model call, no pruning, exact.
function rewindLedgerFromNotes(targetTurn) {
    const store = getChatStore();
    ensureLedgerNotes(store);
    // Journal any external page edits FIRST: an edit made after the last pass would
    // otherwise be silently reverted by the fold below.
    adoptExternalLedgerEdits(store);
    if (!notesCover(store, targetTurn)) return false;
    const before = store.ledgerNotes.length;
    store.ledgerNotes = store.ledgerNotes.filter(n => n && typeof n.t === 'number' && n.t <= targetTurn);
    store.ledger = foldLedgerNotes(store.ledgerNotes, targetTurn);
    if (typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx > targetTurn) store.ledgerLiveIdx = targetTurn;
    store.ledgerStaging = null;
    store.ledgerStagingNotes = null;
    store.ledgerRebuild = null;
    log(`Ledger rewound by folding notes to turn ${targetTurn}: dropped ${before - store.ledgerNotes.length} note(s), no model call.`);
    return true;
}

function mergeLedgerDeltas(deltas, target, atTurn) {
    if (!Array.isArray(deltas) || deltas.length === 0) return 0;
    let ledger = target;
    if (!ledger || typeof ledger !== 'object') {
        const store = getChatStore();
        if (!store.ledger || typeof store.ledger !== 'object') store.ledger = {};
        ledger = store.ledger;
        // Durable early adoption: a copilot edit made since the last pass is
        // journaled BEFORE new deltas land on top of it.
        try { adoptExternalLedgerEdits(store); } catch (e) { log('adoptExternalLedgerEdits failed (non-fatal):', e); }
    }
    let changed = 0;
    for (const d of deltas) {
        if (!d || typeof d !== 'object') continue;
        const rawName = typeof d.name === 'string' ? d.name.trim() : '';
        if (!rawName) continue;
        const key = resolveLedgerKey(ledger, rawName);
        const entry = ledger[key] || {};
        let touched = false;
        if (typeof d.core === 'string')  { const v = stripLeadingLabel(d.core);  if (v) { entry.core  = v; touched = true; } }
        if (typeof d.state === 'string') { const v = stripLeadingLabel(d.state); if (v) { entry.state = v; touched = true; } }
        if (typeof d.arc === 'string')   { const v = stripLeadingLabel(d.arc);   if (v) { entry.arc   = v; touched = true; } }
        if (Array.isArray(d.threads)) {
            entry.threads = d.threads
                .filter(t => typeof t === 'string' && t.trim())
                .map(t => stripLeadingLabel(t))
                .filter(Boolean);
            touched = true;
        }
        if (touched) {
            entry.updatedAt = Date.now();
            if (typeof atTurn === 'number' && isFinite(atTurn)) entry._t = atTurn;   // last turn that shaped this entry — lets rewinds drop future-derived state instantly
            ledger[key] = entry;
            changed++;
        }
    }
    // The page is the materialized view; the notes are the history behind it. Staged
    // rebuild merges are NOT journalled here — they are journalled as one re-based
    // note per character at swap time, where the rebuild's coverage is known.
    if (changed && !target) { try { appendLedgerNotes(deltas, atTurn); } catch (e) { log('appendLedgerNotes failed (non-fatal):', e); } }
    return changed;
}

// Queue a ledger update for the batch just summarized and return IMMEDIATELY.
// The scribe runs in the background (sequentially, one at a time) so the
// summarize→ghost cycle finishes at full speed. If we switch chats before the
// scribe lands, the result is discarded via the epoch guard. Never awaited.
// ─── Live ledger pass (decoupled from summarization) ─────────────────
// The per-batch ledger update only sees turns as they get SUMMARIZED, so the most
// recent ~verbatimTurns of character development never reach the ledger and "Now"
// lags the current scene. The live pass closes that gap: every N turns it runs the
// scribe over the recent, not-yet-summarized window so states, arcs, and threads
// track the present. It hands off cleanly to the summarization pass — it only
// covers turns AFTER summarizedUpTo and advances a persisted pointer (ledgerLiveIdx)
// so no turn is reprocessed. Same queue, same guards; failures are non-fatal.
let _turnsSinceLive = 0;
let _rosterTick = 0;   // advances once per turn so the off-screen roster rotates

// Pure: which [start,end] turn range the live pass should cover, or null if nothing
// new. Skips already-summarized turns; resyncs if the pointer is stale-high (e.g.
// after a deletion left it past the chat end).
function _computeLiveLedgerRange(summarizedUpTo, ledgerLiveIdx, latestIdx) {
    if (typeof latestIdx !== 'number' || latestIdx < 0) return null;
    const su = (typeof summarizedUpTo === 'number') ? summarizedUpTo : -1;
    let li = (typeof ledgerLiveIdx === 'number') ? ledgerLiveIdx : -1;
    if (li > latestIdx) li = su;   // pointer past chat end (deletion/branch) — resync to summarized
    const start = Math.max(su + 1, li + 1);
    if (start > latestIdx) return null;
    return [start, latestIdx];
}

// Queue a live scribe pass over the recent window. Returns true iff a job was
// pushed. Skips when a batch/backfill is running or the queue is non-empty, so live
// jobs never pile up or fight the summarization pass — the next turn retries.
function queueLiveLedgerUpdate(opts = {}) {
    try {
        const manual = !!opts.manual;
        const s = getSettings();
        if (!s.ledgerEnabled || s.ledgerLiveUpdate === false) return false;
        if (_llmChannelBusy() || _ledgerQueue.length > 0) return 'busy';
        const { chat } = SillyTavern.getContext();
        if (!Array.isArray(chat) || chat.length === 0) return false;
        const store = getChatStore();
        const turns = getAssistantTurns(chat);
        if (turns.length === 0) return false;
        const latestIdx = turns[turns.length - 1].index;
        const range = _computeLiveLedgerRange(store.summarizedUpTo, store.ledgerLiveIdx, latestIdx);
        if (!range) return false;
        const _step = Math.max(1, (s.turnsPerSummary | 0) || 5);
        const _staging = !!(store.ledgerRebuild && store.ledgerRebuild.staging);   // an active staged catch-up owns the pointer — route into staging, never the live ledger
        if (range[1] - range[0] + 1 > _step * 3) {
            // The gap is far bigger than a normal turn-to-turn window (interrupted
            // rebuild, long-idle pointer): one giant passage would blow the prompt.
            // Same bounded background chunks a rewind uses; liveIdx advances per chunk.
            const _n = queueLedgerReplay(range[0] - 1, range[1], { staging: _staging });
            if (manual && _n > 0) toastr.info(`Catching up ${range[1] - range[0] + 1} turn(s) in ${_n} background pass${_n === 1 ? '' : 'es'} — failures will be reported.`, 'Summaryception', { timeOut: 4000 });
            return _n > 0;
        }
        const storyTxt = buildPassageFromRange(chat, range[0], range[1]);
        if (!storyTxt.trim()) return false;
        const contextStr = buildLedgerContext(range[0], LEDGER_GIST_CAP);   // bounded recent gist (was the whole story every turn)
        _ledgerQueue.push({ storyTxt, contextStr, epoch: _chatEpoch, gen: _ledgerGen, live: true, liveEnd: range[1], staging: _staging, manual });
        try { renderLedger(); } catch (_) { /* panel may be closed */ }   // indicator flips to "reading…" the moment work is queued
        processLedgerQueue();   // fire and forget
        return true;
    } catch (e) { try { log('queueLiveLedgerUpdate failed (non-fatal):', e); } catch (_) {} return false; }
}

// Cadence gate: called once per assistant turn. Resets the counter only when a live
// pass is actually queued, so a skipped (busy) turn is retried rather than dropped.
// Busy self-retry: the live pass fires right after maybeSummarizeTurns in the same
// callback, so on cadence turns the summarizer is ALWAYS running and the pass was
// skipped with nothing retrying until the user's next action — the ledger lagged a
// full turn and the freshest scene's characters were missing. A skipped-busy pass
// now retries itself every few seconds until the coast is clear.
let _liveRetryTimer = null;
let _liveRetryLeft = 0;
function _clearLiveRetry() { if (_liveRetryTimer) { clearTimeout(_liveRetryTimer); _liveRetryTimer = null; } _liveRetryLeft = 0; }
// A 'busy' skip must NEVER be abandoned. The old bound was 8 tries x 4s = 32s of
// patience — SHORTER THAN ONE MODEL CALL on a phone. So the ordinary sequence
// (play -> summarizer holds the channel 30s+ -> live pass retries -> gives up)
// left the newest turn permanently un-ingested: the ledger's "Now" lagged, and the
// user had to tap "Update now" by hand, which only worked because the channel was
// free by then. That is exactly why it did not feel automatic. 'busy' means another
// pass holds the channel and passes always finish, so retrying until it lands is
// correct and cannot loop forever; the cap only kills a pathological zombie timer,
// and 'false' (nothing to ingest) stops immediately.
const _LIVE_RETRY_MAX = 300;   // ~20 min of patience, not 32 seconds
function _armLiveRetry() {
    if (_liveRetryTimer) return;                    // one pending retry at a time
    if (_liveRetryLeft <= 0) _liveRetryLeft = _LIVE_RETRY_MAX;
    _liveRetryTimer = setTimeout(() => {
        _liveRetryTimer = null;
        const r = queueLiveLedgerUpdate();
        if (r === true) { _turnsSinceLive = 0; _liveRetryLeft = 0; try { renderLedger(); } catch (_) {} return; }
        if (r === false) { _liveRetryLeft = 0; return; }   // nothing left to ingest
        if (--_liveRetryLeft > 0) _armLiveRetry();
    }, 4000);
}

function maybeQueueLiveLedger() {
    const s = getSettings();
    if (!s.ledgerEnabled || s.ledgerLiveUpdate === false) return;
    _turnsSinceLive++;
    if (_turnsSinceLive < Math.max(1, s.ledgerLiveEveryTurns ?? 1)) return;
    const r = queueLiveLedgerUpdate();
    if (r === true) { _turnsSinceLive = 0; _clearLiveRetry(); }
    else if (r === 'busy') _armLiveRetry();
}

// ─── Ledger checkpoints + smart rewind (branch / bulk-trim) ──────────
// The character ledger is cumulative and can't be trimmed by turn, so a branch or
// bulk delete would otherwise force a rebuild from the WHOLE history. Instead we
// snapshot the ledger into localStorage every few turns (keyed by a content signature
// that survives rename/branch, so a freshly-branched chat can still find its parent's
// checkpoints; old snapshots are thinned, not dropped, so deep branches still land near
// one). On a branch/trim to turn X we restore the nearest snapshot at/before X instantly
// and re-derive the remaining delta as bounded BACKGROUND scribe jobs — no blocking
// foreground call, no sticky toast, no full rebuild.
const _CKPT_PREFIX = 'sc_ledgerckpt::';
const CKPT_EVERY = 1;    // snapshot EVERY ledgered turn: retention (dense recent + sparse anchors) caps storage at the same count, and a nearest-neighbor checkpoint means deleting one message replays ONLY the turns after it — never a cadence tax of unrelated turns before it
const CKPT_KEEP = 16;    // dense recent snapshots kept per chat (with every-turn cadence: the last 16 turns each have an exact restore point)
const CKPT_SPARSE_EVERY = 25;   // beyond the dense window, keep one snapshot per this many turns — a deep branch rewinds from a nearby old checkpoint instead of forcing a full rebuild

function _chatSig() {
    try {
        const { chat } = SillyTavern.getContext();
        if (!Array.isArray(chat) || chat.length === 0) return null;
        const pick = (m) => m ? (String(m.send_date == null ? '' : m.send_date) + '|' + String(m.name == null ? '' : m.name) + '|' + String(m.mes == null ? '' : m.mes).slice(0, 100)) : '';
        let firstAsst = null;
        for (const m of chat) { if (m && !m.is_user) { firstAsst = m; break; } }
        const raw = pick(chat[0]) + '||' + pick(firstAsst);
        let h = 5381;
        for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) & 0xFFFFFFFF;
        return (h >>> 0).toString(36) + '_' + raw.length;
    } catch (_) { return null; }
}

// Pure: which checkpoint turns survive a prune. The newest `keepRecent` stay dense;
// older ones are thinned to one per `sparseEvery`-turn bucket (newest in each bucket
// wins). sparseEvery <= 0 drops the tail entirely (quota-pressure hard prune).
function _selectCheckpointKeeps(turnsAsc, keepRecent, sparseEvery) {
    const keep = new Set();
    if (!Array.isArray(turnsAsc) || turnsAsc.length === 0) return keep;
    const recentStart = Math.max(0, turnsAsc.length - Math.max(1, keepRecent | 0));
    for (let i = recentStart; i < turnsAsc.length; i++) keep.add(turnsAsc[i]);
    const every = sparseEvery | 0;
    if (every > 0) {
        const byBucket = new Map();
        for (let i = 0; i < recentStart; i++) byBucket.set(Math.floor(turnsAsc[i] / every), turnsAsc[i]);   // ascending — newest per bucket wins
        for (const t of byBucket.values()) keep.add(t);
    }
    return keep;
}

function _pruneCheckpoints(sig, keep, sparseEvery) {
    try {
        if (typeof localStorage === 'undefined' || !sig) return;
        const prefix = _CKPT_PREFIX + sig + '::';
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || k.indexOf(prefix) !== 0) continue;
            let at = 0; try { at = (JSON.parse(localStorage.getItem(k)) || {}).atTurn || 0; } catch (_) {}
            entries.push([k, at]);
        }
        if (entries.length <= keep) return;
        entries.sort((a, b) => a[1] - b[1]);   // oldest first
        const every = (sparseEvery === undefined) ? CKPT_SPARSE_EVERY : sparseEvery;
        const keeps = _selectCheckpointKeeps(entries.map(e => e[1]), keep, every);
        for (const [k, at] of entries) if (!keeps.has(at)) localStorage.removeItem(k);
    } catch (_) {}
}

function saveLedgerCheckpoint(atTurn, ledgerOverride) {
    try {
        if (typeof localStorage === 'undefined' || typeof atTurn !== 'number' || atTurn < 0) return;
        const sig = _chatSig();
        if (!sig) return;
        const store = getChatStore();
        const src = (ledgerOverride && typeof ledgerOverride === 'object') ? ledgerOverride : store.ledger;
        if (!src || typeof src !== 'object' || Object.keys(src).length === 0) return;
        const payload = JSON.stringify({ atTurn, ledger: src, savedAt: Date.now(), era: (store.ledgerEra | 0) });
        const key = _CKPT_PREFIX + sig + '::' + atTurn;
        try { localStorage.setItem(key, payload); }
        catch (_) { _pruneCheckpoints(sig, Math.max(2, Math.floor(CKPT_KEEP / 2)), 0); try { localStorage.setItem(key, payload); } catch (_) {} }
        _pruneCheckpoints(sig, CKPT_KEEP);
        // Remember this signature in chat metadata (survives head-edits, copied into
        // branches) so lookups can union across sig drift instead of losing everything.
        if (!Array.isArray(store.ckptSigs)) store.ckptSigs = [];
        if (!store.ckptSigs.includes(sig)) {
            store.ckptSigs.push(sig);
            while (store.ckptSigs.length > 3) store.ckptSigs.shift();
        }
    } catch (_) {}
}

function listLedgerCheckpoints() {
    const out = [];
    try {
        if (typeof localStorage === 'undefined') return out;
        const sig = _chatSig();
        if (!sig) return out;
        // Union across the current signature AND the recent signatures remembered in
        // chat metadata: the content sig changes when the greeting / first messages
        // are edited or head messages deleted, which used to orphan EVERY checkpoint
        // at once. Metadata survives those edits, so older-sig snapshots stay usable.
        const store = getChatStore();
        const sigs = new Set([sig]);
        if (Array.isArray(store.ckptSigs)) for (const s2 of store.ckptSigs) if (s2) sigs.add(s2);
        const seen = new Set();   // dedupe by atTurn — the newest sig wins
        for (const sg of sigs) {
            const prefix = _CKPT_PREFIX + sg + '::';
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || k.indexOf(prefix) !== 0) continue;
                try {
                    const v = JSON.parse(localStorage.getItem(k));
                    // Era gate: Clear Ledger bumps store.ledgerEra, making every older
                    // snapshot invisible to THIS chat (a rewind must never resurrect a
                    // ledger the user explicitly rejected) while branches — whose copied
                    // store carries the era they branched at — keep seeing theirs.
                    if (v && ((v.era | 0) !== (store.ledgerEra | 0))) continue;
                    if (v && typeof v.atTurn === 'number' && v.ledger && !seen.has(v.atTurn)) { seen.add(v.atTurn); out.push(v); }
                } catch (_) {}
            }
        }
        out.sort((a, b) => a.atTurn - b.atTurn);
    } catch (_) {}
    return out;
}

// Pure: the newest checkpoint at or before targetTurn, or null.
function _pickCheckpoint(list, targetTurn) {
    if (!Array.isArray(list) || typeof targetTurn !== 'number') return null;
    let best = null;
    for (const c of list) {
        if (c && typeof c.atTurn === 'number' && c.atTurn <= targetTurn && (!best || c.atTurn > best.atTurn)) best = c;
    }
    return best;
}

function maybeCheckpointLedger(ledgerOverride) {
    try {
        const st = getChatStore();
        const idx = st.ledgerLiveIdx;
        if (typeof idx !== 'number' || idx < 0) return;
        // Per-chat cursor (in the chat store, not module state): a module-global
        // cursor leaked across chats — after a long chat, a shorter chat's turns
        // never exceeded the stale cursor and checkpointing silently stopped.
        const last = (typeof st._ckptLast === 'number') ? st._ckptLast : -999;
        if (idx < last + CKPT_EVERY) return;   // throttle by cadence (and skip same-turn repeats)
        st._ckptLast = idx;
        saveLedgerCheckpoint(idx, ledgerOverride);
    } catch (_) {}
}

// Pure: split the replay span (fromExclusive, toInclusive] into summarizer-sized
// [start,end] chunks, so a stale checkpoint never produces one monster prompt.
function _computeReplayChunks(fromExclusive, toInclusive, step) {
    const chunks = [];
    if (typeof fromExclusive !== 'number' || typeof toInclusive !== 'number') return chunks;
    const st = Math.max(1, step | 0);
    for (let a = fromExclusive + 1; a <= toInclusive; a += st) chunks.push([a, Math.min(a + st - 1, toInclusive)]);
    return chunks;
}

// Queue a clean-slate ledger rebuild through turn `targetTurn` as background jobs,
// batched by ASSISTANT turns exactly like the manual backfill (message-index chunks
// would roughly double the call count on a long history). Each job advances
// ledgerLiveIdx and checkpoints as it lands — resumable, and it leaves sparse
// snapshots behind so a future trim into this region rewinds instantly instead.
// Returns the number of jobs queued.
function queueLedgerRebuild(targetTurn) {
    try {
        const { chat } = SillyTavern.getContext();
        if (!Array.isArray(chat) || chat.length === 0) return 0;
        const s = getSettings();
        const turns = getAssistantTurns(chat).filter(t => t.index <= targetTurn);
        const batches = _computeBackfillBatches(turns, (s.turnsPerSummary | 0) || 5);
        let queued = 0;
        for (const b of batches) {
            const storyTxt = buildPassageFromRange(chat, b.passageStart, Math.min(b.endIdx, targetTurn));
            if (!storyTxt.trim()) continue;
            const contextStr = buildLedgerContext(b.passageStart, LEDGER_GIST_CAP);
            _ledgerQueue.push({ storyTxt, contextStr, epoch: _chatEpoch, gen: _ledgerGen, live: true, liveEnd: Math.min(b.endIdx, targetTurn), staging: true });
            queued++;
        }
        if (queued > 0) processLedgerQueue();   // fire and forget — the queue serializes
        return queued;
    } catch (e) { try { log('queueLedgerRebuild failed (non-fatal):', e); } catch (_) {} return 0; }
}

// Queue the (fromExclusive, toInclusive] delta as bounded BACKGROUND scribe jobs —
// one per summarizer-sized batch — instead of one blocking foreground call. Each job
// advances ledgerLiveIdx as it lands (live/liveEnd) and re-checkpoints along the way,
// so an interrupted replay resumes from the last finished chunk instead of restarting.
// The queue already carries the epoch guard and serializes against live passes.
// Returns the number of jobs queued.
function queueLedgerReplay(fromExclusive, toInclusive, opts) {
    try {
        const { chat } = SillyTavern.getContext();
        if (!Array.isArray(chat) || chat.length === 0) return 0;
        const s = getSettings();
        const staging = !!(opts && opts.staging);
        const end = Math.min(toInclusive, chat.length - 1);
        const chunks = _computeReplayChunks(fromExclusive, end, (s.turnsPerSummary | 0) || 5);
        let queued = 0;
        for (const [a, b] of chunks) {
            const storyTxt = buildPassageFromRange(chat, a, b);
            if (!storyTxt.trim()) continue;   // empty span — a later chunk's liveEnd covers the gap
            const contextStr = buildLedgerContext(a, LEDGER_GIST_CAP);   // bounded, past-only
            _ledgerQueue.push({ storyTxt, contextStr, epoch: _chatEpoch, gen: _ledgerGen, live: true, liveEnd: b, staging });
            queued++;
        }
        if (queued > 0) processLedgerQueue();   // fire and forget — the queue serializes
        return queued;
    } catch (e) { try { log('queueLedgerReplay failed (non-fatal):', e); } catch (_) {} return 0; }
}

// Restore the nearest checkpoint at/before targetTurn and re-derive the delta forward.
// Returns true if it rewound; false if no usable checkpoint (caller suggests manual rebuild).
// Pure: copy of a ledger with every entry whose last shaping turn (_t) lies PAST
// maxTurn removed. Entries without a stamp (legacy) are kept — we cannot judge them.
// Used to decontaminate the SERVING ledger instantly when a trim/branch forces a
// staged rebuild with no checkpoint: state earned on the abandoned timeline must not
// keep injecting while the clean rebuild crawls.
function _ledgerDroppingPast(ledger, maxTurn) {
    const out = {};
    if (!ledger || typeof ledger !== 'object') return out;
    for (const [k, v] of Object.entries(ledger)) {
        if (v && typeof v._t === 'number' && v._t > maxTurn) continue;
        out[k] = v;
    }
    return out;
}

// Pure: synthesize a restore point from entry stamps when no saved snapshot
// covers the ceiling. Entries carry the turn that last shaped them (_t), so
// "current ledger minus everything shaped past the ceiling" IS a valid snapshot
// AT the ceiling. Requires stamping to be active (>=1 stamped entry pre-drop) —
// an all-legacy ledger has no lineage to trust, so synthesis declines and the
// caller falls back to a staged rebuild. Unstamped entries in a stamp-active
// ledger are kept (same policy as serving decontamination: cannot judge them;
// the replay refreshes any character who appears).
function _synthesizeCheckpoint(ledger, ceil) {
    if (!ledger || typeof ledger !== 'object' || typeof ceil !== 'number' || !isFinite(ceil) || ceil < 0) return null;
    let stamped = 0;
    for (const v of Object.values(ledger)) if (v && typeof v._t === 'number') stamped++;
    if (stamped === 0) return null;
    return { atTurn: Math.floor(ceil), ledger: _ledgerDroppingPast(ledger, Math.floor(ceil)), synthetic: true };
}

// Pure: what should a content change at `idx` do to the ledger?
//   'ignore' — not yet ledgered (idx past the live pointer) or feature off: the live
//              pass will ingest the final text anyway.
//   'deep'   — edit is deeper than `depth` turns behind the pointer: almost always a
//              correction TOWARD established canon (the audit workflow), so the ledger
//              already reflects the intended facts; re-deriving the whole tail would
//              burn tokens to learn nothing.
//   'rewind' — recent edit: cheap checkpoint rewind + tiny replay keeps the ledger
//              true to the corrected text.
function _editRewindDecision(idx, liveIdx, depth) {
    if (!Number.isFinite(idx) || idx < 0) return 'ignore';
    if (typeof liveIdx !== 'number' || liveIdx < 0 || idx > liveIdx) return 'ignore';
    const d = depth | 0;
    if (d <= 0) return 'ignore';
    if (liveIdx - idx > d) return 'deep';
    return 'rewind';
}

async function tryAutoRewindLedger(targetTurn, label, maxCkptTurn) {
    try {
        const s = getSettings();
        if (s.ledgerAutoRewind === false) return false;
        if (typeof targetTurn !== 'number' || targetTurn < 0) return false;
        const _st0 = getChatStore();
        if (targetTurn <= 0) {
            // Rewinding to the literal start: nothing exists before turn 0, so clear
            // and let the live pass re-derive the first turn. This clear must NEVER
            // apply more broadly — a previous version also wiped here whenever the
            // chat had no SUMMARIZED history, which destroyed live-built ledgers on
            // unsummarized chats (they have real content and real checkpoints; the
            // 'nothing worth preserving' premise predates the live ledger).
            const epoch = _chatEpoch;
            _ledgerQueue = [];
            _ledgerGen++;
            _st0.ledger = {};
            // The journal must clear WITH the page: ghost notes left behind here
            // re-materialized the entire abandoned ledger at the next fold.
            _st0.ledgerNotes = [];
            _st0.ledgerNotesFrom = 0;
            _st0.ledgerLiveIdx = -1;
            _st0.ledgerStaging = null;
            _st0.ledgerStagingNotes = null;
            _st0.ledgerRebuild = null;
            await saveChatStore();
            if (_chatEpoch !== epoch) return true;
            try { updateInjection(true); renderLedger(); } catch (_) {}
            toastr.info(`Ledger cleared for this ${label} — re-deriving from the remaining turns.`, 'Summaryception', { timeOut: 4500 });
            return true;
        }
        // Fold first: if the notes reach back this far, the rewind is exact and free.
        // Everything below (checkpoints, synthesis, staged rebuild) is now only the
        // fallback for history recorded before notes existed.
        if (rewindLedgerFromNotes(targetTurn)) {
            _ledgerQueue = [];
            _ledgerGen++;
            await saveChatStore();
            try { updateInjection(true); renderLedger(); } catch (_) {}
            toastr.success(`Ledger rewound to turn ${targetTurn} (${label}) — folded from its own history, instantly. Nothing to re-read.`, 'Summaryception', { timeOut: 4000 });
            return true;
        }
        const _ckptCeil = (typeof maxCkptTurn === 'number' && isFinite(maxCkptTurn)) ? Math.min(targetTurn, maxCkptTurn) : targetTurn;
        let ckpt = _pickCheckpoint(listLedgerCheckpoints(), _ckptCeil);
        if (!ckpt) {
            // No snapshot at/below the target. Re-derivation from history is the only
            // remaining source of truth — but it does NOT need to be the heavyweight
            // foreground backfill (busy lock + giant progress toast). Clean-slate the
            // ledger and queue the SAME bounded background jobs a normal rewind uses,
            // batched by assistant turns and checkpointing every few turns as they
            // land — so this exact situation can never recur for this region.
            const cur = getChatStore();
            const hasLedger = cur.ledger && typeof cur.ledger === 'object' && Object.keys(cur.ledger).length > 0;
            if (!hasLedger) return true;   // nothing stale to fix — live pass fills it forward
            // Serve honestly during the rebuild: drop entries whose last shaping turn
            // lies past the target — they were earned on the abandoned timeline and
            // would contaminate every injection until the swap. (Unstamped legacy
            // entries stay; the swap replaces everything anyway.)
            // Better than a full rebuild: if stamping is active, SYNTHESIZE the missing
            // snapshot from the stamps and take the normal restore path — replaying
            // only the owed tail. Old facts about dropped characters re-enter from the
            // layer summaries in the replay context; the missing-core self-heal
            // re-anchors anyone left coreless.
            const synth = _synthesizeCheckpoint(cur.ledger, _ckptCeil);
            if (synth) {
                ckpt = synth;
            } else {
            // Clamp the rebuild's finish line to a turn a scribe pass can actually
            // reach. Deleting the last AI reply hands us targetTurn = the user
            // message before it; every job's liveEnd is an ASSISTANT index, so a
            // user-indexed target made `liveEnd >= target` unreachable — the rebuild
            // ran, then the swap waited forever and the stale page kept serving.
            const effTarget = _lastAssistantAt((SillyTavern.getContext() || {}).chat, targetTurn);
            if (effTarget < 0) {
                // The rewind lands before the first AI turn: the true ledger state
                // there is EMPTY. Install it exactly — page, journal, and pointer —
                // instead of leaving the stale serving page as the final state.
                cur.ledger = {};
                cur.ledgerNotes = [];
                cur.ledgerNotesFrom = 0;
                cur.ledgerLiveIdx = targetTurn;
                cur.ledgerStaging = null;
                cur.ledgerStagingNotes = null;
                cur.ledgerRebuild = null;
                _ledgerQueue = [];
                _ledgerGen++;
                await saveChatStore();
                try { updateInjection(true); renderLedger(); } catch (_) {}
                toastr.success(`Ledger rewound to turn ${targetTurn} — before the story's first reply, so it starts empty and refills as you play.`, 'Summaryception', { timeOut: 5000 });
                return true;
            }
            const _dropped = Object.keys(cur.ledger).length;
            cur.ledger = _ledgerDroppingPast(cur.ledger, effTarget);
            const _droppedN = _dropped - Object.keys(cur.ledger).length;
            if (_droppedN > 0) log(`Rewind(${label}): dropped ${_droppedN} ledger entr${_droppedN === 1 ? 'y' : 'ies'} shaped past turn ${effTarget} from the serving copy.`);
            // STAGING rebuild: the existing ledger keeps serving injection EXACTLY as
            // it is (imperfect beats absent) while the clean rebuild accumulates in
            // ledgerStaging. The swap happens atomically at completion; a failure or
            // an app-kill keeps the old ledger and resumes from the last finished
            // chunk. Nothing is deleted before its replacement exists.
            _ledgerQueue = [];
            _ledgerGen++;                  // invalidate any in-flight job — it saw the pre-trim timeline
            // Re-base the old journal to the SERVING page (which just got
            // decontaminated above). A bare trim here broke page == fold(notes) for
            // the whole rebuild window: at swap time the adoption diff then read the
            // entire stale serving ledger as "external work" and imported it into
            // the fresh journal — where a rewind inside the rebuild's own coverage
            // resurrected it. Re-based, fold(notes) equals the serving page exactly,
            // so (a) a mid-rebuild fold reproduces the page instead of painting the
            // abandoned timeline over it, and (b) the ONLY swap-time divergence is
            // a genuine external edit made while the rebuild ran — which is the one
            // thing the swap must carry across. Journal any pre-existing external
            // work first; it belongs to the timeline the rebuild replaces.
            if (Array.isArray(cur.ledgerNotes)) {
                try { adoptExternalLedgerEdits(cur); } catch (_) {}
                cur.ledgerNotes = _baseNotesFromPage(cur.ledger, effTarget);
                cur.ledgerNotesFrom = effTarget;   // effTarget, not targetTurn: the swap's coverage check (notesCover(st, upTo)) compares against the pointer the jobs actually reach
            }
            // RESUME, don't restart: if a staged rebuild is already underway, its
            // completed chunks (through ledgerLiveIdx) are valid for a tail trim —
            // deleting messages ABOVE the pointer changes nothing below it. Blowing
            // all progress away on every deletion made active editing restart the
            // whole history from turn 0, over and over.
            const _resumable = !!(cur.ledgerRebuild && cur.ledgerRebuild.staging
                && cur.ledgerStaging && typeof cur.ledgerStaging === 'object'
                && typeof cur.ledgerLiveIdx === 'number' && cur.ledgerLiveIdx >= 0
                && cur.ledgerLiveIdx < effTarget);
            let jobs = 0;
            if (_resumable) {
                // A rebuild that started before the staging journal existed has no
                // notes for its finished chunks: journaling only the resumed tail
                // would masquerade as full coverage. Absent journal -> the swap's
                // per-entry-base fallback; present journal keeps accumulating.
                if (cur.ledgerStagingNotes !== undefined && !Array.isArray(cur.ledgerStagingNotes)) cur.ledgerStagingNotes = undefined;
                jobs = queueLedgerReplay(cur.ledgerLiveIdx, effTarget, { staging: true });
                cur.ledgerRebuild = { target: effTarget, staging: true, attempts: cur.ledgerRebuild.attempts | 0 };
            } else {
                cur.ledgerStaging = {};
                cur.ledgerStagingNotes = [];   // the rebuild journals its own reads — the swap installs page AND journal
                cur.ledgerLiveIdx = -1;        // tracks STAGING progress until the swap
                cur._ckptLast = -1;            // re-arm checkpointing (staging snapshots) from zero — per-chat cursor since v5.51
                jobs = queueLedgerRebuild(effTarget);
                cur.ledgerRebuild = jobs > 0 ? { target: effTarget, staging: true, attempts: 0 } : null;   // persisted: resumes at reopen
                if (jobs === 0) cur.ledgerStaging = null;
            }
            await saveChatStore();
            try { updateInjection(true); renderLedger(); } catch (_) {}
            toastr.info(
                jobs > 0
                    ? (_resumable
                        ? `Ledger rebuild adjusted for this ${label} — continuing from turn ${cur.ledgerLiveIdx} (${jobs} background pass${jobs === 1 ? '' : 'es'} left). Your current ledger entries stay live until it lands.`
                        : `No ledger snapshot exists that far back — rebuilding a fresh one for this ${label} in ${jobs} background pass${jobs === 1 ? '' : 'es'}. Your current ledger entries stay live until the rebuild lands. Keep playing.`)
                    : `Nothing to rebuild for this ${label} — the live pass covers the remaining turns.`,
                'Summaryception', { timeOut: 6500 });
            return true;
            }
        }
        const store = getChatStore();
        _ledgerQueue = [];   // drop pending background jobs — we're rewriting the ledger
        _ledgerGen++;        // and invalidate any job already IN FLIGHT: its deltas were computed against the pre-rewind ledger/timeline
        store.ledger = JSON.parse(JSON.stringify(ckpt.ledger || {}));
        // Every surviving note describes turns past this restore point (notesCover
        // said no, so ledgerNotesFrom > ckpt.atTurn) — ghosts of the abandoned
        // timeline. Left in place, the next fold (a message deletion, a rewind)
        // painted them back over the restored page. Rebase: the journal restarts
        // as base notes of the checkpoint itself; the replay journals forward.
        store.ledgerNotes = _baseNotesFromPage(store.ledger, ckpt.atTurn);
        store.ledgerNotesFrom = ckpt.atTurn;
        store.ledgerLiveIdx = ckpt.atTurn;
        store._ckptLast = ckpt.atTurn;   // re-arm checkpointing from the restore point — per-chat cursor
        // The restore itself is instant. The delta re-derivation is NOT a foreground
        // concern — summary/injection repair already finished — so it runs as bounded
        // background jobs instead of one blocking scribe call with a sticky toast.
        // liveIdx stays at the checkpoint until each chunk lands, so an interruption
        // (mobile app backgrounded mid-call) resumes from the last finished chunk.
        const queued = (ckpt.atTurn < targetTurn) ? queueLedgerReplay(ckpt.atTurn, targetTurn) : 0;
        if (queued === 0) { store.ledgerLiveIdx = targetTurn; store._ckptLast = targetTurn; }
        store.ledgerRebuild = queued > 0 ? { target: targetTurn } : null;   // persisted: an app-kill mid-replay resumes at reopen
        store.ledgerStaging = null;   // a checkpoint restore supersedes any half-finished staged rebuild
        store.ledgerStagingNotes = null;
        await saveChatStore();
        try { updateInjection(true); renderLedger(); } catch (_) {}
        toastr.success(
            queued
                ? `Ledger restored from ${ckpt.synthetic ? `a restore point synthesized from entry stamps (turn ${ckpt.atTurn})` : `the turn-${ckpt.atTurn} checkpoint`} (${label}) — re-deriving ${targetTurn - ckpt.atTurn} turn(s) in ${queued} background pass${queued === 1 ? '' : 'es'}. Keep playing; it catches up on its own.`
                : `Ledger auto-rewound to turn ${targetTurn} from a checkpoint at turn ${ckpt.atTurn} — nothing to re-derive.`,
            'Summaryception', { timeOut: 6000 });
        return true;
    } catch (e) { try { log('tryAutoRewindLedger failed (non-fatal):', e); } catch (_) {} return false; }
}

function queueLedgerUpdate(storyTxt, contextStr, endIdx) {
    const s = getSettings();
    if (!s.ledgerEnabled) return;
    const store = getChatStore();
    if (!store.ledger || typeof store.ledger !== 'object') store.ledger = {};
    // endIdx (when known) rides as liveEnd so the job advances ledgerLiveIdx and
    // checkpoints on completion — without it, live-off installs never saved a
    // single checkpoint, so every branch rewind fell through to a full rebuild.
    const job = { storyTxt, contextStr, epoch: _chatEpoch, gen: _ledgerGen };
    if (typeof endIdx === 'number' && endIdx >= 0) { job.live = true; job.liveEnd = endIdx; }
    _ledgerQueue.push(job);
    processLedgerQueue();   // fire and forget — deliberately NOT awaited
}

// A catch-up chunk that fails must never let LATER chunks advance the pointer
// past its hole (turns silently skipped forever = drifting 'Now'). Drop the rest
// of the pipeline, count the attempt on the persisted marker, and let the resume
// path retry from the last COMPLETED chunk.
function _abortCatchupPipeline(reason) {
    try {
        _ledgerQueue = [];
        _ledgerGen++;
        const st = getChatStore();
        if (st.ledgerRebuild && typeof st.ledgerRebuild === 'object') {
            st.ledgerRebuild.attempts = (st.ledgerRebuild.attempts | 0) + 1;
            saveChatStore().catch(() => {});
            log(`Ledger catch-up paused (${reason}) — attempt ${st.ledgerRebuild.attempts}; will resume from the last completed chunk.`);
        }
    } catch (_) {}
}

// Failure visibility: live passes are deliberately quiet (background bookkeeping),
// but SILENT failure created an invisible circle — the pointer stays put (hole-free
// rule), the user taps Update now again, the same span re-reads, fails again, and
// nothing on screen ever says why. Manual jobs now report their failure directly;
// automatic jobs report once after 3 consecutive failures instead of circling
// forever in the dark.
let _liveFailStreak = 0;
function _noteLiveFailure(job, reason) {
    try {
        _liveFailStreak++;
        if (job && job.manual) {
            toastr.warning(`Ledger update failed (${reason}) — the pointer stayed put so nothing is skipped. Tap 🔄 Update now to retry.`, 'Summaryception', { timeOut: 6000 });
            return;
        }
        if (_liveFailStreak === 3) {
            toastr.warning(`The character ledger has failed to read the latest turn(s) 3 times in a row (${reason}). It keeps retrying on new turns — if this persists, check the model or connection.`, 'Summaryception', { timeOut: 7000 });
        }
    } catch (_) {}
}

async function processLedgerQueue() {
    if (_ledgerActive) return;
    // The scribe channel is EXCLUSIVE. callSummarizer snapshots ST's prompt toggles,
    // disables them, and restores on finish — two concurrent calls interleave those
    // snapshots and leave the user's toggles permanently wrong (and fight for rate
    // limit). Jobs stay queued and run the instant the audit releases the channel.
    if (_llmChannelBusy()) { setTimeout(() => { processLedgerQueue(); }, 2000); return; }
    _ledgerActive = true;
    try {
        while (_ledgerQueue.length > 0) {
            const job = _ledgerQueue.shift();
            try {
                const s = getSettings();
                const _store0 = getChatStore();
                // Staging jobs read from and write to the staging ledger; the LIVE
                // ledger keeps serving injection untouched until the swap.
                if (job.staging && (!_store0.ledgerStaging || typeof _store0.ledgerStaging !== 'object')) _store0.ledgerStaging = {};
                const _base = job.staging ? _store0.ledgerStaging : _store0.ledger;
                const ledgerStr = serializeLedgerForScribe(_base, s.ledgerContextMaxChars);
                const deltas = await callLedgerScribe(job.storyTxt, job.contextStr, ledgerStr);
                // Chat-switch guard: a result computed for the previous chat must
                // never be written into this one.
                if (job.epoch !== _chatEpoch) {
                    log('Ledger (background): chat switched mid-update — result discarded.');
                    continue;
                }
                if (typeof job.gen === 'number' && job.gen !== _ledgerGen) {
                    // The chat's timeline moved (edit / delete / swipe / rewind) while
                    // this pass was reading it — the result is stale and must be
                    // discarded. But a silent discard left the pointer unmoved with the
                    // user having WATCHED the pass complete: their next tap redid
                    // identical work, looking like an endless restart. Discards now
                    // say so (manual) and always self-heal by re-running automatically.
                    log('Ledger (background): ledger was rewound/trimmed mid-update — stale result discarded; re-deriving automatically.');
                    if (job.manual) toastr.info('That read was discarded — the chat changed (edit/delete/swipe) while it ran. Re-reading automatically…', 'Summaryception', { timeOut: 4000 });
                    if (job.live) _armLiveRetry();
                    continue;
                }
                if (!deltas) {
                    // Unparseable scribe output on a pointer-advancing chunk: stop the
                    // pipeline HERE rather than skip the hole and drift.
                    if (job.live && typeof job.liveEnd === 'number') {
                        _noteLiveFailure(job, 'unparseable scribe output');
                        _abortCatchupPipeline('unparseable scribe output');
                        continue;
                    }
                    log('Ledger (background): no parseable output — skipped.');
                    continue;
                }
                const _tgt = job.staging ? (getChatStore().ledgerStaging || (getChatStore().ledgerStaging = {})) : undefined;
                const changed = mergeLedgerDeltas(deltas, _tgt, (typeof job.liveEnd === 'number' ? job.liveEnd : undefined));
                // A staged rebuild journals its own reads: the swap installs page AND
                // journal together, or the first fold after it undoes the rebuild.
                if (job.staging && changed > 0 && typeof job.liveEnd === 'number') {
                    const _stJ = getChatStore();
                    if (Array.isArray(_stJ.ledgerStagingNotes)) {
                        for (const n of _notesFromDeltas(deltas, job.liveEnd)) _stJ.ledgerStagingNotes.push(n);
                    }
                }
                if (job.live && typeof job.liveEnd === 'number') {
                    const _st = getChatStore();
                    if (typeof _st.ledgerLiveIdx !== 'number' || job.liveEnd > _st.ledgerLiveIdx) _st.ledgerLiveIdx = job.liveEnd;
                    if (_st.ledgerRebuild && typeof _st.ledgerRebuild.target === 'number' && _st.ledgerLiveIdx >= _st.ledgerRebuild.target) {
                        // Catch-up complete. If it was a STAGING rebuild, swap the clean
                        // result in atomically — the old ledger served injection until
                        // this exact moment, so there was never an empty window. The
                        // swap carries the staged JOURNAL in with the page (and any
                        // copilot edits made to the live page while it ran).
                        if (job.staging && _swapStagedLedgerIn(_st)) {
                            toastr.success('Ledger rebuild complete — the fresh, branch-accurate ledger is now live.', 'Summaryception', { timeOut: 5000 });
                        }
                        _st.ledgerStaging = null;
                        _st.ledgerStagingNotes = null;
                        _st.ledgerRebuild = null;
                    }
                    maybeCheckpointLedger(job.staging ? _tgt : undefined);
                }
                if (job.live) _liveFailStreak = 0;
                if (changed > 0) {
                    await saveChatStore();
                    updateInjection();
                    try { renderLedger(); } catch (_) { /* panel may be closed */ }
                    log(`Ledger (background): updated ${changed} character entr${changed === 1 ? 'y' : 'ies'}.`);
                    if (job.manual) toastr.success(`Ledger updated — ${changed} character entr${changed === 1 ? 'y' : 'ies'} refreshed through turn ${job.liveEnd}.`, 'Summaryception', { timeOut: 3500 });
                } else {
                    log('Ledger (background): no changes to apply.');
                    if (job.live) { try { await saveChatStore(); } catch (_) {} }
                    if (job.manual) toastr.info(`Ledger read through turn ${job.liveEnd} — no character changes to record.`, 'Summaryception', { timeOut: 3000 });
                }
            } catch (e) {
                log('Ledger (background) failed for one batch — ledger unchanged:', e);
                if (job && job.live) _noteLiveFailure(job, (e && e.message) ? e.message : 'request failed');
                // Pointer-advancing chunk threw (network/abort): same rule — never
                // let later chunks hop the hole.
                if (job.live && typeof job.liveEnd === 'number') _abortCatchupPipeline('request failed');
            }
        }
    } finally {
        _ledgerActive = false;
    }
}

// ─── Retroactive backfill (auditor + ledger over existing history) ───
// The summarizer self-heals a backlog, but the auditor and ledger only run
// forward on each new batch. For a story that already has summaries (or was
// running before these passes existed), these drivers replay the existing
// history to populate detail notes and the character ledger. All are
// user-triggered, sequential, cancelable (via the progress toast), and reuse
// callSummarizer's retry/abort. They never create snippets or ghost messages —
// they only read source passages and write details / ledger entries.

// Pure: split chronological assistant turns into sequential passages that mirror
// the live summarizer's batching — each passage spans from the previous batch's
// end+1 to this batch's last assistant-turn index, so every message is covered
// exactly once. Returns [{passageStart, endIdx, count}].
function _computeBackfillBatches(assistantTurns, perBatch) {
    const batches = [];
    if (!Array.isArray(assistantTurns) || assistantTurns.length === 0) return batches;
    const step = Math.max(1, perBatch | 0);
    let passageStart = 0;
    for (let i = 0; i < assistantTurns.length; i += step) {
        const slice = assistantTurns.slice(i, i + step);
        const endIdx = slice[slice.length - 1].index;
        if (endIdx < passageStart) continue;   // defensive: never go backwards
        batches.push({ passageStart, endIdx, count: slice.length });
        passageStart = endIdx + 1;
    }
    return batches;
}

async function backfillLedgerFromHistory(opts) {
    const auto = !!(opts && opts.auto);   // autonomous rebuild (branch/trim fallback): no confirm, clean-slate first
    const s = getSettings();
    if (!s.ledgerEnabled) { if (!auto) toastr.warning('Enable the Character Ledger first.', 'Summaryception'); return; }
    if (isSummarizing) { if (!auto) toastr.warning('Busy — try again in a moment.', 'Summaryception'); return; }
    if (_llmChannelBusy()) { if (!auto) toastr.warning('A background pass is finishing — try again in a few seconds.', 'Summaryception'); return; }

    const store = getChatStore();
    if (!store.ledger || typeof store.ledger !== 'object') store.ledger = {};
    if (auto) { store.ledger = {}; store.ledgerLiveIdx = -1; }   // clean slate FIRST — so a branch with no earlier turns (e.g. back to turn 0) still ends up cleared

    const { chat } = SillyTavern.getContext();
    const turns = getAssistantTurns(chat);
    if (turns.length === 0) {
        if (auto) { await saveChatStore(); updateInjection(true); try { renderLedger(); } catch (_) {} toastr.info('Ledger cleared — this branch has no earlier turns to rebuild from.', 'Summaryception', { timeOut: 4000 }); }
        else toastr.info('No story turns to build the ledger from yet.', 'Summaryception', { timeOut: 4000 });
        return;
    }
    const batches = _computeBackfillBatches(turns, s.turnsPerSummary);
    if (batches.length === 0) {
        if (auto) { await saveChatStore(); updateInjection(true); try { renderLedger(); } catch (_) {} }
        else toastr.info('Nothing to process.', 'Summaryception');
        return;
    }
    if (!auto && !confirm(
        `Build the Character Ledger from the whole story?\n\n` +
        `Replays ${turns.length} turns in ${batches.length} passes (~${batches.length} background LLM calls) to populate/refresh the ledger. ` +
        `It MERGES into the current ledger — use "Clear Ledger" first if you want a clean rebuild. You can stop anytime; progress is kept.`
    )) return;

    _ledgerQueue = [];   // we drive the scribe directly here; drop pending background jobs (store was cleared above)
    const startEpoch = _chatEpoch;   // if the user switches chats mid-run, abandon — never write another chat's ledger

    let done = 0, failed = 0, cancelled = false, consec = 0, _bfCkpt = -999;
    // Grounding gist is built per-batch below (bounded + past-only) — sending the whole
    // story on every pass was the main cost on long chats.
    const toast = toastr.info(`${auto ? 'Auto-rebuilding' : 'Building'} ledger: 0 / ${batches.length} passes`, 'Summaryception Ledger', {
        timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true,
        onCloseClick: () => { cancelled = true; abortSummarization(); },
    });
    isSummarizing = true;
    try {
        for (const b of batches) {
            if (cancelled || _chatEpoch !== startEpoch) break;
            const storyTxt = buildPassageFromRange(chat, b.passageStart, b.endIdx);
            if (!storyTxt.trim()) { done++; continue; }
            try {
                const ledgerStr = serializeLedgerForScribe(store.ledger, s.ledgerContextMaxChars);
                const contextStr = buildLedgerContext(b.passageStart, LEDGER_GIST_CAP);   // bounded + past-only — don't send the whole gist every pass (long chats hit token limits -> 429 waits)
                const deltas = await callLedgerScribe(storyTxt, contextStr, ledgerStr);
                if (_chatEpoch !== startEpoch) break;   // switched during the call — discard, never merge into the wrong chat
                if (deltas) mergeLedgerDeltas(deltas, undefined, b.endIdx);
                if (b.endIdx >= _bfCkpt + CKPT_EVERY) { try { saveLedgerCheckpoint(b.endIdx); } catch (_) {} _bfCkpt = b.endIdx; }   // checkpoint AS we rebuild, so a later branch can cheaply rewind instead of full-rebuilding again
                consec = 0;
            } catch (e) {
                failed++; consec++;
                log('Ledger backfill: pass failed:', e);
                if (consec >= 3) { toastr.error('3 consecutive failures — pausing. Progress saved.', 'Summaryception', { timeOut: 7000 }); break; }
            }
            done++;
            if (done % 6 === 0) await saveChatStore();   // throttle: the full-chat write is the per-batch cost — save every few passes; the end-of-run save persists the rest
            const pct = Math.round((done / batches.length) * 100);
            $(toast).find('.toast-message').text(`Building ledger: ${done} / ${batches.length} passes (${pct}%)${failed ? ` | ${failed} failed` : ''}\nlast pass: ${(_lastCallMs / 1000).toFixed(0)}s · ${_lastCallRespChars} char response\nClick ✕ to stop`);
        }
        toastr.clear(toast);
        if (_chatEpoch !== startEpoch) {
            toastr.warning(`Stopped — you switched chats. The original chat kept its ledger progress through pass ${done}.`, 'Summaryception', { timeOut: 6000 });
        } else {
            await saveChatStore();
            store.ledgerLiveIdx = turns.length ? turns[turns.length - 1].index : (typeof store.ledgerLiveIdx === 'number' ? store.ledgerLiveIdx : -1);
            try { if (typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx >= 0) saveLedgerCheckpoint(store.ledgerLiveIdx); } catch (_) {}   // head snapshot: the very next edit/deletion restores instantly instead of replaying the last chunk
            store._ckptLast = (typeof store.ledgerLiveIdx === 'number') ? store.ledgerLiveIdx : _bfCkpt;   // align live checkpoint throttle with what we just built — per-chat cursor
            updateInjection(true);
            try { renderLedger(); } catch (_) {}
            const nChars = Object.keys(store.ledger).length;
            if (cancelled) toastr.warning(`Stopped at ${done}/${batches.length}. Ledger has ${nChars} character(s). Progress saved.`, 'Summaryception', { timeOut: 5000 });
            else toastr.success(`Ledger built — ${nChars} character(s) across ${done} passes${failed ? `, ${failed} failed` : ''}.`, 'Summaryception', { timeOut: 5000 });
        }
    } finally {
        isSummarizing = false;
        try { updateUI(); } catch (_) {}
    }
}

// Selected ledger: read ONE snippet's source scene into the current ledger.
async function runLedgerForSnippet(layerIdx, snippetIdx) {
    const s = getSettings();
    if (!s.ledgerEnabled) { toastr.warning('Enable the Character Ledger first.', 'Summaryception'); return; }
    if (isSummarizing) { toastr.warning('Busy — try again in a moment.', 'Summaryception'); return; }
    if (_llmChannelBusy()) { toastr.warning('A background pass is finishing — try again in a few seconds.', 'Summaryception'); return; }
    const store = getChatStore();
    const layer = store.layers[layerIdx];
    if (!layer || !layer[snippetIdx] || !layer[snippetIdx].turnRange) { toastr.error('This snippet has no source turns to read.', 'Summaryception'); return; }
    if (!store.ledger || typeof store.ledger !== 'object') store.ledger = {};
    const sn = layer[snippetIdx];
    const { chat } = SillyTavern.getContext();
    const startEpoch = _chatEpoch;
    isSummarizing = true;
    try {
        const storyTxt = buildPassageFromRange(chat, sn.turnRange[0], sn.turnRange[1]);
        if (!storyTxt.trim()) { toastr.error('Source turns are empty.', 'Summaryception'); return; }
        const contextStr = buildLedgerContext(sn.turnRange[0], LEDGER_GIST_CAP);   // bounded, past-only (was whole-gist)
        toastr.info(`Reading scene ${sn.turnRange[0]}–${sn.turnRange[1]} into the ledger…`, 'Summaryception', { timeOut: 3000, progressBar: true });
        const deltas = await callLedgerScribe(storyTxt, contextStr, serializeLedgerForScribe(store.ledger, s.ledgerContextMaxChars));
        if (_chatEpoch !== startEpoch) { toastr.info('Chat changed — scene not applied.', 'Summaryception', { timeOut: 3000 }); return; }
        const changed = deltas ? mergeLedgerDeltas(deltas, undefined, (sn && sn.turnRange && typeof sn.turnRange[1] === 'number') ? sn.turnRange[1] : undefined) : 0;
        await saveChatStore();
        updateInjection(true);
        renderLedger();
        if (changed > 0) toastr.success(`Ledger updated from this scene (${changed} character${changed === 1 ? '' : 's'}).`, 'Summaryception', { timeOut: 3000 });
        else toastr.info('No character updates from this scene.', 'Summaryception', { timeOut: 3000 });
    } finally {
        isSummarizing = false;
    }
}

// Whole audit: run the auditor over every Layer 0 snippet that has no detail yet.
async function backfillAuditsForLayer0() {
    const s = getSettings();
    if (!s.sisterEnabled) { toastr.warning('Enable the Detail Auditor first.', 'Summaryception'); return; }
    if (isSummarizing) { toastr.warning('Busy — try again in a moment.', 'Summaryception'); return; }
    if (_llmChannelBusy()) { toastr.warning('A background pass is finishing — try again in a few seconds.', 'Summaryception'); return; }
    const store = getChatStore();
    const l0 = (store.layers && store.layers[0]) ? store.layers[0] : [];
    const targets = [];   // capture snippet OBJECTS, not indices, so a mid-run deletion can't shift us onto the wrong snippet
    for (let i = 0; i < l0.length; i++) {
        const sn = l0[i];
        if (sn && sn.turnRange && !(sn.detail && String(sn.detail).trim())) targets.push(sn);
    }
    if (targets.length === 0) { toastr.info('No snippets need auditing — every Layer 0 snippet already has a detail note (or none exist).', 'Summaryception', { timeOut: 4000 }); return; }
    if (!confirm(
        `Backfill detail notes for ${targets.length} snippet(s) that have none yet?\n\n` +
        `Runs the auditor once per snippet (~${targets.length} LLM calls). Existing detail notes are left untouched. You can stop anytime; progress is kept.`
    )) return;

    const { chat } = SillyTavern.getContext();
    const startEpoch = _chatEpoch;   // abandon on chat switch — never write another chat's snippets
    let done = 0, added = 0, failed = 0, cancelled = false, consec = 0;
    const toast = toastr.info(`Auditing: 0 / ${targets.length}`, 'Summaryception Auditor', {
        timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true,
        onCloseClick: () => { cancelled = true; abortSummarization(); },
    });
    isSummarizing = true;
    try {
        for (const sn of targets) {
            if (cancelled || _chatEpoch !== startEpoch) break;
            const cur0 = store.layers && store.layers[0];
            if (!cur0 || cur0.indexOf(sn) === -1 || !sn.turnRange) { done++; continue; }   // deleted/moved — skip
            const storyTxt = buildPassageFromRange(chat, sn.turnRange[0], sn.turnRange[1]);
            if (!storyTxt.trim()) { done++; continue; }
            const parts = [];
            for (let li = store.layers.length - 1; li >= 0; li--) {
                const l = store.layers[li]; if (!l) continue;
                for (const other of l) { if (other === sn) continue; parts.push(other.text); }   // skip self by identity
            }
            const contextStr = parts.length ? parts.join('\n') : '(none yet)';   // one snippet per line, matching the other context builders
            try {
                const detail = await callAuditor(storyTxt, sn.text, contextStr);
                if (_chatEpoch !== startEpoch) break;                    // switched during the call
                if (cur0.indexOf(sn) === -1) { done++; continue; }       // deleted during the call
                if (detail) { sn.detail = detail; added++; }
                consec = 0;
            } catch (e) {
                failed++; consec++;
                log('Audit backfill: snippet failed:', e);
                if (consec >= 3) { toastr.error('3 consecutive failures — pausing. Progress saved.', 'Summaryception', { timeOut: 7000 }); break; }
            }
            done++;
            if (done % 6 === 0) await saveChatStore();   // throttle: the full-chat write is the per-batch cost — save every few snippets; the end-of-run save persists the rest
            const pct = Math.round((done / targets.length) * 100);
            $(toast).find('.toast-message').text(`Auditing: ${done} / ${targets.length} (${pct}%) | +${added} notes${failed ? ` | ${failed} failed` : ''}\nClick ✕ to stop`);
        }
        toastr.clear(toast);
        if (_chatEpoch !== startEpoch) {
            toastr.warning(`Stopped — you switched chats. The original chat kept its progress (${added} note(s) added).`, 'Summaryception', { timeOut: 6000 });
        } else {
            await saveChatStore();
            updateInjection(true);
            if (cancelled) toastr.warning(`Stopped at ${done}/${targets.length}. Added ${added} note(s). Progress saved.`, 'Summaryception', { timeOut: 5000 });
            else toastr.success(`Audit backfill done — ${added} detail note(s) added across ${done} snippet(s)${failed ? `, ${failed} failed` : ''}.`, 'Summaryception', { timeOut: 5000 });
        }
    } finally {
        isSummarizing = false;
        try { updateSnippetBrowser(); } catch (_) {}
    }
}

// ─── Continuity Auditor engine ───────────────────────────────────────
async function callContinuityChecker(storyTxt, snippetText, recordStr) {
    const s = getSettings();
    const raw = await callSummarizer(storyTxt, recordStr, {
        systemPrompt: s.continuitySystemPrompt,
        userPrompt: s.continuityUserPrompt,
        snippet: snippetText,
        quiet: true,   // continuity failures are logged, never surfaced as summarizer errors
    });
    return normalizeContinuityOutput(raw);
}

// The established record to check a snippet against: manual notepad + character ledger
// + the story-so-far gist. Bounded via the ledger cap.
function buildContinuityRecord() {
    const s = getSettings();
    const store = getChatStore();
    const parts = [];
    const nb = (store.notepad || '').trim();
    if (nb) parts.push('NOTEPAD (manual canon):\n' + nb);
    let led = '';
    try { led = serializeLedgerForScribe(store.ledger, s.ledgerContextMaxChars); } catch (_) {}
    if (led && led.trim()) parts.push('CHARACTER LEDGER:\n' + led.trim());
    let gist = '';
    try { gist = buildFullContext(0); } catch (_) {}
    if (gist && gist.trim()) parts.push('STORY SO FAR:\n' + gist.trim());
    return parts.join('\n\n') || '(nothing established yet)';
}

let _continuityQueue = [];
let _continuityActive = false;
let _editRecheckTimer = null;      // debounce for re-checking snippets after message edits
let _editRecheckActive = false;
const _pendingEditedIdx = new Set();

// Queue a continuity check for the snippet just pushed to Layer 0. Fire-and-forget.
function queueContinuityCheck(storyTxt, snippetText) {
    const s = getSettings();
    if (!s.continuityEnabled) return;
    const store = getChatStore();
    const layer0 = store.layers && store.layers[0];
    if (!layer0 || layer0.length === 0) return;
    _continuityQueue.push({ snip: layer0[layer0.length - 1], storyTxt, snippetText, epoch: _chatEpoch });
    processContinuityQueue();
}

async function processContinuityQueue() {
    if (_continuityActive) return;
    if (_llmChannelBusy()) { setTimeout(() => { processContinuityQueue(); }, 2000); return; }   // channel held by another pass; jobs stay queued
    _continuityActive = true;
    try {
        while (_continuityQueue.length > 0) {
            const job = _continuityQueue.shift();
            try {
                if (job.epoch !== _chatEpoch) continue;   // chat switched before we got to it
                const recordStr = buildContinuityRecord();
                const flags = await callContinuityChecker(job.storyTxt, job.snippetText, recordStr);
                if (job.epoch !== _chatEpoch) continue;    // switched during the call
                const store = getChatStore();
                const layer0 = store.layers && store.layers[0];
                if (!layer0 || !layer0.includes(job.snip)) { log('Continuity: snippet no longer in Layer 0 — result discarded.'); continue; }
                if (typeof job.snippetText === 'string' && job.snip.text !== job.snippetText) { log('Continuity: snippet changed externally mid-check — result discarded.'); continue; }
                if (flags.length > 0 && job.snip.turnRange) {
                    const added = mergeContinuityFlags(store, job.snip.turnRange, flags);
                    if (added > 0) {
                        await saveChatStore();
                        updateInjection();
                        try { renderLedger(); } catch (_) {}
                        log(`Continuity (background): ${added} flag(s) added.`);
                        if (getSettings().continuityAutoFix) {
                            const tr = job.snip.turnRange;
                            const mine = (getChatStore().continuityFlags || []).filter(f => f && f.status === 'open' && f.where === 'snippet' && Array.isArray(f.turnRange) && tr && f.turnRange[0] === tr[0] && f.turnRange[1] === tr[1]);
                            let fixed = 0;
                            for (const f of mine) { try { if (await applyContinuityFix(f.id)) fixed++; } catch (_) {} }
                            if (fixed > 0) toastr.info(`Continuity: auto-fixed ${fixed} issue${fixed === 1 ? '' : 's'} in a snippet.`, 'Summaryception', { timeOut: 4000 });
                            else toastr.warning(`Continuity: ${added} issue${added === 1 ? '' : 's'} flagged (couldn't auto-fix — review).`, 'Summaryception', { timeOut: 5000 });
                        } else {
                            toastr.warning(`Continuity: ${added} issue${added === 1 ? '' : 's'} flagged for review.`, 'Summaryception', { timeOut: 5000 });
                        }
                    }
                } else {
                    log('Continuity (background): snippet consistent — no flags.');
                }
            } catch (e) {
                log('Continuity check failed for one snippet (non-fatal):', e);
            }
        }
    } finally {
        _continuityActive = false;
    }
}

// Whole-story continuity sweep: check every snippet against its source + the record.
async function backfillContinuityForLayer0() {
    const s = getSettings();
    if (!s.continuityEnabled) { toastr.warning('Enable the Continuity Auditor first.', 'Summaryception'); return; }
    if (isSummarizing) { toastr.warning('Busy — try again in a moment.', 'Summaryception'); return; }
    if (_llmChannelBusy()) { toastr.warning('A background pass is finishing — try again in a few seconds.', 'Summaryception'); return; }
    const store = getChatStore();
    const targets = [];   // snippet OBJECTS, so a mid-run deletion can't shift us onto the wrong one
    for (const layer of (store.layers || [])) {
        if (!Array.isArray(layer)) continue;
        for (const sn of layer) { if (sn && sn.turnRange && sn.text) targets.push(sn); }
    }
    targets.sort((a, b) => ((a.turnRange && a.turnRange[0]) || 0) - ((b.turnRange && b.turnRange[0]) || 0));   // oldest -> newest so fixes propagate against corrected earlier snippets
    if (targets.length === 0) { toastr.info('No snippets to check yet.', 'Summaryception', { timeOut: 4000 }); return; }
    if (!confirm(
        `Check continuity across ${targets.length} snippet(s)?\n\n` +
        `Runs one check per snippet (~${targets.length} background LLM calls), comparing each to its source passage and the established record. Any problems land in the Continuity list — nothing is changed automatically. You can stop anytime; progress is kept.`
    )) return;

    const { chat } = SillyTavern.getContext();
    const startEpoch = _chatEpoch;
    let done = 0, flagged = 0, cleared = 0, failed = 0, cancelled = false, consec = 0;
    const toast = toastr.info(`Checking continuity: 0 / ${targets.length}`, 'Summaryception Continuity', {
        timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true,
        onCloseClick: () => { cancelled = true; abortSummarization(); },
    });
    isSummarizing = true;
    try {
        for (const sn of targets) {
            if (cancelled || _chatEpoch !== startEpoch) break;
            if (!sn.turnRange) { done++; continue; }
            const storyTxt = buildPassageFromRange(chat, sn.turnRange[0], sn.turnRange[1]);
            if (!storyTxt.trim()) { done++; continue; }
            try {
                const recordStr = buildContinuityRecord();
                const flags = await callContinuityChecker(storyTxt, sn.text, recordStr);
                if (_chatEpoch !== startEpoch) break;
                if (typeof sn.text === 'string') { const rc = reconcileSnippetFlags(store, sn.turnRange, flags); flagged += rc.added; cleared += rc.cleared; }
                if (getSettings().continuityAutoFix && sn.turnRange) {
                    const mine = (store.continuityFlags || []).filter(f => f && f.status === 'open' && f.where === 'snippet' && Array.isArray(f.turnRange) && f.turnRange[0] === sn.turnRange[0] && f.turnRange[1] === sn.turnRange[1]);
                    for (const f of mine) { try { await applyContinuityFix(f.id); } catch (_) {} }
                }
                consec = 0;
            } catch (e) {
                failed++; consec++;
                log('Continuity backfill: snippet failed:', e);
                if (consec >= 3) { toastr.error('3 consecutive failures — pausing. Progress saved.', 'Summaryception', { timeOut: 7000 }); break; }
            }
            done++;
            if (done % 6 === 0) await saveChatStore();
            const pct = Math.round((done / targets.length) * 100);
            $(toast).find('.toast-message').text(`Checking continuity: ${done} / ${targets.length} (${pct}%) | ${flagged} flagged${cleared ? `, ${cleared} cleared` : ''}${failed ? ` | ${failed} failed` : ''}\nClick ✕ to stop`);
        }
        toastr.clear(toast);
        if (_chatEpoch !== startEpoch) {
            toastr.warning(`Stopped — you switched chats. The original chat kept its progress (${flagged} flagged).`, 'Summaryception', { timeOut: 6000 });
        } else {
            await saveChatStore();
            updateInjection(true);
            try { renderLedger(); } catch (_) {}
            if (cancelled) toastr.warning(`Stopped at ${done}/${targets.length}. ${flagged} flagged, ${cleared} cleared. Progress saved.`, 'Summaryception', { timeOut: 5000 });
            else toastr.success(`Continuity re-check done — ${flagged} new issue${flagged === 1 ? '' : 's'} flagged, ${cleared} fixed issue${cleared === 1 ? '' : 's'} cleared, across ${done} snippet(s)${failed ? `, ${failed} failed` : ''}.`, 'Summaryception', { timeOut: 6000 });
        }
    } finally {
        isSummarizing = false;
    }
}

// Copilot/UI actions. Resolve = fixed (logged briefly, then gone). Dismiss = false
// alarm (remembered so it's never re-raised). Both are deliberate — the auditor itself
// never deletes a flag.
async function resolveContinuityFlag(id) {
    const store = getChatStore();
    const list = store.continuityFlags || [];
    const i = list.findIndex(f => f && f.id === id);
    if (i < 0) return false;
    const f = list[i];
    list.splice(i, 1);
    if (!Array.isArray(store.continuityResolved)) store.continuityResolved = [];
    store.continuityResolved.unshift({ issue: f.issue, fix: f.fix, kind: f.kind, turnRange: Array.isArray(f.turnRange) ? f.turnRange.slice() : undefined, resolvedAt: Date.now() });
    store.continuityResolved = store.continuityResolved.slice(0, 20);
    await saveChatStore(); updateInjection(); try { renderLedger(); } catch (_) {}
    log(`Continuity: flag ${id} resolved.`);
    return true;
}

async function dismissContinuityFlag(id) {
    const store = getChatStore();
    const list = store.continuityFlags || [];
    const i = list.findIndex(f => f && f.id === id);
    if (i < 0) return false;
    const f = list[i];
    list.splice(i, 1);
    if (!Array.isArray(store.continuityDismissed)) store.continuityDismissed = [];
    const sig = _continuitySig(f);
    if (sig && !store.continuityDismissed.includes(sig)) store.continuityDismissed.push(sig);
    await saveChatStore(); updateInjection(); try { renderLedger(); } catch (_) {}
    log(`Continuity: flag ${id} dismissed.`);
    return true;
}

// Locate the snippet object a flag points at, by exact turnRange match. Pure.
function _findSnippetByTurnRange(store, turnRange) {
    if (!store || !Array.isArray(store.layers) || !Array.isArray(turnRange)) return null;
    const a = turnRange[0], b = turnRange[1];
    for (const layer of store.layers) {
        if (!Array.isArray(layer)) continue;
        for (const sn of layer) {
            if (sn && Array.isArray(sn.turnRange) && sn.turnRange[0] === a && sn.turnRange[1] === b) return { layer, snippet: sn };
        }
    }
    return null;
}

// Rewrite one snippet so it is consistent with a correction. Returns corrected text.
async function callContinuityFixer(snippetText, fix, contextStr) {
    const s = getSettings();
    const raw = await callSummarizer(fix, contextStr, {   // storyTxt slot carries the correction
        systemPrompt: s.continuityFixSystemPrompt,
        userPrompt: s.continuityFixUserPrompt,
        snippet: snippetText,
        quiet: true,
    });
    return (raw || '').trim();
}

// Apply one flag's fix to its snippet (SNIPPET layer only — never the source message),
// then log it as applied and remove the flag. Returns true iff the snippet changed.
async function applyContinuityFix(id) {
    const store = getChatStore();
    const list = store.continuityFlags || [];
    const flag = (id && typeof id === 'object') ? id : list.find(f => f && f.id === id);
    if (!flag || !flag.fix) return false;
    if (flag.where && flag.where !== 'snippet') {
        // Source-level: the message itself is wrong. Rewriting the snippet would make it
        // disagree with its source and cause a perpetual drift flag — leave it for the
        // copilot to fix at the message level.
        log(`Continuity: flag ${flag.id} is source-level — left for the copilot (message edit), snippet untouched.`);
        return false;
    }
    const found = _findSnippetByTurnRange(store, flag.turnRange);
    if (!found || !found.snippet) { await resolveContinuityFlag(flag.id); return false; }   // snippet gone — just clear the flag
    const sn = found.snippet;
    const before = sn.text;
    let changed = false;
    try {
        const corrected = await callContinuityFixer(sn.text, flag.fix, buildContinuityRecord());
        if (corrected && corrected !== before) { sn.text = corrected; changed = true; }
    } catch (e) { log('applyContinuityFix: rewrite failed (non-fatal):', e); return false; }
    const i = list.findIndex(f => f && f.id === flag.id);
    if (i >= 0) list.splice(i, 1);
    if (!Array.isArray(store.continuityResolved)) store.continuityResolved = [];
    store.continuityResolved.unshift({ issue: flag.issue, fix: flag.fix, kind: flag.kind, turnRange: Array.isArray(flag.turnRange) ? flag.turnRange.slice() : undefined, applied: changed, resolvedAt: Date.now() });
    store.continuityResolved = store.continuityResolved.slice(0, 20);
    await saveChatStore(); updateInjection(); try { renderLedger(); } catch (_) {}
    log(`Continuity: flag ${flag.id} applied (snippet ${changed ? 'rewritten' : 'unchanged'}).`);
    return changed;
}

// Apply every open flag's fix, OLDEST -> NEWEST, so each correction lands before the
// snippets that follow it are touched (no cascading errors).
async function applyAllContinuityFixes() {
    const store = getChatStore();
    const allOpen = (store.continuityFlags || []).filter(f => f && f.status === 'open' && f.fix);
    const open = allOpen.filter(f => f.where === 'snippet').slice();
    const sourceCount = allOpen.length - open.length;
    open.sort((a, b) => ((a.turnRange && a.turnRange[0]) || 0) - ((b.turnRange && b.turnRange[0]) || 0));
    if (open.length === 0) { toastr.info(`No snippet-level fixes to apply${sourceCount ? ` — ${sourceCount} source-level flag(s) need the copilot (message edits).` : '.'}`, 'Summaryception', { timeOut: 4500 }); return; }
    if (isSummarizing) { toastr.warning('Busy — try again in a moment.', 'Summaryception'); return; }
    const startEpoch = _chatEpoch;
    let done = 0, applied = 0, cancelled = false;
    const toast = toastr.info(`Applying continuity fixes: 0 / ${open.length}`, 'Summaryception Continuity', {
        timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true,
        onCloseClick: () => { cancelled = true; abortSummarization(); },
    });
    isSummarizing = true;
    try {
        for (const flag of open) {
            if (cancelled || _chatEpoch !== startEpoch) break;
            try { if (await applyContinuityFix(flag.id)) applied++; } catch (e) { log('applyAll: one fix failed:', e); }
            done++;
            $(toast).find('.toast-message').text(`Applying continuity fixes: ${done} / ${open.length} | ${applied} applied\nClick ✕ to stop`);
        }
    } finally { isSummarizing = false; }
    toastr.clear(toast);
    if (_chatEpoch === startEpoch) {
        updateInjection(true);
        toastr.success(`Applied ${applied} snippet-level fix${applied === 1 ? '' : 'es'} (oldest → newest)${sourceCount ? `; ${sourceCount} source-level flag(s) left for the copilot.` : '.'}`, 'Summaryception', { timeOut: 5500 });
    } else {
        toastr.warning('Chat changed — stopped applying fixes; progress kept.', 'Summaryception', { timeOut: 5000 });
    }
}

// Which snippets' source ranges cover a given message index. Pure.
function _findSnippetsCovering(store, idx) {
    const out = [];
    if (!store || !Array.isArray(store.layers) || typeof idx !== 'number') return out;
    for (const layer of store.layers) {
        if (!Array.isArray(layer)) continue;
        for (const sn of layer) {
            if (sn && Array.isArray(sn.turnRange) && idx >= sn.turnRange[0] && idx <= sn.turnRange[1]) out.push(sn);
        }
    }
    return out;
}

// Re-check ONE snippet against its (possibly just-edited) source + the record, reconcile
// its flags, and auto-fix snippet-level ones if the toggle is on.
async function recheckSnippet(sn) {
    if (!sn || !Array.isArray(sn.turnRange)) return;
    const { chat } = SillyTavern.getContext();
    const storyTxt = buildPassageFromRange(chat, sn.turnRange[0], sn.turnRange[1]);
    if (!storyTxt.trim()) return;
    const flags = await callContinuityChecker(storyTxt, sn.text, buildContinuityRecord());
    const store = getChatStore();
    if (!store.layers || !store.layers.some(l => Array.isArray(l) && l.includes(sn))) return;   // snippet gone
    reconcileSnippetFlags(store, sn.turnRange, flags);
    if (getSettings().continuityAutoFix) {
        const mine = (store.continuityFlags || []).filter(f => f && f.status === 'open' && f.where === 'snippet' && Array.isArray(f.turnRange) && f.turnRange[0] === sn.turnRange[0] && f.turnRange[1] === sn.turnRange[1]);
        for (const f of mine) { try { await applyContinuityFix(f.id); } catch (_) {} }
    }
    await saveChatStore(); updateInjection(); try { renderLedger(); } catch (_) {}
}

// Debounced flush: re-check every snippet touched by a recently-edited message, oldest first.
async function flushEditedRecheck() {
    if (_editRecheckActive) return;
    const s = getSettings();
    if (!s.continuityEnabled) { _pendingEditedIdx.clear(); return; }
    if (_llmChannelBusy()) { clearTimeout(_editRecheckTimer); _editRecheckTimer = setTimeout(flushEditedRecheck, 1500); return; }   // wait for whichever pass holds the channel
    _editRecheckActive = true;
    const _epoch = _chatEpoch;
    try {
        const store = getChatStore();
        const idxs = Array.from(_pendingEditedIdx); _pendingEditedIdx.clear();
        const seen = new Set(), affected = [];
        for (const idx of idxs) for (const sn of _findSnippetsCovering(store, idx)) { if (!seen.has(sn)) { seen.add(sn); affected.push(sn); } }
        affected.sort((a, b) => a.turnRange[0] - b.turnRange[0]);   // oldest -> newest
        for (const sn of affected) {
            // Each recheck is an LLM call. recheckSnippet's identity check stops a
            // result from LANDING in the wrong chat, but only after the call is spent —
            // stop issuing them the moment the chat is gone.
            if (_chatEpoch !== _epoch) { log('edit-recheck: chat switched — abandoning the remaining snippet(s).'); break; }
            try { await recheckSnippet(sn); } catch (e) { log('edit-recheck: one snippet failed:', e); }
        }
        if (affected.length) log(`Continuity: re-checked ${affected.length} snippet(s) after message edit(s).`);
    } finally { _editRecheckActive = false; }
}

// MESSAGE_EDITED handler — only summarized messages (those inside a snippet range) matter;
// edits to recent verbatim turns have no snippet and are ignored. Coalesced via debounce.
function onMessageEdited(mesId) {
    try {
        const idx = Number(mesId);
        if (!Number.isFinite(idx)) return;
        noteLedgerContentChange(idx);   // ledger reaction is independent of the continuity auditor
        if (!getSettings().continuityEnabled) return;
        if (_findSnippetsCovering(getChatStore(), idx).length === 0) return;   // not summarized yet — nothing to re-check
        _pendingEditedIdx.add(idx);
        clearTimeout(_editRecheckTimer);
        _editRecheckTimer = setTimeout(flushEditedRecheck, 1500);
    } catch (_) {}
}

// ─── Ledger vs content changes (edits / swipes) ──────────────────────
// The live pass only ever moves FORWARD, so an edit or swipe at/below the live
// pointer used to leave the ledger describing the PRE-change text forever — the
// audit workflow (apply a batch of fixes) desynced the ledger on every run.
// Changes are coalesced (Apply-all fires a burst of MESSAGE_EDITED) and resolved
// once: rewind to a checkpoint that predates the earliest change, replay to head.
let _ledgerEditMin = Infinity;
let _ledgerEditTimer = null;
let _deepEditToastShown = false;
function noteLedgerContentChange(idx) {
    try {
        const s = getSettings();
        if (!s.ledgerEnabled) return;
        const st = getChatStore();
        const live = (typeof st.ledgerLiveIdx === 'number') ? st.ledgerLiveIdx : -1;
        const decision = _editRewindDecision(idx, live, (s.ledgerEditRewindDepth ?? 10));
        if (decision === 'ignore') return;
        if (decision === 'deep') {
            if (!_deepEditToastShown) {
                _deepEditToastShown = true;
                toastr.info(`A deep-history message (turn ${idx}, ledger is at ${live}) was edited. Deep edits are treated as corrections toward existing canon and are not re-derived — run "Build ledger from history" if this edit changed character facts.`, 'Summaryception', { timeOut: 7000 });
            }
            return;
        }
        _ledgerEditMin = Math.min(_ledgerEditMin, Math.floor(idx));
        clearTimeout(_ledgerEditTimer);
        const _epochAtArm = _chatEpoch;
        _ledgerEditTimer = setTimeout(() => {
            if (_chatEpoch !== _epochAtArm) { _ledgerEditMin = Infinity; return; }   // armed for a chat that is no longer loaded
            const minIdx = _ledgerEditMin;
            _ledgerEditMin = Infinity;
            if (!Number.isFinite(minIdx)) return;
            try {
                const { chat } = SillyTavern.getContext();
                const turns = getAssistantTurns(chat || []);
                if (turns.length === 0) return;
                const head = turns[turns.length - 1].index;
                // Rewind floor: the checkpoint must PREDATE the earliest change; replay
                // then re-derives through the head, ingesting the corrected text.
                tryAutoRewindLedger(head, 'edit', Math.max(0, minIdx - 1)).catch(() => {});
            } catch (_) {}
        }, 2000);
    } catch (_) {}
}

function onMessageSwiped(mesId) {
    try {
        const idx = Number(mesId);
        if (!Number.isFinite(idx)) return;
        // A swipe replaces the message's content wholesale — same class as an edit.
        noteLedgerContentChange(idx);
    } catch (_) {}
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

// Bounded self-retry for a summarization deferred by a busy channel, so a skipped
// run does not wait for the user's next turn.
let _summarizeRetryTimer = null;
let _summarizeRetryLeft = 0;
function _clearSummarizeRetry() { if (_summarizeRetryTimer) { clearTimeout(_summarizeRetryTimer); _summarizeRetryTimer = null; } _summarizeRetryLeft = 0; }
function _armSummarizeRetry() {
    if (_summarizeRetryTimer) return;
    if (_summarizeRetryLeft <= 0) _summarizeRetryLeft = 300;   // never abandon a pending summarization
    _summarizeRetryTimer = setTimeout(() => {
        _summarizeRetryTimer = null;
        if (_llmChannelBusy()) { if (--_summarizeRetryLeft > 0) _armSummarizeRetry(); return; }
        _summarizeRetryLeft = 0;
        maybeSummarizeTurns().catch(() => {});
    }, 3000);
}

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) return;
    if (s.pauseSummarization) return;  // ← new
    // The summarizer was the ONE pass that never joined the exclusive channel: it
    // checked only its OWN flag, so while a ledger scribe / auditor / continuity
    // pass held the channel it happily started a SECOND concurrent callSummarizer.
    // Every other pass defers to isSummarizing, so the hole was one-directional and
    // invisible — and it opened on the most ordinary sequence there is: tap Update
    // now (or let any background pass run), then keep playing. Concurrency here is
    // not just slow: callSummarizer snapshots ST's prompt toggles, disables them,
    // and restores on finish, so interleaved calls leave the user's toggles
    // permanently wrong. A deferred run retries itself; every new turn retries too,
    // and the summarizer self-heals a backlog by design.
    if (_llmChannelBusy()) { _armSummarizeRetry(); return; }

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

    log(`Visible assistant turns: ${visibleTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleTurns.length <= s.verbatimTurns) return;

    const overflow = visibleTurns.length - s.verbatimTurns;

    // ─── Backlog detection ───────────────────────────────────────
    const backlogThreshold = s.turnsPerSummary * 2;

    if (overflow > backlogThreshold && !catchupDismissed) {
        if (_catchupDialogOpen) return;   // a dialog is already on screen — don't stack another
        log(`Large backlog detected: ${overflow} turns over limit`);

        const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);
        _catchupDialogOpen = true;
        let choice;
        try { choice = await showCatchupDialog(overflow, batchesNeeded); }
        finally { _catchupDialogOpen = false; }

        if (choice === 'skip') {
            const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
            if (cutoff) {
                store.summarizedUpTo = cutoff.index;
                log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
            }
            catchupDismissed = true;
            await saveChatStore();
            return;
        } else if (choice === 'catchup') {
            await runCatchup(visibleTurns, overflow);
            return;
        } else if (choice === 'partial') {
            await summarizeOneBatch(visibleTurns);
            return;
        }
        return;
    }

    // ─── Normal operation: single batch ──────────────────────────
    const success = await summarizeOneBatch(visibleTurns);

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return;
    }

    const remaining = getAssistantTurns(chat).filter(t => !chat[t.index].extra?.sc_ghosted);
    if (remaining.length > s.verbatimTurns && remaining.length - s.verbatimTurns <= backlogThreshold) {
        await maybeSummarizeTurns();
    }
}

// ─── Core: Single Batch Summarization ────────────────────────────────

async function summarizeOneBatch(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatch');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        for (const t of turnsToGhost) {
            await ghostMessage(t.index);
        }
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatch - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatch - EMPTY BATCH');
        return false;
    }

    isSummarizing = true;

    try {
        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;
        trace('  startIdx:', startIdx, 'endIdx:', endIdx);
        trace('  store.summarizedUpTo:', store.summarizedUpTo);

        log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

        if (!store.layers[0]) store.layers[0] = [];
        const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

        // ─── SANITY CHECK ───
        if (passageStart > endIdx) {
            log(`ERROR: passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
            trace('<<< EXITING summarizeOneBatch - PASSAGE START GREATER THAN END');
            return false;
        }

        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
        if (!storyTxt.trim()) {
            trace('<<< EXITING summarizeOneBatch - EMPTY PASSAGE');
            return false;
        }

        const contextStr = buildFullContext(0);

        toastr.info(`Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`, 'Summaryception', {
            timeOut: 3000,
            progressBar: true,
        });

        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  summary length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('<<< EXITING summarizeOneBatch - EMPTY SUMMARY');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        await ghostMessagesUpTo(endIdx);

        // Sister pass: check the snippet for dropped specifics; attach a detail note if any.
        queueAuditDetail(storyTxt, summary, contextStr);   // non-blocking: audit runs in background
        queueContinuityCheck(storyTxt, summary);           // non-blocking: continuity check runs in background
        // Ledger pass: evolve the per-character psychological model from this passage —
        // but ONLY if the live pass hasn't already covered these turns. With live
        // updates on (the default, every turn), ledgerLiveIdx sits at the chat head,
        // so scribing the batch again here was a 100% redundant LLM call per batch.
        if (!(s.ledgerLiveUpdate !== false && typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx >= endIdx)) {
            queueLedgerUpdate(storyTxt, buildLedgerContext(passageStart, LEDGER_GIST_CAP), endIdx);   // bounded, past-only gist
        } else {
            log('Ledger: batch turns already covered by the live pass — no extra scribe call.');
        }

        log(`Layer 0 now has ${store.layers[0].length} snippets`);

        await maybePromoteLayer(0);
        await saveChatStore();

        toastr.success(`Summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: 2000 });
        trace('<<< EXITING summarizeOneBatch - SUCCESS');
        return true;

    } finally {
        isSummarizing = false;
    }
}

// ─── Core: Inner Batch for Catchup ───────────────────────────────────

async function summarizeOneBatchFromTurns(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    // This handles desync where summarizedUpTo advanced but ghosting failed
    // (e.g., connection drop mid-summarization). Without this filter, the batch
    // always starts at the first un-ghosted turn, gets rejected by the
    // startIdx <= summarizedUpTo guard, and loops forever.
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        // All "visible" turns are actually already summarized but not ghosted.
        // Ghost them now to fix the desync.
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        for (const t of turnsToGhost) {
            await ghostMessage(t.index);
        }
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatchFromTurns - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    trace('  batchSize:', batchSize);
    trace('  batch prepared:', batch.length);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const startIdx = batch[0].index;
    const endIdx = batch[batch.length - 1].index;

    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  store.summarizedUpTo:', store.summarizedUpTo);

    if (!store.layers[0]) store.layers[0] = [];

    // ─── Start from the message AFTER the last summarized one ───
    const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

    trace('  passageStart:', passageStart, 'endIdx:', endIdx);

    // ─── SANITY CHECK: passageStart should always be <= endIdx ───
    if (passageStart > endIdx) {
        trace('  CRITICAL: passageStart > endIdx! This should never happen.');
        trace('  This likely means the batch was already summarized.');
        trace('<<< EXITING - passageStart > endIdx');
        return false;
    }

    trace('  About to call buildPassageFromRange...');

    try {
        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  buildPassageFromRange returned, length:', storyTxt?.length ?? 'UNDEFINED');

        if (!storyTxt.trim()) {
            trace('  <<< EXITING - storyTxt is empty after trim');
            trace('  This suggests all messages in range [' + passageStart + ', ' + endIdx + '] are hidden or empty');
            return false;
        }

        trace('  About to call buildFullContext...');
        const contextStr = buildFullContext(0);
        trace('  buildFullContext returned, length:', contextStr?.length ?? 'UNDEFINED');

        trace('  About to call callSummarizer...');
        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  callSummarizer returned, length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('  <<< EXITING - summary is empty');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

        await ghostMessagesUpTo(endIdx);

        // Sister pass: check the snippet for dropped specifics; attach a detail note if any.
        queueAuditDetail(storyTxt, summary, contextStr);   // non-blocking: audit runs in background
        queueContinuityCheck(storyTxt, summary);           // non-blocking: continuity check runs in background
        // Ledger pass — same live-coverage gate as the single-batch path: with live
        // updates on, every catch-up batch was ALSO a redundant scribe call.
        if (!(s.ledgerLiveUpdate !== false && typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx >= endIdx)) {
            queueLedgerUpdate(storyTxt, buildLedgerContext(passageStart, LEDGER_GIST_CAP), endIdx);   // bounded, past-only gist
        } else {
            log('Ledger: batch turns already covered by the live pass — no extra scribe call.');
        }

        await maybePromoteLayer(0);
        // In the bulk path the range /hide above already wrote the chat (with the new
        // summary + ghost state) this batch, and layer promotion re-derives on load — so
        // when ghosting is on we skip the extra full-chat write here and let runCatchup
        // flush once at the end. With ghosting off there's no /hide save, so keep it.
        if (s.disableGhosting) await saveChatStore();

        trace('<<< EXITING summarizeOneBatchFromTurns - SUCCESS');
        return true;

    } catch (err) {
        trace('  CAUGHT EXCEPTION:', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.substring?.(0, 200),
        });
        console.error(LOG_PREFIX, 'summarizeOneBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeOneBatchFromTurns - EXCEPTION');
        return false;
    }
}

// ─── Core: Catchup Processing ────────────────────────────────────────

async function runCatchup(visibleTurns, overflow) {

    trace('>>> ENTERING runCatchup');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
    trace('  overflow:', overflow);

    const s = getSettings();
    const totalBatches = Math.ceil(overflow / s.turnsPerSummary);
    let completed = 0;
    let failed = 0;
    let cancelled = false;

    trace('  totalBatches calculated:', totalBatches);

    const progressToast = toastr.info(
        `Processing backlog: 0 / ${totalBatches} batches (0%)`,
        'Summaryception Catch-Up',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            onCloseClick: () => {
                cancelled = true;
                abortSummarization();
            },
        }
    );

    isSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const currentVisible = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            trace(`  currentVisible turns: ${currentVisible.length}, verbatimTurns limit: ${s.verbatimTurns}`);

            if (currentVisible.length <= s.verbatimTurns) {
                trace('  Visible turns now within limit, breaking');
                break;
            }

            trace('  About to call summarizeOneBatchFromTurns...');
            const success = await summarizeOneBatchFromTurns(currentVisible);

            if (success) {
                trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                completed++;
                consecutiveFailures = 0;
            } else {
                trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
                failed++;
                consecutiveFailures++;

                if (consecutiveFailures >= 3) {
                    toastr.error(
                        '3 consecutive failures — API may be down. Pausing catch-up. Progress saved; will resume on next message.',
                        'Summaryception',
                        { timeOut: 8000 }
                    );
                    trace('  3 consecutive failures, breaking');
                    break;
                }
            }

            const pct = Math.round((completed / totalBatches) * 100);
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast).find('.toast-message').text(
                `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`
            );
        }

        toastr.clear(progressToast);

        if (cancelled) {
            toastr.warning(
                `Catch-up paused at ${completed}/${totalBatches}. Progress saved — will continue on next message.`,
                'Summaryception',
                { timeOut: 5000 }
            );
        } else if (failed === 0) {
            toastr.success(
                `Catch-up complete! ${completed} batches processed.`,
                'Summaryception',
                { timeOut: 4000 }
            );
        } else {
            toastr.warning(
                `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
                'Summaryception',
                { timeOut: 6000 }
            );
        }

        try { await saveChatStore(); } catch (_) {}   // single end-of-run flush (per-batch bulk writes are skipped when /hide already persisted them)
        updateInjection(true);
        updateUI();

    } finally {
        isSummarizing = false;
    }
}

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your ${s.verbatimTurns} verbatim limit).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Summarize all ${overflowCount} turns — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Summarize ${s.turnsPerSummary} turns now, deal with the rest later</span>
        </div>
        </button>
        <button id="sc_catchup_later" class="menu_button sc-catchup-later">
        <div class="sc-btn-text"><span class="sc-btn-label">Not now</span>
        <span class="sc-btn-desc">Close this and ask again later</span></div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => {
            overlay.remove();
            resolve('catchup');
        });
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => {
            overlay.remove();
            resolve('skip');
        });
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => {
            overlay.remove();
            resolve('partial');
        });
        overlay.querySelector('#sc_catchup_later').addEventListener('click', () => {
            overlay.remove();
            resolve('later');
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); resolve('later'); }
        });
    });
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        const seed = layer.shift();
        seed.promoted = true;
        seed.seedFromLayer = layerIndex;
        destLayer.push(seed);

        log(`Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`);

        toastr.info(
            `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
            'Summaryception',
            { timeOut: 2000 }
        );

        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex);
        }
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex + 1);
        }
        return;
    }

    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map(sn => sn.text).join('\n\n');   // paragraph breaks — the meta-summarizer must see where one scene summary ends and the next begins
    const contextStr = buildFullContext(layerIndex + 1);

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true }
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    // Propagate a covering turnRange so the merged snippet stays recallable.
    // Children created before this fix (or legacy range-less merges) may lack a
    // range; compute from whatever VALID child ranges exist. If none do, leave
    // the merged snippet range-less ("unrecallable legacy") rather than
    // fuzzy-reconstructing — recall already degrades gracefully for these.
    const childRanges = toMerge
        .map(sn => sn.turnRange)
        .filter(r => Array.isArray(r) && r.length === 2
            && Number.isFinite(r[0]) && Number.isFinite(r[1]));

    const merged = {
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    };
    if (childRanges.length > 0) {
        merged.turnRange = [
            Math.min(...childRanges.map(r => r[0])),
            Math.max(...childRanges.map(r => r[1])),
        ];
    }
    destLayer.push(merged);

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}

// ─── Character Ledger: injection block ───────────────────────────────

const _ESC_RE = /[.*+?^${}()|[\]\\]/g;
function _escapeRegex(str) { return String(str).replace(_ESC_RE, '\\$&'); }

// Aliases used to detect whether a character is "on screen" in recent text:
// the full name plus its first and last name-tokens. Prose/dialogue usually
// refers to a character by given name (and sometimes surname), so keying on the
// first and last tokens — not the longest — is what reliably catches "Stella"
// for "Stella Vermillion". Recall matters more than precision here: a missed
// on-screen character loses its behavioral anchor (the whole point of the
// ledger), whereas an occasional off-screen inject is merely a little wasteful.
// Pure: how much the STORY has invested in this person. Not a guess and not a
// preference — every term is something the story itself produced:
//   arc     — relationship history with the protagonist. The single strongest
//             signal: the scribe only writes an arc once a relationship has actually
//             moved, and only lengthens it as more happens between them.
//   threads — unresolved business. Someone the story owes something to, or who owes
//             something, is load-bearing; a spear-carrier has none.
//   core    — how fully they are drawn. A richly established nature took many scenes.
//   pin     — the user overriding everything, which stays possible but is no longer
//             required for the system to know a sister outranks a classmate.
function _characterWeight(entry, pinned) {
    let w = 0;
    if (!entry || typeof entry !== 'object') return w;
    if (pinned) w += 1000;                                                  // an explicit override always wins
    const arc = (typeof entry.arc === 'string') ? entry.arc.trim() : '';
    if (arc) w += 40 + Math.min(60, Math.floor(arc.length / 12));           // has a relationship at all, deepened by its depth
    const threads = Array.isArray(entry.threads) ? entry.threads.filter(t => typeof t === 'string' && t.trim()) : [];
    w += Math.min(60, threads.length * 20);                                 // unresolved business with the story
    const core = (typeof entry.core === 'string') ? entry.core.trim() : '';
    w += Math.min(30, Math.floor(core.length / 30));                        // how fully they are drawn
    return w;
}

// Pure: name tokens that CANNOT identify one character because two or more share
// them. Siblings are the everyday case: with "Jovan Argent" and "Claire Argent" in
// the cast, the bare token "Argent" identifies nobody — yet it was an alias for
// BOTH, so "Jovan Argent stepped onto the platform" marked Claire on screen too:
// her full entry injected (wasted tokens) and, far worse, the storyteller told a
// character is present who is not — an invitation to write her into a scene she
// never entered. A human reader could not resolve a bare "Argent" either; neither
// should we. Such tokens are dropped as standalone aliases, so those characters are
// matched only by their full name or their unambiguous given name.
function _ambiguousTokens(names) {
    const count = new Map();
    for (const n of (names || [])) {
        const parts = String(n || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) continue;                 // single-token names contribute no short form
        const toks = new Set();
        for (const t of [parts[0], parts[parts.length - 1]]) {
            if (t && t.length > 2) toks.add(t.toLowerCase());
        }
        for (const t of toks) count.set(t, (count.get(t) || 0) + 1);
    }
    const amb = new Set();
    for (const [t, c] of count) if (c > 1) amb.add(t);
    return amb;
}

function characterAliases(name, ambiguous) {
    const full = String(name || '').trim();
    if (!full) return [];
    const aliases = [full];
    const tokens = full.split(/\s+/).filter(Boolean);
    if (tokens.length > 1) {
        const fullLower = full.toLowerCase();
        const add = (tok) => {
            if (!tok || tok.length <= 2) return;
            if (tok.toLowerCase() === fullLower) return;
            if (ambiguous && ambiguous.has(tok.toLowerCase())) return;   // shared with another character — identifies nobody
            if (aliases.some(a => a.toLowerCase() === tok.toLowerCase())) return;
            aliases.push(tok);
        };
        add(tokens[0]);                    // given name (most often spoken)
        add(tokens[tokens.length - 1]);    // surname (formal address)
    }
    return aliases;
}

// Whole-word presence test (no substring false positives like "Ann" in
// "announced"). Unicode-aware; falls back to \b if property escapes are
// unsupported. `haystackLower` must already be lower-cased.
function wordPresentInText(haystackLower, needle) {
    const n = String(needle || '').trim().toLowerCase();
    if (n.length < 2) return false;
    try {
        return new RegExp('(^|[^\\p{L}\\p{N}_])' + _escapeRegex(n) + '($|[^\\p{L}\\p{N}_])', 'iu').test(haystackLower);
    } catch (_) {
        return new RegExp('\\b' + _escapeRegex(n) + '\\b', 'i').test(haystackLower);
    }
}

// One compact, prose-like line per character. Priority order Nature → Now →
// Open → Arc means a length cap truncates the least-critical field (Arc) first.
function formatLedgerEntry(name, entry, capChars) {
    if (!entry || typeof entry !== 'object') return '';
    const norm = (v) => String(v).trim().replace(/\s+/g, ' ');
    const parts = [];
    if (typeof entry.core === 'string' && entry.core.trim())   parts.push('Nature: ' + norm(entry.core));
    if (typeof entry.state === 'string' && entry.state.trim()) parts.push('Now: ' + norm(entry.state));
    if (Array.isArray(entry.threads)) {
        const th = entry.threads.filter(t => typeof t === 'string' && t.trim()).map(norm);
        if (th.length) parts.push('Open: ' + th.join('; '));
    }
    if (typeof entry.arc === 'string' && entry.arc.trim())     parts.push('Arc: ' + norm(entry.arc));
    if (parts.length === 0) return '';
    // Strip any trailing period so the ". " separator gives exactly one, never "..".
    const cleaned = parts.map(p => p.replace(/[.\s]+$/, ''));
    let line = norm(name) + ' — ' + cleaned.join('. ') + '.';
    const cap = capChars || 600;
    if (line.length > cap) line = line.slice(0, Math.max(1, cap - 1)).replace(/\s+\S*$/, '').trimEnd() + '…';
    return line;
}

// The active-cast character block, injected every turn. "Active" = a ledger
// character whose name (or given name) appears in the recent chat window — so
// the storyteller always has their behavioral anchor and current state on hand,
// which is what keeps a tsundere from suddenly screaming and a volatile mood
// from evaporating between turns.
// Pure: choose which off-screen characters the roster lists THIS turn. If the whole
// off-screen cast fits under the cap, list everyone. Otherwise anchor the most-recent
// (likeliest to return) and rotate the remaining slots through the rest of the cast,
// advancing one step per turn (`tick`) so no one is forgotten for long. `sorted` is
// names, most-recent first. Deterministic given (sorted, cap, tick).
function _selectRoster(sorted, cap, tick) {
    if (!Array.isArray(sorted) || cap <= 0 || sorted.length === 0) return [];
    if (sorted.length <= cap) return sorted.slice();
    const warm = Math.max(1, Math.ceil(cap / 2));
    const warmSet = sorted.slice(0, warm);
    const coldPool = sorted.slice(warm);
    const coldSlots = cap - warmSet.length;
    if (coldSlots <= 0 || coldPool.length === 0) return warmSet;
    const t = (((tick | 0) % coldPool.length) + coldPool.length) % coldPool.length;
    const cold = [];
    for (let i = 0; i < Math.min(coldSlots, coldPool.length); i++) cold.push(coldPool[(t + i) % coldPool.length]);
    return warmSet.concat(cold);
}

// Character pins — a per-chat set of ledger names the user wants ALWAYS present in the
// roster, even when off-screen (uncapped, exempt from rotation). Distinct from
// store.pins (verbatim-quote memories). Never redundant with the full cards: a pinned
// on-screen character shows as a full card and is excluded from the roster below.
function getLedgerPins() {
    const st = getChatStore();
    if (!Array.isArray(st.ledgerPins)) st.ledgerPins = [];
    return st.ledgerPins;
}
function isLedgerPinned(name) {
    const t = String(name).toLowerCase();
    return getLedgerPins().some(p => String(p).toLowerCase() === t);
}
function toggleLedgerPin(name) {
    if (name === undefined || name === null) return;
    const pins = getLedgerPins();
    const t = String(name).toLowerCase();
    const i = pins.findIndex(p => String(p).toLowerCase() === t);
    if (i >= 0) pins.splice(i, 1); else pins.push(String(name));
    saveChatStore();
    updateInjection(true);
    try { renderLedger(); } catch (_) {}
}

// Pure: final off-screen roster line-up. Pinned characters come first and ALWAYS
// appear (uncapped, not subject to rotation); the rest of the cast fills the rotating
// warm/cold slots up to `cap`. Deduped so nothing is listed twice. `offscreen` already
// excludes the on-screen full-card cast, so a pinned on-screen character is simply
// absent here (they are a full card elsewhere) — no conflict, no redundancy.
// THE selection function — the one answer to "who does the storyteller receive
// this turn, and how". Used by BOTH the injection builder and the Character
// Ledger panel, so the panel is a truthful preview of the injection by
// construction, never a drifting copy.
//   shown  — full entries injected (on screen, recency-ordered, capped)
//   roster — identity-line injected this turn (pins first, then rotation)
//   out    — in the ledger, NOT injected this turn
function computeLedgerCast(ledger, s, recentLower, pins, rosterTick, recentMsgs) {
    const names = Object.keys(ledger || {});
    const res = { shown: [], compact: [], roster: [], out: [] };
    if (!names.length) return res;
    const ambiguous = _ambiguousTokens(names);
    let active = [];
    for (const name of names) {
        const entry = ledger[name];
        if (!entry || typeof entry !== 'object') continue;
        const aliases = characterAliases(name, ambiguous);
        if (recentLower && aliases.some(a => wordPresentInText(recentLower, a))) {
            // How recently they were ON SCREEN — the newest message they appear in.
            let seen = -1;
            if (Array.isArray(recentMsgs)) {
                for (let i = recentMsgs.length - 1; i >= 0; i--) {
                    const low = recentMsgs[i];
                    if (low && aliases.some(a => wordPresentInText(low, a))) { seen = i; break; }
                }
            }
            active.push({ name, entry, u: entry.updatedAt || 0, seen });
        }
    }
    // PRESENCE earns the slot, not recency-of-being-written-about. Sorting by
    // updatedAt was a death spiral: a character standing in the scene whose state
    // had not changed carried an old timestamp, so among the people actually there
    // he ranked LAST, got cut by the cap, dropped to a bare roster line, and the
    // storyteller — handed only his name — wrote him out of the scene. Gone from the
    // text, the scribe never touched him again, so his timestamp froze and he could
    // never climb back. A best friend could vanish from a duel he was standing in
    // and stay frozen doing whatever he was doing twenty turns earlier. Ranking by
    // last appearance inverts it: present -> injected -> written -> updated.
    active.sort((a, b) => (b.seen - a.seen) || (b.u - a.u));
    const maxActive = Math.max(1, s.ledgerMaxActive ?? 6);
    // WHO MATTERS is not something the user should have to hand-annotate — asking for
    // pins was pushing the system's job onto them. The ledger already holds the
    // answer and was ignoring it: importance is what the STORY has invested in a
    // person. A sister the protagonist has 30 turns of relationship history with,
    // three unresolved threads, and a fully drawn nature is not the same as a
    // classmate who spoke once, and the data says so plainly. Recency alone said they
    // were equal, so the sister lost her slot to whoever twitched last.
    const pinLower = new Set((pins || []).map(p => String(p).toLowerCase()));
    for (const a of active) a.w = _characterWeight(a.entry, pinLower.has(a.name.toLowerCase()));
    // Presence is still the gate — you must be in the scene to hold a full slot — but
    // among the people who ARE here, the story's own investment decides, and only then
    // recency. A pin is now just the heaviest possible vote, not the only one.
    res.shown = active.slice().sort((a, b) => (b.w - a.w) || (b.seen - a.seen) || (b.u - a.u)).slice(0, maxActive);
    const _fullSet = new Set(res.shown.map(x => x.name));
    active = active.filter(x => !_fullSet.has(x.name));
    // THE ANTI-BIAS TIER. Six full entries and a bare name for everyone else made the
    // ledger cause the very forgetting it exists to prevent: the storyteller wrote the
    // six it was handed and the rest of the room evaporated — a best friend, a sister,
    // a headmaster standing right there reduced to a word. Anyone ON SCREEN past the
    // cap now gets a COMPACT entry (who they are + what they are doing) instead of a
    // name. The cap still bounds the expensive full entries; it no longer decides who
    // exists.
    res.compact = active;   // on screen but past the cap — compact, never a bare name
    const shownNames = new Set(res.shown.concat(res.compact).map(a => a.name));
    if (s.ledgerInjectRoster !== false) {
        const rosterCap = Math.max(0, s.ledgerRosterMax ?? 12);
        const offscreen = names
            .filter(n => !shownNames.has(n))
            .map(n => ({ name: n, entry: ledger[n], u: (ledger[n] && ledger[n].updatedAt) || 0 }))
            .filter(o => o.entry && typeof o.entry === 'object')
            .sort((a, b) => b.u - a.u);
        const rotate = s.ledgerRosterRotate !== false;
        res.roster = _composeRoster(offscreen.map(o => o.name), pins, rosterCap, rosterTick, rotate);
    }
    const injected = new Set([...shownNames, ...res.roster]);
    res.out = names.filter(n => !injected.has(n));
    return res;
}

function _composeRoster(offscreen, pinnedNames, cap, tick, rotate) {
    if (!Array.isArray(offscreen)) return [];
    const pinnedSet = new Set((pinnedNames || []).map(n => String(n).toLowerCase()));
    const pinnedOff = offscreen.filter(n => pinnedSet.has(String(n).toLowerCase()));
    const unpinned = offscreen.filter(n => !pinnedSet.has(String(n).toLowerCase()));
    const picked = _selectRoster(unpinned, cap, rotate ? tick : 0);
    const seen = new Set();
    const out = [];
    for (const n of pinnedOff.concat(picked)) {
        const k = String(n).toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(n); }
    }
    return out;
}

function buildCharacterBlock() {
    const s = getSettings();
    if (!s.ledgerEnabled) return '';
    const store = getChatStore();
    const ledger = store.ledger;
    if (!ledger || typeof ledger !== 'object') return '';
    const names = Object.keys(ledger);
    if (names.length === 0) return '';

    let recentLower = '';
    let recentMsgs = [];
    try {
        const { chat } = SillyTavern.getContext();
        const windowSize = Math.max(1, s.ledgerActiveWindow ?? 12);
        recentMsgs = (chat || []).slice(-windowSize).map(m => ((m && typeof m.mes === 'string') ? m.mes : '').toLowerCase());
        recentLower = (chat || [])
            .slice(-windowSize)
            .map(m => (m && typeof m.mes === 'string') ? m.mes : '')
            .join('\n')
            .toLowerCase();
    } catch (_) { return ''; }
    if (!recentLower.trim()) return '';

    const cast = computeLedgerCast(ledger, s, recentLower, getLedgerPins(), _rosterTick, recentMsgs);
    const capChars = Math.max(80, s.ledgerMaxCharsPerChar ?? 600);
    const shown = cast.shown;
    const blocks = shown
        .map(({ name, entry }) => formatLedgerEntry(name, entry, capChars))
        .filter(Boolean);

    // Roster: one compact line per character NOT currently on screen (name + the
    // first clause of their stable nature), so the storyteller never forgets a
    // character exists and can bring them back consistently instead of dropping or
    // contradicting them. Identity only — no volatile state — so it stays cheap
    // enough to carry the whole cast. In an academy where no one should vanish, this
    // is what keeps the long-absent professor or classmate a real, returnable person.
    // On screen, past the full-entry cap: who they are and what they are doing. Never
    // a bare name — a person standing in the scene the storyteller cannot see is how
    // the room empties.
    let compactLine = '';
    if (cast.compact && cast.compact.length) {
        const _clipC = (txt, max) => {
            let t = (typeof txt === 'string') ? txt.trim().replace(/\s+/g, ' ') : '';
            if (!t) return '';
            const cut = t.search(/[.;]\s/);
            if (cut > 0) t = t.slice(0, cut);
            if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd() + '\u2026';
            return t;
        };
        const citems = cast.compact.map(({ name, entry }) => {
            const core = _clipC(entry && entry.core, 90);
            const state = _clipC(entry && entry.state, 90);
            let s2 = name;
            if (core) s2 += ' \u2014 ' + core;
            if (state) s2 += ' | now: ' + state;
            return s2;
        }).filter(Boolean);
        if (citems.length) compactLine = 'ALSO PRESENT in this scene \u2014 they are here and must not vanish from it; give them presence when the moment touches them: ' + citems.join('; ') + '.';
    }

    let rosterLine = '';
    if (s.ledgerInjectRoster !== false) {
        const picked = cast.roster;
        const entryByName = new Map(picked.map(n => [n, ledger[n]]));
        const _clip = (txt, max) => {
            let t = (typeof txt === 'string') ? txt.trim().replace(/\s+/g, ' ') : '';
            if (!t) return '';
            const cut = t.search(/[.;]\s/);
            if (cut > 0) t = t.slice(0, cut);
            if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd() + '\u2026';
            return t;
        };
        const items = picked.map((name) => {
            const entry = entryByName.get(name);
            const core = _clip(entry && entry.core, 100);
            // The roster used to ship a NAME and a personality fragment and nothing
            // else — so the storyteller knew Silas existed but had no idea he was in
            // the east yard taking bets. Off-screen people became furniture, and the
            // world stopped existing outside the current scene. Their last recorded
            // state IS where they are: absent evidence they moved, a person stays
            // where the story left them. Carrying it makes the ledger a live map of
            // the whole cast instead of a spotlight on six of them — and it invents
            // nothing, which is the only reason it is allowed.
            const state = _clip(entry && entry.state, 90);
            const asOf = (entry && typeof entry._t === 'number') ? entry._t : null;
            let s = name;
            if (core) s += ' \u2014 ' + core;
            if (state) s += ' | last seen' + (asOf !== null ? ' (turn ' + asOf + ')' : '') + ': ' + state;
            return s;
        }).filter(Boolean);
        if (items.length > 0) rosterLine = 'Other people in this world, currently off-screen \u2014 the story continues around them. "last seen" is where the story left each one; absent something that moved them, that is still where they are and what they are doing, and time has passed since. Use it to keep the world alive off-screen and to bring anyone back when the moment calls for it, true to who they are: ' + items.join('; ') + '.';
    }

    if (blocks.length === 0 && !rosterLine && !compactLine) return '';

    let body = blocks.join('\n');
    if (compactLine) body += (body ? '\n\n' : '') + compactLine;
    if (rosterLine) body += (body ? '\n\n' : '') + rosterLine;

    const tpl = s.ledgerInjectTemplate || '\n\n<characters>\n{{characters}}\n</characters>\n';
    return subst(tpl, '{{characters}}', body);
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    // ── Manual notepad — per-chat story/lore memory (survives branches) ──
    let notesPart = '';
    if (s.injectNotepad !== false && store.notepad && store.notepad.trim().length > 0) {
        const tpl = s.notepadTemplate || '\n\n<notes>\n{{notes}}\n</notes>\n';
        notesPart = subst(tpl, '{{notes}}', store.notepad.trim());
    }

    // ── Auto-generated layered summary ──
    let summaryPart = '';
    if (s.injectSummary !== false && store.layers && !store.layers.every(l => !l || l.length === 0)) {
        const snippets = [];
        for (let i = store.layers.length - 1; i >= 1; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            for (const sn of layer) snippets.push(sn.text);
        }
        if (store.layers[0] && store.layers[0].length > 0) {
            for (const sn of store.layers[0]) snippets.push(sn.text);
        }
        if (snippets.length > 0) {
            summaryPart = subst(s.injectionTemplate, '{{summary}}', snippets.join('\n'));   // one snippet per line (was join(' ') — a single run-on wall)
        }
    }

    // ── Sister detail notes — the specifics the compact snippets dropped, for
    //    recent (Layer 0) events. Rides along with the summary, clearly marked. ──
    let detailPart = '';
    if (s.injectDetails !== false && s.sisterEnabled && store.layers && store.layers[0]) {
        const notes = store.layers[0]
            .filter(sn => sn.detail && sn.detail.trim())
            .map(sn => '- ' + sn.detail.trim());
        if (notes.length > 0) {
            const tpl = s.sisterInjectTemplate || '\n\n<details>\n{{details}}\n</details>\n';
            detailPart = subst(tpl, '{{details}}', notes.join('\n'));
        }
    }

    // Optional sections gated by their own injection toggles (independent of the
    // background passes, which keep running so the data stays maintained).
    // Continuity corrections — unresolved flags, injected as OOC directives so the
    // Storyteller self-corrects while a human/copilot reconciles the stored record.
    // Off by default; capped by continuityNudgeMax.
    let continuityPart = '';
    if (s.continuityNudge && Array.isArray(store.continuityFlags)) {
        const open = store.continuityFlags.filter(f => f && f.status === 'open' && f.fix && String(f.fix).trim());
        if (open.length > 0) {
            const cap = (typeof s.continuityNudgeMax === 'number' && s.continuityNudgeMax > 0) ? s.continuityNudgeMax : 6;
            const lines = open.slice(0, cap).map(f => '- ' + String(f.fix).trim());
            continuityPart = '\n\n<continuity_corrections>\nOut-of-character — a human is reconciling the record; keep the story consistent with these established facts and do not contradict them:\n' + lines.join('\n') + '\n</continuity_corrections>\n';
        }
    }

    const pinnedPart = (s.injectPinned !== false) ? buildPinnedBlock() : '';
    const charPart   = (s.injectLedger !== false) ? buildCharacterBlock() : '';

    // Stable canon first (notepad → pinned → active-cast character state), then the
    // narrative (summary gist → recent-detail specifics). Grouping "who these people
    // are" ahead of "what happened" frames the scene for the storyteller.
    return notesPart + pinnedPart + charPart + summaryPart + detailPart + continuityPart;
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjected = '';

function updateInjection(force = false) {
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        const s = getSettings();

        const pos  = (s.injectionPosition ?? 1);
        const dep  = (s.injectionDepth ?? 4);
        const role = (s.injectionRole ?? 0);

        if (!s.enabled) {
            if (_lastInjected !== '' || force) {
                setExtensionPrompt(MODULE_NAME, '', pos, dep, false, role);
                _lastInjected = '';
            }
            return;
        }

        const summaryBlock = assembleSummaryBlock();
        // `force` bypasses the cache — required on chat/branch switch, because a
        // branch inherits the parent's metadata so the block is byte-identical to
        // what was last injected, and the plain equality check would skip re-injection.
        if (!force && summaryBlock === _lastInjected) return;

        setExtensionPrompt(MODULE_NAME, summaryBlock || '', pos, dep, false, role);
        _lastInjected = summaryBlock || '';

        log(`Injection updated: ${(summaryBlock || '').length} chars @ pos ${pos} depth ${dep}`);
    } catch (e) {
        log('updateInjection error:', e);
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────

// When a message is deleted, SillyTavern splices the chat array so every later
// message's index shifts down. Our stored bookkeeping is index-based
// (summarizedUpTo, each snippet's turnRange, ghostedIndices), so it must shift
// too — otherwise recall / snippet-regen / backfill would later read the wrong
// source turns. The ledger is name-keyed and carries no indices, so it is
// untouched. These run only on deletion, do no model calls, and are O(snippets).

// Precise single-deletion shift at index D. An index x maps: x>D -> x-1; x==D
// was the deleted message. A snippet whose entire source was the deleted
// message becomes unrecallable (turnRange nulled, text kept).
function reindexAfterDeletion(store, D) {
    if (!store || typeof D !== 'number' || D < 0) return;
    if (typeof store.summarizedUpTo === 'number' && store.summarizedUpTo >= D) {
        store.summarizedUpTo = store.summarizedUpTo - 1;
    }
    if (typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx >= D) {
        store.ledgerLiveIdx = store.ledgerLiveIdx - 1;   // keep the live pointer aligned after a deletion
    }
    // The notes journal is indexed by turn like everything else, and v5.65.0 forgot
    // to reindex it: every note sat one turn off the chat afterwards. Worse, the turn
    // itself is GONE, so the note recording what it changed must go with it — and
    // once it does, refolding IS the rewind. That is why a single deletion no longer
    // needs a scribe replay: drop the dead turn's notes, shift the rest down, refold.
    // (Base notes are carried-over snapshots of everything up to their turn, not a
    // record of that turn, so they shift rather than vanish.)
    if (Array.isArray(store.ledgerNotes)) {
        // Journal external page edits BEFORE the shift+refold — a copilot fix made
        // since the last pass died to something as routine as deleting one message.
        adoptExternalLedgerEdits(store);
        store.ledgerNotes = store.ledgerNotes
            .filter(n => !(n && typeof n.t === 'number' && n.t === D && !n.base))
            .map(n => (n && typeof n.t === 'number' && n.t >= D) ? Object.assign({}, n, { t: n.t - 1 }) : n);
        if (typeof store.ledgerNotesFrom === 'number' && store.ledgerNotesFrom > D) store.ledgerNotesFrom -= 1;
        // The staging journal is turn-indexed exactly like the live one; a mid-rebuild
        // deletion must shift it too, or the swap installs notes one turn off the chat.
        if (Array.isArray(store.ledgerStagingNotes)) {
            store.ledgerStagingNotes = store.ledgerStagingNotes
                .filter(n => !(n && typeof n.t === 'number' && n.t === D && !n.base))
                .map(n => (n && typeof n.t === 'number' && n.t >= D) ? Object.assign({}, n, { t: n.t - 1 }) : n);
        }
        if (notesCover(store, (typeof store.ledgerLiveIdx === 'number') ? store.ledgerLiveIdx : 0)) {
            store.ledger = foldLedgerNotes(store.ledgerNotes, Infinity);   // exact, instant, zero model calls
        }
    }
    if (Array.isArray(store.continuityFlags)) {
        store.continuityFlags = store.continuityFlags.filter(f => {
            if (!f) return false;
            if (!Array.isArray(f.turnRange)) return true;
            let a = f.turnRange[0], b = f.turnRange[1];
            if (a > D) a -= 1;
            if (b >= D) b -= 1;
            if (a > b || b < 0) return false;   // the flag's source is gone — drop it
            f.turnRange = [a, b];
            return true;
        });
    }
    if (Array.isArray(store.layers)) {
        for (const layer of store.layers) {
            if (!Array.isArray(layer)) continue;
            for (const sn of layer) {
                if (!sn || !Array.isArray(sn.turnRange) || sn.turnRange.length < 2) continue;
                let s = sn.turnRange[0], e = sn.turnRange[1];
                if (typeof s !== 'number' || typeof e !== 'number') continue;
                if (s > D) s -= 1;            // start shifts only if strictly after the deletion
                if (e >= D) e -= 1;           // end shifts if at or after (the deleted msg leaves the span)
                sn.turnRange = (s > e) ? null : [s, e];   // whole source gone -> unrecallable, keep text
            }
        }
    }
    if (Array.isArray(store.ghostedIndices)) {
        store.ghostedIndices = store.ghostedIndices
            .filter(i => i !== D)
            .map(i => (i > D ? i - 1 : i));
    }
}

// Safe fallback when we can't pinpoint the deletion (bulk/scattered/unknown
// index): only fix anything that now points PAST the end of the chat, so
// nothing references a non-existent message. Never mis-shifts in-range indices.
function clampStoreToLength(store, newLen) {
    if (!store) return;
    const max = (newLen | 0) - 1;
    if (typeof store.summarizedUpTo === 'number' && store.summarizedUpTo > max) store.summarizedUpTo = max;
    if (typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx > max) store.ledgerLiveIdx = max;
    if (Array.isArray(store.continuityFlags)) {
        store.continuityFlags = store.continuityFlags.filter(f => {
            if (!f) return false;
            if (!Array.isArray(f.turnRange)) return true;
            if (f.turnRange[0] > max) return false;
            if (f.turnRange[1] > max) f.turnRange[1] = max;
            return true;
        });
    }
    if (Array.isArray(store.layers)) {
        for (const layer of store.layers) {
            if (!Array.isArray(layer)) continue;
            for (const sn of layer) {
                if (!sn || !Array.isArray(sn.turnRange) || sn.turnRange.length < 2) continue;
                let s = sn.turnRange[0], e = sn.turnRange[1];
                if (typeof s !== 'number' || typeof e !== 'number') continue;
                if (s > max) { sn.turnRange = null; continue; }
                if (e > max) e = max;
                sn.turnRange = (s > e) ? null : [s, e];
            }
        }
    }
    if (Array.isArray(store.ghostedIndices)) store.ghostedIndices = store.ghostedIndices.filter(i => i <= max);
    if (Array.isArray(store.continuityResolved)) {
        store.continuityResolved = store.continuityResolved.filter(r => r && (!Array.isArray(r.turnRange) || r.turnRange[1] <= max));
    }
}

function onMessageDeleted(deletedIndex) {
    try {
        const { chat } = SillyTavern.getContext();
        const newLen = Array.isArray(chat) ? chat.length : 0;
        const delta = (_prevChatLen >= 0) ? (_prevChatLen - newLen) : -1;   // messages removed since last known length
        _prevChatLen = newLen;
        const store = getChatStore();
        const D = (typeof deletedIndex === 'number' && isFinite(deletedIndex) && deletedIndex >= 0)
            ? Math.floor(deletedIndex) : -1;

        let _bulkTrim = false;
        let _genStale = true;
        let _liPre = -1;   // pre-deletion live pointer — the timeline D belongs to
        if (delta === 1 && D >= 0 && D <= newLen) {
            // D is a PRE-deletion index — every comparison against the pointer must
            // use the pre-deletion pointer too. Reading it after reindexAfterDeletion
            // (which decrements it) made the guard below false for exactly D == liveIdx:
            // deleting the newest read turn — the most common deletion there is, the
            // last AI reply — skipped the legacy rewind, and the stale ledger sat
            // until the NEXT event (editing the message before it) tripped over the
            // rewind this deletion owed. Same-frame capture, compared apples to apples.
            _liPre = (typeof store.ledgerLiveIdx === 'number') ? store.ledgerLiveIdx : -1;
            reindexAfterDeletion(store, D);   // the common case: one message, known position — exact shift
            // Deleting a message the ledger never read (above the live pointer)
            // invalidates nothing in flight: passages below D are untouched and the
            // pointer did not shift. Bumping the generation here threw away COMPLETED
            // passes for no reason — the root of the 'it restarts after finishing'
            // loop when the user deleted during background reads.
            if (D > _liPre) _genStale = false;
        } else if (delta >= 1 || D >= 0) {
            clampStoreToLength(store, newLen);   // bulk / uncertain — safe overrun-only repair
            _bulkTrim = true;
        } else {
            return;   // no shrink detected
        }
        if (_genStale) _ledgerGen++;   // in-flight scribe jobs saw the pre-deletion timeline — their liveEnd and deltas are stale
        saveChatStore();
        updateInjection(true);       // active cast may have changed if a recent message went away
        try { updateUI(); } catch (_) {}
        if (_bulkTrim && delta > 1 && newLen > 0) {
            // A bulk trim is a branch in disguise. With notes this folds instantly;
            // without them (history older than the notes base) it falls back.
            tryAutoRewindLedger(newLen - 1, 'trim').catch(() => {});
        } else if (!_bulkTrim && newLen > 0) {
            // SINGLE deletion. reindexAfterDeletion already dropped the dead turn's
            // notes and refolded, so the ledger is ALREADY correct — the page no
            // longer contains anything that turn contributed. Nothing to call.
            //
            // Before notes, a rewind meant an expensive scribe replay, so this case
            // deliberately skipped it and left the deleted message's facts in the
            // ledger "for one turn". They did not leave: the mismatch was only
            // discovered on the next chat load, which then looked like a BRANCH and
            // re-read everything. That is why deleting appeared to need a close and
            // reopen, and why returning to a chat re-read a ledger that was current.
            // Legacy chats (history predating the notes base) still need the fallback.
            // Two different pointers on purpose: whether the JOURNAL can vouch for the
            // page is a question about NOW (post-deletion pointer); whether the deleted
            // turn was within what the ledger had read is a question about THEN
            // (pre-deletion pointer). Conflating them skipped the rewind for D == liveIdx.
            const _liNow = (typeof store.ledgerLiveIdx === 'number') ? store.ledgerLiveIdx : -1;
            if (!notesCover(store, _liNow) && D >= 0 && D <= _liPre) {
                tryAutoRewindLedger(Math.max(0, D - 1), 'delete').catch(() => {});
            } else {
                try { renderLedger(); } catch (_) { /* panel may be closed */ }
            }
        }
    } catch (e) { log('onMessageDeleted error:', e); }
}

function onMessageReceived(messageIndex) {
    try {
        const { chat } = SillyTavern.getContext();
        _prevChatLen = Array.isArray(chat) ? chat.length : _prevChatLen;
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            setTimeout(async () => {
                await maybeSummarizeTurns();
                maybeQueueLiveLedger();   // live ledger: keep recent character states current, independent of summarization cadence
                maybeAuditLedger();       // ledger self-audit: periodically verify entries against the story and correct drift the scribe generated
                _rosterTick++;            // advance roster rotation one step per turn
                updateInjection();
                updateUI();
            }, 500);
        }
    } catch (e) {
        log('onMessageReceived error:', e);
    }
}

function onChatChanged() {
    try { if (typeof window !== 'undefined' && typeof window._closeNotepadFs === 'function') window._closeNotepadFs(); } catch (_) {}
    log('Chat changed.');
    catchupDismissed = false;
    _clearLiveRetry();
    _clearAuditRetry();
    _clearSummarizeRetry();
    _turnsSinceAudit = 0;
    _turnsSinceLive = 0;   // cadence is per-chat; a leftover count could skip the new chat's first pass
    try { const { chat } = SillyTavern.getContext(); _prevChatLen = Array.isArray(chat) ? chat.length : -1; } catch (_) { _prevChatLen = -1; }
    // Kickstart: a chat with a live ledger but ZERO saved snapshots (backfill-built
    // long ago, or a victim of the pre-v5.51 global-cursor bug that silently
    // stopped checkpointing) gets one immediately — so the very next edit or
    // deletion has a restore point instead of falling to synthesis or a rebuild.
    try {
        const st0 = getChatStore();
        if (st0 && typeof st0.ledgerLiveIdx === 'number' && st0.ledgerLiveIdx >= 0
            && st0.ledger && Object.keys(st0.ledger).length > 0
            && listLedgerCheckpoints().length === 0) {
            saveLedgerCheckpoint(st0.ledgerLiveIdx);
            st0._ckptLast = st0.ledgerLiveIdx;
            log(`Kickstart: saved first checkpoint at turn ${st0.ledgerLiveIdx} (chat had none).`);
        }
    } catch (_) {}
    // Editor + audit state is PER-CHAT. Never let a memory snapshot, pending
    // edits, or queued audits from the previous chat leak into this one —
    // an Undo here with the old chat's snapshot would corrupt this chat's memory.
    _editorPending = [];
    _editorUndoSnapshot = null;
    _auditQueue = [];
    _ledgerQueue = [];
    _continuityQueue = [];
    _pendingEditedIdx.clear();               // indices from the OLD chat — meaningless (and dangerous) in this one
    clearTimeout(_editRecheckTimer);         // a pending debounce would re-check the WRONG chat's snippets
    clearTimeout(_ledgerEditTimer);          // same class: an armed edit-rewind would rewind the WRONG chat at the old chat's indices
    _ledgerEditTimer = null;
    _ledgerEditMin = Infinity;
    _chatEpoch++;   // invalidate any ledger update still in flight for the previous chat
    _ledgerGen++;   // defense in depth — same invalidation through the generation guard
    $('#sc_editor_undo').hide();
    $('#sc_editor_review_list').empty();
    clearRecall();
    setTimeout(renderPins, 300);
    setTimeout(async () => {
        if (maybeRecoverStore()) { try { await saveChatStore(); } catch (_) {} }
        await repairIfBranched();
        // Resume an interrupted ledger catch-up (the queue is memory-only; an app
        // kill mid-rebuild used to strand the ledger half-empty with nothing to
        // restart it). ledgerLiveIdx advanced per finished chunk, so this picks up
        // exactly where the last completed pass left off.
        try {
            const st = getChatStore();
            if (st.ledgerRebuild && typeof st.ledgerRebuild.target === 'number' && _ledgerQueue.length === 0 && !_ledgerActive) {
                const attempts = st.ledgerRebuild.attempts | 0;
                if (attempts >= 5) {
                    // Five failed rounds: something is persistently wrong (model emitting
                    // unparseable output, provider rejecting). STOP retrying automatically —
                    // the endless retry-toast loop is worse than a stale ledger. The old
                    // ledger keeps serving; a manual 'Build ledger from history' or the
                    // next successful live pass clears this state.
                    log(`Ledger catch-up suspended after ${attempts} failed attempts — not auto-resuming.`);
                    toastr.warning('Ledger catch-up keeps failing (check the summarizer connection / model output). Your current ledger stays as-is; run "Build ledger from history" once the connection is healthy.', 'Summaryception', { timeOut: 9000 });
                } else {
                    const { chat } = SillyTavern.getContext();
                    const li = (typeof st.ledgerLiveIdx === 'number') ? st.ledgerLiveIdx : -1;
                    const tgt = Math.min(st.ledgerRebuild.target, (Array.isArray(chat) ? chat.length : 1) - 1);
                    if (li < tgt) {
                        const n = queueLedgerReplay(li, tgt, { staging: !!st.ledgerRebuild.staging });
                        if (n > 0) toastr.info(`Resuming ledger catch-up — ${n} background pass${n === 1 ? '' : 'es'} remaining.`, 'Summaryception', { timeOut: 4000 });
                        else { st.ledgerRebuild = null; st.ledgerStaging = null; st.ledgerStagingNotes = null; }
                    } else {
                        // Pointer already reached the target (completion raced the reload):
                        // finish the swap if a staged result is waiting. Same one swap as the
                        // in-session path — page and staged journal installed together, live-
                        // page external edits carried across. (The previous rebase here read
                        // three fields off the rebuild marker — upTo, endIdx, cursor —
                        // which NOTHING ever writes; the only real field is `target`. So its anchor was always -1, its base
                        // notes sat below every real note, and the fold restored the exact
                        // stale content the rebuild replaced. The "fix" shipped green because
                        // the test fed it a hand-fabricated `upTo` production never produces.)
                        if (st.ledgerRebuild.staging) _swapStagedLedgerIn(st);
                        st.ledgerStaging = null;
                        st.ledgerStagingNotes = null;
                        st.ledgerRebuild = null;
                    }
                }
            }
        } catch (_) {}
        updateInjection(true);   // force — new branch/chat needs re-injection past the cache
        updateUI();
    }, 200);
}

function onGenerationStarted() {
    // Keep the length tracker fresh — a user message is already in the chat by now,
    // and MESSAGE_RECEIVED only fires for AI messages, so this closes that gap
    // before any subsequent deletion is measured.
    try { const { chat } = SillyTavern.getContext(); _prevChatLen = Array.isArray(chat) ? chat.length : _prevChatLen; } catch (_) {}
    // Force so the injection is guaranteed present at prompt-build time, even if
    // a branch/chat switch left it stale or cleared. This removes the need to
    // toggle enabled/pause or refresh the page after branching.
    updateInjection(true);
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-pin',
            callback: (args, value) => { addPin(String(value||'')); return ''; },
            helpString: 'Pin the current text selection (or the last message) into Summaryception permanent memory. Optional value = label.',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-recall',
            callback: (args, value) => { runRecall(String(value||'')); return ''; },
            helpString: 'Verbatim recall: fetch the original chat text behind the memory snippets matching the query, inject for the next generation.',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-status',
            callback: () => {
                const store = getChatStore();
                const lines = ['**Summaryception Status**'];
                lines.push(`Summarized up to index: ${store.summarizedUpTo}`);
                if (store.layers) {
                    for (let i = 0; i < store.layers.length; i++) {
                        const l = store.layers[i];
                        if (l && l.length > 0) {
                            lines.push(`Layer ${i}: ${l.length} snippets`);
                        }
                    }
                }
                return lines.join('\n');
            },
            helpString: 'Show Summaryception layer status',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                await unghostAllMessages();

                const store = getChatStore();
                store.layers.length = 0;
                store.summarizedUpTo = -1;
                store.ghostedIndices = [];
                store.ledger = {};

                const { chatMetadata } = SillyTavern.getContext();
                chatMetadata[MODULE_NAME] = store;

                await saveChatStore();
                dropBackupsForCurrentChat();
                try {
                    const ctx2 = SillyTavern.getContext();
                    if (ctx2.saveChat) await ctx2.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-ledger',
            callback: () => {
                const store = getChatStore();
                const ledger = store.ledger || {};
                const names = Object.keys(ledger);
                if (names.length === 0) return '*Character ledger is empty for this chat.*';
                const entries = names
                    .map(name => ({ name, entry: ledger[name], u: (ledger[name] && ledger[name].updatedAt) || 0 }))
                    .sort((a, b) => b.u - a.u);
                const lines = ['**Character Ledger**'];
                for (const { name, entry } of entries) {
                    const line = formatLedgerEntry(name, entry, 100000);
                    if (line) lines.push('- ' + line);
                }
                return lines.join('\n');
            },
            helpString: 'Show the current per-character continuity ledger for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-ledger-build',
            callback: () => { backfillLedgerFromHistory(); return ''; },
            helpString: 'Build the character ledger from the whole existing story (replays it in batches; cancelable)',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-audit-all',
            callback: () => { backfillAuditsForLayer0(); return ''; },
            helpString: 'Backfill detail notes for all Layer 0 snippets that have none yet (cancelable)',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────

function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
        $('#sc_verbatim_turns').val(s.verbatimTurns);
        $('#sc_verbatim_turns_val').text(s.verbatimTurns);
        $('#sc_turns_per_summary').val(s.turnsPerSummary);
        $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
        $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
        $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
        $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
        $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
        $('#sc_max_layers').val(s.maxLayers);
        $('#sc_max_layers_val').text(s.maxLayers);
        $('#sc_injection_template').val(s.injectionTemplate);
        $('#sc_injection_position').val(String(s.injectionPosition ?? 1));
        $('#sc_injection_depth').val(s.injectionDepth ?? 4);
        $('#sc_injection_depth_val').text(s.injectionDepth ?? 4);
        $('#sc_inject_notepad').prop('checked', s.injectNotepad !== false);
        $('#sc_inject_pinned').prop('checked', s.injectPinned !== false);
        $('#sc_inject_ledger').prop('checked', s.injectLedger !== false);
        $('#sc_inject_summary').prop('checked', s.injectSummary !== false);
        $('#sc_inject_details').prop('checked', s.injectDetails !== false);
        _syncNotepadUi(store.notepad || '');
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        $('#sc_sister_enabled').prop('checked', s.sisterEnabled !== false);
        $('#sc_sister_system_prompt').val(s.sisterSystemPrompt);
        $('#sc_sister_user_prompt').val(s.sisterUserPrompt);
        $('#sc_ledger_enabled').prop('checked', s.ledgerEnabled !== false);
        $('#sc_continuity_enabled').prop('checked', s.continuityEnabled === true);
        $('#sc_continuity_autofix').prop('checked', s.continuityAutoFix === true);
        $('#sc_continuity_nudge').prop('checked', s.continuityNudge === true);
        $('#sc_continuity_nudge_max').val(s.continuityNudgeMax ?? 6);
        $('#sc_continuity_nudge_max_val').text(s.continuityNudgeMax ?? 6);
        if (s.continuitySystemPrompt !== undefined) $('#sc_continuity_system_prompt').val(s.continuitySystemPrompt);
        if (s.continuityUserPrompt !== undefined) $('#sc_continuity_user_prompt').val(s.continuityUserPrompt);
        if (s.continuityFixSystemPrompt !== undefined) $('#sc_continuity_fix_system_prompt').val(s.continuityFixSystemPrompt);
        if (s.continuityFixUserPrompt !== undefined) $('#sc_continuity_fix_user_prompt').val(s.continuityFixUserPrompt);
        $('#sc_ledger_system_prompt').val(s.ledgerSystemPrompt);
        $('#sc_ledger_user_prompt').val(s.ledgerUserPrompt);
        $('#sc_ledger_active_window').val(s.ledgerActiveWindow ?? 12);
        $('#sc_ledger_active_window_val').text(s.ledgerActiveWindow ?? 12);
        $('#sc_ledger_max_active').val(s.ledgerMaxActive ?? 6);
        $('#sc_ledger_max_active_val').text(s.ledgerMaxActive ?? 6);
        $('#sc_ledger_max_chars').val(s.ledgerMaxCharsPerChar ?? 600);
        $('#sc_ledger_live').prop('checked', s.ledgerLiveUpdate !== false);
        $('#sc_ledger_live_every').val(s.ledgerLiveEveryTurns ?? 1);
        $('#sc_ledger_live_every_val').text(s.ledgerLiveEveryTurns ?? 1);
        $('#sc_ledger_roster').prop('checked', s.ledgerInjectRoster !== false);
        $('#sc_ledger_roster_max').val(s.ledgerRosterMax ?? 12);
        $('#sc_ledger_roster_max_val').text(s.ledgerRosterMax ?? 12);
        $('#sc_ledger_roster_rotate').prop('checked', s.ledgerRosterRotate !== false);
        $('#sc_ledger_auto_rewind').prop('checked', s.ledgerAutoRewind !== false);
        $('#sc_ledger_max_chars_val').text(s.ledgerMaxCharsPerChar ?? 600);
        $('#sc_editor_system_prompt').val(s.editorSystemPrompt);
        $('#sc_editor_user_prompt').val(s.editorUserPrompt);
        $('#sc_recall_k').val(s.recallMaxSnippets??4);
        $('#sc_recall_persist').val(s.recallPersist??1);
        $('#sc_recall_auto').prop('checked', s.recallAuto===true);
        renderPins();
        // ── Prompt preset migration & sync ──
        // Migration: existing users with the old game-state default get upgraded to narrative.
        // Users who customized their prompt get marked as 'custom'.
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt) {
                // User had the old default — upgrade to narrative
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                // User customized their prompt — mark as custom
                s.promptPreset = 'custom';
                saveSettings();
            }
        }

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_input_strip_tags').val((s.inputStripTags || []).join('\n'));
        $('#sc_input_strip_headers').val((s.inputStripHeaders || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        let ghostedCount = 0;
        try {
            const { chat } = SillyTavern.getContext();
            ghostedCount = chat.filter(m => m.extra?.sc_ghosted).length;
        } catch (e) { /* no chat loaded */ }

        let statsHtml = '';
        if (s.disableGhosting) {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (metadata only — not visually hidden)</div>`;
        } else {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
        }
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }

        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');

        updateSnippetBrowser();
        renderLedger();
        updateCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

function updateCustomPromptSlots() {
    const s = getSettings();
    const select = $('#sc_custom_prompt_slot');
    select.empty().append('<option value="">-- Load a saved prompt --</option>');

    const prompts = s.savedCustomPrompts || {};
    const names = Object.keys(prompts).sort();

    for (const name of names) {
        const preview = prompts[name].substring(0, 60).replace(/\n/g, ' ');
        select.append(
            $('<option></option>')
            .val(name)
            .text(`${name}`)
            .attr('title', preview)
        );
    }

    // Show/hide the prompt manager based on current preset
    if (s.promptPreset === 'custom') {
        $('#sc_custom_prompt_manager').show();
    } else {
        $('#sc_custom_prompt_manager').hide();
    }
}

// Names in current render order, so the manage-UI can delete by index without
// round-tripping a character name (which may contain quotes/entities) through a
// DOM attribute. Rebuilt on every renderLedger call, kept in lockstep with the DOM.
let _ledgerOrder = [];

function _resolvedLogHtml(resolved) {
    if (!resolved || resolved.length === 0) return '';
    const items = resolved.slice(0, 8).map(r => `<li>${escapeHtml((r.applied ? '✔ fixed: ' : '✔ resolved: ') + (r.fix || r.issue || ''))}</li>`).join('');
    return `<details class="sc-cf-resolved"><summary class="sc-muted">Recently resolved (${resolved.length})</summary><ul>${items}</ul></details>`;
}

function renderContinuity() {
    try {
        const $box = $('#sc_continuity_view');
        if ($box.length === 0) return;
        const store = getChatStore();
        const flags = (store.continuityFlags || []).filter(f => f && f.status === 'open');
        const resolved = store.continuityResolved || [];
        if (flags.length === 0) {
            const note = resolved.length ? ` <span class="sc-muted">— ${resolved.length} recently resolved</span>` : '';
            $box.html(`<div class="sc-muted">No open continuity issues.${note}</div>` + _resolvedLogHtml(resolved));
            return;
        }
        const sorted = flags.slice().sort((a, b) => ((a.turnRange && a.turnRange[0]) || 0) - ((b.turnRange && b.turnRange[0]) || 0));
        let html = '';
        for (const f of sorted) {
            const isSnippet = f.where === 'snippet';
            const badge = `<span class="sc-cf-badge ${isSnippet ? 'sc-cf-snippet' : 'sc-cf-source'}">${isSnippet ? 'snippet-fixable' : 'source · message edit'}</span>`;
            const tr = Array.isArray(f.turnRange) ? `turns ${f.turnRange[0]}–${f.turnRange[1]}` : '';
            const applyBtn = isSnippet
                ? `<button class="menu_button sc-cf-apply" data-id="${escapeHtml(String(f.id))}"><i class="fa-solid fa-wand-magic-sparkles"></i> Apply</button>`
                : `<button class="menu_button sc-cf-copilot" title="The source message is wrong — fix it via the copilot or manually; auto-fix never edits messages" disabled><i class="fa-solid fa-robot"></i> Copilot / message</button>`;
            html += `<div class="sc-cf-card">`
                + `<div class="sc-cf-head">${badge}<span class="sc-cf-turns">${tr}</span></div>`
                + `<div class="sc-cf-issue">${escapeHtml(f.issue || '')}</div>`
                + `<div class="sc-cf-fix"><span class="sc-cf-fixlabel">Fix:</span> ${escapeHtml(f.fix || '')}</div>`
                + `<div class="sc-cf-actions">${applyBtn}<button class="menu_button sc-cf-dismiss" data-id="${escapeHtml(String(f.id))}"><i class="fa-solid fa-xmark"></i> Dismiss</button></div>`
                + `</div>`;
        }
        $box.html(html + _resolvedLogHtml(resolved));
    } catch (e) { try { log('renderContinuity failed (non-fatal):', e); } catch (_) {} }
}

// Which characters have their history expanded (per render, not persisted).
const _histOpen = new Set();

// The wiki view: every turn that changed this character, oldest first, showing only
// what MOVED that turn — which is exactly what the note holds. This is the record
// that proves a character developed rather than being replaced.
function _historyHtml(store, name) {
    try {
        const rows = ledgerHistoryFor(store.ledgerNotes, name);
        if (!rows.length) {
            return '<div class="sc-ledger-hist-box"><div class="sc-muted">No recorded history yet for this character. History starts being kept from the moment a turn changes them.</div></div>';
        }
        const from = (typeof store.ledgerNotesFrom === 'number') ? store.ledgerNotesFrom : 0;
        const items = rows.map((n) => {
            const bits = [];
            if (typeof n.core === 'string')  bits.push('<b>Nature</b> ' + escapeHtml(n.core));
            if (typeof n.state === 'string') bits.push('<b>Now</b> ' + escapeHtml(n.state));
            if (typeof n.arc === 'string')   bits.push('<b>Arc</b> ' + escapeHtml(n.arc));
            if (Array.isArray(n.threads))    bits.push('<b>Open threads</b> ' + escapeHtml(n.threads.join('; ') || '(all resolved)'));
            if (!bits.length) return '';
            return '<li><span class="sc-hist-turn">' + (n.base ? 'as of turn ' + n.t : 'turn ' + n.t) + '</span>' +
                (n.base ? ' <span class="sc-muted">(carried over)</span>' : '') +
                '<div class="sc-hist-body">' + bits.join('<br>') + '</div></li>';
        }).filter(Boolean).join('');
        return '<div class="sc-ledger-hist-box"><div class="sc-muted">Every turn that changed them — only what moved is recorded, so unchanged traits simply persist. Exact history kept from turn ' + from + '.</div><ol class="sc-hist-list">' + items + '</ol></div>';
    } catch (e) {
        return '<div class="sc-ledger-hist-box"><div class="sc-muted">History unavailable.</div></div>';
    }
}

function renderLedger() {
    try {
        try { renderContinuity(); } catch (_) {}
        const $box = $('#sc_ledger_view');
        if ($box.length === 0) return;
        const store = getChatStore();
        const ledger = (store && store.ledger && typeof store.ledger === 'object') ? store.ledger : {};
        const names = Object.keys(ledger);
        if (names.length === 0) {
            _ledgerOrder = [];
            $box.html('<div class="sc-muted">No characters recorded yet for this chat. The ledger fills in automatically as the story is summarized.</div>');
            return;
        }

        // THE SAME selection the injection uses — not a copy. The panel's contract:
        // describe exactly what the storyteller receives THIS turn, per character.
        const s = getSettings();
        let recentLower = '';
        let _panelMsgs = [];
        try {
            const { chat } = SillyTavern.getContext();
            const windowSize = Math.max(1, s.ledgerActiveWindow ?? 12);
            _panelMsgs = (chat || []).slice(-windowSize).map(m => ((m && typeof m.mes === 'string') ? m.mes : '').toLowerCase());
            recentLower = _panelMsgs.join('\n');
        } catch (_) { /* no chat loaded */ }
        const cast = computeLedgerCast(ledger, s, recentLower, getLedgerPins(), _rosterTick, _panelMsgs);
        const statusOf = new Map();
        cast.shown.forEach(x => statusOf.set(x.name, 'full'));
        (cast.compact || []).forEach(x => { if (!statusOf.has(x.name)) statusOf.set(x.name, 'compact'); });
        cast.roster.forEach(n => { if (!statusOf.has(n)) statusOf.set(n, 'roster'); });
        const rank = { full: 0, compact: 1, roster: 2 };
        const entries = names
            .map(name => ({ name, entry: ledger[name], u: (ledger[name] && ledger[name].updatedAt) || 0, st: statusOf.get(name) || 'out' }))
            .sort((a, b) => ((rank[a.st] ?? 2) - (rank[b.st] ?? 2)) || (b.u - a.u));
        _ledgerOrder = entries.map(e => e.name);
        const _nInj = cast.shown.length + (cast.compact || []).length + cast.roster.length;

        const field = (label, val) => {
            if (val === undefined || val === null || !String(val).trim()) return '';
            return `<div class="sc-ledger-field"><span class="sc-ledger-flabel">${label}</span> ${escapeHtml(String(val).trim())}</div>`;
        };

        const _pinnedSet = new Set(getLedgerPins().map(p => String(p).toLowerCase()));
        // Freshness, stated plainly: no guessing whether a pass is running, no tapping
        // to find out. The scribe reads a turn AFTER it exists, so "current through
        // the newest turn" is the best possible state — it is never ahead.
        let freshHtml = '';
        try {
            const { chat: _c } = SillyTavern.getContext();
            const _turns = getAssistantTurns(_c || []);
            const _latest = _turns.length ? _turns[_turns.length - 1].index : -1;
            // Ask the SAME function that decides what to read, instead of reinventing
            // the rule. Two bugs lived in the reinvention: it ignored summarizedUpTo
            // (turns at or below it were already read by the summarization pass's own
            // scribe, so once summarizing ran ahead of the live pointer the panel
            // screamed about turns that were long since read), and it reported
            // `latest - pointer`, a MESSAGE-INDEX difference — roughly double the turn
            // count with alternating user/assistant messages. Both at once produced
            // "22 turn(s) not read yet" on a ledger that was perfectly current.
            const _range = _computeLiveLedgerRange(store.summarizedUpTo, store.ledgerLiveIdx, _latest);
            const _behind = _range ? _turns.filter(t => t.index >= _range[0]).length : 0;
            const _li = Math.max(
                (typeof store.summarizedUpTo === 'number') ? store.summarizedUpTo : -1,
                (typeof store.ledgerLiveIdx === 'number') ? store.ledgerLiveIdx : -1,
            );
            const _working = _ledgerActive || _ledgerAuditActive || _ledgerQueue.length > 0 || !!_liveRetryTimer;
            freshHtml = _working
                ? `<div class="sc-ledger-fresh sc-fresh-work">⏳ Reading the story into the ledger${_behind ? ` — ${_behind} turn(s) behind` : ''}… it lands on its own; nothing to tap.</div>`
                : _behind > 0
                    ? `<div class="sc-ledger-fresh sc-fresh-lag">⚠ ${_behind} turn(s) not read yet — the next turn picks them up automatically.</div>`
                    : `<div class="sc-ledger-fresh sc-fresh-ok">✓ Current through turn ${_li} (the newest turn). Nothing pending.</div>`;
        } catch (_) { /* no chat loaded */ }
        let html = freshHtml + `<div class="sc-ledger-injsum">💉 Injected this turn: <b>${_nInj}</b> of ${names.length} — ${cast.shown.length} full + ${(cast.compact || []).length} compact (all on screen) + ${cast.roster.length} roster line${cast.roster.length === 1 ? '' : 's'}. Nobody on screen is ever reduced to a name.</div>`;
        entries.forEach(({ name, entry, st }, i) => {
            // Badge = this turn's injection truth, straight from the shared selector.
            const badge = st === 'full'
                ? '<span class="sc-ledger-badge">💉 injected — full entry (on screen)</span>'
                : st === 'compact'
                    ? '<span class="sc-ledger-badge sc-ledger-rosterbadge">💉 injected — on screen (compact: nature + now)</span>'
                    : st === 'roster'
                    ? '<span class="sc-ledger-badge sc-ledger-rosterbadge">🔁 injected — roster line</span>'
                    : '<span class="sc-ledger-badge sc-ledger-outbadge">⏸ not injected this turn</span>';
            const pinned = _pinnedSet.has(name.toLowerCase());
            const pinBadge = pinned ? '<span class="sc-ledger-badge sc-ledger-pinbadge">pinned</span>' : '';
            let threadsHtml = '';
            if (Array.isArray(entry.threads) && entry.threads.length) {
                const items = entry.threads.filter(t => t && String(t).trim())
                    .map(t => `<li>${escapeHtml(String(t).trim())}</li>`).join('');
                if (items) threadsHtml = `<div class="sc-ledger-field"><span class="sc-ledger-flabel">Open threads</span><ul class="sc-ledger-threads">${items}</ul></div>`;
            }
            html += `<div class="sc-ledger-card" data-idx="${i}">
                <div class="sc-ledger-head"><span class="sc-ledger-name">${escapeHtml(name)}</span>${badge}${pinBadge}
                    <button class="sc-ledger-hist menu_button fa-solid fa-clock-rotate-left${_histOpen.has(name) ? ' sc-pinned' : ''}" title="How they became who they are — every turn that changed this character"></button>
                    <button class="sc-ledger-pin menu_button fa-solid fa-thumbtack${pinned ? ' sc-pinned' : ''}" title="${pinned ? 'Unpin — allow rotation' : 'Pin — always keep in context, even when off-screen'}"></button>
                    <button class="sc-ledger-del menu_button fa-solid fa-xmark" title="Delete this character from the ledger"></button>
                </div>
                ${field('Nature', entry.core)}
                ${field('Now', entry.state)}
                ${threadsHtml}
                ${field('Arc', entry.arc)}
                ${_histOpen.has(name) ? _historyHtml(store, name) : ''}
            </div>`;
        });
        $box.html(html);
    } catch (e) {
        log('renderLedger error:', e);
    }
}

function updateSnippetBrowser() {
    const store = getChatStore();
    let html = '';

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const rangeStr = sn.turnRange
                    ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                    : sn.mergedCount
                        ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                        : '';
                const seedStr = sn.promoted ? ' 🌱' : '';
                const canRedo = (i === 0 && sn.turnRange);
                const redoBtn = canRedo
                    ? `<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right" title="Regenerate this snippet"></button>`
                    : '';

                // Sister detail row (Layer 0 turn-summaries only)
                let detailRow = '';
                if (i === 0 && sn.turnRange) {
                    const hasDetail = sn.detail && String(sn.detail).trim();
                    const detailText = hasDetail
                        ? `<span class="sc-detail-text" data-layer="${i}" data-idx="${j}" title="Click to edit detail">📝 ${escapeHtml(String(sn.detail).trim())}</span>`
                        : `<span class="sc-detail-empty">no detail</span>`;
                    const detailRedo = `<button class="sc-detail-redo menu_button fa-solid fa-wand-magic-sparkles" title="${hasDetail ? 'Regenerate' : 'Generate'} detail (re-run the sister on these turns)"></button>`;
                    const detailDel = hasDetail
                        ? `<button class="sc-detail-delete menu_button fa-solid fa-eraser" title="Delete this detail"></button>`
                        : '';
                    const ledgerBtn = `<button class="sc-detail-ledger menu_button fa-solid fa-brain" title="Read this scene into the character ledger"></button>`;
                    detailRow = `<div class="sc-detail-row" data-layer="${i}" data-idx="${j}">${detailText}${detailRedo}${detailDel}${ledgerBtn}</div>`;
                }

                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                <span class="sc-snippet-text" data-layer="${i}" data-idx="${j}" title="Click to edit">${escapeHtml(sn.text)}</span>
                <span class="sc-snippet-meta">${rangeStr}${seedStr}</span>
                ${redoBtn}
                <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                ${detailRow}
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    // Edit snippet on click
    $('.sc-snippet-text').off('click').on('click', function () {
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];
        const textEl = $(this);

        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.text)
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const newText = $(this).val().trim();
                    if (newText) {
                        sn.text = newText;
                        await saveChatStore();
                        updateInjection();
                        toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                    }
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                const newText = $(this).val().trim();
                if (newText && newText !== sn.text) {
                    sn.text = newText;
                    await saveChatStore();
                    updateInjection();
                    toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                }
                updateSnippetBrowser();
            });

        textEl.replaceWith(textarea);

        // Auto-size to fit content
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';

        textarea.focus().select();
    });

    // Redo snippet
    $('.sc-snippet-redo').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const store = getChatStore();
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];

        if (!sn.turnRange) {
            toastr.warning(
                'Only Layer 0 (turn summary) snippets can be regenerated. Promoted meta-summaries have no source turns.',
                'Summaryception',
                { timeOut: 5000 }
            );
            return;
        }

        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.', 'Summaryception');
            return;
        }

        const [rangeStart, rangeEnd] = sn.turnRange;
        const { chat } = SillyTavern.getContext();

        if (!confirm(`Regenerate summary for turns ${rangeStart}–${rangeEnd}?`)) return;

        isSummarizing = true;
        const btn = $(this);
        btn.prop('disabled', true).removeClass('fa-rotate-right').addClass('fa-spinner fa-spin');

        try {
            const storyTxt = buildPassageFromRange(chat, rangeStart, rangeEnd);

            if (!storyTxt.trim()) {
                toastr.error('Source turns are empty — cannot regenerate.', 'Summaryception');
                return;
            }

            const contextParts = [];
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const l = store.layers[i];
                if (!l) continue;
                for (let j = 0; j < l.length; j++) {
                    if (i === layerIdx && j === snippetIdx) continue;
                    contextParts.push(l[j].text);
                }
            }
            const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';

            toastr.info(`Regenerating summary for turns ${rangeStart}–${rangeEnd}…`, 'Summaryception', {
                timeOut: 3000,
                progressBar: true,
            });

            const newSummary = await callSummarizer(storyTxt, contextStr);

            if (!newSummary) {
                toastr.error('Regeneration failed — original snippet kept.', 'Summaryception');
                return;
            }

            sn.text = newSummary;
            sn.timestamp = Date.now();
            sn.regenerated = true;

            await saveChatStore();
            updateInjection();
            updateUI();

            toastr.success(`Snippet regenerated for turns ${rangeStart}–${rangeEnd}`, 'Summaryception', { timeOut: 3000 });

        } finally {
            isSummarizing = false;
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
        }
    });

    // Delete snippet
    $('.sc-snippet-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer) {
            layer.splice(snippetIdx, 1);

            if (store.layers[0] && store.layers[0].length > 0) {
                const maxEnd = Math.max(...store.layers[0]
                    .filter(sn => sn.turnRange)
                    .map(sn => sn.turnRange[1]));
                store.summarizedUpTo = maxEnd;
            } else {
                store.summarizedUpTo = -1;
            }

            await saveChatStore();
            updateInjection();
            updateUI();
            toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
        }
    });

    // Edit detail on click
    $('.sc-detail-text').off('click').on('click', function () {
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;
        const sn = layer[snippetIdx];
        const commit = async (val) => {
            const v = (val || '').trim();
            if (v !== (sn.detail || '')) {
                if (v) sn.detail = v; else delete sn.detail;
                await saveChatStore();
                updateInjection();
                toastr.success('Detail updated', 'Summaryception', { timeOut: 1500 });
            }
        };
        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.detail || '')
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    await commit($(this).val());
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                await commit($(this).val());
                updateSnippetBrowser();
            });
        $(this).replaceWith(textarea);
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';
        textarea.focus().select();
    });

    // Regenerate / generate detail (re-run the sister on the snippet's source turns)
    $('.sc-detail-redo').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-detail-row').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-detail-row').data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx] || !layer[snippetIdx].turnRange) return;
        if (isSummarizing) { toastr.warning('Busy summarizing — try again in a moment.', 'Summaryception'); return; }
        const sn = layer[snippetIdx];
        const [rangeStart, rangeEnd] = sn.turnRange;
        const { chat } = SillyTavern.getContext();
        isSummarizing = true;
        const btn = $(this);
        btn.prop('disabled', true).removeClass('fa-wand-magic-sparkles').addClass('fa-spinner fa-spin');
        try {
            const storyTxt = buildPassageFromRange(chat, rangeStart, rangeEnd);
            if (!storyTxt.trim()) { toastr.error('Source turns are empty — cannot audit.', 'Summaryception'); return; }
            const contextParts = [];
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const l = store.layers[i];
                if (!l) continue;
                for (let k = 0; k < l.length; k++) {
                    if (i === layerIdx && k === snippetIdx) continue;
                    contextParts.push(l[k].text);
                }
            }
            const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';
            toastr.info(`Auditing turns ${rangeStart}–${rangeEnd} for detail…`, 'Summaryception', { timeOut: 3000, progressBar: true });
            const detail = await callAuditor(storyTxt, sn.text, contextStr);
            if (detail) {
                sn.detail = detail;
                toastr.success('Detail generated', 'Summaryception', { timeOut: 2500 });
            } else {
                delete sn.detail;
                toastr.info('Auditor found nothing to add — the snippet already covers it.', 'Summaryception', { timeOut: 3000 });
            }
            await saveChatStore();
            updateInjection();
        } finally {
            isSummarizing = false;
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-wand-magic-sparkles');
            updateSnippetBrowser();
        }
    });

    // Delete detail
    $('.sc-detail-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-detail-row').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-detail-row').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer && layer[snippetIdx]) {
            delete layer[snippetIdx].detail;
            await saveChatStore();
            updateInjection();
            updateSnippetBrowser();
            toastr.info('Detail removed', 'Summaryception', { timeOut: 1500 });
        }
    });

    // Selected ledger: read this one scene into the character ledger
    $('.sc-detail-ledger').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-detail-row').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-detail-row').data('idx'));
        const btn = $(this);
        btn.prop('disabled', true).removeClass('fa-brain').addClass('fa-spinner fa-spin');
        try {
            await runLedgerForSnippet(layerIdx, snippetIdx);
        } finally {
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-brain');
        }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Continuity Editor ("Co-Writer / Master Novelist") ───────────────
// Reads the ENTIRE memory (notepad + all snippets + detail notes), asks a
// smart editor model for a MINIMAL set of edits to resolve a problem/retcon,
// then applies them under per-item review with a one-tap undo. Reuses the
// summarizer connection + machinery.

let _editorPending = [];
let _editorUndoSnapshot = null;
let _editorCancelled = false;

// ── Memory Transplant (portable .md) ───────────────────────────────
// A TRANSPLANT is the story's memory as a portable Markdown file: notepad,
// character ledger, snippets (+details), pins. Human-readable, but every item
// sits between HTML-comment markers carrying a JSON payload, so an external
// auditor AI can edit the CONTENT while the importer re-parses the STRUCTURE
// losslessly. Distinct from the raw JSON export: that one restores the SAME
// chat (turn indexes, ghosting); the transplant targets a FRESH chat, where
// the old chat's turn indexes are meaningless by definition — so snippets
// import range-less ("unrecallable": their source turns lived in another
// chat), pins import as free pins (their source text does not exist here),
// and the ledger re-bases to "state as of import".
function _tpMark(kind, payload) {
    return '<!-- SC-' + kind + (payload ? ' ' + JSON.stringify(payload) : '') + ' -->';
}
function buildTransplantExport(store, meta) {
    const L = [];
    const m = Object.assign({ v: 1 }, meta || {});
    L.push('# SUMMARYCEPTION MEMORY TRANSPLANT');
    L.push(_tpMark('TRANSPLANT', m));
    L.push('');
    L.push('## NOTEPAD (author canon — highest authority)');
    L.push(_tpMark('NOTEPAD'));
    L.push(String(store.notepad || '').trim());
    L.push('<!-- /SC-NOTEPAD -->');
    L.push('');
    L.push('## CHARACTER LEDGER');
    const led = (store.ledger && typeof store.ledger === 'object') ? store.ledger : {};
    for (const name of Object.keys(led)) {
        const e = led[name] || {};
        const pay = { name };
        if (typeof e._t === 'number') pay.t = e._t;
        L.push(_tpMark('LEDGER', pay));
        L.push('CORE: ' + String(e.core || '').trim());
        L.push('STATE: ' + String(e.state || '').trim());
        L.push('ARC: ' + String(e.arc || '').trim());
        L.push('THREADS: ' + String(e.threads || '').trim());
        L.push('<!-- /SC-LEDGER -->');
        L.push('');
    }
    L.push('## MEMORY SNIPPETS (story order)');
    const layers = Array.isArray(store.layers) ? store.layers : [];
    for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        if (!Array.isArray(layer)) continue;
        for (const sn of layer) {
            if (!sn) continue;
            const pay = {};
            if (Array.isArray(sn.turnRange)) pay.turns = sn.turnRange[0] + '-' + sn.turnRange[1];
            if (li > 0) pay.layer = li;
            L.push(_tpMark('SNIPPET', pay));
            L.push(String(sn.text || '').trim());
            if (sn.detail) {
                L.push('<!-- SC-DETAIL -->');
                L.push(String(sn.detail).trim());
            }
            L.push('<!-- /SC-SNIPPET -->');
            L.push('');
        }
    }
    L.push('## PINNED QUOTES (verbatim — never reworded)');
    const pins = Array.isArray(store.pins) ? store.pins : [];
    for (const p of pins) {
        if (!p) continue;
        L.push(_tpMark('PIN', p.label ? { label: p.label } : {}));
        L.push(String(p.excerpt || '').trim());
        L.push('<!-- /SC-PIN -->');
        L.push('');
    }
    const flags = Array.isArray(store.continuityFlags) ? store.continuityFlags.filter(f => f && f.issue) : [];
    if (flags.length) {
        L.push('## OPEN CONTINUITY FLAGS (informational — not re-imported)');
        for (const f of flags) L.push('- [' + (f.kind || 'issue') + '] ' + f.issue + (f.fix ? ' → ' + f.fix : ''));
        L.push('');
    }
    return L.join('\n');
}
// Tolerant marker parser: keys ONLY on SC- markers; headings/prose between
// blocks are ignored; CRLF normalized; a block missing its closer runs to the
// next opener (an auditor AI's most likely mutilation) rather than being lost.
function parseTransplant(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n');
    const open = /<!--\s*SC-(TRANSPLANT|NOTEPAD|LEDGER|SNIPPET|PIN)\s*(\{[\s\S]*?\})?\s*-->/g;
    const out = { meta: null, notepad: '', ledger: {}, snippets: [], pins: [] };
    const marks = [];
    let m;
    while ((m = open.exec(t)) !== null) {
        let pay = null;
        if (m[2]) { try { pay = JSON.parse(m[2]); } catch (_) { pay = null; } }
        marks.push({ kind: m[1], pay, start: m.index, bodyAt: m.index + m[0].length });
    }
    for (let i = 0; i < marks.length; i++) {
        const mk = marks[i];
        if (mk.kind === 'TRANSPLANT') { out.meta = mk.pay || {}; continue; }
        const hardEnd = (i + 1 < marks.length) ? marks[i + 1].start : t.length;
        const closer = new RegExp('<!--\\s*/SC-' + mk.kind + '\\s*-->');
        const seg = t.slice(mk.bodyAt, hardEnd);
        const cm = closer.exec(seg);
        let body = (cm ? seg.slice(0, cm.index) : seg).trim();
        if (mk.kind === 'NOTEPAD') {
            out.notepad = body;
        } else if (mk.kind === 'LEDGER') {
            const name = mk.pay && typeof mk.pay.name === 'string' ? mk.pay.name.trim() : '';
            if (!name) continue;
            const entry = {};
            const fm = /^(CORE|STATE|ARC|THREADS):[ \t]*/;
            let cur = null;
            for (const line of body.split('\n')) {
                const f = fm.exec(line);
                if (f) { cur = f[1].toLowerCase(); entry[cur] = line.slice(f[0].length); }
                else if (cur) entry[cur] += '\n' + line;
            }
            for (const k of Object.keys(entry)) { entry[k] = entry[k].trim(); if (!entry[k]) delete entry[k]; }
            if (Object.keys(entry).length) out.ledger[name] = entry;
        } else if (mk.kind === 'SNIPPET') {
            const dm = /<!--\s*SC-DETAIL\s*-->/.exec(body);
            let text2 = body, detail;
            if (dm) { text2 = body.slice(0, dm.index).trim(); detail = body.slice(dm.index + dm[0].length).trim(); }
            if (text2) {
                const sn = { text: text2 };
                if (detail) sn.detail = detail;
                if (mk.pay && typeof mk.pay.turns === 'string') sn.turns = mk.pay.turns;
                out.snippets.push(sn);
            }
        } else if (mk.kind === 'PIN') {
            if (body) out.pins.push({ label: (mk.pay && mk.pay.label) ? String(mk.pay.label) : '', excerpt: body });
        }
    }
    return out;
}
// Fresh-chat store fields from a parsed transplant. baseTurn = "state as of
// NOW" for the ledger (page + base journal at one turn: page == fold(notes)
// holds from the first instant). Snippets are layer-0 and RANGE-LESS — every
// null-turnRange code path (recall "unrecallable", recompute, reindex) already
// treats that as first-class. Pins are FREE pins (srcIdx null): the one class
// v5.76 injects unconditionally, which is exactly right for quotes whose
// source text lives in another chat.
// Pure: batch the UNSUMMARIZED tail (turns past summarizedUpTo) exactly the way
// live summarization would — same batch size, same passage continuity (each
// passage starts where the previous ended, so user turns between assistant
// turns are never skipped). Used by the export's ephemeral pass.
function _exportTailBatches(chat, upTo, per) {
    const from = (typeof upTo === 'number') ? upTo : -1;
    const p = (per | 0) > 0 ? (per | 0) : 5;
    const turns = [];
    if (Array.isArray(chat)) {
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m || i <= from) continue;
            const isOurGhost = m.extra?.sc_ghosted === true;
            if (!m.is_user && (!m.is_system || isOurGhost) && m.mes && m.mes.trim().length > 0) turns.push(i);
        }
    }
    const out = [];
    let cursor = from;
    for (let i = 0; i < turns.length; i += p) {
        const endIdx = turns[Math.min(i + p, turns.length) - 1];
        out.push({ passageStart: cursor < 0 ? 0 : cursor + 1, endIdx });
        cursor = endIdx;
    }
    return out;
}

function storeFieldsFromTransplant(parsed, baseTurn) {
    const b = (typeof baseTurn === 'number' && baseTurn >= 0) ? baseTurn : 0;
    const ledger = {};
    const notes = [];
    for (const name of Object.keys(parsed.ledger || {})) {
        const e = parsed.ledger[name];
        const entry = { updatedAt: Date.now(), _t: b };
        for (const k of ['core', 'state', 'arc', 'threads']) if (e[k]) entry[k] = e[k];
        ledger[name] = entry;
        const bn = { t: b, name, at: Date.now(), base: true };
        for (const k of ['core', 'state', 'arc', 'threads']) if (e[k]) bn[k] = e[k];
        notes.push(bn);
    }
    const snippets = (parsed.snippets || []).map(sn => {
        const o = { text: sn.text, turnRange: null, imported: true };
        if (sn.detail) o.detail = sn.detail;
        return o;
    });
    const pins = (parsed.pins || []).map((p, i) => ({
        id: 'pin_tp_' + Date.now() + '_' + i, mesId: b, srcIdx: null,
        excerpt: p.excerpt, label: p.label || '', createdAt: Date.now(),
    }));
    return {
        notepad: parsed.notepad || '',
        ledger, ledgerNotes: notes, ledgerNotesFrom: b, ledgerLiveIdx: b,
        layers: [snippets], pins,
    };
}

function buildMemoryDump() {
    const store = getChatStore();
    const snippets = [];
    if (store.layers) {
        for (let L = 0; L < store.layers.length; L++) {
            const layer = store.layers[L];
            if (!layer) continue;
            for (let i = 0; i < layer.length; i++) {
                const sn = layer[i];
                const entry = { id: `L${L}#${i}`, layer: L, text: sn.text };
                if (sn.turnRange) entry.turns = `${sn.turnRange[0]}-${sn.turnRange[1]}`;
                if (sn.detail) entry.detail = sn.detail;
                snippets.push(entry);
            }
        }
    }
    return { notepad: store.notepad || '', snippets };
}

function resolveSnippetId(id) {
    const m = /^L(\d+)#(\d+)$/.exec(String(id || '').trim());
    if (!m) return null;
    const layer = parseInt(m[1], 10), idx = parseInt(m[2], 10);
    const store = getChatStore();
    const arr = store.layers && store.layers[layer];
    if (!arr || !arr[idx]) return null;
    return { layer, idx, arr, obj: arr[idx] };
}

function extractJsonArray(raw) {
    if (!raw) return null;
    let t = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = t.indexOf('['), end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;
    try { const p = JSON.parse(t.slice(start, end + 1)); return Array.isArray(p) ? p : null; }
    catch { return null; }
}

function recomputeSummarizedUpTo() {
    const store = getChatStore();
    const l0 = (store.layers && store.layers[0]) ? store.layers[0].filter(sn => sn.turnRange) : [];
    store.summarizedUpTo = l0.length > 0 ? Math.max(...l0.map(sn => sn.turnRange[1])) : -1;
}

function snapshotMemory() {
    const store = getChatStore();
    _editorUndoSnapshot = {
        notepad: store.notepad || '',
        layers: JSON.parse(JSON.stringify(store.layers || [])),
    };
}

async function restoreMemorySnapshot() {
    if (!_editorUndoSnapshot) return;
    const store = getChatStore();
    store.notepad = _editorUndoSnapshot.notepad;
    store.layers = JSON.parse(JSON.stringify(_editorUndoSnapshot.layers));
    recomputeSummarizedUpTo();
    await saveChatStore();
    updateInjection(true);
    updateUI();
    _syncNotepadUi(store.notepad || '');
    $('#sc_editor_undo').hide();
    $('#sc_editor_review_list').empty();
    _editorUndoSnapshot = null;
    _editorPending = [];
    toastr.success('Reverted — memory restored to before the edits.', 'Summaryception', { timeOut: 3000 });
}

async function runContinuityEditorReview() {
    const s = getSettings();
    const command = ($('#sc_editor_command').val() || '').trim();
    if (!command) { toastr.warning('Describe what to fix first.', 'Summaryception'); return; }
    const dump = buildMemoryDump();
    if (dump.snippets.length === 0 && !dump.notepad.trim()) {
        toastr.info('No memory yet to edit in this chat.', 'Summaryception'); return;
    }
    const btn = $('#sc_editor_review');
    btn.prop('disabled', true).text('Thinking…');
    _editorCancelled = false;
    $('#sc_editor_cancel').show();
    try {
        const memStr = JSON.stringify(dump, null, 1);
        let userTpl = (s.editorUserPrompt || '');
        userTpl = subst(userTpl, '{{command}}', command);
        userTpl = subst(userTpl, '{{memory}}', memStr);
        userTpl = subst(userTpl, '{{player_name}}', getPlayerName());
        toastr.info('Co-Writer is reviewing your full memory…', 'Summaryception', { timeOut: 4000, progressBar: true });
        const raw = await callSummarizer('(continuity edit)', '', {
            systemPrompt: s.editorSystemPrompt,
            userPrompt: userTpl,
        });
        if (_editorCancelled) {
            toastr.info('Review cancelled — nothing was changed.', 'Summaryception', { timeOut: 2500 });
            return;
        }
        const edits = extractJsonArray(raw);
        if (!edits) {
            toastr.error('Co-Writer did not return valid edits. Try rephrasing, or point the connection at a stronger model.', 'Summaryception', { timeOut: 7000 });
            return;
        }
        if (edits.length === 0) {
            $('#sc_editor_review_list').empty();
            toastr.info('Co-Writer found nothing that needs changing.', 'Summaryception', { timeOut: 5000 });
            return;
        }
        snapshotMemory();   // capture pre-edit state so every Apply can be undone
        renderEditorReview(edits);
    } catch (e) {
        log('Continuity editor error:', e);
        toastr.error('Co-Writer failed — nothing was changed.', 'Summaryception', { timeOut: 5000 });
    } finally {
        $('#sc_editor_cancel').hide();
        _editorCancelled = false;
        btn.prop('disabled', false).text('🔍 Review Proposed Edits');
    }
}

function renderEditorReview(edits) {
    _editorPending = [];
    let cards = '';
    let shown = 0;
    edits.forEach((e, i) => {
        const op = String(e.op || '');
        let head, kind, oldText;
        if (op === 'edit_notepad') {
            _editorPending[i] = { op };
            head = '✏️ Notepad (canon)'; kind = 'edit'; oldText = getChatStore().notepad || '';
        } else if (['edit_snippet', 'delete_snippet', 'edit_detail', 'delete_detail'].includes(op)) {
            const r = resolveSnippetId(e.id);
            if (!r) return;   // id doesn't exist — skip this edit
            _editorPending[i] = { op, ref: r };
            if (op === 'edit_snippet')       { head = `✏️ Snippet ${e.id}`;   kind = 'edit';   oldText = r.obj.text || ''; }
            else if (op === 'delete_snippet'){ head = `🗑️ Snippet ${e.id}`;   kind = 'delete'; oldText = r.obj.text || ''; }
            else if (op === 'edit_detail')   { head = `✏️ Detail on ${e.id}`; kind = 'edit';   oldText = r.obj.detail || ''; }
            else                             { head = `🗑️ Detail on ${e.id}`; kind = 'delete'; oldText = r.obj.detail || ''; }
        } else { return; }   // unknown op — skip
        shown++;
        const reason = e.reason ? `<div class="sc-editor-reason">${escapeHtml(String(e.reason))}</div>` : '';
        const oldBlock = `<div class="sc-editor-old">was: ${escapeHtml(oldText.slice(0, 240))}${oldText.length > 240 ? '…' : ''}</div>`;
        const body = kind === 'edit'
            ? oldBlock + `<textarea class="sc-editor-new text_pole" data-idx="${i}" rows="3">${escapeHtml(String(e.text || ''))}</textarea>`
            : oldBlock;
        cards += `<div class="sc-editor-card ${kind === 'delete' ? 'sc-editor-card-del' : ''}" data-idx="${i}">
            <div class="sc-editor-head">${head}</div>
            ${reason}
            ${body}
            <div class="sc-editor-btns">
                <button class="sc-editor-apply menu_button" data-idx="${i}">${kind === 'delete' ? 'Apply (delete)' : 'Apply'}</button>
                <button class="sc-editor-reject menu_button" data-idx="${i}">Reject</button>
            </div>
        </div>`;
    });
    const header = `<div class="sc-editor-actions"><button id="sc_editor_applyall" class="menu_button">✅ Apply All (${shown})</button></div>`;
    $('#sc_editor_review_list').html(shown ? header + cards : '<div class="sc-hint">No applicable edits — the proposed ids weren\'t found in memory.</div>');
}

async function applyEditorOp(i) {
    const pend = _editorPending[i];
    if (!pend) return false;
    const store = getChatStore();
    const card = $(`.sc-editor-card[data-idx="${i}"]`);
    const newVal = String(card.find('.sc-editor-new').val() ?? '').trim();
    if (pend.op === 'edit_notepad') {
        store.notepad = newVal;
        _syncNotepadUi(newVal);
    } else if (pend.ref) {
        const { obj, arr } = pend.ref;   // object reference — stable across splices
        if (pend.op === 'edit_snippet') { if (newVal) obj.text = newVal; }
        else if (pend.op === 'edit_detail') { if (newVal) obj.detail = newVal; else delete obj.detail; }
        else if (pend.op === 'delete_detail') { delete obj.detail; }
        else if (pend.op === 'delete_snippet') { const k = arr.indexOf(obj); if (k >= 0) arr.splice(k, 1); }
    }
    recomputeSummarizedUpTo();
    await saveChatStore();
    updateInjection(true);
    return true;
}

async function finalizeAfterApply() {
    updateUI();
    if (typeof updateSnippetBrowser === 'function') updateSnippetBrowser();
    $('#sc_editor_undo').show();
}

// ─── Copilot Bridge: mirror memory into the Author's Note ─────────────
// External OOC tools (e.g. ST-Copilot) can't read Summaryception's memory
// directly — they only read native fields. The Author's Note is the one native
// field that's meant to be written programmatically and that such tools read.
// So we can copy the FULL memory (notepad + snippets + details) into it on
// demand, and pull it back out — stashing any real Author's Note content in a
// non-injected place so nothing is lost or permanently duplicated.
const SC_AN_START = '[SUMMARYCEPTION MEMORY';
const SC_AN_END = '[END SUMMARYCEPTION MEMORY]';

function formatMemoryForAN() {
    const dump = buildMemoryDump();
    // Slim mirror: only the parts Copilot's native Summaryception integration does NOT
    // read. That integration already feeds Copilot the snippet TEXT automatically, but it
    // never reads the notepad or the detail notes — so we bridge exactly those two.
    let out = `${SC_AN_START} (canon + key details) — for OOC analysis tools. NOTE: the running event snippets are already provided to you separately via the Summaryception integration; this block adds only what that integration omits: permanent canon and the specifics behind key events. Treat as canon, NOT as roleplay direction.]\n\n`;
    out += `NOTEPAD (permanent canon — highest authority):\n${dump.notepad && dump.notepad.trim() ? dump.notepad.trim() : '(empty)'}\n\n`;
    const withDetails = dump.snippets.filter(s => s.detail);
    if (withDetails.length) {
        out += `KEY DETAILS (specifics attached to particular events; the event summaries themselves are already in your <summary_context>):\n`;
        for (const s of withDetails) {
            const turns = s.turns ? ` (turns ${s.turns})` : '';
            out += `- [${s.id}${turns}] ${s.text} — DETAIL: ${s.detail}\n`;
        }
    }
    out += `\n${SC_AN_END}`;
    return out;
}

function _getAuthorsNote() {
    const ctx = SillyTavern.getContext();
    return (ctx.chatMetadata && ctx.chatMetadata.note_prompt) || '';
}

function _setAuthorsNote(text) {
    const ctx = SillyTavern.getContext();
    if (ctx.chatMetadata) {
        ctx.chatMetadata.note_prompt = text;
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
    }
    // keep the on-screen Author's Note textarea in sync if it's rendered
    const $an = $('#extension_floating_prompt');
    if ($an.length) { $an.val(text).trigger('input'); }
}

async function mirrorMemoryToAN() {
    const store = getChatStore();
    const current = _getAuthorsNote();
    // stash the REAL author's note (non-injected storage) only if it isn't already our block
    if (!current.includes(SC_AN_START)) {
        store.anStash = current;
        await saveChatStore();
    }
    _setAuthorsNote(formatMemoryForAN());
    toastr.success("Full memory mirrored to the Author's Note. Ask Copilot now — then hit Restore.", 'Summaryception', { timeOut: 5000 });
}

async function restoreAuthorsNoteFromStash() {
    const store = getChatStore();
    const stashed = store.anStash != null ? store.anStash : '';
    _setAuthorsNote(stashed);
    delete store.anStash;
    await saveChatStore();
    toastr.info(stashed.trim() ? "Author's Note restored." : "Author's Note cleared (nothing was there before).", 'Summaryception', { timeOut: 3000 });
}

async function clearAuthorsNoteHard() {
    const store = getChatStore();
    _setAuthorsNote('');
    delete store.anStash;
    await saveChatStore();
    toastr.info("Author's Note wiped.", 'Summaryception', { timeOut: 2500 });
}

// ─── Pinned Memories ──────────────────────────────────────────────────
// ── Pin provenance ──────────────────────────────────────────────────
// Pins are injected VERBATIM every turn, so a pin whose source turn was branched
// away kept narrating a timeline that no longer exists — prose from the future
// injected forever, with nothing trimming it. mesId cannot gate this: it records
// when the pin was CREATED (last message index at pin time), not where the quoted
// text LIVES. The honest rule is provenance: a pin injects only while its text
// still exists in the current chat. srcIdx caches where; null declares a FREE pin
// (the selection was never chat text — decidable only at creation) that injects
// unconditionally; -1 marks an orphan (source text gone from this branch): shown
// in the panel, excluded from injection, revived automatically if a later branch
// brings the text back (every liveness miss rescans).
function _pinNeedle(pin) {
    let x = String((pin && pin.excerpt) || '');
    if (x.endsWith('\u2026')) x = x.slice(0, -1);   // addPin appends … when a long selection is truncated — the stored excerpt is then a PREFIX of the source
    return x;
}
function _findPinSource(pin, chat) {
    const needle = _pinNeedle(pin);
    if (!needle || !Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {   // newest-first: a repeated quote resolves to its latest occurrence
        const m = chat[i];
        if (m && typeof m.mes === 'string' && m.mes.includes(needle)) return i;
    }
    return -1;
}
function _pinAlive(pin, chat) {
    if (!pin) return false;
    if (pin.srcIdx === null) return true;   // free pin — timeline-independent by declaration at creation
    const idx = (typeof pin.srcIdx === 'number' && pin.srcIdx >= 0) ? pin.srcIdx : -1;
    if (idx >= 0 && Array.isArray(chat) && chat[idx] && typeof chat[idx].mes === 'string' && chat[idx].mes.includes(_pinNeedle(pin))) return true;
    // Cache miss: source deleted, shifted by a deletion, edited, or a legacy pin
    // (no srcIdx) resolving for the first time. One rescan settles all of them.
    pin.srcIdx = _findPinSource(pin, chat);
    return pin.srcIdx >= 0;
}

function getPins() { const st=getChatStore(); if(!Array.isArray(st.pins)) st.pins=[]; return st.pins; }

async function addPin(label) {
    const s=getSettings(); const { chat }=SillyTavern.getContext();
    let excerpt='';
    try { const sel=window.getSelection && String(window.getSelection()); if(sel && sel.trim().length>2) excerpt=sel.trim(); } catch(e){}
    if(!excerpt){
        for(let i=(chat?.length||0)-1;i>=0;i--){ const m=chat[i]; if(m && m.mes && m.mes.trim() && !m.is_system){ excerpt=m.mes.trim(); break; } }
    }
    if(!excerpt){ toastr.warning('Nothing to pin.','Summaryception'); return; }
    const cap=s.pinMaxChars??1500; if(excerpt.length>cap) excerpt=excerpt.slice(0,cap)+'…';
    const _src = _findPinSource({ excerpt }, chat);
    // Found: quote text, gated on liveness. Not found: the selection was never chat
    // text — a FREE pin (null), injected unconditionally. Only creation can tell
    // these apart; later, "absent from chat" is indistinguishable from "branched away".
    getPins().push({ id:'pin_'+Date.now(), mesId:(chat?.length||1)-1, srcIdx: (_src >= 0 ? _src : null), excerpt, label:(label||'').trim(), createdAt:Date.now() });
    await saveChatStore(); updateInjection(true); renderPins();
    toastr.success('Pinned ('+excerpt.length+' chars)','Summaryception',{timeOut:2000});
}

function renderPins() {
    const el=$('#sc_pins_list'); if(!el.length) return;
    const pins=getPins();
    if(pins.length===0){ el.html('<div class="sc-hint">No pins yet. Select text (or nothing = last message) and pin it — pins are injected verbatim every turn, immune to summarization.</div>'); return; }
    const { chat }=SillyTavern.getContext();
    let total=0, html='';
    for(const p of pins){ const alive=_pinAlive(p, chat); if(alive) total+=p.excerpt.length;
        html+='<div class="sc-pin-item'+(alive?'':' sc-pin-orphan')+'" data-id="'+p.id+'"'+(alive?'':' style="opacity:.55" title="Source text no longer exists in this branch — not injected. Unpin it, or re-pin from live text; it revives by itself if a branch brings the text back."')+'><span class="sc-pin-label">'+(alive?'📌 ':'⚠️ ')+escapeHtml(p.label||('msg #'+p.mesId))+' <small>('+(alive?p.excerpt.length+' ch':'orphaned')+')</small></span><span class="sc-pin-text"'+(alive?'':' style="text-decoration:line-through"')+'>'+escapeHtml(p.excerpt.slice(0,160))+(p.excerpt.length>160?'…':'')+'</span><button class="sc-pin-unpin menu_button fa-solid fa-xmark" title="Unpin"></button></div>';
    }
    html+='<div class="sc-hint">Total: '+total+' chars (cap '+(getSettings().pinsMaxTotalChars??6000)+')</div>';
    el.html(html);
}

function buildPinnedBlock() {
    const s=getSettings(); const pins=getPins(); if(pins.length===0) return '';
    const { chat }=SillyTavern.getContext();
    const cap=s.pinsMaxTotalChars??6000; let used=0; const parts=[];
    for(let i=pins.length-1;i>=0;i--){ const p=pins[i];   // newest kept first under cap
        if(!_pinAlive(p, chat)) continue;   // source text not in THIS branch — a quote from an abandoned timeline must not narrate this one
        if(used+p.excerpt.length>cap){ log('Pins over cap — oldest pins truncated from injection.'); break; }
        used+=p.excerpt.length; parts.unshift((p.label?('['+p.label+'] '):'')+p.excerpt);
    }
    return parts.length? '\n\n<pinned>\n'+parts.join('\n---\n')+'\n</pinned>\n' : '';
}

// ─── Verbatim Recall ─────────────────────────────────────────────────
let _recallRemaining=0; let _lastRecallText='';

function _mergeRanges(ranges, chatLen){
    const cl=ranges.map(([a,b])=>[Math.max(0,a),Math.min(chatLen-1,b)]).filter(([a,b])=>b>=a);
    cl.sort((x,y)=>x[0]-y[0]);
    const out=[]; for(const r of cl){ if(out.length && r[0]<=out[out.length-1][1]+1){ out[out.length-1][1]=Math.max(out[out.length-1][1],r[1]); } else out.push([...r]); }
    return out;
}

function clearRecall(){
    try{ const {setExtensionPrompt}=SillyTavern.getContext(); const s=getSettings();
        setExtensionPrompt(MODULE_NAME+'_recall','',s.recallPosition??1,s.recallDepth??6,false,s.recallRole??0);
    }catch(e){}
    _recallRemaining=0;
}

async function runRecall(query, opts = {}){
    query=(query||'').trim(); if(!query){ if(!opts.silent) toastr.warning('Give the recall a query.','Summaryception'); return; }
    // Recall's selection step is a real callSummarizer call — the SEVENTH pass on the
    // channel, and the last one that was still gating on a private flag. Auto-recall
    // fires on GENERATION_ENDED, the same instant the summarizer and ledger scribe
    // fire, so with recallAuto on it would run a concurrent call and interleave
    // SillyTavern's prompt-toggle snapshot/restore. Auto simply skips (it re-runs
    // next turn); a manual /sc-recall says why.
    if (_llmChannelBusy()) {
        if (opts.silent) { log('auto-recall: channel busy — skipping this turn.'); return; }
        toastr.info('A background pass is finishing — try the recall again in a few seconds.','Summaryception',{timeOut:3500});
        return;
    }
    const s=getSettings(); const { chat }=SillyTavern.getContext();
    const dump=buildMemoryDump();
    if(!dump.snippets.length){ if(!opts.silent) toastr.info('No memory snippets to recall from yet.','Summaryception'); return; }
    const k=s.recallMaxSnippets??4;
    const catalog=JSON.stringify(dump.snippets.map(x=>({id:x.id,text:x.text,detail:x.detail?String(x.detail).split('\n')[0]:undefined})));
    const sys=(s.recallSystemPrompt||'').replace('{{k}}',String(k));
    const user='QUERY: '+query+'\n\nCATALOG:\n'+catalog+'\n\nReturn ONLY the JSON array of ids.';
    let ids=null;
    for(let attempt=0;attempt<2 && !ids;attempt++){
        try{ const raw=await callSummarizer('(recall select)','',{systemPrompt:sys,userPrompt:attempt?user+'\nSTRICT JSON ARRAY ONLY.':user,quiet:true});
            const arr=extractJsonArray(raw); if(Array.isArray(arr)) ids=arr.filter(x=>typeof x==='string').slice(0,k);
        }catch(e){ log('recall select failed:',e); }
    }
    if(!ids){ if(!opts.silent) toastr.error('Recall selection failed — model did not return valid ids.','Summaryception'); else log('auto-recall: selection failed'); return; }
    if(!ids.length){ if(!opts.silent) toastr.info('Recall: nothing relevant found for that query.','Summaryception'); return; }
    const ranges=[]; const unrec=[];
    for(const id of ids){ const r=resolveSnippetId(id); if(r && r.obj.turnRange) ranges.push({id,range:r.obj.turnRange}); else unrec.push(id); }
    if(!ranges.length){ if(!opts.silent) toastr.warning('Chosen snippets are unrecallable (legacy).','Summaryception',{timeOut:5000}); return; }
    const merged=_mergeRanges(ranges.map(x=>x.range), chat.length);   // A1: clamp + merge
    let block='[RECALLED SCENES — verbatim from earlier turns]\n'; let used=block.length; const cap=s.recallMaxChars??12000;
    for(const [a,b] of merged){
        const passage=buildPassageFromRange(chat,a,b); if(!passage.trim()) continue;
        const head='\n▸ turns '+a+'–'+b+':\n';
        if(used+head.length+passage.length>cap){ block+='\n▸ turns '+a+'–'+b+': (trimmed — over recall budget)\n'; break; }
        block+=head+passage+'\n'; used+=head.length+passage.length;
    }
    _lastRecallText=block;
    const {setExtensionPrompt}=SillyTavern.getContext();
    setExtensionPrompt(MODULE_NAME+'_recall',block,s.recallPosition??1,s.recallDepth??6,false,s.recallRole??0);
    _recallRemaining=Math.max(1,s.recallPersist??1);
    if(opts.silent){ log('Auto-recall injected: '+merged.length+' range(s), '+used+' chars'); } else toastr.success('Recalled '+merged.length+' scene range(s), '+used+' chars ('+ids.join(', ')+')'+(unrec.length?(' — unrecallable: '+unrec.join(',')):''),'Summaryception',{timeOut:6000});
}

function onGenerationEnded(){
    try { const { chat } = SillyTavern.getContext(); _prevChatLen = Array.isArray(chat) ? chat.length : _prevChatLen; } catch (_) {}
    if(_recallRemaining>0){ _recallRemaining--; if(_recallRemaining<=0){ clearRecall(); log('Recall injection cleared (ephemeral).'); } }
    // Auto-recall: background, never blocks. Uses YOUR latest message as the query
    // and stages the recalled scene for your NEXT reply (one-turn continuity window).
    const s=getSettings();
    if(s.recallAuto && s.enabled && !_llmChannelBusy()){
        const { chat }=SillyTavern.getContext(); let q='';
        for(let i=(chat?.length||0)-1;i>=0;i--){ const m=chat[i]; if(m?.is_user && m.mes?.trim()){ q=m.mes.trim().slice(0,400); break; } }
        if(q.length>10){ _autoRecallBusy=true; runRecall(q,{silent:true}).catch(e=>log('auto-recall failed:',e)).finally(()=>{ _autoRecallBusy=false; }); }
    }
}

function bindUIEvents() {
    $(document).on('change', '#sc_enabled', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $(document).on('change', '#sc_pause_summarization', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: 5000 }
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: 3000 }
            );
        }
    });

    $(document).on('change', '#sc_disable_ghosting', function () {
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();

        if ($(this).prop('checked')) {
            toastr.info(
                'Message hiding disabled. Summarized messages will remain visible but still be excluded from LLM context via the sc_ghosted flag.',
                'Summaryception',
                { timeOut: 5000 }
            );
        }
    });

    $(document).on('input', '#sc_summarizer_response_length', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $(document).on('change', '#sc_strip_patterns', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });

    $(document).on('change', '#sc_input_strip_tags', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().inputStripTags = lines;
        saveSettings();
    });

    $(document).on('change', '#sc_input_strip_headers', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().inputStripHeaders = lines;
        saveSettings();
    });

    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        { id: '#sc_turns_per_summary', key: 'turnsPerSummary', display: '#sc_turns_per_summary_val' },
        { id: '#sc_snippets_per_layer', key: 'snippetsPerLayer', display: '#sc_snippets_per_layer_val' },
        { id: '#sc_snippets_per_promotion', key: 'snippetsPerPromotion', display: '#sc_snippets_per_promotion_val' },
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
        { id: '#sc_ledger_active_window', key: 'ledgerActiveWindow', display: '#sc_ledger_active_window_val' },
        { id: '#sc_ledger_max_active', key: 'ledgerMaxActive', display: '#sc_ledger_max_active_val' },
        { id: '#sc_ledger_max_chars', key: 'ledgerMaxCharsPerChar', display: '#sc_ledger_max_chars_val' },
        { id: '#sc_ledger_live_every', key: 'ledgerLiveEveryTurns', display: '#sc_ledger_live_every_val' },
        { id: '#sc_ledger_roster_max', key: 'ledgerRosterMax', display: '#sc_ledger_roster_max_val' },
    ];

    for (const sl of sliders) {
        $(document).on('input', sl.id, function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val;
            $(sl.display).text(val);
            saveSettings();
            updateInjection();
        });
    }

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(document).on('change', ta.id, function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
        });
    }

    // ── Injection placement controls ──
    $(document).on('change', '#sc_injection_position', function () {
        getSettings().injectionPosition = parseInt($(this).val(), 10);
        saveSettings();
        updateInjection(true);
    });
    $(document).on('input', '#sc_injection_depth', function () {
        const val = parseInt($(this).val(), 10);
        getSettings().injectionDepth = val;
        $('#sc_injection_depth_val').text(val);
        saveSettings();
        updateInjection(true);
    });

    // ── Injection contents (which sections are actually sent) ──
    const injectToggles = [
        ['#sc_inject_notepad', 'injectNotepad'],
        ['#sc_inject_pinned',  'injectPinned'],
        ['#sc_inject_ledger',  'injectLedger'],
        ['#sc_inject_summary', 'injectSummary'],
        ['#sc_inject_details', 'injectDetails'],
    ];
    for (const [id, key] of injectToggles) {
        $(document).on('change', id, function () {
            getSettings()[key] = $(this).prop('checked');
            saveSettings();
            updateInjection(true);
        });
    }

    // ── Manual notepad (per-chat, live) ──
    $(document).on('input', '#sc_notepad', function () {
        getChatStore().notepad = $(this).val();
        saveChatStore();
        updateInjection(true);
        const $fs = $('#sc_notepad_fs_text');
        if ($fs.length && $fs.val() !== $(this).val()) { $fs.val($(this).val()); $('#sc_notepad_fs_count').text(String($(this).val()).length + ' ch'); }   // panel edits mirror into an open editor
    });

    // ── Notepad full-screen editor ──
    // One store, one pipeline: the editor writes THROUGH #sc_notepad's input
    // handler (val + trigger), so persistence, injection refresh, and any future
    // notepad side effects live in exactly one place. Exiting never discards —
    // every keystroke is already saved; ⤡ and ✕ both simply return to the panel.
    $(document).on('click', '#sc_notepad_fullscreen', function () {
        if ($('#sc_notepad_fs').length) return;   // already open
        const cur = String(getChatStore().notepad || '');
        const $ov = $(
            '<div id="sc_notepad_fs" class="sc-notepad-fs-overlay">'
            + '<div class="sc-notepad-fs-head">'
            + '<span class="sc-notepad-fs-title">📝 Manual Notepad (this chat)</span>'
            + '<span class="sc-notepad-fs-count" id="sc_notepad_fs_count"></span>'
            + '<button id="sc_notepad_fs_min" class="menu_button" title="Back to the normal panel view — your text is already saved">⤡ Default</button>'
            + '<button id="sc_notepad_fs_close" class="menu_button" title="Close — your text is already saved">✕</button>'
            + '</div>'
            + '<textarea id="sc_notepad_fs_text" class="sc-notepad-fs-text" placeholder="Lore this story must never forget — e.g. character names & canon, world rules, locations, ongoing plot facts."></textarea>'
            + '</div>'
        );
        $('body').append($ov);
        const $t = $('#sc_notepad_fs_text');
        $t.val(cur);
        $('#sc_notepad_fs_count').text(cur.length + ' ch');
        $t.trigger('focus');
    });
    function _closeNotepadFs() { $('#sc_notepad_fs').remove(); }
    window._closeNotepadFs = _closeNotepadFs;   // onChatChanged closes an open editor — its text belongs to the chat being left
    $(document).on('click', '#sc_notepad_fs_min, #sc_notepad_fs_close', _closeNotepadFs);
    $(document).on('keydown', function (e) { if (e.key === 'Escape' && $('#sc_notepad_fs').length) _closeNotepadFs(); });
    $(document).on('input', '#sc_notepad_fs_text', function () {
        const v = $(this).val();
        $('#sc_notepad_fs_count').text(v.length + ' ch');
        $('#sc_notepad').val(v).trigger('input');   // the one pipeline: store + save + injection + mirror-guard
    });

    // ── Detail Auditor (sister) ──
    $(document).on('change', '#sc_sister_enabled', function () {
        getSettings().sisterEnabled = $(this).prop('checked');
        saveSettings();
        updateInjection(true);
    });
    $(document).on('input', '#sc_sister_system_prompt', function () {
        getSettings().sisterSystemPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('input', '#sc_sister_user_prompt', function () {
        getSettings().sisterUserPrompt = $(this).val();
        saveSettings();
    });

    // ── Character Ledger (psychologist) ──
    $(document).on('change', '#sc_ledger_enabled', function () {
        getSettings().ledgerEnabled = $(this).prop('checked');
        saveSettings();
        updateInjection(true);
    });
    $(document).on('change', '#sc_ledger_live', function () {
        getSettings().ledgerLiveUpdate = $(this).prop('checked');
        saveSettings();
    });
    $(document).on('change', '#sc_ledger_roster', function () {
        getSettings().ledgerInjectRoster = $(this).prop('checked');
        saveSettings();
        updateInjection(true);
    });
    $(document).on('change', '#sc_ledger_roster_rotate', function () {
        getSettings().ledgerRosterRotate = $(this).prop('checked');
        saveSettings();
        updateInjection(true);
    });
    $(document).on('change', '#sc_ledger_auto_rewind', function () {
        getSettings().ledgerAutoRewind = $(this).prop('checked');
        saveSettings();
    });
    $(document).on('input', '#sc_ledger_system_prompt', function () {
        getSettings().ledgerSystemPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('input', '#sc_ledger_user_prompt', function () {
        getSettings().ledgerUserPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('click', '.sc-ledger-del', function () {
        const idx = $(this).closest('.sc-ledger-card').data('idx');
        const name = _ledgerOrder[idx];
        if (name === undefined || name === null) return;
        const store = getChatStore();
        if (store.ledger && Object.prototype.hasOwnProperty.call(store.ledger, name)) {
            const _e = store.ledger[name];
            delete store.ledger[name];
            // Journal the deletion. Without a tombstone the very next fold (one
            // message deletion was enough) resurrected the character in full.
            if (Array.isArray(store.ledgerNotes)) {
                let _t = (typeof store.ledgerLiveIdx === 'number' && store.ledgerLiveIdx >= 0) ? store.ledgerLiveIdx : 0;
                if (_e && typeof _e._t === 'number' && _e._t > _t) _t = _e._t;
                store.ledgerNotes.push({ t: _t, name, at: Date.now(), gone: true });
            }
            // dropping a character also drops any pin on them, so no orphan pins linger
            const pins = getLedgerPins();
            const pi = pins.findIndex(p => String(p).toLowerCase() === String(name).toLowerCase());
            if (pi >= 0) pins.splice(pi, 1);
            saveChatStore();
            updateInjection(true);
            renderLedger();
        }
    });
    $(document).on('click', '.sc-ledger-pin', function () {
        const idx = $(this).closest('.sc-ledger-card').data('idx');
        toggleLedgerPin(_ledgerOrder[idx]);
    });
    $(document).on('click', '#sc_ledger_clear', async function () {
        if (!confirm('Clear the entire character ledger for THIS chat?\n\nThis removes all recorded character nature, current state, arc, and open threads. It rebuilds automatically as the story continues.')) return;
        const store = getChatStore();
        store.ledger = {};
        // New era: all existing snapshots become invisible to this chat — a later
        // auto-rewind must never restore the ledger the user just rejected. (They are
        // not deleted: sibling branches share the checkpoint keyspace and keep the
        // era they branched at.) In-flight jobs and staged rebuilds are from the old
        // era too — invalidate them.
        store.ledgerEra = (store.ledgerEra | 0) + 1;
        store._ckptLast = -1;
        store.ledgerRebuild = null;
        store.ledgerStaging = null;
        store.ledgerStagingNotes = null;
        _ledgerQueue = [];
        _ledgerGen++;
        await saveChatStore();
        updateInjection(true);
        renderLedger();
        toastr.success('Character ledger cleared for this chat. Old snapshots retired — rebuilt ones start a fresh era.', 'Summaryception', { timeOut: 3500 });
    });

    $(document).on('click', '#sc_ledger_now', function () {
        const s = getSettings();
        if (!s.ledgerEnabled) { toastr.info('Enable the Character Ledger first.', 'Summaryception', { timeOut: 3000 }); return; }
        const r = queueLiveLedgerUpdate({ manual: true });
        if (r === true) toastr.info('Reading the latest turn(s) into the ledger — you\'ll get a toast when it lands (or if it fails).', 'Summaryception', { timeOut: 3000 });
        else if (r === 'busy') { _armLiveRetry(); toastr.info('Still working on the previous pass — the update runs the moment it finishes.', 'Summaryception', { timeOut: 3500 }); }
        else toastr.success('Ledger is already current with the latest turn.', 'Summaryception', { timeOut: 2500 });
    });

    $(document).on('click', '.sc-ledger-hist', function () {
        const name = $(this).closest('.sc-ledger-card').find('.sc-ledger-name').text();
        if (!name) return;
        if (_histOpen.has(name)) _histOpen.delete(name); else _histOpen.add(name);
        try { renderLedger(); } catch (_) {}
    });

    $(document).on('click', '#sc_ledger_audit', async function () {
        const s = getSettings();
        if (!s.ledgerEnabled) { toastr.info('Enable the Character Ledger first.', 'Summaryception', { timeOut: 3000 }); return; }
        const $b = $(this);
        $b.prop('disabled', true);
        try {
            const r = await auditLedgerEntries({ manual: true });
            if (r === 'busy') { _armAuditRetry(); toastr.info('Busy right now — the audit runs automatically the moment current work finishes.', 'Summaryception', { timeOut: 3500 }); }
        } finally { $b.prop('disabled', false); }
    });

    // ── Backfill / Maintenance ──
    $(document).on('click', '#sc_ledger_build', function () { backfillLedgerFromHistory(); });
    $(document).on('click', '#sc_audit_all', function () { backfillAuditsForLayer0(); });
    // ── Continuity Auditor UI ──
    $(document).on('click', '#sc_continuity_recheck', function () { backfillContinuityForLayer0(); });
    $(document).on('click', '#sc_continuity_applyall', function () { applyAllContinuityFixes(); });
    $(document).on('click', '#sc_continuity_view .sc-cf-apply', async function () {
        const id = $(this).data('id'); if (!id) return;
        $(this).prop('disabled', true).text('Applying…');
        try { const ok = await applyContinuityFix(String(id)); if (!ok) toastr.info('Nothing to change, or source-level (left for the copilot).', 'Summaryception', { timeOut: 3500 }); }
        finally { try { renderContinuity(); } catch (_) {} }
    });
    $(document).on('click', '#sc_continuity_view .sc-cf-dismiss', async function () {
        const id = $(this).data('id'); if (!id) return;
        try { await dismissContinuityFlag(String(id)); } finally { try { renderContinuity(); } catch (_) {} }
    });
    $(document).on('change', '#sc_continuity_enabled', function () { getSettings().continuityEnabled = $(this).prop('checked'); saveSettings(); });
    $(document).on('change', '#sc_continuity_autofix', function () { getSettings().continuityAutoFix = $(this).prop('checked'); saveSettings(); });
    $(document).on('change', '#sc_continuity_nudge', function () { getSettings().continuityNudge = $(this).prop('checked'); saveSettings(); updateInjection(true); });
    $(document).on('input', '#sc_continuity_nudge_max', function () { const v = parseInt($(this).val(), 10) || 6; getSettings().continuityNudgeMax = v; $('#sc_continuity_nudge_max_val').text(v); saveSettings(); });
    $(document).on('change', '#sc_continuity_system_prompt', function () { getSettings().continuitySystemPrompt = $(this).val(); saveSettings(); });
    $(document).on('change', '#sc_continuity_user_prompt', function () { getSettings().continuityUserPrompt = $(this).val(); saveSettings(); });
    $(document).on('change', '#sc_continuity_fix_system_prompt', function () { getSettings().continuityFixSystemPrompt = $(this).val(); saveSettings(); });
    $(document).on('change', '#sc_continuity_fix_user_prompt', function () { getSettings().continuityFixUserPrompt = $(this).val(); saveSettings(); });

    // ── Continuity Editor (Co-Writer / Master Novelist) ──
    $(document).on('click', '#sc_editor_review', runContinuityEditorReview);
    $(document).on('click', '#sc_editor_undo', restoreMemorySnapshot);
    $(document).on('click', '#sc_editor_cancel', function () {
        _editorCancelled = true;
        abortSummarization();
        toastr.info('Cancelling the co-writer…', 'Summaryception', { timeOut: 1500 });
    });

    // ── Copilot Bridge (Author's Note) ──
    $(document).on('click', '#sc_mirror_an', mirrorMemoryToAN);
    $(document).on('click', '#sc_restore_an', restoreAuthorsNoteFromStash);
    $(document).on('click', '#sc_clear_an', clearAuthorsNoteHard);
    $(document).on('input', '#sc_editor_system_prompt', function () {
        getSettings().editorSystemPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('input', '#sc_editor_user_prompt', function () {
        getSettings().editorUserPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('click', '.sc-editor-apply', async function () {
        const i = parseInt($(this).data('idx'), 10);
        const ok = await applyEditorOp(i);
        if (ok) {
            $(`.sc-editor-card[data-idx="${i}"]`).slideUp(120, function () { $(this).remove(); });
            await finalizeAfterApply();
            toastr.success('Applied', 'Summaryception', { timeOut: 1200 });
        }
    });
    $(document).on('click', '.sc-editor-reject', function () {
        const i = parseInt($(this).data('idx'), 10);
        $(`.sc-editor-card[data-idx="${i}"]`).slideUp(120, function () { $(this).remove(); });
    });
    $(document).on('click', '#sc_editor_applyall', async function () {
        const btn = $(this);
        btn.prop('disabled', true).text('Applying…');
        const order = [];
        _editorPending.forEach((p, i) => { if (p) order.push(i); });
        // apply deletes last (object refs keep this safe; this is just tidy ordering)
        order.sort((a, b) => (/^delete_/.test((_editorPending[a] || {}).op) ? 1 : 0) - (/^delete_/.test((_editorPending[b] || {}).op) ? 1 : 0));
        let n = 0;
        for (const i of order) {
            if ($(`.sc-editor-card[data-idx="${i}"]`).length === 0) continue;   // skip rejected
            const ok = await applyEditorOp(i);
            if (ok) n++;
        }
        await finalizeAfterApply();
        $('#sc_editor_review_list').empty();
        toastr.success(`Applied ${n} edit(s)`, 'Summaryception', { timeOut: 2500 });
        btn.prop('disabled', false).text('✅ Apply All');
    });

    // ── Universal "Reset to Default" for prompt/template fields ──
    // Restores the field to the shipped default (the current best-known version),
    // saves it, and re-runs the field's own input handler so everything downstream
    // (preset detection, injection refresh) stays consistent.
    $(document).on('click', '.sc-prompt-reset', function () {
        const key = $(this).data('key');
        const target = $(this).data('target');
        if (!Object.hasOwn(defaultSettings, key)) return;
        getSettings()[key] = defaultSettings[key];
        saveSettings();
        $(target).val(defaultSettings[key]).trigger('input');
        toastr.success('Reset to default', 'Summaryception', { timeOut: 1500 });
    });

    // ── Pins + Recall ──
    $(document).on('click', '#sc_pin_add', () => addPin($('#sc_pin_label').val()||''));
    $(document).on('click', '.sc-pin-unpin', async function(){
        const id=$(this).closest('.sc-pin-item').data('id');
        const pins=getPins(); const i=pins.findIndex(p=>p.id===id);
        if(i>=0){ pins.splice(i,1); await saveChatStore(); updateInjection(true); renderPins(); }
    });
    $(document).on('click', '#sc_recall_go', () => runRecall($('#sc_recall_query').val()));
    $(document).on('click', '#sc_recall_clear', () => { clearRecall(); toastr.info('Recall cleared.','Summaryception',{timeOut:1500}); });
    $(document).on('click', '#sc_recall_to_notepad', async () => {
        if(!_lastRecallText){ toastr.warning('Nothing recalled yet.','Summaryception'); return; }
        const st=getChatStore(); st.notepad=(st.notepad?st.notepad+'\n\n':'')+_lastRecallText;
        await saveChatStore(); _syncNotepadUi(st.notepad); updateInjection(true);
        toastr.success('Recall appended to Notepad (permanent).','Summaryception');
    });
    $(document).on('input', '#sc_recall_k', function(){ getSettings().recallMaxSnippets=parseInt($(this).val())||4; saveSettings(); });
    $(document).on('change', '#sc_recall_auto', function(){ getSettings().recallAuto=$(this).prop('checked'); saveSettings(); if(!$(this).prop('checked')) clearRecall(); });
    $(document).on('input', '#sc_recall_persist', function(){ getSettings().recallPersist=parseInt($(this).val())||1; saveSettings(); });

    $(document).on('change', '#sc_debug_mode', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_trace_mode', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('click', '#sc_repair', async function () {
        const { chat } = SillyTavern.getContext();
        let repaired = 0;

        const progressToast = toastr.info(
            'Scanning for orphaned messages...',
            'Summaryception — Repair',
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
        );

        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];

            const isStuckHidden = (m.is_system || m.is_hidden)
            && !m.is_user
            && !m.extra?.sc_ghosted
            && m.mes
            && m.mes.trim().length > 0;

            if (isStuckHidden) {
                try {
                    await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, { showOutput: false });
                } catch (e) {
                    log(`Repair: failed to unhide ${i}:`, e);
                }

                m.is_system = false;
                delete m.is_hidden;

                repaired++;

                if (repaired % 5 === 0) {
                    $(progressToast).find('.toast-message').text(
                        `Repairing: found ${repaired} orphaned messages...`
                    );
                }
            }
        }

        toastr.clear(progressToast);

        if (repaired > 0) {
            try {
                const ctx = SillyTavern.getContext();
                if (ctx.saveChat) await ctx.saveChat();
            } catch (e) {
                log('Could not save chat:', e);
            }
            updateUI();
            toastr.success(
                `Repaired ${repaired} orphaned messages. They are now visible to the summarizer again.`,
                'Summaryception',
                { timeOut: 5000 }
            );
        } else {
            toastr.info('No orphaned messages found.', 'Summaryception', { timeOut: 3000 });
        }
    });

    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) return;

        try {
            await unghostAllMessages();
        } catch (e) {
            console.error(LOG_PREFIX, 'Error during unghost (continuing with clear):', e);
            toastr.warning('Some messages could not be unghosted, but memory will still be cleared.', 'Summaryception');
        }

        const store = getChatStore();
        store.layers.length = 0;
        store.summarizedUpTo = -1;
        store.ghostedIndices = [];

        const { chatMetadata } = SillyTavern.getContext();
        chatMetadata[MODULE_NAME] = store;

        await saveChatStore();
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }
        dropBackupsForCurrentChat();
        updateInjection();
        updateUI();
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
    });

    // Rebuild every snippet from the beginning: un-ghost all, clear snippets, re-summarize
    // the whole chat from turn 0. Ledger and notepad are kept.
    $(document).on('click', '#sc_rebuild_snippets', async function () {
        const s = getSettings();
        if (!s.enabled) { toastr.warning('Enable Summaryception first.'); return; }
        if (isSummarizing) { toastr.warning('Already summarizing. Please wait.'); return; }
        if (!confirm('Rebuild ALL snippets from the start?\n\nThis un-ghosts every message, clears the existing snippets, and re-summarizes the whole chat from turn 0. Your character ledger and notepad are kept.')) return;
        $(this).prop('disabled', true).text(' Working…');
        try {
            try { await unghostAllMessages(); } catch (e) { log('rebuild: unghost issue (continuing):', e); }
            const store = getChatStore();
            store.layers.length = 0;
            store.summarizedUpTo = -1;
            store.ghostedIndices = [];
            await saveChatStore();
            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);
            if (visibleTurns.length <= s.verbatimTurns) {
                toastr.info('Snippets cleared — not enough turns beyond the verbatim window to summarize yet.', 'Summaryception', { timeOut: 4000 });
            } else {
                const overflow = visibleTurns.length - s.verbatimTurns;
                toastr.info(`Rebuilding: ${overflow} turn(s) to re-summarize from the start…`, 'Summaryception', { timeOut: 2500 });
                await runCatchup(visibleTurns, overflow);
            }
            updateInjection();
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-arrows-rotate"></i> Rebuild All Snippets');
            updateUI();
        }
    });

    // Clear EVERYTHING Summaryception generated for this chat: snippets, ledger, pins, and
    // continuity flags, and un-ghost all messages. The hand-typed notepad is kept.
    $(document).on('click', '#sc_clear_all', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat?\n\nRemoves snippets, the character ledger, pinned quotes/characters, and continuity flags, and un-ghosts every message. Your hand-typed notepad is kept. This cannot be undone.')) return;
        try { await unghostAllMessages(); } catch (e) { toastr.warning('Some messages could not be unghosted, but memory will still be cleared.', 'Summaryception'); }
        const store = getChatStore();
        store.layers.length = 0;
        store.summarizedUpTo = -1;
        store.ghostedIndices = [];
        store.ledger = {};
        store.ledgerLiveIdx = -1;
        if (Array.isArray(store.ledgerPins)) store.ledgerPins = [];
        if (Array.isArray(store.pins)) store.pins = [];
        store.continuityFlags = [];
        store.continuityDismissed = [];
        store.continuityResolved = [];
        try { _ledgerQueue = []; } catch (_) {}
        const { chatMetadata } = SillyTavern.getContext();
        chatMetadata[MODULE_NAME] = store;
        await saveChatStore();
        try { const ctx = SillyTavern.getContext(); if (ctx.saveChat) await ctx.saveChat(); } catch (e) { log('clear-all: save issue:', e); }
        dropBackupsForCurrentChat();
        updateInjection();
        updateUI();
        try { renderLedger(); } catch (_) {}
        toastr.success('All memory cleared — snippets, ledger, pins, and flags (notepad kept).', 'Summaryception');
    });

    $(document).on('click', '#sc_force_summarize', async function () {
        const s = getSettings();
        if (!s.enabled) {
            toastr.warning('Enable Summaryception first.');
            return;
        }
        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.');
            return;
        }
        if (s.pauseSummarization) {
            log('Force Summarize overrides pause mode.');
        }
        $(this).prop('disabled', true).text(' Working…');
        try {
            catchupDismissed = false;

            const _healed = await healOrphanGhosts();   // rescue snippets-cleared-but-still-hidden turns first
            if (_healed > 0) toastr.info(`Restored ${_healed} orphaned turn(s) to verbatim before summarizing.`, 'Summaryception', { timeOut: 3000 });

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            if (visibleTurns.length <= s.verbatimTurns) {
                toastr.info('Nothing to summarize — visible turns are within the verbatim limit.', 'Summaryception');
                return;
            }

            const overflow = visibleTurns.length - s.verbatimTurns;
            toastr.info(`${overflow} turns to process. Starting...`, 'Summaryception', { timeOut: 2000 });

            await runCatchup(visibleTurns, overflow);
            updateInjection();
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateUI();
        }
    });

    $(document).on('click', '#sc_stop_summarize', function () {
        if (!isSummarizing && !currentAbortController) {
            toastr.info('Nothing is running.', 'Summaryception');
            return;
        }
        abortSummarization();
        toastr.warning('Summarization stopped. Progress has been saved.', 'Summaryception', { timeOut: 4000 });
        $(this).prop('disabled', true);
        setTimeout(() => $(this).prop('disabled', false), 2000);
        updateUI();
    });

    $(document).on('click', '#sc_refresh_preview', () => updateUI());

    $(document).on('click', '#sc_export', function () {
        const store = getChatStore();
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    function _downloadText(name, text, mime) {
        const blob = new Blob([text], { type: mime || 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
    }
    $(document).on('click', '#sc_tp_export', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        const store = getChatStore();
        const { chat } = SillyTavern.getContext();
        const meta = { exportedAt: new Date().toISOString(), turns: Array.isArray(chat) ? chat.length : 0, scVersion: SC_VERSION };
        // The transplant must carry the WHOLE story — including the verbatim
        // window your settings deliberately keep unsummarized in the session.
        // So the export runs an EPHEMERAL pass over that tail: same batching,
        // same prompts, same context as live summarization — but the snippets
        // go into the FILE ONLY. The session is untouched by construction:
        // no layers.push, no summarizedUpTo advance, no ghosting — if your
        // verbatim window is 9, it is still 9 after the export.
        const tailBatches = _exportTailBatches(chat, store.summarizedUpTo, getSettings().turnsPerSummary);
        let tail = [];
        if (tailBatches.length) {
            if (isSummarizing || _llmChannelBusy()) { toastr.info('A background pass is running — try the export again in a few seconds.', 'Summaryception', { timeOut: 3500 }); return; }
            $btn.prop('disabled', true);
            isSummarizing = true;
            toastr.info('Summarizing the last ' + tailBatches.length + ' batch' + (tailBatches.length === 1 ? '' : 'es') + ' of recent turns for the export (your session stays exactly as it is)…', 'Summaryception', { timeOut: 5000, progressBar: true });
            try {
                for (const b of tailBatches) {
                    const storyTxt = buildPassageFromRange(chat, b.passageStart, b.endIdx);
                    if (!storyTxt.trim()) continue;
                    const summary = await callSummarizer(storyTxt, buildFullContext(0));
                    if (!summary) {
                        // A half-true export that LOOKS complete is worse than no export.
                        toastr.error('Summarizer failed on turns ' + b.passageStart + '\u2013' + b.endIdx + ' \u2014 export aborted so you never get a file missing its newest chapter. Try again.', 'Summaryception', { timeOut: 7000 });
                        return;
                    }
                    tail.push({ text: summary, turnRange: [b.passageStart, b.endIdx] });
                }
            } finally { isSummarizing = false; $btn.prop('disabled', false); }
        }
        const view = tail.length
            ? Object.assign({}, store, { layers: [((store.layers && store.layers[0]) || []).concat(tail)].concat(Array.isArray(store.layers) ? store.layers.slice(1) : []) })
            : store;
        const md = buildTransplantExport(view, meta);
        _downloadText('memory_transplant_' + new Date().toISOString().slice(0, 10) + '.md', md);
        toastr.success('Memory transplant exported' + (tail.length ? ' \u2014 including ' + tail.length + ' fresh snippet(s) for the verbatim window (session untouched)' : '') + '. Pair it with the Auditor Brief for an external review.', 'Summaryception', { timeOut: 6000 });
    });
    $(document).on('click', '#sc_tp_brief', async function () {
        try {
            const res = await fetch(new URL('MEMORY_AUDITOR.md', import.meta.url));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            _downloadText('MEMORY_AUDITOR.md', await res.text());
        } catch (e) {
            log('auditor brief fetch failed:', e);
            toastr.error('Could not load MEMORY_AUDITOR.md from the extension folder.', 'Summaryception');
        }
    });
    $(document).on('click', '#sc_tp_import', function () {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.md,.txt,text/markdown,text/plain';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const parsed = parseTransplant(await file.text());
                const nSnip = parsed.snippets.length, nLed = Object.keys(parsed.ledger).length, nPin = parsed.pins.length;
                if (!nSnip && !nLed && !parsed.notepad) { toastr.error('No transplant markers found in that file.', 'Summaryception'); return; }
                if (!confirm('Import memory transplant into THIS chat?\n\nREPLACES: notepad, character ledger, all snippets, all pins, continuity flags.\nKEEPS: your chat messages (nothing is ghosted).\n\nIncoming: ' + nSnip + ' snippet(s), ' + nLed + ' ledger character(s), ' + nPin + ' pin(s)' + (parsed.notepad ? ', notepad' : '') + '.')) return;
                try { await unghostAllMessages(); } catch (_) {}
                const { chat } = SillyTavern.getContext();
                const base = Math.max(0, (Array.isArray(chat) ? chat.length : 1) - 1);
                const store = getChatStore();
                const f = storeFieldsFromTransplant(parsed, base);
                store.notepad = f.notepad;
                store.ledger = f.ledger;
                store.ledgerNotes = f.ledgerNotes;
                store.ledgerNotesFrom = f.ledgerNotesFrom;
                store.ledgerLiveIdx = f.ledgerLiveIdx;
                store.layers = f.layers;
                store.pins = f.pins;
                store.ghostedIndices = [];
                store.continuityFlags = []; store.continuityResolved = []; store.continuityDismissed = [];
                store.ledgerStaging = null; store.ledgerStagingNotes = null; store.ledgerRebuild = null;
                store._ckptLast = -1;
                store.ledgerEra = (store.ledgerEra | 0) + 1;   // checkpoints of the replaced ledger must never restore over the transplant
                recomputeSummarizedUpTo();                     // imported snippets are range-less: this chat's own summarization starts clean
                await saveChatStore();
                try { const ctx = SillyTavern.getContext(); if (ctx.saveChat) await ctx.saveChat(); } catch (_) {}
                updateInjection(true); updateUI();
                try { renderLedger(); renderPins(); _syncNotepadUi(store.notepad); } catch (_) {}
                toastr.success('Transplant imported: ' + nSnip + ' snippet(s), ' + nLed + ' character(s), ' + nPin + ' pin(s). The story continues from here with its memory.', 'Summaryception', { timeOut: 6000 });
            } catch (err) {
                log('transplant import failed:', err);
                toastr.error('Transplant import failed: ' + (err && err.message || err), 'Summaryception');
            }
        };
        input.click();
    });

    $(document).on('click', '#sc_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.layers || !Array.isArray(data.layers)) {
                    toastr.error('Invalid file format.');
                    return;
                }

                const { chat } = SillyTavern.getContext();
                const store = getChatStore();

                await unghostAllMessages();

                store.layers = data.layers;
                store.summarizedUpTo = data.summarizedUpTo ?? -1;
                store.ghostedIndices = data.ghostedIndices || [];
                // Restore the rest of memory too, so export → import is a faithful
                // round-trip (older export files simply omit these — keep current).
                if (typeof data.notepad === 'string') store.notepad = data.notepad;
                if (data.ledger && typeof data.ledger === 'object' && !Array.isArray(data.ledger)) store.ledger = data.ledger;
                if (Array.isArray(data.pins)) store.pins = data.pins;

                if (store.summarizedUpTo >= 0) {
                    await ghostMessagesUpTo(store.summarizedUpTo);
                }

                await saveChatStore();
                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                toastr.success(
                    `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                               'Summaryception',
                               { timeOut: 4000 }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.');
            }
        };
        input.click();
    });

    // ── Prompt Preset dropdown ──
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        // Auto-save custom prompt before switching away
        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            log('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            // Restore the last custom prompt if we have one
            if (s.lastCustomPrompt) {
                $('#sc_summarizer_user_prompt').val(s.lastCustomPrompt);
                s.summarizerUserPrompt = s.lastCustomPrompt;
                log('Restored auto-saved custom prompt');
            }
            $('#sc_custom_prompt_manager').show();
        } else {
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
            $('#sc_custom_prompt_manager').hide();
        }

        saveSettings();
        updateCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $(document).on('input', '#sc_summarizer_user_prompt', function () {
        const currentText = $(this).val();
        const s = getSettings();

        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                // Auto-save before we switch to custom
                s.promptPreset = 'custom';
                s.lastCustomPrompt = currentText;
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                updateCustomPromptSlots();
            }
        } else {
            // Keep lastCustomPrompt in sync while editing in custom mode
            s.lastCustomPrompt = currentText;
        }

        saveSettings();
    });

    // ── Custom Prompt: Save to named slot ──
    $(document).on('click', '#sc_custom_prompt_save', function () {
        const name = $('#sc_custom_prompt_name').val().trim();
        if (!name) {
            toastr.warning('Enter a name for the prompt.', 'Summaryception');
            return;
        }

        const s = getSettings();
        if (!s.savedCustomPrompts) s.savedCustomPrompts = {};

        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to save.', 'Summaryception');
            return;
        }

        const isOverwrite = s.savedCustomPrompts[name];
        s.savedCustomPrompts[name] = promptText;
        saveSettings();

        $('#sc_custom_prompt_name').val('');
        updateCustomPromptSlots();

        toastr.success(
            `Prompt "${name}" ${isOverwrite ? 'updated' : 'saved'}.`,
            'Summaryception',
            { timeOut: 2000 }
        );
    });

    // ── Custom Prompt: Load from named slot ──
    $(document).on('click', '#sc_custom_prompt_load', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to load.', 'Summaryception');
            return;
        }

        const s = getSettings();
        const promptText = s.savedCustomPrompts?.[name];
        if (!promptText) {
            toastr.error(`Prompt "${name}" not found.`, 'Summaryception');
            return;
        }

        $('#sc_summarizer_user_prompt').val(promptText);
        s.summarizerUserPrompt = promptText;
        s.lastCustomPrompt = promptText;
        s.promptPreset = 'custom';
        $('#sc_prompt_preset').val('custom');
        saveSettings();

        toastr.success(`Loaded prompt "${name}".`, 'Summaryception', { timeOut: 2000 });
    });

    // ── Custom Prompt: Delete named slot ──
    $(document).on('click', '#sc_custom_prompt_delete_slot', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to delete.', 'Summaryception');
            return;
        }

        if (!confirm(`Delete saved prompt "${name}"?`)) return;

        const s = getSettings();
        if (s.savedCustomPrompts) {
            delete s.savedCustomPrompts[name];
            saveSettings();
        }

        updateCustomPromptSlots();
        toastr.info(`Prompt "${name}" deleted.`, 'Summaryception', { timeOut: 2000 });
    });

    // ── Custom Prompt: Export as .txt ──
    $(document).on('click', '#sc_custom_prompt_export', function () {
        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to export.', 'Summaryception');
            return;
        }

        const blob = new Blob([promptText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_prompt_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Prompt exported.', 'Summaryception', { timeOut: 2000 });
    });

    // ── Custom Prompt: Import from .txt ──
    $(document).on('click', '#sc_custom_prompt_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.text';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                if (!text.trim()) {
                    toastr.warning('File is empty.', 'Summaryception');
                    return;
                }

                const s = getSettings();
                $('#sc_summarizer_user_prompt').val(text);
                s.summarizerUserPrompt = text;
                s.lastCustomPrompt = text;
                s.promptPreset = 'custom';
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                saveSettings();
                updateCustomPromptSlots();

                toastr.success(
                    `Prompt imported from "${file.name}".`,
                    'Summaryception',
                    { timeOut: 3000 }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.', 'Summaryception');
            }
        };
        input.click();
    });

    $(document).on('click', '#sc_reset_defaults', function () {
        if (!confirm(
            'Reset ALL settings to recommended defaults?\n\n' +
            'This resets every slider, prompt, template, and toggle (summarizer, auditor, ledger, editor, recall, injection) to the best-known defaults.\n' +
            'It will NOT clear your summary memory / character ledger, and NOT touch your connection settings.'
        )) return;

        const s = getSettings();

        // Reset sliders
        s.verbatimTurns = defaultSettings.verbatimTurns;
        s.turnsPerSummary = defaultSettings.turnsPerSummary;
        s.snippetsPerLayer = defaultSettings.snippetsPerLayer;
        s.snippetsPerPromotion = defaultSettings.snippetsPerPromotion;
        s.maxLayers = defaultSettings.maxLayers;

        // Reset prompts
        s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
        s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
        s.promptPreset = defaultSettings.promptPreset;
        s.injectionTemplate = defaultSettings.injectionTemplate;
        s.notepadTemplate = defaultSettings.notepadTemplate;
        s.stripPatterns = [...defaultSettings.stripPatterns];
        s.inputStripTags = [...defaultSettings.inputStripTags];
        s.inputStripHeaders = [...defaultSettings.inputStripHeaders];
        s.ledgerEditRewindDepth = defaultSettings.ledgerEditRewindDepth;
        s.ledgerAuditEnabled = defaultSettings.ledgerAuditEnabled;
        s.ledgerAuditEveryTurns = defaultSettings.ledgerAuditEveryTurns;
        s.ledgerAuditMaxPerRun = defaultSettings.ledgerAuditMaxPerRun;
        s.ledgerAuditEvidenceMsgs = defaultSettings.ledgerAuditEvidenceMsgs;
        s.ledgerAuditEvidenceChars = defaultSettings.ledgerAuditEvidenceChars;
        s.ledgerAuditSystemPrompt = defaultSettings.ledgerAuditSystemPrompt;
        s.ledgerAuditUserPrompt = defaultSettings.ledgerAuditUserPrompt;
        s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

        // Reset Detail Auditor (sister) prompts
        s.sisterEnabled = defaultSettings.sisterEnabled;
        s.sisterSystemPrompt = defaultSettings.sisterSystemPrompt;
        s.sisterUserPrompt = defaultSettings.sisterUserPrompt;
        s.sisterInjectTemplate = defaultSettings.sisterInjectTemplate;

        // Reset Continuity Editor prompts
        s.editorSystemPrompt = defaultSettings.editorSystemPrompt;
        s.editorUserPrompt = defaultSettings.editorUserPrompt;

        // Reset Recall selector prompt
        s.recallSystemPrompt = defaultSettings.recallSystemPrompt;

        // Reset injection-content toggles
        s.injectNotepad = defaultSettings.injectNotepad;
        s.injectPinned = defaultSettings.injectPinned;
        s.injectLedger = defaultSettings.injectLedger;
        s.injectSummary = defaultSettings.injectSummary;
        s.injectDetails = defaultSettings.injectDetails;

        // Reset Character Ledger settings (NOT the ledger data — that is per-chat memory)
        s.ledgerEnabled = defaultSettings.ledgerEnabled;
        s.ledgerSystemPrompt = defaultSettings.ledgerSystemPrompt;
        s.ledgerUserPrompt = defaultSettings.ledgerUserPrompt;
        s.ledgerInjectTemplate = defaultSettings.ledgerInjectTemplate;
        s.ledgerActiveWindow = defaultSettings.ledgerActiveWindow;
        s.ledgerMaxActive = defaultSettings.ledgerMaxActive;
        s.ledgerMaxCharsPerChar = defaultSettings.ledgerMaxCharsPerChar;
        s.ledgerContextMaxChars = defaultSettings.ledgerContextMaxChars;

        // Reset debug
        s.debugMode = defaultSettings.debugMode;
        s.traceMode = defaultSettings.traceMode;

        saveSettings();
        updateInjection(true);
        updateUI();

        toastr.success(
            'All prompts, templates, and tuning reset to recommended defaults. Your memory, character ledger, and connection settings were preserved.',
            'Summaryception',
            { timeOut: 4500 }
        );
    });
}

// ─── Connection Settings UI ──────────────────────────────────────────

function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            save();
            updateConnectionSubPanels(sourceSelect.value);
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, s().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, s().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            s().connectionProfileId = profileSelect.value;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = s().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile: document.getElementById('summaryception_profile_settings'),
        ollama: document.getElementById('summaryception_ollama_settings'),
        openai: document.getElementById('summaryception_openai_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) container.style.display = 'none';
        }, 8000);
    }
}

async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}

// ─── Initialization ──────────────────────────────────────────────────

(async function init() {
    try {
        const {
            eventSource,
            event_types,
            renderExtensionTemplateAsync,
        } = SillyTavern.getContext();

        getSettings();

        // Register core hooks + slash commands FIRST. These are what actually run
        // your memory: injection, summarization, and branch repair. They don't
        // depend on the settings panel, so registering them up front means a panel
        // failure below can never stop them — and there's no window at startup
        // where an early chat event is missed.
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        if (event_types.CHAT_RENAMED) eventSource.on(event_types.CHAT_RENAMED, () => setTimeout(async () => { if (maybeRecoverStore()) { try { await saveChatStore(); } catch (_) {} try { updateInjection(true); updateUI(); } catch (_) {} } }, 300));
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
        if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
        if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
        // MESSAGE_UPDATED is a DISTINCT event, not a fallback: programmatic edits
        // (script/slash flows, other extensions) can fire UPDATED without EDITED.
        // The old else-if shadowed it whenever SWIPED existed — those edits were
        // invisible: no ledger rewind, no snippet recheck, silent stale. The edit
        // pipeline dedupes (Set + min-coalescer), so double-firing is harmless.
        if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, onMessageEdited);
        if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
        else eventSource.on(event_types.MESSAGE_RECEIVED, onGenerationEnded);
        registerSlashCommands();

        try {
            (typeof window !== 'undefined' ? window : globalThis).summaryceptionContinuity = {
                list: () => { try { return JSON.parse(JSON.stringify(getChatStore().continuityFlags || [])); } catch (_) { return []; } },
                resolve: (id) => resolveContinuityFlag(id),
                dismiss: (id) => dismissContinuityFlag(id),
                recheck: () => backfillContinuityForLayer0(),
                recheckMessage: (idx) => { try { const arr = _findSnippetsCovering(getChatStore(), Number(idx)); return Promise.all(arr.map(sn => recheckSnippet(sn))).then(() => arr.length); } catch (_) { return 0; } },
                apply: (id) => applyContinuityFix(id),
                applyAll: () => applyAllContinuityFixes(),
                enable: (on) => { getSettings().continuityEnabled = (on !== false); saveSettings(); return getSettings().continuityEnabled; },
                setAutoFix: (on) => { getSettings().continuityAutoFix = (on !== false); saveSettings(); return getSettings().continuityAutoFix; },
                setNudge: (on) => { getSettings().continuityNudge = (on !== false); saveSettings(); return getSettings().continuityNudge; },
            };
            log('Continuity copilot API ready at window.summaryceptionContinuity (list/resolve/dismiss/recheck).');
        } catch (_) {}
        eventSource.on(event_types.APP_READY, () => {
            migratePrompts();
            try { patchLedgerPrompt(); } catch (_) {}
            try { gcLocalStorageBudget(); } catch (_) {}   // bounded checkpoint/backup footprint — quota death silently breaks checkpointing
            updateInjection();
            updateUI();
            console.log(LOG_PREFIX, `Summaryception v${SC_VERSION} loaded — the transplant export now covers the verbatim window: an EPHEMERAL summarization pass over the unsummarized tail (same batching, prompts, and context as live) puts the newest turns in the FILE while the session stays byte-identical — no cursor advance, no ghosting, no layer push; a verbatim window of 9 is still 9 after the export, and a failed batch aborts the export loudly instead of delivering a file missing its newest chapter. Full history: git log.`);
        });

        // Settings panel — isolated. renderExtensionTemplateAsync() fetches
        // settings.html by a FIXED path, so if this extension's folder is named
        // anything other than "Extension-Summaryception" the fetch 404s. Keeping
        // it in its own try means that failure only hides the settings panel;
        // the memory engine above keeps working.
        try {
            // Work out our OWN folder name from this module's URL, so the settings
            // panel loads no matter what you named the repo/folder. This removes the
            // fixed-name requirement entirely. If URL detection ever fails, fall back
            // to the current known folder name.
            let extPath = 'third-party/Summaryception-Personal-Bruce-';
            try {
                const m = import.meta.url.match(/extensions\/(third-party\/[^/]+)\//);
                if (m && m[1]) extPath = decodeURIComponent(m[1]);
            } catch (_) { /* keep fallback */ }

            const html = await renderExtensionTemplateAsync(extPath, 'settings', {});
            $('#extensions_settings2').append(html);
            bindUIEvents();
            initConnectionUI();
        } catch (e) {
            console.error(
                `${LOG_PREFIX} Settings panel failed to load (the core memory features still work). It tried to load settings from the extension's own folder, detected via import.meta.url.`,
                e
            );
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Initialization failed:`, e);
    }
})();
