# Install

`dsh-thinking-breaker` is a dsh **host plugin bundle**. Installing it means adding a row to a profile's roster; there is no build step and no runtime dependency to fetch.

## Requirements

- A running DeepSeek Harness with the `dsh` CLI (or DSH Desktop).
- Node `>=22.19.0 || >=24.0.0` (the plugin uses top-level `await`).
- `pnpm` on `PATH` when installing through the plugin manager.

## Install with the plugin manager (recommended)

From the DSH Desktop plugin manager, or the CLI:

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-thinking-breaker
```

That adds the dependency and the bundle layer. **Restart the host afterwards** — ESM caches are per-process, so a running instance will not pick up a new bundle layer.

## Manual install

Add the dependency and the bundle to the profile, then install:

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-thinking-breaker": "link:/absolute/path/to/dsh-thinking-breaker"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...existing bundles...
        "dsh-thinking-breaker"
      ]
    }
  }
}
```

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

Then restart the host.

## A caveat about `link:` installs

pnpm's `link:` protocol does **not** install the linked package's own dependencies. This plugin declares `@deepseek-ai/schemastery` for its config schema, so under a `link:` install that specifier does not resolve from `lib/index.js`, and the module therefore exports **no `Config`**.

That is handled deliberately and is not a failure:

- the entry still activates, and **every option still works** (the plugin resolves its own defaults);
- what you lose is host-side validation and the auto-generated settings form;
- `usingFallbackSchema` from the module reports which mode is active.

It must not be "fixed" with a stand-in schema: cordis calls `schema.validate` on whatever the module exports, and a shim without that method crashes the host with `TypeError: Cannot read properties of undefined (reading 'validate')`. `npm run verify` pins this contract.

If you want the settings form, install the plugin in a way that installs its dependencies — e.g. pack it and install the tarball with `file:` instead of `link:`:

```bash
cd /absolute/path/to/dsh-thinking-breaker && npm pack
dsh plugin --profile desktop add /absolute/path/to/dsh-thinking-breaker/dsh-thinking-breaker-1.1.0.tgz
```

## Verify it is working

After a restart, the plugin's log lines are the signal:

```
[thinking-breaker] trip: session=... turn=... rule=low-novelty reasoningChars=... — request aborted
[thinking-breaker] agent/request-error: ... recovering loop abort with a fresh attempt (1/1)
[thinking-breaker] post-trip hint delivered: session=... tool=... trips=1
[thinking-breaker] tool failures x2 in this turn: session=... tool=... — injecting change-approach guidance
[thinking-breaker] denying repeated failing call: session=... tool=... after 3 failures
```

## Disabling and rollback

Disable one arm only:

```yaml
config:
  retryWithoutThinking: false   # keep detecting/aborting, stop the auto-retry
  toolFailureGuard: false       # disable the tool arm
```

Disable everything:

```yaml
config:
  enabled: false
```

Or set the row itself to `disabled: true`.

Full rollback: remove the entry from `dsh.profile.bundles` and from `dependencies` in the profile's `package.json`, run `pnpm install`, and restart.

The plugin writes no files, makes no network requests, and never modifies session history, so removing it leaves nothing behind.

## A note on profile secrets

This plugin needs no credentials and stores none. While installing it, however, a real
hazard in the *profile* surfaced that is worth repeating here, because it is easy to miss:

A profile's `cordis.patch.yml` commonly carries inline secrets — for example an MCP client
row with `headers: { Authorization: Bearer <token> }`. Those live in plain text on disk, are
copied into any backup of the profile, and are readable by anything that can read the file.

If a token sits there, treat it as exposed and **rotate it at the provider**. When you put a
new one in place:

- prefer the provider's own reference mechanism over an inline literal when one exists
  (`apiKeyEnv: NAME` reads a named environment variable; not every credential field offers
  that, and MCP `headers` values are plain YAML strings);
- scope the token to what the integration actually needs — a read-only MCP integration does
  not need `repo` or `delete_repo`;
- keep a copy of the config without secrets if you back the profile up.
