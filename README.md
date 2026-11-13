# Regex Atlas — Visual Regex & AST Playground with AI Rule Generator

A developer workbench for regular expressions: **see the AST as a node graph**, **hover to sync**
the graph ↔ code ↔ test corpus, **build patterns from drag-and-drop blocks**, and **ask for a rule in
plain English**. Everything expensive runs in a Web Worker behind a hard kill-deadline, and matching
uses a Thompson-NFA/Pike-VM engine that is **provably linear** — so catastrophic backtracking can
never freeze the UI.

```
React 19 · TypeScript · React Flow (@xyflow/react) · Monaco Editor · Web Workers
Node 22 + Express · SQLite (WAL, 24h TTL) · Zstandard share links · Groq / Gemini Flash (optional)
```

---

## Quick start

```bash
npm install
npm run dev          # Vite on :5173  +  API on :8787 (proxied at /api)
```

Open http://localhost:5173.

Production (one process, one port):

```bash
npm run build
NODE_OPTIONS=--experimental-sqlite npm run serve   # serves dist/ + /api on :8787
```

Optional free AI keys (see `.env.example`). Without keys the app still generates rules — see
[The AI layer](#the-ai-layer) below.

```bash
GROQ_API_KEY=gsk_...          # Llama 3.3 70B via Groq (lowest TTFT)
GEMINI_API_KEY=...            # Gemini Flash fallback
```

---

## What it does

### 1. Bi-directional hover sync
* **Graph → editor**: hovering a node highlights its exact source span in Monaco
  (`(ab|c)+`, not just `+` — spans include the whole quantified element).
* **Graph → corpus**: the hovered node's own sub-pattern is executed over the corpus, so the
  substring that *this node* is responsible for lights up (bright cyan) while other matches stay
  dimmed amber.
* **Editor → graph**: moving the caret inside the pattern resolves the innermost AST node at that
  offset (`nodeAtOffset`) and highlights it in the graph.
* Clicking a node **pins** it, so you can inspect captures and ranges without keeping the mouse still.

### 2. Visual node graph
* Fan-out tree layout with zero node overlap, collapse/expand per subtree (double-click a card),
  drag to reposition, `Auto layout` to reset.
* Colour-coded node flavours (literal / class / group / quantifier / anchor / alternation / lookaround)
  and a legend in the inspector.

### 3. Drag-and-drop node builder
* Palette of atoms, structure, repeat and anchor blocks → drop into a track → **live compiled regex**.
* Blocks are reorderable, editable in place (`Repeat * + ?`, `Repeat n–m`, `lazy`), and the compiled
  pattern is validated before it is pushed into the editor.

### 4. Two engines, one contract
| Engine | What it is | Complexity |
| --- | --- | --- |
| **Safe · linear** (default) | Thompson NFA + Pike VM simulation with capture slots | **O(n·m)** guaranteed |
| **Backtracking** | native `RegExp`, used for the ReDoS demo/comparison | O(2ⁿ) worst case |

* The safe engine runs in a **dedicated Web Worker** with a **hard deadline**: on timeout the worker is
  `terminate()`d and respawned, because a busy JS loop cannot be interrupted cooperatively.
* Patterns the automaton cannot express (lookarounds, backreferences) are reported explicitly and
  fall back to the backtracking engine *with a warning in the UI* instead of silently behaving
  differently.
* The step budget is surfaced live (`steps`), so "linear" is observable, not just a claim.

### 5. ReDoS analysis
Static analysis runs on every keystroke (O(pattern), not O(input)) and reports:
nesting depth, **star height**, capture count, whether the pattern needs backtracking, a 0–100 risk
score, and findings with concrete rewrites — nested quantifiers, overlapping alternation branches,
unanchored unbounded repetition, multiple `.*` runs.

### 6. The AI layer
* **Natural language → rule**: `match valid Indian GST numbers` produces the pattern, an explanation of
  every component, sample matches/rejects, and the node graph — loaded in one click.
* **Performance & vulnerability explainer**: a review of the current pattern plus an O(n) rewrite you
  can apply directly.
* **Providers**: Groq (Llama 3.3) or Gemini Flash when a key is present.
* **Fallback (default)**: a deterministic **Local Rule Compiler** ships in the backend. It recognises
  real domain shapes (GSTIN, PAN, email, Indian mobile, IPv4, ISO date, URL, UUID v4, PIN, INR amount,
  hex colour) and *composes* rules from prose (`starts with INV- and ends with 2024`,
  `at least 6 digits`, `between a and z`). Instant, offline, zero cost — and it emits the same
  explanation + examples contract as a model would.

---

## Backend

Stateless by default.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | engine, store, AI mode, architecture summary |
| `GET /api/examples` | curated patterns + corpora |
| `POST /api/regex/run` | linear-engine match with server-side deadline and corpus cap |
| `POST /api/regex/parse` | AST + microsecond parse timings (p50/p95 of 25 runs) |
| `POST /api/regex/analyze` | static risk report |
| `GET /api/regex/compare` | safe-engine result + why backtracking is not run server-side |
| `POST /api/ai/generate` | natural language → rule (+ AST) |
| `POST /api/ai/review` | risk explainer + linear rewrite |
| `POST /api/share` | zstd + base64url share code (stateless) or 24h stored code |
| `GET /api/share/:id` | resolve a 24h code |
| `GET /api/store/stats` | live entries / expired / bytes |

**Time.** Matching is O(n·m) on the NFA engine; parsing is a single recursive-descent pass measured in
microseconds (`/api/regex/parse`). The server never executes an untrusted pattern on a backtracking
engine — that would be a self-inflicted ReDoS.

**Space.** A share is `zstd(JSON)` → base64url → `#s=…`. Nothing is written for a share, so storage
cost is zero and the link never rots. Opting into a short code stores the same compressed blob in
SQLite with `expires_at = now + 24h`; a sweeper deletes expired rows and `journal_mode=WAL` keeps
reads lock-free.

```
src/  shared/  server/
```

`shared/regex` is imported by **both** the worker and the server, so the browser and the API always
agree on a pattern's semantics. The design mirrors the Rust reference architecture:

| Rust reference | Here |
| --- | --- |
| `regex` crate (finite automata, linear time) | Pike VM over a Thompson NFA (`shared/regex/pikevm.ts`) |
| `tree-sitter` (µs incremental parse) | recursive-descent parser with source spans (`shared/regex/parser.ts`) |
| `zstd` share payloads | `node:zlib` Zstandard |
| SQLite WAL / Redis TTL | `node:sqlite` in WAL mode, 24h TTL (in-memory fallback) |

---

## Testing

```bash
npm test        # 42 tests: parser, Pike VM, analysis, share codec, API service, local AI, UI smoke
npm run typecheck
```

The engine tests include a **linear-time guard**: `(a+)+$` over 40 000 characters must finish in well
under 3 s with steps proportional to `n × m`, plus a step-budget exhaustion test. The UI smoke test
mounts the real `App` (with Monaco/React-Flow shims and a synchronous worker facade) to catch
render-time crashes.

---

## Keyboard & interaction cheatsheet

| Action | Result |
| --- | --- |
| Hover a graph node | highlight token + corpus spans + inspector |
| Click a graph node | pin it |
| Double-click a node | collapse/expand its subtree |
| Move the caret in the editor | highlight the node at that offset |
| `⌘/Ctrl + ↵` in the AI box | generate a rule |
| Toggle `Safe · linear` / `Backtracking` | compare guaranteed-linear vs exponential behaviour |
| Share → Copy | stateless `#s=` link |
