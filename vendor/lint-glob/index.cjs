// The ESLint integrations use only these two tinyglobby entry points.
const { globSync: matchPaths, hasMagic } = require('glob');
const { resolve, relative, sep } = require('node:path');

const pathOptions = { windowsPathsNoEscape: process.platform === 'win32', magicalBraces: true };
const isNegated = pattern => pattern.startsWith('!') && !pattern.startsWith('!(');
const isDynamicPattern = pattern => isNegated(pattern) || hasMagic(pattern, pathOptions);

function globSync(patterns, options = {}) {
  const { cwd = process.cwd(), absolute = false, dot = false, onlyDirectories = false, expandDirectories = true, ignore = [] } = options;
  const input = [patterns].flat();
  const positive = input.filter(pattern => pattern && !isNegated(pattern));
  if (!positive.length) return [];
  // TypeScript includes can name a directory instead of a wildcard.
  const directoryContents = pattern => `${pattern.replace(/[\\/]$/, '')}/**/*`;
  const expand = paths => paths.flatMap(pattern => expandDirectories && !isDynamicPattern(pattern)
    ? [pattern, directoryContents(pattern)] : [pattern]);
  const ignored = [...[ignore].flat().filter(pattern => pattern && !isNegated(pattern)), ...input.filter(isNegated).map(pattern => pattern.slice(1))];
  const entries = matchPaths(expand(positive), {
    ...pathOptions,
    cwd,
    dot,
    follow: true,
    ignore: expand(ignored),
    nodir: !onlyDirectories,
    withFileTypes: true,
  });
  return entries.filter(entry => !onlyDirectories || entry.isDirectory()).map(entry => {
    const fullPath = entry.fullpath();
    return (absolute ? fullPath : relative(resolve(cwd), fullPath)).split(sep).join('/');
  });
}

exports.globSync = globSync;
exports.isDynamicPattern = isDynamicPattern;
