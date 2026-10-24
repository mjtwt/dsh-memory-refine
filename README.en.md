# dsh-memory-refine

**[简体中文](README.md) | English**

A "memory refine" plugin for DSH (DeepSeek Harness): it distills a long conversation into candidate entries, you approve them one by one, and only then do they land in your long-term memory files — which you can read, edit and delete directly in a panel.

The other direction is covered too: **when it needs to "remember something from before", it never has to read a whole file.** A keyword recall returns a few passages with line numbers (one memory per passage, ~400 characters), in about 12 ms.

> This is not a commercial product; it is something I built because I needed it. Take it if you want it. (MIT)
> Every judgement it makes rests on one premise: long-term memory is something you confirmed by hand, not something the model accumulated on its own.

![The Memory Refine panel](docs/panel.png)

---

## What it solves

- Session logs keep growing (hundreds of events per conversation), while real long-term memory is only a handful of `.md` files;
- Refining by hand is error-prone, and it is even easier to mistake **engine-injected prompts** for "something the user said";
- Editing memory files directly has no safety net: break something and you cannot roll back; two writers (you and the model) overwrite each other;
- When the model wants to "remember something from before" it has only two options: **read the whole file** (33KB in one shot) or not read at all — the middle gear ("just the relevant few entries") was missing, and whole-file reads are both expensive and prone to treating an unrelated entry as fact.

---

## Install

Prerequisite: DSH with the profile mechanism (Desktop, or a CLI build with profiles).

1. Put this directory anywhere (example: `D:/plugins/dsh-memory-refine`). **Replace the path after `link:` below with wherever you put it.**

2. Add a linked dependency to the profile's `package.json`:

   ```json
   {
     "dependencies": {
       "dsh-memory-refine": "link:D:/plugins/dsh-memory-refine"
     }
   }
   ```

3. Add it to the `dsh.profile.bundles` array in the same file:

   ```json
   { "dsh": { "profile": { "bundles": ["dsh-memory-refine"] } } }
   ```

4. **Restart the whole DSH process.**

> ⚠️ **After changing code you must restart the whole DSH process.** The ESM module cache is keyed by URL; toggling the plugin in the plugin manager does **not** re-import new code — you will think your change did nothing.

A "Memory Refine" icon appears in the sidebar once it is loaded.

---

## First run (the panel is empty?)

A fresh DSH install usually has **no** `memory/` directory, so the left column may be empty the first time you open the panel. That is not a bug.

You do not need to create directories by hand; either path produces your first memory file:

1. **Let the model do it**: say "create `memory/example-topic.md` with one placeholder line". `memory_write` creates the `memory/` directory and the file for you.
2. **Do it yourself**: create a `.md` file under `DSH_HOME/memory/`, then hit "Refresh" in the panel.

`DSH_HOME` is usually `C:\Users\<you>\.dsh` on Windows.

> `AGENTS.md` is DSH's per-turn injected layer, not something this plugin creates. Without it the plugin still works; the left column just has one fewer entry.

---

## Rules for writing memory

The plugin only handles *how to write safely*; **what to write** is still up to you. Three pitfalls, learned the hard way:

1. **One memory per `<!--@refine-->` block.** Put two things in one block and you can no longer edit or delete either of them independently.
2. **State the subject explicitly.** Do not write just "name: something" — are you naming the assistant, or saying that this is your own name? The model would rather ask you than guess (it will tell you: a wrong guess gets carried around as a fact).
3. **Make it repeat the entry back.** "What does this entry mean, and whose is it?" is far more reliable than hoping it understood.

---

## Six tools

The plugin registers six model-callable tools, all of which only touch whitelisted files.

| Tool | What it does |
| --- | --- |
| `memory_list` | Lists managed files: the injected layer `AGENTS.md`, the index, topic notes and the archive — with version hashes and line counts |
| `memory_read` | Reads a managed file (paginated), returning its layer, version and total line count |
| `memory_recall` | Recalls the few relevant passages for a keyword: returns `path:start-end`, version and the passage itself — never the whole file, and no extra read once it answers |
| `memory_gather` | Turns a session into refinement material, writes it to disk as markdown, returns a preview and statistics |
| `memory_write` | Writes to a managed file. **Nothing lands until the user says yes** |
| `memory_import` | Imports external content into a memory file (new section / append) |

