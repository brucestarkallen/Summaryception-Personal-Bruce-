# 🧠 Summaryception

### Layered memory **and** living character continuity for SillyTavern

A memory system for long‑form roleplay in [SillyTavern](https://github.com/SillyTavern/SillyTavern). It keeps your most recent turns verbatim, compresses everything older into an ever‑growing hierarchy of summary snippets, and — the part that sets this fork apart — maintains a **living psychological ledger of every character** so people stay *the same person* and evolve realistically across hundreds of turns, instead of snapping out of character when a scene gets compressed.

> This is an **enhanced fork** of the original **Summaryception** by **Lodactio** ([Extension‑Summaryception](https://github.com/Lodactio/Extension-Summaryception)). The original is a layered recursive summarizer. This fork keeps that engine and adds a character‑psychology layer, a detail auditor, retroactive backfill, granular injection control, and a lot of robustness work. See **[What this fork adds](#-what-this-fork-adds-over-the-original)**.

---

## 🧭 TL;DR for a future maintainer (human or AI)

- **What it does:** verbatim recent turns → layered summaries of older turns → plus a per‑character "ledger" (nature / current mood / relationship arc / open threads) → all assembled into one injected memory block.
- **Three background passes**, each per summarized batch, each fire‑and‑forget (never blocks generation): **(1) Summarizer** writes the compact snippet; **(2) Detail Auditor** catches specifics the snippet dropped; **(3) Character Ledger scribe** updates the psychological model of everyone in the passage.
- **Storage key is `MODULE_NAME = 'summaryception'`** — used for both `extensionSettings[MODULE_NAME]` (settings) and `chatMetadata[MODULE_NAME]` (per‑chat memory). **⚠️ Never change this string** — it would orphan every user's saved summaries and ledger. The display name and repo name are cosmetic and safe to change; this key is not.
- **The ledger is a FOLD, not a mutable blob.** Every scribe reply is journalled as a small per-turn *note* holding only the fields that changed (`store.ledgerNotes`); a character's page is the newest value of each field across their notes. `store.ledger` is the materialized view every consumer reads, so injection/panel/roster/audit are untouched — but **time** lives in the notes. A branch or delete to turn N is `notes.filter(t <= N)` + refold: instant, exact, **zero model calls**. `store.ledgerNotesFrom` marks how far back the notes are authoritative (a chat that predates notes adopts its page as a base note at the current pointer; rewinds below that fall back to the checkpoint/rebuild path, which is now legacy-only). Notes compact into a fresh base past `_NOTES_SOFT_CAP`, keeping exact history for the recent tail. **Never mutate `store.ledger` without journalling a note.** External writers (the Chat Assistant's memory edits, undo restores) can't know the journal exists, so `adoptExternalLedgerEdits()` reconciles page → notes before EVERY fold (rewind, message-deletion refold, rebuild swap, scribe merge): a page-side field diff becomes a note, a page-side character deletion becomes a `gone: true` tombstone (which `foldLedgerNotes` honors — later notes lawfully re-introduce). Guards: an empty page adopts nothing (unmaterialized ≠ mass deletion), a provably stale entry (`_t` behind the journal's) is repaired by the fold instead of adopted, and rebuild-trimmed serving pages never generate tombstones.
- **The ledger is injected as compact prose, not JSON.** The scribe *outputs* JSON only so it parses reliably; that JSON is parsed into stored fields and discarded. What reaches the storyteller is one readable line per on‑screen character.
- **Everything is defensive:** background passes are `try/catch` + `quiet`, guarded against chat switches (epoch token), never throw upward, and the hot injection path is exception‑wrapped. Editing/deleting chat messages is handled (indices are resynced).
- **Single file does the work:** `index.js` (~7k lines). `settings.html` is the panel, `style.css` the styling, `manifest.json` the metadata. `connectionutil.js` is upstream — don't edit.
- **⚠️ THE GATE — run all three before every push. Never use `node --check index.js`.**
  SillyTavern loads `index.js` as an **ES module**; `node --check` on a `.js` file parses it as **CommonJS** and silently accepts what ESM rejects (a duplicate top-level `let`, most importantly). That false pass shipped a redeclared identifier in v5.58.0 and the extension **failed to load at all through v5.60.0 while every check reported green**.

  ```bash
  node load_test.mjs     # 1. MODULE INTEGRITY: really loads index.js as an ES module against mocked
                         #    SillyTavern globals, then asserts every event handler bound.
                         #    Catches SyntaxErrors, TDZ, init crashes, and event-wiring regressions.
  node ledger_test.js    # 2. LOGIC: the ledger/memory assertion suite (also re-runs the ESM parse).
  node e2e_test.mjs      # 3. PIPELINE: swaps connectionutil.js for a scripted stub and runs the REAL
                         #    index.js end to end — event -> scribe -> ledger -> injection -> checkpoint
                         #    -> auditor -> chat switch. "Passes the unit tests" is not "works".
  npx eslint@9 --config eslint.config.mjs index.js connectionutil.js   # 4. STATIC: no-undef / no-redeclare
                         #    across every code path, including ones no test executes.
  ```
  All three must exit 0. `require-atomic-updates` findings (8 as of v5.81.0; one left with the deleted snapshot-undo code) are false positives on this codebase — every
  guard→set path is synchronous (an async body runs synchronously to its first `await`), and
  `_catchupDialogOpen` covers the one genuine await-window; verify before dismissing any new one.
- **One exclusive LLM channel.** Every background pass (summarizer, ledger scribe, detail auditor, ledger auditor, continuity checker, edit re-check) must gate on **`_llmChannelBusy()`**. `callSummarizer` snapshots SillyTavern's prompt toggles, disables them, and restores on finish — two concurrent calls interleave those snapshots and leave the user's toggles **permanently wrong**. Adding a new pass? Add its flag to that one predicate; never hand-roll a subset check (that pattern is O(n²) and has already failed twice).

---

## ✨ What this fork adds over the original

| Area | Original Summaryception | This fork |
|---|---|---|
| **Character continuity** | — | **Character Ledger**: a 3rd background "scribe" pass keeping per‑character *core / state / arc / open‑threads*; only the active on‑screen cast is injected. The flagship feature. |
| **Detail preservation** | Single summary snippet per batch | **Detail Auditor** ("sister"): a 2nd pass that checks whether the snippet dropped hard‑to‑reconstruct specifics (numbers, names, promises, capabilities, canon) and attaches a short detail note. |
| **Existing stories** | Summarizes going forward only | **Backfill / Maintenance**: retroactively build the ledger and detail notes over a story that already has summaries (`/sc-ledger-build`, `/sc-audit-all`), plus per‑snippet "run just this scene" buttons. Cancelable, non‑blocking. |
| **Injection control** | Fixed | **Injection Contents** toggles: independently include/exclude notepad, pinned, ledger, summary, and detail notes — without stopping the background passes that build them. |
| **Manual memory** | — | **Manual Notepad** (per‑chat canon), **Pinned Memories** (`/sc-pin`), **Verbatim Recall** (`/sc-recall` — fetch the *original* text behind matching snippets, injected ephemerally). |
| **Editing memory** | Manual | **Continuity Editor**: describe a problem/retcon; a model proposes a minimal set of edits to snippets/notepad/details under per‑item review with undo. |
| **Connection** | — | Run the summarizer passes on a **separate connection/model** (default, a Connection Profile, Ollama, or OpenAI‑compatible) so you can use a cheap/fast model for memory work. |
| **Robustness** | — | Chat‑switch guards (no cross‑chat contamination), **message‑deletion resync** (stored indices shift when you delete a message), safe short↔full **character‑name unification**, reentrancy guards, per‑batch saves. |
| **UI** | Nested | Flat, self‑contained collapsible cards; comprehensive one‑click **Reset All** to recommended defaults (preserves memory + connection). |

---

## 🔄 Architecture

### The layer system (the "‑ception")
- **Verbatim window** — the newest *N* assistant turns (`verbatimTurns`) are sent to the roleplay AI word‑for‑word.
- **Layer 0** — when the window overflows, the oldest turns are summarized in batches (`turnsPerSummary` turns → one snippet). Each snippet stores `{ text, turnRange:[startIdx,endIdx], detail?, timestamp }`.
- **Higher layers** — when a layer exceeds `snippetsPerLayer`, its oldest snippets are promoted/merged into a "summary of summaries" one layer up (up to `maxLayers`). Promoted/merged snippets carry a *covering* `turnRange` so they remain recallable.
- **Injection order:** `notepad → pinned → characters(ledger) → summary → details`. Stable canon (who these people are) is grouped ahead of the narrative (what happened).
- **Ghosting** — summarized messages are hidden from the LLM via SillyTavern's native hide flag (`extra.sc_ghosted`) but stay visible to you.

### The three background passes (all per batch, all fire‑and‑forget)
1. **Summarizer** (`summarizeOneBatch`) — builds the passage from the batch's turns, calls the model with a context‑aware prompt (record only the *delta* vs. what's already summarized), pushes the snippet, ghosts the turns.
2. **Detail Auditor** (`queueAuditDetail` → `processAuditQueue`) — re‑reads the same passage, emits `NONE` or a `DETAIL:` line of only the missing specifics, attaches it to the snippet. Sequential queue, discarded if the snippet is gone or the chat switched.
3. **Character Ledger scribe** (`queueLedgerUpdate` → `processLedgerQueue`) — reads the passage + current ledger, returns a JSON array of per‑character updates, which are merged into the store. Epoch‑guarded against chat switches.

