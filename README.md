# kml-highlight

Portable **syntax-highlighting assets** for Kernel ML (KML) documents: a **TextMate grammar** (editor-agnostic spec) and a **CodeMirror 6** stream highlighter.

## Layout

| Path | Role |
|------|------|
| `spec/kml.tmLanguage.json` | TextMate grammar (`source.kml`). Import from `kml-highlight/spec/kml.tmLanguage.json`. |
| `src/codemirror/` | `StreamLanguage` + `HighlightStyle` helpers. Import from `kml-highlight/codemirror`. |

## Peers

`@codemirror/language` and `@lezer/highlight` are **peerDependencies** so the host app controls versions and duplicate installs stay deduped (important for Vite + React).
