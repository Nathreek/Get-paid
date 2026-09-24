import { fileURLToPath } from 'node:url';
import { waitUntil } from '@vercel/functions';
import { createAppStore } from '../app.mjs';
import { createAppServer } from '../http-server.mjs';

const store = await createAppStore();
const server = createAppServer({
  directory: fileURLToPath(new URL('../dist/', import.meta.url)),
  store,
  trustProxy: true,
  background: waitUntil,
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
