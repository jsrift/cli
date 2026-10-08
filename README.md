# jsrift-cli

Command-line front end for the `jsrift` deobfuscation engine. It reads
JavaScript, TypeScript or JSX, runs the pass pipeline, and writes readable source.

## Install

```sh
npm install -g jsrift-cli        # installs the `jsrift` command
jsrift bundle.js -o clean.js --stats

npx jsrift-cli bundle.js -o clean.js    # or without installing
```

Node 20.19 or later is required. The only dependency is the `jsrift` engine;
argument parsing, colour handling and report rendering are local to this
package.

```sh
jsrift bundle.js -o clean.js --stats
cat bundle.js | jsrift > clean.js
jsrift bundle.js --analyze
```

## The stdout contract

**stdout is the deobfuscated code.** Nothing else is ever written there, so
`jsrift in.js > out.js` and `jsrift in.js | prettier` both work unchanged.

Everything human-facing - the progress indicator, the `--stats` report, warnings
and errors - goes to **stderr**.

Three modes deliberately take stdout over, because in those modes there is no
code to emit or the machine-readable output is the point:

| flag | what stdout becomes |
| --- | --- |
| `--json` | the metadata object as JSON (pair with `-o` to keep the code) |
| `--analyze` | the fingerprint report, or its JSON with `--json` |
| `--list-passes`, `--list-techniques` | the listing, or its JSON with `--json` |

## Usage

```
jsrift <input> [-o <file>] [options]
```

`<input>` is a file path. `-` or no argument at all reads stdin. A value can be
attached with `=` (`--preset=aggressive`) or follow as the next argument, and
`--` ends option parsing. At most one input is accepted.

### Input and output

| flag | effect |
| --- | --- |
| `-o`, `--output <file>` | write the code to `<file>` instead of stdout |
| `--json` | print the metadata object as JSON on stdout |
| `--stats` | print a human-readable report on stderr |
| `--analyze` | fingerprint the input and exit without transforming it |
| `--list-passes` | every pass id, grouped by stage |
| `--list-techniques` | every technique and which presets enable it |

With `--json` and no `-o`, the metadata owns stdout and the code is not
written anywhere; a note on stderr says so.

### What to run

| flag | effect |
| --- | --- |
| `--preset <conservative\|balanced\|aggressive>` | default `balanced` |
| `--enable <technique[,...]>` | force techniques on |
| `--disable <technique[,...]>` | force techniques off; wins over the preset |
| `--disable-pass <passId[,...]>` | skip individual passes; the escape hatch below the technique level |
| `--language <auto\|js\|jsx\|ts\|tsx>` | default `auto`, which walks a detection ladder |
| `--allow-execution` | opt in to the `sandbox` evaluation tier |

A technique named in both `--enable` and `--disable` is a usage error rather
than a silent precedence rule.

Technique names are validated. A typo prints the valid list and the closest
match rather than silently ignoring the flag:

```
$ jsrift in.js --disable varableRenaming
error Unknown technique "varableRenaming" in --disable.
Valid techniques: stringDecoding, variableRenaming, controlFlowAnalysis, ...
Did you mean variableRenaming?
```

Pass ids are validated the same way against `--list-passes`.

#### `--allow-execution`

The `native` and `interpreter` decoder tiers never execute input code. The
`sandbox` tier does: it compiles an AST-extracted slice of the input with
`new Function` in the calling realm, with host globals shadowed by parameters.
That is a mitigation, not a boundary. There is no isolated realm, and
`constructor.constructor` reopens the real global scope, so in Node the
executed slice has the process, the filesystem and the network. No preset
enables the tier. `--allow-execution` turns it on for this run only, and is the
right call exactly when you trust the input and the first two tiers could not
decode it. It does not otherwise change which techniques run.

### Output shape

| flag | effect |
| --- | --- |
| `--no-format` | skip pretty-printing |
| `--indent <n>` | indentation width, 0-16 (default 2) |
| `--quotes <single\|double\|preserve>` | default `preserve`: input literals keep their quotes |
| `--no-comments` | drop comments from the output |
| `--source-map [inline]` | write `<out>.map`, or `inline` to append a data URI |
| `--banner` | prepend a summary comment to the code |

`--source-map` on its own writes a sibling `.map` file and appends a
`//# sourceMappingURL=` comment, so it needs `-o`. Use `--source-map inline`
when the output goes to stdout.

The map points back at the **obfuscated input**, which is what makes a stack
trace from the original bundle navigable in the deobfuscated source.

### Budgets

| flag | effect |
| --- | --- |
| `--max-iterations <n>` | fixpoint iteration cap, 1-1000 |
| `--time-budget <ms>` | stop and emit best-effort output after this long |
| `--no-verify` | skip re-parsing the output to prove it is valid |

A run cut short by the time budget or the iteration cap still writes output
and reports `truncated` in the stats. It degrades; it does not fail.

### Reporting

