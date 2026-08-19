/**
 * `git grep` 字面量搜索,供 source 的 `searchCode` 复用。
 *
 * 为什么是 git grep 而不是捆一个 ripgrep:仓库本来就是 git repo,`git grep` 免费拿到正确的
 * ignore 语义(node_modules、构建产物天然不进结果),且不给打包链多一个要签名的二进制 ——
 * 未签名二进制在 electron-builder 翻 fuses 之后是一启动就 SIGKILL。
 *
 * **只做字面量(-F),不给正则**:agent 写错的正则会产生一个看不出破绽的「0 命中」,
 * 而 0 命中恰好是最危险的返回值(见 formatSearchResult 的免责句)。字面量行为可预测,
 * 等真实使用证明不够,再加正则开关。
 */
import { spawn } from 'node:child_process';
import { resolveTool } from '../config/tool-paths';
import type { CodeSearchFileHits, CodeSearchResult } from './source';

/**
 * 每文件命中上限,同时也是 `git grep -m` 的取数上限。
 * 防一个 generated / minified 文件的几百次命中把真正的调用点挤出窗口。
 * 因为在 git 侧就截了,超限时只知道「还有更多」,给不出精确条数 —— 见 {@link CodeSearchFileHits.omitted}。
 */
const PER_FILE_LIMIT = 20;
/** 展示的文件数上限。 */
const FILE_LIMIT = 20;
/** 单行截断:压缩产物的一行可能有几万字符,整行灌进上下文没有意义。 */
const LINE_CHARS = 240;

export interface GitGrepOptions {
  /** 搜某个 tree-ish(与 `git show <ref>:<path>` 同口径);缺省搜工作区 */
  treeish?: string;
  /** 工作区模式下是否连未跟踪文件一起搜(vbranch 的新文件还没进索引) */
  untracked?: boolean;
  pathPrefix?: string;
}

/**
 * 跑一次 git grep 并按文件分组截断。
 *
 * **「没搜到」与「搜失败」必须可分**:git grep 用 exit code 1 表示无匹配(正常结果),
 * >1 才是真错误(坏 ref、不是仓库、输出撑爆 maxBuffer)。早先把两者一并吞成空结果,
 * 于是一次失败的搜索会伪装成「0 命中」—— 那正是这个工具最想拦住的反向幻觉,
 * 只不过换成由我们自己制造。故失败一律抛,由 MCP 层如实告诉 agent 搜索没跑成。
 *
 * 产出量在**读取阶段**就封顶,不是拿回全量再切:模型完全可以提交单字符 query,大仓库下那会
 * 先把几百 MB 灌进缓冲区再撞上 maxBuffer,变成上面那种假 0 命中。两道闸缺一不可 ——
 * `-m` 只管住单个文件的命中数,命中的**文件数**照样无上限,于是逐行读、数够 {@link FILE_LIMIT}
 * 个文件就杀掉子进程。
 */
export async function gitGrep(
  repo: string,
  query: string,
  opts: GitGrepOptions = {},
): Promise<CodeSearchResult> {
  // 多要一条:够我们判断「这个文件还有更多」,又不至于把命中全量拉回来。
  const args = ['-C', repo, 'grep', '-n', '-F', '-I', '-m', String(PER_FILE_LIMIT + 1)];
  if (!opts.treeish && opts.untracked) args.push('--untracked');
  // `-e` 把 query 与选项分开:以 `-` 开头的搜索词不会被当成 git 选项。
  args.push('-e', query);
  if (opts.treeish) args.push(opts.treeish);
  args.push('--');
  if (opts.pathPrefix) args.push(opts.pathPrefix);

  return collect(repo, args, opts.treeish);
}

/**
 * 逐行读 git grep 的 stdout,凑满 {@link FILE_LIMIT} 个文件就杀掉子进程。
 *
 * 提前收工不是错误,但结果**必然是截断的** —— 故置 `moreFiles`,让上层把措辞从「共 N 处」
 * 切成「已截断,不是全部」。剩下几个文件无从得知,所以它是布尔而不是计数。
 */
function collect(repo: string, args: string[], treeish?: string): Promise<CodeSearchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTool('git'), args, { cwd: repo });
    const byFile = new Map<string, { line: number; text: string }[]>();
    let total = 0;
    let truncated = false;
    let buf = '';
    let stderr = '';
    let done = false;

    const finish = (result: CodeSearchResult): void => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const result = (): CodeSearchResult => group(byFile, total, truncated);

    const take = (raw: string): void => {
      const hit = parseLine(raw, treeish);
      if (!hit) return;
      const existing = byFile.get(hit.path);
      if (!existing) {
        // 满了还来新文件 —— 到此为止,后面的不再读也不再等
        if (byFile.size >= FILE_LIMIT) {
          truncated = true;
          child.kill();
          finish(result());
          return;
        }
        byFile.set(hit.path, [{ line: hit.line, text: hit.text }]);
      } else {
        existing.push({ line: hit.line, text: hit.text });
      }
      total += 1;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0 && !done) {
        take(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // 只留个头:出错时用来说清失败原因,不必把整片 stderr 攒着
      if (stderr.length < 2000) stderr += chunk;
    });

    child.on('error', (e) => {
      if (done) return;
      done = true;
      reject(new Error(`代码搜索没能跑起来:${e.message}`));
    });
    child.on('close', (code) => {
      if (done) return; // 我们主动杀的,结果已经交出去了
      if (buf) take(buf); // 末行可能没有换行符
      // 1 = 无匹配,正常结果;0 = 有匹配;其余才是真失败(坏 ref、不是仓库…)
      if (code === 0 || code === 1) return finish(result());
      done = true;
      reject(new Error(`代码搜索没能跑起来:git grep 退出码 ${code}${stderr ? ` — ${stderr.trim()}` : ''}`));
    });
  });
}

/**
 * 一行:`<path>:<line>:<text>`(工作区)或 `<tree>:<path>:<line>:<text>`(指定了 tree-ish)。
 * 认不出的行返回 null(直接丢弃)。
 */
function parseLine(raw: string, treeish?: string): { path: string; line: number; text: string } | null {
  if (!raw) return null;
  const prefix = treeish ? `${treeish}:` : '';
  const rest = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  // 取最早的「:<数字>:」作行号段。路径里同时出现冒号与纯数字段时会切错,
  // 但那种路径在被审仓库里几乎不存在,不值得为它引入 `-z` 的 NUL 分隔解析。
  const m = /^(.*?):(\d+):([\s\S]*)$/.exec(rest);
  if (!m) return null;
  return { path: m[1], line: Number(m[2]), text: truncate(m[3].trim()) };
}

function truncate(s: string): string {
  return s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS)}…` : s;
}

function group(
  byFile: ReadonlyMap<string, { line: number; text: string }[]>,
  total: number,
  truncated: boolean,
): CodeSearchResult {
  const files: CodeSearchFileHits[] = [...byFile.entries()].map(([path, list]) => ({
    path,
    hits: list.slice(0, PER_FILE_LIMIT),
    // git 侧 -m 多取了一条,拿到超额只说明「还有更多」,数不出还有几条
    hasMore: list.length > PER_FILE_LIMIT,
  }));
  return { files, total, moreFiles: truncated };
}
