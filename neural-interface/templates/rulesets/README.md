# SynaBun rulesets

One source, rendered per host by `neural-interface/lib/rulesets/render.js`.

- `core.md` is the text every host gets. A line ending in `<!-- except: codex -->` is dropped for the hosts it names; the line `<!-- host -->` is where the host's own file goes.
- `claude.md`, `codex.md`, `opencode.md`, `gemini.md`, `cursor.md` hold at most two bullets each.
- `coexistence.md` is a snippet people copy by hand. It is never installed.
- `manifest.json` carries the version and one hash per host. A text change without a new version and new hashes fails `tests/rulesets-render.test.mjs`, which prints the hashes to paste.
- `legacy-hashes.json` lists every ruleset SynaBun ever served, so the installer can recognise a copy someone pasted. `node scripts/gen-ruleset-legacy-hashes.mjs` adds to it and never drops an entry.
