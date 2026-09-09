/** Server-Sent Events writing. Ported from the SSEWriter half of providers/streaming.go. */

import type { ServerResponse } from 'node:http';
import type { ApiError } from '../providers/errors.js';
import type { StreamChunk } from '../providers/types.js';

export class SseWriter {
  constructor(private readonly res: ServerResponse) {}

  writeHeaders(): void {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });
  }

  writeEvent(data: string): void {
    this.res.write(`data: ${data}\n\n`);
  }

  writeChunk(chunk: StreamChunk): void {
    this.writeEvent(JSON.stringify(chunk));
  }

  writeDone(): void {
    this.res.write('data: [DONE]\n\n');
  }

  writeError(err: ApiError): void {
    this.writeEvent(JSON.stringify({ error: err }));
  }
}
