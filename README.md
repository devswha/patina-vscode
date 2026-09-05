# Patina for VS Code

Local writing-signal inspection and deliberate rewrites through Patina CLI.

- Debounced document scores and sentence-level lexical hints run offline.
  Paragraph and document findings remain when they cannot be localized.
- **Patina: Audit Current Document** opens the CLI's full audit report and
  updates diagnostics when the original document has not changed.
- **Patina: Humanize Selection** runs verification, opens a diff, and applies it
  only after confirmation. A changed document is never overwritten.
- Configure CLI path, language, backend and warning threshold. The extension
  stores no API key and runs only in trusted workspaces.

Requires Patina CLI 8.3.0 or newer for sentence hints and audit diagnostics
(or a development checkout's
`bin/patina.js` configured as `patina.cliPath`). Node.js/npm is required for the
default `npx patina-cli` path. First run **Patina: Install or Update CLI** to cache
the package. Background operations use npm's offline resolution and never
download updates. Draft text is passed through stdin; inspection invokes no model.

Explicit audit/rewrite commands use the backend already configured for your CLI
and may send the selected text to that provider. No provider key prompt is added
by this extension. Scores are editing hints, not authorship probabilities.

Download `patina-vscode-1.1.0.vsix` from this repository's GitHub release. In VS
Code, run **Extensions: Install from VSIX**, select that file, then run
**Patina: Install or Update CLI**. Open a trusted workspace to enable inspection.
Use **Patina: Score Current Document**, **Patina: Audit Current Document**, or
**Patina: Humanize Selection** from the command palette.

Development: `npm test`. The application is ESM with a small CommonJS activation
shim for the extension host. Host validation runs through the installed VS Code
under Xvfb using `npm run test:host`. Set `PATINA_TEST_CLI` to a local
`bin/patina.js`; `PATINA_CODE_BINARY` optionally selects the VS Code executable.
