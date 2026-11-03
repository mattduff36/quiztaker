// Older ESLint plugins require minimatch as a callable CommonJS export.
// Delegate every match to the patched upstream engine; retain both public APIs.
const modern = require('minimatch-modern');
function callable(api) {
  const implementation = typeof api === 'function' ? api : api.minimatch;
  const match = Object.assign((path, pattern, options) => implementation(path, pattern, options), api);
  match.minimatch = implementation;
  match.defaults = options => callable(api.defaults(options));
  return match;
}
module.exports = callable(modern);
// Explicit assignments also expose named exports to Node's ESM loader.
module.exports.minimatch = modern.minimatch;
module.exports.Minimatch = modern.Minimatch;
module.exports.braceExpand = modern.braceExpand;
module.exports.makeRe = modern.makeRe;
module.exports.match = modern.match;
module.exports.filter = modern.filter;
module.exports.escape = modern.escape;
module.exports.unescape = modern.unescape;
module.exports.GLOBSTAR = modern.GLOBSTAR;
module.exports.sep = modern.sep;
