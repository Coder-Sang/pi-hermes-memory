# On-demand Markdown memory

Retrieval reads Markdown directly. It does not open SQLite, create a search
index, or call an embedding/model API. `session_search` separately searches Pi's
JSONL conversation history.

## Configuration and compatibility

```json
{
  "memoryMode": "policy-only",
  "memoryPolicyStyle": "full",
  "lazyInitialization": true,
  "standingInstructionsEnabled": true
}
```

`policy-only` is the default. It appends fixed usage rules, not ordinary memory
contents. `full` and `compact` explain when to search and how to read entries.
`custom` preserves supplied text; `none` omits the policy. Tools stay registered
in every mode even when files are empty or absent.

`lazyInitialization` defaults to `false`. When explicitly enabled in
`policy-only`, ordinary memory loading waits for first use. Pinned instructions
and Pi-native skill discovery remain available at session start.

Explicit `legacy-inject` retains automatic injection and its existing capacity
and consolidation rules. Memory updates/reloads may change its system prefix;
it is not covered by the policy-only cache stability guarantee. Existing
`sessions.db` files are not opened or migrated.

`STANDING.md` keeps its original behavior in every mode, including policy style
`none`: user-pinned instructions are automatically included subject to the
existing switch, 20-entry cap and 2,000-character budget. Ordinary memory tools
never write this file. User edits/pins, policy changes, tool configuration, and
Pi skill discovery changes can still change the prefix.

## Scopes and storage views

| target | Source |
| --- | --- |
| `memory` | User-global `MEMORY.md` |
| `user` | User-global `USER.md` |
| `project` | Current execution directory's project `MEMORY.md` |
| `failure` | User-global `failures.md`, including old entries |

Caller-supplied file paths and project names are not accepted. Read/search views
read committed files, strip internal metadata comments and preserve the
`\n§\n` entry delimiter. They do not rebuild legacy injection snapshots. Failure
retrieval does not apply `failureInjection*` age/count filters, which control
legacy injection only.

## memory_read

Arguments: required `target`, optional `offset`, `limit`, and `revision`.
`offset` is a non-negative integer, default `0`. `limit` is an integer from `1`
through `16000`, default `8000`. Both count Unicode code points, not UTF-8 bytes
or UTF-16 code units.

```json
{"target":"user","limit":2000}
```

Successful results contain `success`, `target`, `content`, `totalChars`,
`nextOffset` and `revision`. `nextOffset: null` indicates the end. Missing files
return empty content successfully. Reading at/past the end returns an empty
final page.

`revision` is SHA-256 of the metadata-free target text. Every nonzero `offset`
requires a revision from read/search. A stale revision returns `memory_changed`
with no content: repeat the search or restart at offset `0`. This prevents
joining pages from different versions during concurrent writes.

## memory_search

Arguments: required nonblank `query`, optional `target`, `category`, and `limit`.
Without `target`, searches use `memory`, `user`, `project`, `failure` order;
entries within a scope follow file order. `limit` is an integer from `1` through
`20`, default `10`.

Queries split on whitespace, normalize with Unicode NFKC, and lowercase. Every
term must occur literally in the normalized entry. Chinese substrings and
English case variants work. Regex, boolean/FTS operators, fuzzy matching and
automatic segmentation are not interpreted.

Optional `category` filters the leading tag: `failure`, `correction`, `insight`,
`preference`, `convention`, or `tool-quirk`.

```json
{"query":"pnpm 构建","target":"project","limit":5}
```

Successful results contain `success`, `count`, and `results`. Each hit has
`target`, `excerpt`, `offset`, `length`, and `revision`. Excerpts contain at most
the first 512 code points. Locations refer to the complete entry in the same
metadata-free text exposed by `memory_read`.

Read a hit using its target, offset, revision and `limit: min(length, 16000)`.
For longer entries, continue with `nextOffset` and the same revision until the
entry's `offset + length` is reached. Repeat search after `memory_changed`.
Do not use incomplete excerpts for replacement/removal.

## Results and failures

Results are ordinary tool-result messages. Recalled facts do not override the
current user's instructions or repository evidence. Preserve earlier history;
fetch updated facts in a new call instead of rewriting old results.

Empty searches succeed with no results. Broad searches skip an unavailable
project; explicit project access returns `project_unavailable`. Invalid input
returns `invalid_arguments`, read/initialization failures return
`memory_read_failed`, and cancellation returns `memory_cancelled`. Failures set
`isError: true` and never fall back to injection. Filesystem exception text and
paths are not included in tool errors.

The restored `memory_search` searches currently authorized Markdown only. It
does not restore the removed SQLite API's arbitrary-project filter or FTS query
syntax. No existing database is modified.
