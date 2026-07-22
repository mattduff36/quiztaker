#!/usr/bin/env node
// pw-cdp-check.js
//
// Heartbeat for the CDP endpoint. Exits 0 if the Chromium debugging port
// responds, else exits 1. Used by the dashboard's CDP status indicator.
//
// Usage: node pw-cdp-check.js

const http = require('http');

const CDP_URL = process.env.PLAYWRIGHT_CDP_URL || 'http://127.0.0.1:9222';
const target = new URL('/json/version', CDP_URL);

const req = http.get(target, { timeout: 2000 }, (res) => {
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    if (res.statusCode === 200) {
      try {
        const info = JSON.parse(body);
        console.log(JSON.stringify({ ok: true, browser: info.Browser || null }));
      } catch {
        console.log(JSON.stringify({ ok: true }));
      }
      process.exit(0);
    } else {
      console.log(JSON.stringify({ ok: false, status: res.statusCode }));
      process.exit(1);
    }
  });
});

req.on('timeout', () => { req.destroy(); });
req.on('error', (e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
