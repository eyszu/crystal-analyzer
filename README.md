# Crystal Analyzer

VS Code support for [Crystal](https://crystal-lang.org): a language-server client plus syntax highlighting, snippets, spec/run tasks and CodeLLDB debugging.

## Architecture

Crystal's semantics (macros, type inference, overloads) can only be answered by the compiler, so this extension does **not** reimplement them. It starts a Crystal language server over stdio and adds built-in fallbacks for anything the server doesn't provide.

| Feature | Provided by |
|---|---|
| Completion, hover, signature help, go to type definition | Language server |
| Go to definition / implementation, find references | (F12) Language server; text-based fallback if the server lacks it or isn't installed |
| Semantic highlighting | Language server; built-in scanner if the server lacks it |
| Inlay hints | Language server; built-in hints for literal/`.new` variable types and parameter names if the server lacks them |
| Syntax highlighting, snippets, brackets, indentation | Extension (TextMate grammar) |
| `require "..."` paths | Extension: F12 / Ctrl+click opens the required file (relative paths, `./dir/*` globs, `lib/` shards, stdlib via `crystal env CRYSTAL_PATH`) |
| ECR templates (`.ecr`) | Extension: HTML + embedded Crystal highlighting for `<% %>`, `<%= %>`, `<%# %>`, `<%- -%>` and `<%%` escapes, including inside HTML attributes. No language-server features inside templates. |
| Run file, run specs (+ code lenses), `shards` tasks, format | Extension |
| Debugging | Extension builds with `crystal build --debug`, then launches [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) |

Hover the **Crystal** status bar item to see which capabilities your server advertises.

## Setup

1. Install Crystal and Shards.
2. Install a language server. The default is [crystalline](https://github.com/elbywan/crystalline) (`crystalline` on your `PATH`). To use another stdio LSP server, set `crystal.server.path` (and `crystal.server.args`).
3. Build and install the extension:

   ```sh
   npm install
   npm run package          # produces crystal-analyzer-0.1.0.vsix
   code --install-extension crystal-analyzer-0.1.0.vsix
   ```

   For development, open this folder in VS Code and press **F5**.

## Commands

`Crystal: Run Current File`, `Debug Current File (CodeLLDB)`, `Run Specs in Current File`, `Run Spec at Cursor`, `Run All Specs`, `Format File`, `Restart Language Server`, `Show Language Server Log`. Spec files also get a **Run** code lens above `describe` / `context` / `it`. A `crystal` task type (`build`, `install`, `spec`, `run`) is auto-detected for projects with a `shard.yml`.

## Debugging

Press F5 in a `.cr` file, or add:

```json
{ "type": "crystal", "request": "launch", "name": "Debug app", "program": "${workspaceFolder}/src/app.cr", "args": [] }
```

The extension builds a debug binary in the temp directory and hands the session to CodeLLDB (it offers to install it). `program` may also point at a prebuilt binary. Crystal debug info is limited: expect breakpoints, stepping and raw variables, not pretty-printed Crystal types.

## Settings

| Setting | Purpose |
|---|---|
| `crystal.server.path` / `args` / `env` / `enable` | Which server to run and how |
| `crystal.compiler.path` | `crystal` executable for run/spec/format/debug |
| `crystal.semanticTokens.fallback` | `auto` (default), `always`, `never` |
| `crystal.inlayHints.fallback` | `auto` (default), `always`, `never` |
| `crystal.inlayHints.variableTypes` / `parameterNames` | Built-in hint options (`none` / `literals` / `all`) |
| `crystal.debug.buildFlags` / `launchOverrides` | Customize the debug build and CodeLLDB config |
| `crystal.trace.server` | LSP tracing |

## Known limits

- **Built-in fallbacks are heuristics.** The text-based navigation matches by name (no overload or receiver awareness); the semantic tokenizer and inlay hints are scanner-based. They exist so the editor stays useful without a server, and step aside when the server provides the feature.
- **Chained-call type hints** need compiler type inference, so they only appear if your server provides them.
- **Lifetimes** are a Rust concept; Crystal is garbage collected and has none, so there is nothing to show.
- **"Traits"** in Crystal are modules (`include`) and abstract types. Completion for them comes from the server; the semantic tokenizer highlights `include`d modules as interfaces.
- Server capabilities vary by server and version. Check the status bar tooltip, and use `crystal.server.path` to switch servers.

## Development

```sh
npm run typecheck       # tsc
npm run build           # bundle to out/extension.js
npm run gen:grammar     # regenerate syntaxes/crystal.tmLanguage.json from scripts/gen-grammar.mjs
npm test                # typecheck + grammar + tokenizer tests (test/fixtures/sample.cr)
```
