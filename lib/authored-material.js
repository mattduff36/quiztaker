// Read only referenced Brightwave/Waveform publication sources in the selected authenticated
// course frame. No LMS writes, hidden answer keys, URL guessing or server fetches.
'use strict';

const LIMITS = Object.freeze({ requests: 200, pages: 160, depth: 6, bytes: 8 * 1024 * 1024,
  responseBytes: 512 * 1024, ms: 45_000, chars: 220_000, chunks: 32 });

function publicationRoot(address) {
  try {
    const url = new URL(address);
    const match = /^\/content\/canon-europe\/publications\/\d+\//.exec(url.pathname);
    if (url.origin !== 'https://canon-europe.csod.com' || url.username || url.password || !match) return null;
    return url.origin + match[0];
  } catch { return null; }
}

function scopedSource(reference, base, root) {
  if (typeof reference !== 'string' || !reference || /[%\\?#\x00-\x20]/.test(reference)) return null;
  try {
    const url = new URL(reference, base);
    return url.href.startsWith(root) && !url.username && !url.password && !url.search && !url.hash
      && /\.(?:htm|html|js|xml)$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

const uncomment = text => text.replace(/<!--[\s\S]*?-->/g, '');
function sourceText(xml) {
  return [...uncomment(xml).matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map(match => match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|li|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
      const named = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
    }).replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function browserSourceRead(frame, url, maxBytes, timeoutMs) {
  return frame.evaluate(async ({ url, root, maxBytes, timeoutMs }) => {
    const selectedRoot = /^\/content\/canon-europe\/publications\/\d+\//.exec(location.pathname)?.[0];
    if (!selectedRoot || location.origin + selectedRoot !== root) return {error:'selected publication changed'};
    // redirect:error prevents even the first redirected request, including SSO.
    const response = await fetch(url, { credentials: 'same-origin', redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    const refused = !response.ok ? `HTTP ${response.status}`
      : !/text|xml|javascript/i.test(response.headers.get('content-type') || '') ? 'non-text source'
      : Number(response.headers.get('content-length')) > maxBytes ? 'response byte limit' : null;
    if (refused) {await response.body?.cancel();return {error:refused,bytes:0};}
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); return { error: 'response byte limit', bytes }; }
        text += decoder.decode(part.value, { stream: true });
      }
      return { text: text + decoder.decode(), bytes };
    } finally { reader.releaseLock(); }
  }, { url, root:publicationRoot(url), maxBytes, timeoutMs });
}

async function collectAuthoredMaterial(frame, { read = browserSourceRead, limits = LIMITS, title = 'Course' } = {}) {
  const address = frame.url(), root = publicationRoot(address);
  if (!root || !/\/(?:index\.htm|lib_[a-z]{2}(?:-[a-z]{2})?\/(?:templates\/master\.htm|html\/course\.htm))$/i.test(new URL(address).pathname)) return null;
  const started = Date.now(), seen = new Set(), gaps = [], materials = [];
  let requests = 0, bytes = 0, pages = 0, chars = 0, stopped = false;
  const gap = (url, reason) => { if (gaps.length < 40) gaps.push({ source: url.slice(root.length), reason }); };
  async function get(url) {
    if (!url || stopped) return null;
    if (requests >= limits.requests || bytes >= limits.bytes || Date.now() - started >= limits.ms) {
      stopped = true; gap(url, 'collection limit'); return null;
    }
    requests++;
    let timer;
    try {
      const timeoutMs = Math.max(1, Math.min(5000, limits.ms - (Date.now() - started)));
      const result = await Promise.race([
        read(frame, url, Math.min(limits.responseBytes, limits.bytes - bytes), timeoutMs),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('source timeout')),timeoutMs);}),
      ]);
      const size = result.bytes ?? Buffer.byteLength(result.text || '');
      bytes += size;
      if (size > limits.responseBytes || bytes > limits.bytes) { stopped = true; gap(url, 'byte limit'); return null; }
      if (result.error) { gap(url, result.error); return null; }
      return uncomment(result.text);
    } catch { gap(url, 'source unavailable, timed out or redirect blocked'); return null; }
    finally {clearTimeout(timer);}
  }
  let master = scopedSource(address.split(/[?#]/)[0], address, root);
  if (/\/index\.htm$/.test(master || '')) {
    const index = await get(master);
    const splashRef = index?.match(/<script\b[^>]*\bsrc\s*=\s*["']([^"']*splash\.js)["']/i)?.[1];
    const splashUrl = scopedSource(splashRef, master, root);
    const splash = splashUrl && await get(splashUrl);
    // Resolve only the loader's observed language expression, not publication IDs.
    const language = index?.match(/<html\b[^>]*\blang=["']([a-z]{2})["']/i)?.[1]
      || splash?.match(/\b(?:var\s+)?lang\s*=\s*["']([a-z]{2})["']/i)?.[1];
    const template = splash?.match(/["'](lib_)["']\s*\+\s*lang\s*\+\s*["'](\/templates\/master\.htm)["']/i);
    const literal = splash?.match(/["'](lib_[a-z]{2}\/templates\/master\.htm)["']/i)?.[1];
    master = scopedSource(literal || (template && language ? `${template[1]}${language}${template[2]}` : ''), address, root);
    if (!master || master === address) { gap(address, 'unsupported or unobserved language loader'); return { root, materials, pages, requests, bytes, gaps, incomplete: true }; }
  }
  const html = master && await get(master);
  const courseRef = html?.match(/<script\b[^>]*\bsrc=["']([^"']*\/course\.js)["']/i)?.[1];
  const courseUrl = scopedSource(courseRef, master, root);
  const loader = courseUrl && await get(courseUrl);
  const manifestRef = loader?.match(/\bmasterObj\.init\(\s*["']([^"']+\.xml)["']/)?.[1];
  let manifestUrl = scopedSource(manifestRef, master, root);
  if (!manifestUrl && /\/html\/course\.htm$/i.test(master || '')) {
    const resources = typeof frame.evaluate === 'function' ? await frame.evaluate(() =>
      performance.getEntriesByType('resource').slice(-400).map(entry => entry.name)).catch(() => []) : [];
    const languageRoot = master.replace(/\/html\/course\.htm$/i, '/');
    const manifests = [...new Set(resources.map(url => scopedSource(url, master, root))
      .filter(url => url && url.startsWith(languageRoot) && /\/xml\/master\.xml$/i.test(url)))];
    if (manifests.length === 1) manifestUrl = manifests[0];
    else gap(master, manifests.length ? 'ambiguous observed manifests' : 'no observed authored manifest resource');
  }
  const manifest = manifestUrl && await get(manifestUrl);
  if (!manifest) { gap(master || address, 'authored manifest unavailable'); return { root, materials, pages, requests, bytes, gaps, incomplete: true }; }
  const queue = [];
  function enqueue(xml, depth, onlyPages = false) {
    const pattern = onlyPages ? /<page\b[^>]*\bxml=["']([^"']+)["']/gi : /<dialogue\b[^>]*\bxml=["']([^"']+)["']/gi;
    for (const match of xml.matchAll(pattern)) {
      const url = scopedSource(match[1], master, root);
      if (!url) { gap(master, 'out-of-scope reference excluded'); continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      if (depth > limits.depth || seen.size > limits.pages) { gap(url, 'page/depth limit'); continue; }
      queue.push({ url, depth });
    }
  }
  enqueue(manifest, 0, true);
  while (queue.length && !stopped) {
    const { url, depth } = queue.shift();
    const xml = await get(url);
    if (!xml) continue;
    pages++;
    if (/\b(?:quiz|assessment|exam|question|test)[_-]?\d*\.xml$/i.test(url)
      || /<(?:questions?|answers?|assessment|quiz)\b|\b(?:correctAnswer|isCorrect|correct)\s*=/i.test(xml)) {
      gap(url, 'assessment source excluded; use observed quiz controls');
      continue;
    }
    enqueue(xml, depth + 1);
    const text = sourceText(xml);
    if (!text) gap(url, 'textless page; inspect images/interactions visually');
    if (/<(?:image|img)\b|\b(?:src|image)=["'][^"']+\.(?:jpg|png|gif|svg)/i.test(xml)) gap(url, 'image content not extracted');
    // Pack short pages together: a chunk limit is not a lesson-page limit.
    // Every excerpt retains its exact source, including continued long pages.
    for (let offset = 0; offset < text.length;) {
      const heading = `\n\n[Authored lesson source: ${url}]\n`;
      let chunk = materials.at(-1);
      if (!chunk || chunk.text.length + heading.length >= 7400) {
        if (materials.length >= limits.chunks) { stopped = true; gap(url, 'retained text limit'); break; }
        chunk = {title: `${title} - source group ${materials.length + 1}`.slice(0, 200), url, text: ''};
        materials.push(chunk);
      }
      const count = Math.min(text.length - offset, 7400 - chunk.text.length - heading.length,
        limits.chars - chars - heading.length);
      if (count <= 0) { stopped = true; gap(url, 'retained text limit'); if (!chunk.text) materials.pop(); break; }
      chunk.text += heading + text.slice(offset, offset + count);
      chars += heading.length + count;
      offset += count;
    }
  }
  return { root, materials, pages, requests, bytes, gaps, incomplete: stopped || gaps.length > 0,
    note: 'Authored text collected, not proof of visual reading, learned material or LMS completion.' };
}

module.exports = { LIMITS, publicationRoot, scopedSource, sourceText, collectAuthoredMaterial, browserSourceRead };