### `memory_recall`: recall first, read closely second

When you need "what did we decide before", call this instead of reading a whole file (one topic file here is 33KB). **The passages it returns usually already contain the answer** — answer from them, don't read the same lines again.

- **Segmentation**: memory files split **per entry** (`- ` start lines / blank lines / headings) — one entry per segment. These files turned out to be one-memory-per-line (`- **title**: body` on a single physical line), so there is nothing to batch up. Rule documents (the injected layer) keep the old "accumulate 600 characters, then cut" rule: they are short one-sentence lists, and per-entry splitting shatters them into 40 segments, 20 of them under 60 characters. Both keep a hard character cut as a backstop — never a 10KB monster segment.
- **Scoring**: TF-IDF over Chinese 2-grams, length-normalised, with a coverage gate (fewer than half of the query tokens hit → not returned). Missing a hit beats padding the list.
- **Archive is opt-in**: the `archive/` layer holds superseded snapshots and is excluded by default (`scope:"live"`); pass `scope:"all"` to search it.
- **The injected layer is excluded too**: `AGENTS.md` sits in the context in full every turn, so recalling its passages adds no information — it only crowds the budget on one common word. Pass `scope:"inject"` to search it.
- **Output**: each hit carries `path` / `startLine` / `endLine` / `version` plus the passage itself. When the passage is intact the render says "cite it as is" and **emits no `memory_read` call at all**; only a truncated passage gets a copy-pasteable offset. Recall points at the spot — close reading is always optional.
- **No hits**: returns a list of live files (path + heading) instead of nothing. No synonyms, no fuzzy matching.
- **Batch what should be batched, skip what should be skipped**: for several unrelated terms, issue multiple `memory_recall` calls **in one message**; for one term (or a prefix of it), don't search twice at all. Every serial step re-pays the whole context plus that step's reasoning — measured: 4 serial steps ¥0.30 vs one batched step ¥0.077 for the same job. It looks like "one more lookup"; on the bill it is "one more think".

The matching guardrail lives in `memory_read`: without an explicit `limit` it returns at most **8KB** (`我们的线.md` stops at line 21) and says in the header how much was withheld. This gate is necessary — in practice the model still makes one "just to be safe" argument-less `memory_read` even when the injected layer forbids reading whole files, and an 88-line file under the 250-line default page means dumping all 33KB. **What prompt wording can't enforce, code should.**

One recall is capped at 2400 characters (≤5.7KB rendered). Acceptance script: `node test/recall.mjs` (read-only, runs against real data).

> The per-hit cap is 1200 characters, and the number is data-driven rather than a "give a fixed slice" choice: after switching to one-entry-per-segment, the 86 live segments measure **P50=363, P90=740, P95=960, max 1744** — only one exceeds 1200. So at this value **98% of entries are handed over whole, with no "truncated" note at all**. At the earlier 400 / 750 most segments were longer than the window, so nearly every hit carried that note — which is the same as carrying none, while still provoking a follow-up read. **Truncating saves nothing; it provokes a 6.5KB follow-up read.** Handing over the whole passage is cheaper.

**The user never has to name the tool, and the trigger lives in exactly one place**: the rule in `AGENTS.md` §4. It is static, visible every turn, and served from the prefix cache — near-zero marginal cost.

**Recall is deliberately not a skill.** A skill has to be loaded before its body is readable, which adds a tool round-trip and a full protocol dump per trigger; worse, the model re-derives the rule "to follow procedure" — observed in practice as "check the injected rule, decide whether to load the skill, then follow the skill", i.e. one decision made twice. One rule, one home. Recall output arrives as a tool result appended to the conversation, so the system prompt is never rewritten and the prefix cache stays warm.

> Why no per-turn auto-injection: the host does expose a `system-prompt/assemble` hook, but inserting a variable section into the system prompt invalidates the prefix cache from that point on — in a long session that single turn can cost an order of magnitude more. Static rules belong in the injected layer `AGENTS.md`, where the content never changes and the cache always hits.

