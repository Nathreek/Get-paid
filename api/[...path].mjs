import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createStore } from '../store.mjs';
import { createAppServer } from '../http-server.mjs';

const database = path.join('/tmp', 'get-paid', 'submissions.sqlite');
await mkdir(path.dirname(database), { recursive: true });
const store = createStore(database);
const server = createAppServer({
  directory: fileURLToPath(new URL('../dist/', import.meta.url)),
  store,
  secureCookies: true,
});

export default function handler(request, response) {
  if (request.url?.startsWith('/api/_route')) {
    request.url = request.url.slice('/api/_route'.length) || '/';
  }
  return new Promise((resolve) => {
    response.once('finish', resolve);
    response.once('close', resolve);
    server.emit('request', request, response);
  });
}
