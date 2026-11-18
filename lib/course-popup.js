'use strict';

const {publicationRoot} = require('./authored-material');
const {sabaAddress} = require('./course-launch');

function authorizedCoursePopup(source, destination) {
  if (sabaAddress(source) && sabaAddress(destination)) return true;
  try {
    const from = new URL(source), to = new URL(destination);
    return from.origin === 'https://canon-europe.csod.com' && to.origin === from.origin
      && !to.username && !to.password && Boolean(publicationRoot(destination))
      && /\/(?:index\.htm|lib_[a-z]{2}\/templates\/master\.htm)$/i.test(to.pathname);
  } catch { return false; }
}

// Existing named windows do not emit "popup". Only children of the exact
// selected opener which actually navigate during this action can be rebound.
async function watchCoursePopup(page) {
  const source = page.url(), existing = new Map(), changed = new Set(), listeners = [];
  for (const candidate of page.context().pages()) {
    if (candidate === page || candidate.isClosed() || await candidate.opener() !== page) continue;
    existing.set(candidate, candidate.url());
    const observe = frame => { if (frame === candidate.mainFrame() && candidate.url() !== existing.get(candidate)) changed.add(candidate); };
    candidate.on('framenavigated', observe);
    listeners.push(() => candidate.off('framenavigated', observe));
  }
  const opened = [];
  const onPopup = popup => opened.push(popup);
  page.on('popup', onPopup);
  return {
    async resolve(timeoutMs = 2500) {
      const until = Date.now() + timeoutMs;
      try {
        while (Date.now() < until) {
          const candidates = [...new Set([...opened, ...changed])].filter(candidate => !candidate.isClosed()
            && authorizedCoursePopup(source, candidate.url()));
          if (candidates.length > 1) throw new Error('Ambiguous course windows opened; inspect the intended page');
          if (candidates.length === 1) {
            const candidate = candidates[0];
            await candidate.waitForLoadState('domcontentloaded', {timeout:10_000});
            // Navigation may have redirected during loading.
            if (!authorizedCoursePopup(source, candidate.url())) throw new Error('Course popup left the authorized course hosts');
            return candidate;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return null;
      } finally { this.close(); }
    },
    close() { page.off('popup', onPopup); for (const remove of listeners) remove(); },
  };
}

module.exports = {authorizedCoursePopup, watchCoursePopup};
