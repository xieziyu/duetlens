import type { Readable, Writable } from 'node:stream';

/**
 * 一行一条的 JSON-RPC 2.0 over stdio。codex app-server 用这个协议:
 * client→server 请求/通知,以及 server→client 反向请求(必须应答)。
 */

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcIncoming {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcHandlers {
  /** 单向通知(无 id) */
  onNotification?: (method: string, params: unknown) => void;
  /** 反向请求(有 id + method):返回值作为 result 应答;抛错则应答 error */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  onError?: (err: Error) => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buf = '';
  private closed = false;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly handlers: JsonRpcHandlers = {},
  ) {
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => this.onData(chunk));
    stdout.on('error', (e: Error) => this.handlers.onError?.(e));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write(payload);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error('connection closed'));
    this.pending.clear();
  }

  private write(obj: unknown): void {
    if (this.closed) return;
    this.stdin.write(JSON.stringify(obj) + '\n');
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let msg: JsonRpcIncoming;
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.onError?.(new Error(`非法 JSON-RPC 行: ${line.slice(0, 200)}`));
      return;
    }

    // 响应:有 id 且带 result/error
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }

    // 反向请求:有 method 且有 id
    if (msg.method && msg.id != null) {
      this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }

    // 通知:有 method 无 id
    if (msg.method) this.handlers.onNotification?.(msg.method, msg.params);
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const respond = (body: Partial<JsonRpcResponse>) =>
      this.write({ jsonrpc: '2.0', id, ...body });
    if (!this.handlers.onServerRequest) {
      respond({ error: { code: -32601, message: `未处理的反向请求: ${method}` } });
      return;
    }
    try {
      const result = await this.handlers.onServerRequest(method, params);
      respond({ result: result ?? null });
    } catch (e) {
      respond({ error: { code: -32603, message: (e as Error).message } });
    }
  }
}
