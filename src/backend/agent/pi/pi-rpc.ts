import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolveTool } from '../../config/tool-paths';

export type PiMessage = Record<string, unknown>;

/** RPC 应答。`success: false` 只表示命令在受理前被拒;受理之后的失败走事件流。 */
export interface PiResponse extends PiMessage {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface PiRpcOptions {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
}

const REQUEST_TIMEOUT_MS = 15_000;
/** stderr 只留尾部:定性失败时要的是最后那几行,不是整场启动日志。 */
const STDERR_KEEP = 4_000;

/**
 * `pi --mode rpc` 子进程的 JSONL 通道。
 *
 * 帧只按 LF 切、容忍尾随 CR —— pi 的 rpc.md 明确要求,Node `readline` 会在
 * U+2028/2029 处多切一刀,而它们在 JSON 字符串里是合法字符,故不能用。
 *
 * 事件:'event' (PiMessage) · 'exit' (code, stderrTail)。
 */
export class PiRpc extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (r: PiResponse) => void; reject: (e: Error) => void }>();
  private buf = '';
  private stderr = '';
  private exited = false;

  constructor(opts: PiRpcOptions) {
    super();
    this.child = spawn(resolveTool('pi'), ['--mode', 'rpc', ...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_KEEP);
      opts.onLog?.(d.trimEnd());
    });
    // spawn 失败(找不到二进制)只走 'error',不会有 'exit' —— 两条都要收成同一种终局
    this.child.on('error', (e) => this.onExit(null, e.message));
    this.child.on('exit', (code) => this.onExit(code));
  }

  /** stderr 尾部。pi 的诊断只写在这里:extension 加载失败时 stdout 一个字节都没有。 */
  stderrTail(): string {
    return this.stderr.trim();
  }

  isAlive(): boolean {
    return !this.exited;
  }

  send(type: string, extra: PiMessage = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PiResponse> {
    if (this.exited) return Promise.reject(new Error(`pi 进程已退出,无法发送 ${type}`));
    const id = randomUUID();
    return new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi 的 ${type} 应答超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ type, id, ...extra })}\n`);
    });
  }

  kill(): void {
    if (!this.exited) this.child.kill();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: PiMessage;
      try {
        msg = JSON.parse(line) as PiMessage;
      } catch {
        // 非 JSONL 的噪声行(启动横幅之类);吞掉,别让一行噪声带走整条会话
        continue;
      }
      const id = typeof msg.id === 'string' ? msg.id : undefined;
      const waiter = msg.type === 'response' && id ? this.pending.get(id) : undefined;
      if (waiter) {
        this.pending.delete(id!);
        waiter.resolve(msg as PiResponse);
      } else {
        this.emit('event', msg);
      }
    }
  }

  private onExit(code: number | null, spawnError?: string): void {
    if (this.exited) return;
    this.exited = true;
    const tail = spawnError ?? this.stderrTail();
    const err = new Error(`pi 进程已退出(code=${code ?? '?'})${tail ? `:${tail}` : ''}`);
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
    this.emit('exit', code, tail);
  }
}