| flag | effect |
| --- | --- |
| `-q`, `--quiet` | no progress indicator, no non-essential stderr |
| `--no-color` | disable ANSI colour |
| `--color` | force ANSI colour on |
| `-h`, `--help` | full option list |
| `-v`, `--version` | version and Node version |

An explicit `--color` or `--no-color` always wins. Otherwise `NO_COLOR` (any
non-empty value) disables colour, `FORCE_COLOR` (any value other than `0`)
enables it, `TERM=dumb` disables it, and failing all of those colour is on
only when the target stream is a TTY. Redirecting to a file yields plain text.

The progress indicator draws a single line on stderr, redrawn in place and
erased when the run finishes. It appears only when stderr is a TTY and
`--quiet` is not set, so it can never contaminate piped output.

## Exit codes

| code | meaning |
| --- | --- |
| `0` | success |
| `1` | usage error: an unknown flag, a bad value, an unreadable input file |
| `2` | the input could not be parsed as any supported dialect |
| `3` | the output failed re-parse verification |
| `70` | internal error (the engine threw); the stack is printed to stderr |

Exit `3` means the output did not re-parse. The code is still written so it can
be inspected, and the diagnostics say what is known: whether the input itself
only parsed with error recovery (the errors were carried in), or the re-parse
ran out of stack (a process limit, not a statement about the output). The
engine names no pass; when the input was clean, `--disable-pass` narrows the
cause by hand. `--no-verify` skips the check entirely and therefore never
yields exit `3`: it reports `verification: "skipped"` and exits `0`.

## The `--stats` report

Output of one run over a 5,384-byte sample (a one-line program run through
`javascript-obfuscator` four times):

```
jsrift · balanced preset · js script · 11/11 techniques on

DETECTIONS
  string-array-rotate      100%  _0x39ad rotated at load
  string-array-wrapper     100%  _0x2bbc (native tier)
  string-array-rotate      100%  _0xc781 rotated at load
  string-array-wrapper     100%  _0x4b9f (native tier)
  string-array-rotate      100%  _0x2f23 rotated at load
  string-array-wrapper     100%  _0x4171 (native tier)
  string-array-rotate      100%  _0x121c rotated at load
  string-array-wrapper     100%  _0x168a (native tier)
  string-array              98%  self-replacing string-array thunk holdi... ×40
  hex-identifiers           97%  65 of 67 distinct identifiers match _0x... ×65
  string-array-rotate       97%  push(shift()) rotation inside an unboun... ×2
  string-array-wrapper      95%  15 decoder aliases resolved from 4 deco... ×15
  ... and 4 more

PASSES 12 of 28 reported work · 69ms in passes
  prepare.normalize-literals      167 changes      6ms ████████████
  strings.inline                   91 changes     29ms ███████
  strings.prune-decoders            4 changes      1ms █
  clean.unused                      1 changes   0.75ms █
  simplify.fold-constants           1 changes   0.56ms █
  simplify.properties               1 changes   0.56ms █
  simplify.sequences                1 changes   0.56ms █

RESULT
  bytes            5,384 →          52  -99.0%
  lines                2 →           3  +50.0%
  changes            266 over 2 iterations · 12 AST nodes
  renames              0 identifiers
  strings             69 decoded
  time              90ms parse 12ms · transform 75ms · generate 2ms
  verified           yes

DIAGNOSTICS
  info    strings.inline  Removed 7 declaration(s) of string-array machiner...
  info    strings.inline  Removed 6 declaration(s) of string-array machiner...
  info    strings.inline  Removed 6 declaration(s) of string-array machiner...
  info    strings.prune-decoders  Removed 4 declaration(s) of string-array machiner...
  info    clean.unused  This is a script, so its top-level declarations a...
  info    clean.unused  This is a script, so its top-level declarations a...
```

Passes are ranked by impact rather than by execution order, so the line that
explains most of the diff is the first one you read. The engine only reports a
pass that changed something, bailed out, or cost at least a millisecond, which
is why the count reads "n of N" rather than listing every registered pass. The
registered total belongs to the build that produced the report.

## Examples

```sh
# Straight through, code on stdout
jsrift bundle.js > clean.js

# Full report on stderr, code in a file, source map alongside it
jsrift bundle.js -o clean.js --stats --source-map

# Everything aggressive does, minus dead-code removal
jsrift bundle.js --preset aggressive --disable deadCodeRemoval -o clean.js

# Machine-readable metadata for a script, code still written to disk
jsrift bundle.js -o clean.js --json | jq '.stats.totalChanges'

# Just tell me what this is
jsrift suspicious.js --analyze

# Narrow a verification failure to a pass
jsrift bundle.js -o clean.js --disable-pass structure.control-flow

# Inputs over a few MB: memory, not time, is the ceiling
NODE_OPTIONS=--max-old-space-size=8192 jsrift big-bundle.js -o clean.js --stats
```

## Building from source

```sh
npm ci
npm run build      # tsup src/cli.ts --format esm --clean --target node20
npm run typecheck  # tsc --noEmit
```

The build emits `dist/cli.js` with a shebang. The `jsrift` engine is left
external and resolved from `node_modules` at run time.

## License

MIT