### `memory_gather` parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `session_id` | current session | Which session to refine |
| `mode` | `incremental` | `incremental` takes only turns after the watermark; `full` takes everything |
| `boundary_seq` | derived automatically | Set the boundary by hand (for debugging) |
| `max_reasoning` | `0` | How many reasoning characters to keep per segment; `0` drops it entirely and leaves a one-line placeholder |
| `out_dir` | `memory-refine-scratch/` under the session workspace | Where the material is written |

Material lands in the **session's own workspace** by default, so it never piles up inside DSH's config directory.

---

## The panel

Sidebar "Memory Refine" icon → main panel.

- **Left column**: managed files. The archive is collapsed by default (`Show archive (N)`); click once to expand.
- **Right column**: the body of the selected file, editable in place. Hit "Save" when done.
- **Top bar**:
  - `Refresh`: drop the cache and re-read from disk.
  - `Clean up material…`: deletes material files (`material-*.md` / `tools-*.md`) from `memory-refine-scratch/` in the current session workspace. It asks once, only recognises those two prefixes, and does not recurse into subdirectories.
- **After a write**: a `This version is fine, delete the backup` line appears above — pressing it deletes the backup taken for that write. If you never press it, the backup stays.
- **Re-read**: select a file and press "Re-read" to load it from disk again. **Use this whenever saving fails with "changed since you looked at it"** — usually the model or another window just wrote to the file. If you have unsaved edits it asks you first.
- **Delete file**: select a file and press "Delete…" → confirm. It backs up the whole file to `memory-refine-backups/` before deleting.
- **Import…**: fill in the target file and a section heading, then put the content in the large box below. The box accepts two kinds of input:
  - **Paste the body** — paste the text you want to import;
  - **Give an absolute path** — write the full path of a file (e.g. `D:\old-notes.md`) and it reads that file itself, so you do not have to paste tens of thousands of words.
    The test is deliberately strict: **single line, ≤ 4096 characters, an absolute path, and the file actually exists** — all four must hold, otherwise it is treated as text. So a body that happens to contain a path is never misread. Relative paths are **not** accepted (the host has no reliable base directory; guessing could read the wrong file).

> The injected layer `AGENTS.md` **cannot be deleted** in the panel, only edited.

---

## Safety design

Every write goes through one path (`confirmAndWrite` in `index.js`):

1. **Version hash pre-check** — if the version you hold does not match the one on disk, abort; not a single byte is written;
2. **Full backup** — a copy is written to `DSH_HOME/memory-refine-backups/` first;
3. **Read-back verification** — the file is read back immediately after writing and compared byte for byte; any mismatch is reported as a failure.

A successful write looks like this (version, line delta, verification result and backup path, all in one line):

![A successful write: version hash, line delta, read-back verification and the backup path](docs/write-result.png)

Also:

- **A write requires the user's explicit yes.** If the question service is unavailable it refuses outright; it does **not** silently degrade to "auto-approve".
- **Whitelist**: only `DSH_HOME/AGENTS.md` and `DSH_HOME/memory/**/*.md`. `..` escapes and anything outside the allowed roots are rejected.
- **Slash-command payloads are not recorded**: the command registers with `recordInput: false`, so the session log does not store a second copy of the full input JSON. The command channel is now only a fallback and is not used in normal operation (see the next section).

---

## How the panel talks to the host

