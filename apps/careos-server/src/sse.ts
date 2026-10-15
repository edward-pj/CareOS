import type { Request, Response } from "express";

export interface SseStream {
  send(event: string, data: unknown, id?: number | string): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Opens a Server-Sent-Events response. A comment-line heartbeat keeps idle connections
 * alive through proxies/load balancers that drop silent sockets (ALB, App Runner, CloudFront).
 */
export function openSse(req: Request, res: Response, heartbeatMs = 25_000): SseStream {
  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 2000\n\n");

  let closed = false;
  const beat = setInterval(() => { if (!closed) res.write(":ping\n\n"); }, heartbeatMs);
  const stop = () => { if (closed) return; closed = true; clearInterval(beat); };
  req.on("close", stop);
  res.on("close", stop);

  return {
    get closed() { return closed; },
    send(event, data, id) {
      if (closed) return;
      res.write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() { stop(); res.end(); },
  };
}
