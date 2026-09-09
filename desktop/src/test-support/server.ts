/**
 * Test HTTP server helper — the node:test counterpart of Go's httptest.Server.
 * Listens on port 0 so parallel test files never collide on a port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<TestServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Collects a request body as a string. */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
