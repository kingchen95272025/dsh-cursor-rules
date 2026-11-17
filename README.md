# dsh-cursor-rules

> Bring Cursor's rule-loading behaviour to DeepSeek Harness: read `.cursor/rules/**/*.mdc` from the
> workspace and from user-level directories, select rules with Cursor's four semantics, and fold them
> into the agent context — plus a **Cursor rules** panel in the Web GUI.

[中文说明](README.zh.md)

---

## What it does

- **Same semantics as Cursor.** A rule's frontmatter decides when it enters the context, not the file name.
- **Nothing new to learn.** If a repository already carries `.cursor/rules`, the agent follows it without you pasting rules into prompts.
- **Zero third-party dependencies.** Frontmatter parsing and glob matching are implemented inside the package, so the bundle is self-contained.
- **Two UI surfaces.** A **Cursor rules** button at the bottom of the sidebar opens a panel, and Settings has a full page listing every rule with its frontmatter, body, and switch.

## Rule types

| Type | Frontmatter | When it enters the agent context |
| --- | --- | --- |
| **Always** | `alwaysApply: true` | Injected in full at the start of a session |
| **Auto Attached** | `alwaysApply: false` + `globs: [...]` | Added when a file the agent has touched matches one of the globs |
| **Agent Requested** | `alwaysApply: false` + `description` | Listed in the on-demand catalog; the agent reads the file when it judges it relevant |
| **Manual** | neither key | Listed in the on-demand catalog only |

Other conventions:

- **Order.** User-level directories come first (`~/.dsh/rules/**` and `~/.cursor/rules/**` by default, in the order given by `userRuleDirs`), then `.cursor/rules/**` from the project root down to the session's working directory. Inside the project layers a more specific copy wins for the same id.
  > A user-level rule's id is `~/<path relative to the home directory>`, so the directory name is part of the id: `~/.dsh/rules/x.mdc` and `~/.cursor/rules/x.mdc` are two independent rules, both injected. `userRuleDirs` only sets the scan order; directories never override each other.
- **Frontmatter forms.** `globs` accepts a YAML block list, an inline array, or Cursor's comma-separated string; `alwaysApply` accepts a boolean or `"true"` / `"false"`.
- **Incremental delivery.** The first request carries a full baseline; later turns only carry a delta when the rule set or its content changes (new or updated bodies, and removal notices for rules that no longer apply). Hundreds of kilobytes of rules are not re-sent every turn.
- **Budget.** One injection never exceeds `maxBytes` (131072 bytes by default). Rules over budget are omitted, and the injected text names what was skipped.
- **Frame boundary.** A `</system-reminder>` inside a rule body is escaped, so repository content cannot break out of the plugin's own `<system-reminder>` frame.

## Install

From the DSH plugin market, search for **Cursor rules** and install the bundle.

From this repository:

```sh
dsh plugin add github:kingchen95272025/dsh-cursor-rules
```

The package is a bundle: `package.json` declares `dsh.bundle.patch`, and `cordis.patch.yml` inserts the
`dsh-cursor-rules` row. The host half is the package main entry; the `dsh.client` declaration makes the
web app load `./client` for the browser half. No build step, no install script.

> Migrating from an older manual install? Remove the hand-written `cursor-rules` row from the profile's
> `cordis.patch.yml` and the copied directory under `<profileDir>/node_modules/` first, otherwise the
> rules are registered twice.

## Configuration

The row's `config` (every key is optional):

```yaml
- insert:
    - id: dsh-cursor-rules
      name: dsh-cursor-rules
      config:
        enabled: true            # master switch; false registers nothing
        includeUserRules: true   # load user-level rule directories
        userRuleDirs:            # scanned in this order
          - ~/.dsh/rules         # DSH's own global rules
          - ~/.cursor/rules      # Cursor-compatible location
        maxBytes: 131072         # per-injection byte budget
        trackTouches: true       # auto-attach glob rules on file touches
        projectRootMarkers:      # markers used to find the project root
          - .git
        httpPath: /cursor-rules  # HTTP prefix used by the panel
        stateFile: cursor-rules.json  # switch state file under $DSH_HOME
```

> In DSH patch semantics `config` **replaces** the whole object instead of deep-merging: an override must
> restate every key it wants to keep.

Rule switches are stored in `$DSH_HOME/cursor-rules.json`:

```json
{
  "version": 1,
  "disabled": [".cursor/rules/global.mdc"]
}
```

## Using the panel

- **Sidebar bottom button** — opens a panel listing every rule with its type tag, globs, description, and switch.
- **Settings → Cursor rules** — the same list as a full page.
- **View** fetches a single rule's full body on demand and renders it as Markdown.
- Turning a rule off removes it from the injected set (Always and Auto Attached alike).

