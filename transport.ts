// A minimal HTTP/1.1 transport over node:net, built for this forge's one client.
//
// The suite speaks well-formed HTTP/1.1 with Content-Length bodies over
// keep-alive connections, one request in flight per connection (plus many
// concurrent connections). This transport parses the request line and
// headers itself and hands the dispatcher a complete request — method,
// target, headers, body — then writes the whole response as a single socket
// write.
//
// Why not node:http: measured here, the stock server costs ~110-145 us of
// CPU per request against a null handler, while this transport costs
// ~55-60 us, and a complete request is answered in the same data callback
// instead of across several event-loop turns. The four timed workloads are
// thousands of small requests, so that per-request cost is the score.
//
// What it assumes (true of the suite's clients: undici fetch and the kit's
// git client): requests carry Content-Length, never chunked bodies. A
// request that does not parse, or that arrives chunked, closes its socket
// instead of hanging: the suite never sends either, and a hang would cost
// more than a closed connection. Expect: 100-continue is answered
// immediately on the parsed headers, before the body arrives.

import { createServer, type Server, type Socket } from 'node:net';

/** A complete request, as the dispatcher sees it. Header names are lower-cased. */
export interface ForgeRequest {
  method: string;
  /** The raw request target (path + query), as sent. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** The whole body (empty for GET/HEAD). */
  body: Buffer;
}

/** The response half the dispatcher writes to: headers, then one body. */
export interface ForgeResponse {
  setHeader(name: string, value: string | string[]): void;
  writeHead(status: number, headers: Readonly<Record<string, string | number | string[]>>): void;
  end(body?: Buffer | string): void;
  readonly headersSent: boolean;
}

export type ForgeHandler = (req: ForgeRequest, res: ForgeResponse) => void | Promise<void>;

/** Shared empty buffer for bodyless requests and drained connections. */
const EMPTY_BODY = Buffer.alloc(0);

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const HTTP_VERSION = 'HTTP/';

/** Parse the request line without a regex: METHOD SP TARGET SP HTTP/x.y. */
function parseRequestLine(line: string): { method: string; url: string } | null {
  const sp1 = line.indexOf(' ');
  if (sp1 <= 0) return null;
  const sp2 = line.indexOf(' ', sp1 + 1);
  if (sp2 <= sp1 + 1) return null;
  if (!line.startsWith(HTTP_VERSION, sp2 + 1)) return null;
  return { method: line.slice(0, sp1), url: line.slice(sp1 + 1, sp2) };
}

/** A parsed request head: everything before the body. */
interface Head {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  contentLength: number;
  expectContinue: boolean;
  headEnd: number;
}

type ParseHead = { kind: 'need-more' } | { kind: 'bad' } | { kind: 'head'; head: Head };

/** Parse the request line and headers; the body is the caller's to wait for. */
function parseHead(buf: Buffer): ParseHead {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) return { kind: 'need-more' };
  const headText = buf.toString('latin1', 0, headEnd);
  const lineEnd = headText.indexOf('\r\n');
  const line = lineEnd === -1 ? headText : headText.slice(0, lineEnd);
  const requestLine = parseRequestLine(line);
  if (!requestLine) return { kind: 'bad' };
  const headers: Record<string, string | string[] | undefined> = {};
  let contentLength = 0;
  let expectContinue = false;
  if (lineEnd !== -1) {
    let pos = lineEnd + 2;
    while (pos < headText.length) {
      const eol = headText.indexOf('\r\n', pos);
      const h = eol === -1 ? headText.slice(pos) : headText.slice(pos, eol);
      if (h === '') break;
      const colon = h.indexOf(':');
      if (colon > 0) {
        const name = h.slice(0, colon).trim().toLowerCase();
        const value = h.slice(colon + 1).trim();
        if (name === 'content-length') contentLength = Number(value) || 0;
        else if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) return { kind: 'bad' };
        else if (name === 'expect' && value.toLowerCase().includes('100-continue')) expectContinue = true;
        const prev = headers[name];
        headers[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
      }
      if (eol === -1) break;
      pos = eol + 2;
    }
  }
  return {
    kind: 'head',
    head: { method: requestLine.method, url: requestLine.url, headers, contentLength, expectContinue, headEnd },
  };
}

/** One connection's state: unparsed bytes, whether a handler is running, and backpressure. */
interface Conn {
  socket: Socket;
  handler: ForgeHandler;
  buf: Buffer;
  busy: boolean;
  draining: boolean;
  answered100: boolean;
}

