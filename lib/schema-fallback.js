/**
 * Schema-library probe.
 *
 * `@deepseek-ai/schemastery` is the real config-schema library. It is not
 * guaranteed to be resolvable from this plugin: the profile installs the plugin
 * with pnpm's `link:` protocol, and **a `link:` dependency does not get its own
 * dependencies installed** — so this plugin's directory has no `node_modules`
 * and the bare specifier fails from `lib/index.js`.
 *
 * The important consequence, learned from a real activation failure: the plugin
 * must NOT substitute a stand-in schema. cordis validates a composition entry
 * itself, by calling `schema.validate`, so handing it a shim that lacks that
 * method crashes the host with
 *
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 *     at resolveConfig (.../cordis/lib/index.js:958:45)
 *
 * Therefore: when the real library resolves, expose it as `Config`; when it does
 * not, expose NO `Config` at all. The entry then activates without host
 * validation and without a settings form, and every option still works because
 * the plugin resolves its own defaults in `resolveConfig`.
 */

/**
 * Try to load the real schema library.
 *
 * @returns `{ z, isFallback }` — `z` is the real factory when `isFallback` is
 * false, otherwise `undefined` and the caller must not publish a schema.
 */
export async function loadSchemaFactory() {
  try {
    const mod = await import('@deepseek-ai/schemastery');
    const z = mod?.default ?? mod;
    if (typeof z?.object === 'function') return { z, isFallback: false };
    return { z: undefined, isFallback: true };
  } catch {
    return { z: undefined, isFallback: true };
  }
}