## How injection works

```
agent/pre-step (waterfall)
   └─ next() returns this turn's entering batch decision
      ├─ collectRules(cwd)            # discover and parse user + project .mdc files
      ├─ selectRules(rules, touched)  # always / auto attached / on-demand catalog
      ├─ planInjection(previous)      # diff against the last delivered state
      └─ insert createUserMessage(...) after the last claimed message
```

Injected messages carry the plugin's own `kind: 'cursor-rules'` source plus `entries` (every id with its
fingerprint) and a `catalogDigest`, so that:

- **Resuming a session** rebuilds the delivered state from history and does not inject twice;
- **After compaction**, when the plugin's messages are gone from history, the full baseline is delivered again;
- Repeated `pre-step` runs in one turn are suppressed by in-memory state.

## Verify

```sh
npm test          # 48 assertions: frontmatter, glob, discovery, selection, injection, switches
```

The test builds its own `.cursor/rules` fixture in the system temp directory, so it passes on any machine.

Host half, against a running profile:

```sh
curl -s "http://127.0.0.1:19387/cursor-rules/rules?sessionId=<sessionId>" | head -c 400
```

The `version` field in the response is the plugin code version — use it to tell which build the running
process loaded.

Browser half — the desktop GUI is served from the custom protocol `dsh-app://app`, and `curl http://127.0.0.1:19387/`
answers `401 dsh web authentication required`, so a plain `curl` cannot tell whether the browser half
loaded. Read the live slot tree instead (requires an open GUI page):

```
cordis_inspect_query(platform="client", provider="Slots", method="listSubTree",
                     input={"root": "settings.section"})
```

Expect `{"id":"cursor-rules","order":30,"active":true}`, and `{"id":"cursor-rules","order":50,"active":true}`
under `sidebar.footer.action`.

## Known trade-offs

- **Touch sources** are the `file_path` of `read` / `write` / `edit` plus the `displayPath` of `fs/observed`.
  Side effects of arbitrary shell commands are not parsed — the same trade-off `dsh-agent-instructions` makes.
- **Auto Attached follows what has been touched, not what is about to be edited.** Cursor also considers files
  you mention in the conversation; this plugin only uses filesystem touch signals, so attachment arrives one
  step later.
- **The panel endpoint has no authentication.** Desktop's web shell requires the `dsh web` token, but this
  plugin registers a named prefix route on `webServer`, which is matched before the token gate, so any local
  process can read it. The exposure is kept minimal: the endpoint only ever reads `*.cursor/rules/**/*.mdc`,
  never arbitrary paths, and `webServer` binds `127.0.0.1` by default. Set `config.enabled` to `false` or
  remove the bundle to close it entirely.
- **Plugin modules are not hot-reloaded.** `dsh-base` sets `hmr.root` to `[]`: the profile watches
  `cordis.patch.yml` and `package.json`, not plugin modules, and the default `ignored` list contains
  `**/node_modules`. So changing **patch or config** remounts automatically, while changing **`lib/*.js`**
  needs a DSH restart (Node's ESM cache would otherwise reuse the old module instance). The `version` field
  is how you confirm which build is live.

## Structure

| File | Responsibility |
| --- | --- |
| `lib/rules.js` | Rule engine (pure logic, no dependencies): frontmatter parsing, glob compilation and matching, rule discovery, four-type selection, incremental injection planning and rendering |
| `lib/index.js` | Host half (Cordis plugin): `agent/pre-step` injection, `tools/result` and `fs/observed` touch collection, panel JSON routes on `ctx.webServer`, switch persistence |
| `lib/client.js` | Browser half (hand-written, no build): `window.__ModuleLoader__.load({ id, factory })`, registering the `sidebar.footer.action` and `settings.section` slots |
| `cordis.patch.yml` | Bundle patch: inserts the `dsh-cursor-rules` row |
| `locale/{en,zh}.json` | Plugin Manager title, description, and detail document |
| `test/smoke.mjs` | Portable smoke test (48 assertions) over a self-built fixture |

## Credits

- `@deepseek-ai/dsh-agent-instructions` — a workspace instruction injector; this plugin follows its
  conventions (own `source`, verbatim bodies, escaped frame tags, incremental delivery).
- `@deepseek-ai/dsh-client-ui-skill` and `@deepseek-ai/dsh-client-ui-cordis` — examples of hand-written
  client bundles, `ctx.slots.inject` seat registration, and sidebar footer buttons.

## License

[MIT](LICENSE)