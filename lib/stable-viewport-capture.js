'use strict';

const sharp = require('sharp');
const sessions = new WeakMap();

// A CSS-scale screenshot clip can exercise Chrome's compositor rescaling at
// non-default browser zoom. Capture the existing surface, then scale
// pixels offline: never set viewport, browser zoom or device metrics.
async function captureStableViewport(page, viewport, format = 'png') {
  let session = sessions.get(page);
  if (!session) {
    session = await page.context().newCDPSession(page);
    sessions.set(page, session);
  }
  let timer, result;
  try {
    result = await Promise.race([
      session.send('Page.captureScreenshot', {
        format, ...(format === 'jpeg' ? {quality:55} : {}),
        fromSurface:true, captureBeyondViewport:false,
      }),
      new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error('Viewport capture timed out; no frame saved')),5000);}),
    ]);
  } catch (error) {
    sessions.delete(page);
    await session.detach().catch(() => {}); // Closing targets already dispose their sessions.
    throw error;
  } finally {clearTimeout(timer);}
  const pixels = Buffer.from(result.data, 'base64');
  const metadata = await sharp(pixels, {limitInputPixels:32_000_000}).metadata();
  const ratio = viewport.dpr || 1;
  if (!metadata.width || !metadata.height
    || Math.abs(metadata.width - viewport.width * ratio) > 2
    || Math.abs(metadata.height - viewport.height * ratio) > 2) {
    throw new Error('Captured viewport dimensions changed; refusing unaligned privacy masks');
  }
  if (metadata.width === viewport.width && metadata.height === viewport.height) return pixels;
  const resized = sharp(pixels).resize(viewport.width, viewport.height, {fit:'fill'});
  return format === 'jpeg' ? resized.jpeg({quality:55}).toBuffer() : resized.png().toBuffer();
}

module.exports = {captureStableViewport};