The panel runs in a browser context, the host runs in another process — and there is no private plugin RPC channel between them (DSH's capability set is fixed at build time; third-party plugins cannot add to it).

So the plugin mounts its own HTTP route on the host side:

```
POST /memory-refine/ui          ← every panel action goes here
  request  { action, sessionId, ... }
  response { ok: true, data } or { ok: false, error }
```

That route:

- only accepts requests from **this machine that pass `connection.requestRejection`** (it does not invent its own token);
- has four gates: `POST` only; `content-type: application/json` only; an 8 MB body limit; 401/403 on a failed trust check;
- translates `sessionId` into an agent and hands it to the **same** `handleUiRequest` — whitelist, version pre-check, backup and read-back all run the same code as the tool path.

**Why it is needed**: slash commands (`ctx.remote.commands.execute`) are the only way a third-party plugin can reach the host, but by design they **write a `command/run` / `command/done` pair into the session log**, which shows up in the conversation view as a `memory-refine · {...}` entry. The HTTP route does not enter the command bus, so there is no such entry.

**Fallback**: if the route fails to register (older DSH without `webServer`), or a request is rejected, the panel falls back to the slash command automatically and shows a red warning at the top — it never leaks silently.

---

## How session material is collected

It reads DSH's session event stream directly (`sessionQuery.readSession`) and never touches the on-disk `session.v4.jsonl.zstd` — no need to decode multi-frame zstd yourself.

What gets dropped:

- entire `<system-reminder>` blocks (AGENTS.md change notices arrive this way, and are **the easiest thing to mistake for "something the user said"**);
- bare runtime snapshots (everything after `Current runtime context.`);
- the prompt list inside `request/header`;
- reasoning bodies (replaced with a single line: `<!-- reasoning omitted: N places, X characters in this segment -->`).

### Watermark: zero external state

Each gathering writes this as the first line of the material file:

```
<!--memory-refine:watermark session=<id> seq=<n> time=<t> turns=<k>-->
```

On the next gathering, `deriveWatermark()` scans the session log's `tool/result` events for the line left by the previous `memory_gather` and takes its `seq` as the boundary.

**Why it is built this way**: no external state file, nothing that grows without bound the way a `handledIds` set would, and it is scoped to the session by construction. The boundary falls on **turns** (`user.seq > boundarySeq`), so it never cuts a turn in half.

---

## Layout

```
memory-refine/
├── index.js        Host half: skill + 6 tools + the UI bridge
├── client.js       Browser half: sidebar icon + main panel
├── gather.js       Pure functions: session event stream → refinement material (no cordis dependency, testable on its own)
├── memory.js       Managed-file access layer: whitelist + version hash + backup + read-back verification
├── protocol.js     The full refinement protocol (injected as a skill)
├── search.js       Pure functions: segmentation + tokenising + TF-IDF scoring (recall)
├── test/recall.mjs Recall acceptance: runs against real memory data, read-only
├── test/smoke.mjs  Offline smoke test: fake ctx + sandboxed DSH_HOME
├── cordis.patch.yml Tells DSH which line to insert
└── package.json
```

`gather.js` is deliberately pure: it takes an array of events and returns text, touching no disk. That way you can replay exported session logs in a sandbox over and over without restarting DSH.

---

## Tests

```
node test/smoke.mjs
```

No DSH process and no real memory files — it loads the host half with a fake `ctx`, points `DSH_HOME` at a sandbox in the OS temp directory, and removes it afterwards.

20 assertions, aimed less at "does it work" and more at **the branches you cannot reach by clicking**:

- The four gates: `POST` only (405), known sub-paths only (404), JSON only (415), trust rejection passed through unchanged (403)
- Whitelist escape rejected (`../../etc/passwd`)
- Writes: read-back verification passes, and a backup file really is created
- **Aborts when the version is stale** (`deadbeefdeadbeef` → not a single byte written)
- Import spacing, and the delete backup naming plus the "it really is gone" check

Producing those branches by hand means restarting DSH once per case. In the assertions they are three lines each.

---

## Uninstall

1. Remove the `dsh-memory-refine` dependency from the profile's `package.json`;
2. Remove `"dsh-memory-refine"` from the `dsh.profile.bundles` array;
3. **Restart DSH**;
4. Optional cleanup:
   - `DSH_HOME/memory-refine-backups/` — pre-write backups (you may want to keep them);
   - `memory-refine-scratch/` under the session workspace — extracted material (safe to delete).

Uninstalling **never** touches anything in `AGENTS.md` or `memory/`.

---

## Known limitations

- **The command channel is a fallback, not the main path.** The panel uses the plugin's own local HTTP route (`POST /memory-refine/ui`) by default and **does not go through the command bus**, so in normal use no `memory-refine · {...}` entry appears in the conversation view. Only when the route is unavailable does it fall back to the `/memory-refine` slash command, leaving a `command/run` / `command/done` pair — and then the panel shows a red warning telling you it degraded. Those events **never enter model history, never cost tokens, and never pollute the gathered material**.
- The panel cannot determine the session id when **no session has ever been opened**; it asks you to open one first.
- Verified on **Windows** only.
