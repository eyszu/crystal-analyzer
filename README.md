# Crystal Analyzer

This extension provides support for the [Crystal](https://crystal-lang.org) programming language.

| Feature | Provided by |
|---|---|
| Completion, hover, signature help, go to type definition | Language server |
| Go to definition (F12) / implementation , find references (Shift+F12) | Language server; text-based fallback if the server lacks it or isn't installed |
| Semantic highlighting | Language server; built-in scanner if the server lacks it |
| Inlay hints | Language server; built-in hints for literal/`.new` variable types and parameter names if the server lacks them |
| Syntax highlighting, snippets, brackets, indentation | Extension (TextMate grammar) |
| `require "..."` paths | Extension: F12 / Ctrl+click opens the required file (relative paths, `./dir/*` globs, `lib/` shards, stdlib via `crystal env CRYSTAL_PATH`) |
| ECR templates (`.ecr`) | Extension: HTML + embedded Crystal highlighting for `<% %>`, `<%= %>`, `<%# %>`, `<%- -%>` and `<%%` escapes, including inside HTML attributes. No language-server features inside templates. |
| Run file, run specs (+ code lenses), `shards` tasks, format | Extension |
| Debugging | Extension builds with `crystal build --debug`, then launches [CodeLLDB](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb) with respective launch.json settings|

## Settings

| Setting | Purpose |
|---|---|
| `crystal.server.path` / `args` / `env` / `enable` | Which server to run. Defaults to [crystalline](https://github.com/elbywan/crystalline) |
| `crystal.compiler.path` | `crystal` executable for run/spec/format/debug |
| `crystal.semanticTokens.fallback` | `auto` (default), `always`, `never` |
| `crystal.inlayHints.fallback` | `auto` (default), `always`, `never` |
| `crystal.inlayHints.variableTypes` / `parameterNames` | Built-in hint options (`none` / `literals` / `all`) |
| `crystal.debug.buildFlags` / `launchOverrides` | Customize the debug build and CodeLLDB config |
| `crystal.trace.server` | LSP tracing |