None of these block generation; failures log and are swallowed.

---

## 🎭 The Character Ledger (flagship feature)

Solves the classic failure: a character who was *flustered* a few turns ago suddenly acts wildly out of character (screaming) because memory compressed the moment to a bare event, losing both her live emotional state **and** her behavioral core. The ledger keeps both.

**Store:** `chatMetadata.summaryception.ledger = { "<name>": { core, state, arc, threads[], updatedAt } }`

- **core** — stable nature: temperament, values, and *how they express themselves* (register, tells, how they address the player, lines they won't cross). Written once, changed only for a genuinely new stable trait. The anti‑out‑of‑character anchor.
- **state** — current, volatile mood. Overwritten each update but carries momentum (a shock lingers; a slight festers until addressed); a re‑entering character resumes their last state.
- **arc** — slow relationship trajectory with the player, including the *formative moments* that explain why they treat the player as they do (relational memory).
- **threads** — concrete open loose ends kept alive until the *story* resolves them (an unaddressed slight, a pending promise, a lie unconfessed).

**Injection = active cast only.** Only characters whose name (or given/surname) appears in the recent window (`ledgerActiveWindow` messages) are injected, capped by `ledgerMaxActive` and `ledgerMaxCharsPerChar`. The injected form is compact prose:

```
<characters>
Who these people are and where they stand right now — keep them consistent and in character; do not contradict:
Alexia Valois — Nature: Analytical, proud, guarded; calls Jovan "Ardent" until she trusts him. Now: Quietly rattled after the wrong-name slip. Open: Wrong-name slip unaddressed; owes Jovan for the cafeteria. Arc: Thawing toward Jovan against her will.
</characters>
```

**Merge semantics:** a field present on a scribe delta replaces it; an omitted field is left untouched; `threads: []` clears, omitted keeps. Short/full name forms of the same character are unified **only when unambiguous** (two characters sharing a name are never merged). The scribe is told to record only what the passage evidences and never invent.

---

## 🗄️ Data model & storage

- **Settings:** `extensionSettings['summaryception']` — all tuning (see `defaultSettings` at the top of `index.js`). Missing keys are backfilled from defaults, so new settings appear automatically for existing users.
- **Per‑chat memory:** `chatMetadata['summaryception']` = `{ layers, summarizedUpTo, ghostedIndices, notepad, pins, ledger }`. Read **uncached** via `getChatStore()` every time (load‑bearing — it re‑reads `chatMetadata`, which SillyTavern swaps on chat change).
- **Index bookkeeping** (`summarizedUpTo`, each snippet's `turnRange`, `ghostedIndices`) is kept in sync when you delete a message (`onMessageDeleted` → `reindexAfterDeletion`). The ledger is name‑keyed and carries no indices, so it's untouched by edits.
- **Export/Import** dumps/restores the *entire* store (snippets + notepad + pins + ledger).

---

## ⌨️ Slash commands

| Command | Does |
|---|---|
| `/sc-status` | Show layer counts + summarized boundary |
| `/sc-preview` | Preview the assembled injection block |
| `/sc-ledger` | Dump the current character ledger |
| `/sc-ledger-build` | Backfill the ledger from the whole existing story (cancelable) |
| `/sc-audit-all` | Backfill detail notes for snippets that lack them (cancelable) |
| `/sc-pin [label]` | Pin the selection / last message into permanent memory |
| `/sc-recall <query>` | Fetch the original text behind matching snippets, injected for the next reply |
| `/sc-clear` | Clear all auto memory for this chat (layers, ledger) and unghost |

---

## 🛠️ Developer notes / invariants (read before editing)

- **Never change `MODULE_NAME = 'summaryception'`.** It's the storage key for both settings and per‑chat memory. Changing it orphans all saved data.
- **`getChatStore()` must stay uncached** — it re‑reads `chatMetadata` each call and migrates missing keys.
- **`onChatChanged` must reset all per‑chat transient state** (editor pending/undo, audit queue, ledger queue) and bump `_chatEpoch` — the epoch invalidates any background pass still in flight for the previous chat. It also refreshes `_prevChatLen`.
- **Background passes are fire‑and‑forget + `quiet:true`** and must never block or throw into the summarize cycle. The hot path (`updateInjection`/`assembleSummaryBlock`) is exception‑wrapped.
- **No hardcoded story/character/genre names anywhere.** Behavior is data‑driven.
- **Ledger injection is prose, not JSON.** Keep it that way (see `formatLedgerEntry` / `buildCharacterBlock`).
- **UI cards are flat siblings** — no nesting. "Reset to Default" buttons are generic (`data-key` + `data-target`).
- **The settings panel loads its own folder path from `import.meta.url`**, so the repo/folder can be renamed freely; the hardcoded fallback path is only a safety net.
- **`connectionutil.js` is upstream** — do not edit.
- The file‑header comment version is intentionally stale; the real version lives in `manifest.json` **and** the `SC_VERSION` constant (top of `index.js`, printed at `APP_READY`) — keep those two in sync on every release.

### Files
| File | Purpose |
|---|---|
| `index.js` | The entire engine (~4.5k lines) — passes, layers, ledger, injection, UI wiring, slash commands |
| `settings.html` | The settings panel markup |
| `style.css` | Panel styling (flat cards) |
| `manifest.json` | Extension metadata (`display_name`, `version`, entry points) |
| `connectionutil.js` | Upstream connection helper — do not edit |

---

## 📜 Credits & license

- **Original Summaryception:** [Lodactio / Extension‑Summaryception](https://github.com/Lodactio/Extension-Summaryception).
- **This enhanced fork:** adds the Character Ledger, Detail Auditor, Backfill/Maintenance, injection controls, and robustness work.
- **License:** GNU AGPL‑3.0 (inherited from the original — see `LICENSE`).

**Notepad = starting canon.** The notepad is the story's *starting* state — written at the beginning and deliberately never updated as the story progresses. Foundational facts (world rules, identities, backstory) stay highest-authority; situational details describe the opening and are *expected* to be outgrown by the snippets. Every LLM consumer (continuity auditor, Continuity Editor, continuity record, Memory Transplant, auditor brief) is told this explicitly, so "the notepad wasn't updated" is never flagged, never "fixed", and never treated as staleness.
