# arachne-cli

The terminal client for an arachne room. Same HTTP and SSE API the web interface
uses, so nothing here can drift from what the GUI does.

```bash
npm install -g .        # or: npm link
arachne status
```

```
engines  Ollama (1)
  ● scout    Ollama · qwen3.8:27b
  ● static   Ollama · qwen3.8:27b
  ● planner  Ollama · qwen3.8:27b
scope    127.0.0.1, localhost
shell    allowlist
state    3 findings · 7 tested · 2 open intents
engage   eng_20261029_9009904205fd  acme-checkout
```

## Commands

```
arachne serve                     start the room runtime and the web UI
arachne status                    engines, routing, scope, counts
arachne agents                    roster: role, tools, skills, model
arachne skills                    installed skills
arachne chat                      interactive session
arachne ask <agent> <text…>       one turn, streamed
arachne room <text…>              fan out to the room
arachne hunt <target>             run the seven-stage pipeline
arachne findings                  candidates, reproduced, confirmed
arachne ledger [--clear]          coverage facts and open intents
arachne engagement new <name> --targets a,b
arachne engagement list | use <id>
arachne tool <name> '<json>'      run one tool by hand
```

Options: `--url <url>` (or `ARACHNE_URL`), `--json` for one event per line,
`--no-color`, `--members a,b,c`, `--thread <id>`, `--port <n>`.

## A turn

```
◍ Mira surface mapper · qwen3.8:27b  [rce-memory-corruption]
  ⚙ scan_sinks path=fixtures/vuln
  ⚑ HIGH     CWE-120 Copies until NUL with no destination size. vuln.c:17 · candidate
    ✓ 4ms   scanned 1 files (0 skipped) — 5 candidates, top 5
  ── 0.9s · 2 steps · 1.2k tok
```

Tool calls, findings, tapbacks, handoffs and hunt phases each get a line. `--json`
prints the raw event stream instead, one object per line, so you can pipe it:

```bash
arachne --json hunt ./target | jq -r 'select(.type=="finding") | .finding.title'
```

## Interactive

`arachne chat` is a plain question-and-answer session with one generalist (no
tools), kept in its own thread namespace — separate from the rooms the agents
work in.

```
/agent <id>   switch agent        /room      fan out to the room
/hunt <path>  run the pipeline    /skills    list skills
/skill <id>   toggle a skill      /ledger    coverage and intents
/findings     findings            /new       fresh thread
/help                             /quit
```

Ctrl-C aborts the running turn, not the session.

## Where the server lives

The CLI is a client. `arachne serve` starts the runtime when it can find it, in
this order:

1. `$ARACHNE_HOME/server/index.mjs`
2. `../gui/server/index.mjs` (when the two folders sit side by side)
3. `./server/index.mjs`

Otherwise point it at a running instance with `--url`.

## Scope

Built for work you are authorized to do. The server's engagement record is the
authorization: probes refuse hosts that are not listed in it.
