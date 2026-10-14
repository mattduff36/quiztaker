# Dependency security overrides

Next.js and its ESLint config are pinned together at 16.3.8. Patched transitive versions are pinned for proxy-addr, source-map-js and postcss-selector-parser.

The Next ESLint plugin depends on fast-glob -> micromatch -> braces. The braces stack-exhaustion advisory (GHSA-vfj7-8cjw-p6xm) affects every published braces release as of 2026-10-14. The root fast-glob override replaces that lint-only dependency with the local @vitriol/next-glob adapter backed by tinyglobby 0.2.17. The adapter implements the plugin's sole call, globSync(string, {onlyDirectories:true}), preserving absolute Windows paths. It is not a general-purpose fast-glob replacement. dependency-compatibility.test.js exercises the real plugin with single/array roots and directory filtering. No lint rules or audit thresholds are disabled.

Use npm ci with the committed lockfile. npm 10 may retain stale workspace transitive resolutions during npm install; always rerun the audit and compatibility test after dependency updates. Remove the adapter once Next removes the vulnerable dependency or a compatible upstream patch is published.
