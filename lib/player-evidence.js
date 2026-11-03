// Read-only player-family evidence for learner snapshots. Markers identify a
// probable authoring family, never an exact product edition, version or score.
async function observePlayerEvidence(page) {
  const markers = new Set();
  for (const frame of page.frames().slice(0, 16)) {
    if (frame.parentFrame() && !await frame.frameElement().then(el => el.isVisible()).catch(() => false)) continue;
    const found = await frame.evaluate(() => {
      const result = [];
      if (document.querySelector('.dki-authoring-element,.dki-element-content')) result.push('dki-elements');
      if (document.querySelector('.disableClaroPadding')) result.push('dki-claro-padding');
      if (document.querySelector('.flipCardPanel')) result.push('dki-flip-card');
      if (document.querySelector('.speech-bubble')) result.push('speech-bubble');
      if (document.querySelector('iframe[src*="story_html5"],script[src*="story_html5"]')) result.push('storyline-assets');
      if (document.querySelector('.rise-app,.rise-blocks')) result.push('rise-elements');
      return result;
    }).catch(() => []);
    for (const marker of found) markers.add(marker);
  }
  return `[Player DOM evidence: ${[...markers].sort().join(',') || 'unrecognized'}]`;
}

module.exports = { observePlayerEvidence };
