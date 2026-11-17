# Dependency security overrides

Next.js is pinned at 16.4.5 for GHSA-mfr8-8qww-v76h. The ESLint config is pinned at 16.3.8. Patched transitive versions are pinned for proxy-addr, source-map-js and postcss-selector-parser.

The Next ESLint plugin depends on fast-glob -> micromatch -> braces (GHSA-vfj7-8cjw-p6xm). The root fast-glob override replaces that path with the local @vitriol/next-glob adapter. The tinyglobby override removes the Picomatch dependency (CVE-2026-112366) from Next lint and both TypeScript lint integrations. The @vitriol/lint-glob adapter delegates matching to glob 14.0.6 with minimatch 11.0.5. It supports the lint consumers' globSync and isDynamicPattern calls. dependency-compatibility.test.js covers absolute Windows roots, directory filtering, TypeScript includes and excludes, and dot paths. No lint rules or audit thresholds are disabled.

Use npm ci with the committed lockfile. npm 10 may retain stale workspace transitive resolutions during npm install; always rerun the audit and compatibility test after dependency updates. Remove the adapter once Next removes the vulnerable dependency or a compatible upstream patch is published.