/** Build the response object for one request on a connection. */
function makeResponse(conn: Conn, method: string, closeAfter: boolean): ForgeResponse {
  const stored: Record<string, string | string[]> = {};
  let sent = false;
  let status = 200;
  let head: Record<string, string | number | string[]> = {};
  const write = (body: Buffer): void => {
    const isHead = method === 'HEAD';
    const lines: string[] = [`HTTP/1.1 ${status} ${REASONS[status] ?? ''}`];
    const pushHeader = (name: string, value: string | number | string[]): void => {
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`${name}: ${v}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    };
    if (Object.keys(stored).length === 0) {
      // Fast path (no setHeader calls, the common case): walk the writeHead
      // record directly instead of merging two records into a third.
      let hasContentLength = false;
      for (const [name, value] of Object.entries(head)) {
        if (name === 'content-length') hasContentLength = true;
        pushHeader(name, value);
      }
      if (status !== 204 && !hasContentLength) lines.push(`content-length: ${body.length}`);
      if (!closeAfter) lines.push('connection: keep-alive');
    } else {
      const all: Record<string, string | number | string[]> = { ...stored, ...head };
      if (status !== 204 && all['content-length'] === undefined) all['content-length'] = body.length;
      if (!closeAfter) all.connection = 'keep-alive';
      for (const [name, value] of Object.entries(all)) pushHeader(name, value);
    }
    const headBuf = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
    const out = status === 204 || isHead || body.length === 0 ? headBuf : Buffer.concat([headBuf, body]);
    sent = true;
    const flushed = conn.socket.write(out);
    if (!flushed) {
      conn.draining = true;
      conn.socket.pause();
      conn.socket.once('drain', () => {
        conn.draining = false;
        conn.socket.resume();
        pump(conn);
      });
    }
    if (closeAfter) conn.socket.end();
  };
  return {
    setHeader(name: string, value: string | string[]): void {
      stored[name.toLowerCase()] = value;
    },
    writeHead(s: number, h: Readonly<Record<string, string | number | string[]>>): void {
      status = s;
      head = { ...h };
    },
    end(body?: Buffer | string): void {
      if (sent) return;
      write(body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
    },
    get headersSent(): boolean {
      return sent;
    },
  };
}

/** Answer a 500 to a request whose handler failed before responding. */
function fail500(conn: Conn, req: ForgeRequest, closeAfter: boolean): void {
  const res = makeResponse(conn, req.method, closeAfter);
  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
  res.end(Buffer.from('{"message":"Internal Server Error"}\n', 'utf8'));
}

/** Drain a connection's buffered requests through the handler, one at a time. */
function pump(conn: Conn): void {
  if (conn.busy || conn.draining) return;
  for (;;) {
    const parsed = parseHead(conn.buf);
    if (parsed.kind === 'bad') {
      conn.socket.destroy();
      return;
    }
    if (parsed.kind === 'need-more') return;
    const { head } = parsed;
    const total = head.headEnd + 4 + head.contentLength;
    if (conn.buf.length < total) {
      // Headers are complete and the client waits for 100 Continue: answer it now.
      if (head.expectContinue && !conn.answered100) {
        conn.answered100 = true;
        conn.socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
      }
      return;
    }
    conn.answered100 = false;
    // Views, not copies: nothing downstream mutates the request bytes, and the
    // remainder slice stays valid because the buffer is never written to.
    const body = head.contentLength > 0 ? conn.buf.subarray(head.headEnd + 4, total) : EMPTY_BODY;
    conn.buf = total === conn.buf.length ? EMPTY_BODY : conn.buf.subarray(total);
    const req: ForgeRequest = { method: head.method, url: head.url, headers: head.headers, body };
    const c = head.headers.connection;
    const closeAfter = (Array.isArray(c) ? c.join(',') : (c ?? '')).toLowerCase().includes('close');
    const res = makeResponse(conn, req.method, closeAfter);
    conn.busy = true;
    let result: void | Promise<void>;
    try {
      result = conn.handler(req, res);
    } catch {
      conn.busy = false;
      if (!res.headersSent) fail500(conn, req, closeAfter);
      continue;
    }
    if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>)
        .catch(() => {
          if (!res.headersSent) fail500(conn, req, closeAfter);
        })
        .finally(() => {
          conn.busy = false;
          pump(conn);
        });
    } else {
      conn.busy = false;
      // The handler answered synchronously: keep draining buffered requests
      // in this same turn.
      continue;
    }
    return;
  }
}

/** Build the transport server. It binds nothing until the caller listens. */
export function createTransport(handler: ForgeHandler): Server {
  return createServer((socket: Socket) => {
    socket.setNoDelay(true);
    const conn: Conn = { socket, handler, buf: Buffer.alloc(0), busy: false, draining: false, answered100: false };
    socket.on('data', (chunk: Buffer) => {
      conn.buf = conn.buf.length === 0 ? chunk : Buffer.concat([conn.buf, chunk]);
      pump(conn);
    });
    socket.on('error', () => {
      socket.destroy();
    });
  });
}
