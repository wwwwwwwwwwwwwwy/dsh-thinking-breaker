/**
 * Regression check for the exact crash seen at install time.
 *
 * cordis validates a composition entry by calling `schema.validate`, and the
 * first shipped version exported a fallback shim as `Config`, which made cordis
 * itself throw:
 *
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 *     at resolveConfig (.../cordis/lib/index.js:958:45)
 *
 * That is a host-side crash, not a plugin-side error, so it must be pinned. This
 * script mimics what cordis does with the module and asserts the module never
 * hands it a schema-shaped thing that lacks `validate`.
 *
 * Run with: node tools/verify-cordis-contract.mjs
 */

import assert from 'node:assert/strict';

const mod = await import('../lib/index.js');

console.log('usingFallbackSchema      =', mod.usingFallbackSchema);
console.log('default export keys      =', Object.keys(mod.default));
console.log('typeof default.apply     =', typeof mod.default.apply);
console.log('typeof default.Config    =', typeof mod.default.Config);

// 1. The default export must always expose an `apply`.
assert.equal(typeof mod.default.apply, 'function', 'apply must be exported');

// 2. `apply` must be callable with no config at all (a bare profile row).
mod.default.apply(
  { on: () => () => {}, logger: { warn() {}, info() {} } },
  undefined,
);
console.log('apply(undefined)         = ok');

// 3. THE CRASH GUARD: if the module exposes `Config`, it must look like a real
//    schema — i.e. carrying `validate` — because cordis calls it unconditionally.
//
//    Both outcomes are legitimate and this script accepts either, because the
//    plugin loads under two very different install modes:
//      - `link:` install (the documented default) -> the linked package gets no
//        node_modules, the specifier does not resolve, and NO Config is exported
//        (the entry then activates with no host validation and no settings form);
//      - `file:`/tarball install -> dependencies are installed, and a real
//        schemastery-backed Config IS exported.
//    What must never happen is exporting something schema-SHAPED without
//    `validate`, which is what crashed cordis during development.
if ('Config' in mod.default) {
  const schema = mod.default.Config;
  assert.ok(schema !== null && schema !== undefined, 'Config must not be null');
  assert.equal(
    typeof schema.validate,
    'function',
    'a published Config MUST provide .validate or cordis crashes reading it',
  );
  console.log('Config.validate          = function (cordis contract satisfied)');
} else {
  console.log('Config                   = absent (fail-safe path: cordis skips validation)');
}

// 3b. Report which install mode is actually in effect, so a runner can tell the
//     two apart at a glance instead of inferring it from the line above.
console.log('usingFallbackSchema      =', mod.usingFallbackSchema);
console.log('install mode (inferred)  =', mod.usingFallbackSchema ? 'link (no deps installed)' : 'file/tarball (deps installed)');

// 4. resolveConfig must never produce `undefined` per field, and must accept a
//    plain entry, a ref-like entry, and nothing at all.
const cases = [undefined, null, {}, { enabled: false }, { enabled: false, noveltyStreak: 3 }];
for (const input of cases) {
  const out = mod.resolveConfig(input);
  for (const [k, v] of Object.entries(out)) {
    assert.notEqual(v, undefined, `resolveConfig(${JSON.stringify(input)}).${k} must be defined`);
  }
}
const custom = mod.resolveConfig({ enabled: false, noveltyStreak: 3 });
assert.equal(custom.enabled, false);
assert.equal(custom.noveltyStreak, 3);
// Untouched fields fall back to the schema defaults.
assert.equal(custom.blockChars, mod.DEFAULT_CONFIG.blockChars);
assert.equal(custom.noveltyOverlap, mod.DEFAULT_CONFIG.noveltyOverlap);
console.log('resolveConfig            = ok (defaults + overrides, no undefined fields)');

console.log('\nAll cordis-contract checks passed.');
