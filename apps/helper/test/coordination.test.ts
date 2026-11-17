import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { askCoordinator, coordinateDecision } from '../src/coordination.js';

test('the connected chat can answer a bounded observation, with only observed actions returned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vitriol-coordination-'));
  const directory = join(home, 'coordination');
  await mkdir(directory);
  await writeFile(join(directory, 'connection.json'), JSON.stringify({ id: 'connection', expiresAt: Date.now() + 30_000 }));
  const waiting = askCoordinator(home, 'job', {
    url: 'https://example.com/course?token=private-value',
    buttons: [{ id: 'b1', name: 'Next', kind: 'content' }],
    image: 'data:image/jpeg;base64,private-image',
  }, 'Select the next step', 5_000);
  try {
    let filename;
    for (let attempt = 0; attempt < 50 && !filename; attempt++) {
      filename = (await readdir(directory)).find(name => name.endsWith('.request.json'));
      if (!filename) await delay(30);
    }
    assert.ok(filename);
    const raw = await readFile(join(directory, filename), 'utf8');
    assert.doesNotMatch(raw, /private-value|private-image/);
    const request = JSON.parse(raw);
    const reply = join(directory, `${request.id}.reply.json`);
    const respond = (targetId: string) => writeFile(reply, JSON.stringify({
      id: request.id, connectionId: request.connectionId, action: { action: 'click', targetId },
    }));
    await respond('b99');
    await delay(800);
    await respond('b1');
    assert.deepEqual(await waiting, { action: 'click', targetId: 'b1' });
    assert.deepEqual(await readdir(directory), ['connection.json']);
  } finally {
    await waiting;
    await rm(home, { recursive: true, force: true });
  }
});

test('routine actions continue automatically and blocked clicks ask once before pausing', async () => {
  const automatic = { action: { action: 'scroll', direction: 'down' } };
  const decide = async () => automatic;
  let asked = 0;
  const unavailable = async () => { asked++; return undefined; };
  assert.deepEqual(await coordinateDecision(decide, unavailable, {}), automatic);
  assert.equal(asked, 0);
  const blocked = await coordinateDecision(decide, unavailable, { blockedControl: true });
  assert.equal((blocked.action as { action: string }).action, 'ask-user');
  assert.equal(asked, 1);
  const action = { action: 'click', targetId: 'b1' } as const;
  assert.deepEqual(await coordinateDecision(decide, async () => action, { coordinationStart: true }), { action });
});
