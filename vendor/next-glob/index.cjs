// Compatibility surface used by @next/eslint-plugin-next get-root-dirs.
// fast-glob preserves absolute patterns; tinyglobby requires absolute:true.
const { isAbsolute } = require('node:path');
const { globSync: tinyGlobSync } = require('tinyglobby');
exports.globSync = function globSync(pattern, options = {}) {
  if (typeof pattern !== 'string') throw new TypeError('Next rootDir must be a string');
  return tinyGlobSync(pattern, { ...options, absolute: isAbsolute(pattern) });
};
