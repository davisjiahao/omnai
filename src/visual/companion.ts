import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import {
  VISUAL_COMPANION_CSS,
  VISUAL_COMPANION_HTML,
  VISUAL_COMPANION_JS,
} from './page.js';
import { loadVisualCompanionDocument } from './types.js';

export interface VisualCompanionServer {
  url: string;
  inputPath: string;
  close(): Promise<void>;
}

export interface VisualCompanionOptions {
  port?: number;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

export async function startVisualCompanion(
  input: string,
  options: VisualCompanionOptions = {},
): Promise<VisualCompanionServer> {
  const inputPath = resolve(input);
  await loadVisualCompanionDocument(inputPath);
  const token = randomBytes(24).toString('hex');
  const prefix = `/${token}/`;
  let expectedHost = '';

  const server = createServer(async (request, response) => {
    if (request.headers.host !== expectedHost) {
      send(response, 403, 'text/plain; charset=utf-8', 'Forbidden.\n', request.method);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed.\n', request.method, { Allow: 'GET, HEAD' });
      return;
    }
    const pathname = new URL(request.url ?? '/', `http://${expectedHost}`).pathname;
    if (!pathname.startsWith(prefix)) {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found.\n', request.method);
      return;
    }
    const resource = pathname.slice(prefix.length);
    if (resource === '') {
      send(response, 200, 'text/html; charset=utf-8', VISUAL_COMPANION_HTML, request.method);
      return;
    }
    if (resource === 'style.css') {
      send(response, 200, 'text/css; charset=utf-8', VISUAL_COMPANION_CSS, request.method);
      return;
    }
    if (resource === 'app.js') {
      send(response, 200, 'text/javascript; charset=utf-8', VISUAL_COMPANION_JS, request.method);
      return;
    }
    if (resource === 'health') {
      send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ status: 'ok', schemaVersion: 1 }), request.method);
      return;
    }
    if (resource === 'document') {
      try {
        const document = await loadVisualCompanionDocument(inputPath);
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify(document), request.method);
      } catch (error) {
        send(response, 422, 'application/json; charset=utf-8', JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }), request.method);
      }
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not found.\n', request.method);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const reject = (error: Error) => rejectListen(error);
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Visual companion did not receive a loopback TCP address.');
  }
  expectedHost = `127.0.0.1:${address.port}`;
  return {
    url: `http://${expectedHost}${prefix}`,
    inputPath,
    close: () => closeServer(server),
  };
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  method: string | undefined,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(method === 'HEAD' ? undefined : body);
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
