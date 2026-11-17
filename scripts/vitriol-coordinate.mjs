import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const owner = process.env.CODEX_THREAD_ID;
if (!owner) throw new Error('Run this command from the Codex chat that should co-ordinate with Vitriol.');
const home = process.env.QUIZTAKER_HOME || join(process.env.LOCALAPPDATA, 'QuizTaker Helper');
const directory = join(home, 'coordination');
const connectionFile = join(directory, 'connection.json');
const [command, requestId] = process.argv.slice(2);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function publish(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const connection = await readJson(connectionFile);
if (command === 'connect') {
  if (connection?.expiresAt > Date.now() && connection.owner !== owner) {
    throw new Error('Another Codex chat is already connected to this helper.');
  }
  await mkdir(directory, { recursive: true });
  await publish(connectionFile, {
    id: connection?.owner === owner && connection.expiresAt > Date.now() ? connection.id : randomUUID(),
    owner,
    expiresAt: Date.now() + 4 * 60 * 60_000,
  });
  console.log('This chat is connected to Vitriol for four hours.');
} else {
  if (connection?.owner !== owner || !(connection.expiresAt > Date.now())) {
    throw new Error('This Codex chat has no active Vitriol connection. Run connect first.');
  }
  if (command === 'pending') {
    const files = (await readdir(directory)).filter(file => file.endsWith('.request.json'));
    const requests = await Promise.all(files.map(file => readJson(join(directory, file))));
    for (const request of requests) {
      if (request?.connectionId === connection.id && request.expiresAt > Date.now()) {
        console.log(JSON.stringify(request));
      }
    }
  } else if (command === 'reply') {
    if (!/^[0-9a-f-]{36}$/.test(requestId ?? '')) throw new Error('A request ID is required.');
    const request = await readJson(join(directory, `${requestId}.request.json`));
    if (request?.id !== requestId || request.connectionId !== connection.id || request.expiresAt <= Date.now()) {
      throw new Error('The course request has expired or belongs to a different connection.');
    }
    const buffers = [];
    for await (const chunk of process.stdin) buffers.push(chunk);
    const action = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    await publish(join(directory, `${requestId}.reply.json`), { id: requestId, connectionId: connection.id, action });
    console.log('Guidance sent for Vitriol to validate.');
  } else if (command === 'disconnect') {
    await rm(connectionFile);
    console.log('This chat disconnected from Vitriol.');
  } else {
    throw new Error('Use connect, pending, reply <request-id>, or disconnect.');
  }
}
