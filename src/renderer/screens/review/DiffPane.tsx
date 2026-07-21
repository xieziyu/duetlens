import { useEffect, useMemo, useRef } from 'react';
import type { DiffFile, DiffHunk, DiffLine } from '@shared/diff';
import type { Finding, Triage } from '@shared/domain';
import type { FindingEditInput } from '@shared/ipc';
import { InlineCard } from './InlineCard';
import { highlightLine, langOf } from './highlight';

/** 文件锚点 id:供左栏点击滚动定位。路径里的非单词字符替换成 -。 */
export function fileAnchorId(path: string): string {
  return 'df-' + path.replace(/[^\w]+/g, '-');
}

export interface DiffPaneProps {
  files: DiffFile[];
  findings: Finding[];
  /** 左栏选中的文件路径;变化时滚动到对应 file-header */
  activePath: string | null;
  /** 右栏点选的 finding;变化时滚动到内联卡并高亮 */
  focusFindingId: string | null;
  /** finding 写路径:裁决 / 就地编辑,缺省则内联卡为只读 */
  onTriage?: (finding: Finding, triage: Triage) => void;
  onUpdate?: (input: FindingEditInput) => void;
}

/**
 * 中栏 diff 主场(对齐 mockup .diff):只读 unified 渲染 + 锚定内联 finding 卡(view/edit/dismissed)。
 * split 视图、框选发起 discussion 归后续切片。
 */
export function DiffPane({ files, findings, activePath, focusFindingId, onTriage, onUpdate }: DiffPaneProps) {
  const ref = useRef<HTMLDivElement>(null);

  // 按文件聚合 findings,便于每个 DiffFileView 只拿自己的
  const byFile = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of findings) {
      const arr = m.get(f.file) ?? [];
      arr.push(f);
      m.set(f.file, arr);
    }
    return m;
  }, [findings]);

  useEffect(() => {
    if (!activePath || !ref.current) return;
    const el = ref.current.querySelector(`#${CSS.escape(fileAnchorId(activePath))}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [activePath]);

  useEffect(() => {
    if (!focusFindingId || !ref.current) return;
    const el = ref.current.querySelector(`#${CSS.escape(`finding-${focusFindingId}`)}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusFindingId]);

  if (files.length === 0) {
    return (
      <div className="diff pane" ref={ref}>
        <p className="diff-empty">暂无 diff。扫描期会在拉取改动后显示。</p>
      </div>
    );
  }

  return (
    <div className="diff pane" ref={ref}>
      {files.map((f) => (
        <DiffFileView
          key={f.path}
          file={f}
          findings={byFile.get(f.path) ?? []}
          focusFindingId={focusFindingId}
          onTriage={onTriage}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  );
}

function DiffFileView({
  file,
  findings,
  focusFindingId,
  onTriage,
  onUpdate,
}: {
  file: DiffFile;
  findings: Finding[];
  focusFindingId: string | null;
  onTriage?: (finding: Finding, triage: Triage) => void;
  onUpdate?: (input: FindingEditInput) => void;
}) {
  // 新侧存在的行号集合;锚点不在其中的 finding 归 off-diff
  const newLines = useMemo(() => {
    const s = new Set<number>();
    for (const h of file.hunks) for (const l of h.lines) if (l.newLine != null) s.add(l.newLine);
    return s;
  }, [file]);

  const lang = useMemo(() => langOf(file.path), [file.path]);
  const offDiff = findings.filter((f) => !newLines.has(f.line));
  // 锚定 findings 按新侧行号分组
  const byLine = new Map<number, Finding[]>();
  for (const f of findings) {
    if (!newLines.has(f.line)) continue;
    const arr = byLine.get(f.line) ?? [];
    arr.push(f);
    byLine.set(f.line, arr);
  }

  return (
    <section className="diff-file">
      <div className="file-header" id={fileAnchorId(file.path)}>
        <span className="fp">
          {file.oldPath && file.oldPath !== file.path && (
            <span className="dim">{file.oldPath} → </span>
          )}
          {file.path}
        </span>
        <span className="chips">
          {findings.length > 0 && <span className="mini fnd">{findings.length} finding</span>}
          {!file.binary && (
            <>
              <span className="mini add">+{file.additions}</span>
              <span className="mini del">−{file.deletions}</span>
            </>
          )}
        </span>
      </div>

      {offDiff.length > 0 && (
        <div className="offdiff">
          <div className="offdiff-head">◇ {offDiff.length} 条 off-diff finding(锚点不在当前改动新侧)</div>
          {offDiff.map((f) => (
            <InlineCard
              key={f.id}
              finding={f}
              focused={f.id === focusFindingId}
              onTriage={onTriage}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}

      {file.binary ? (
        <div className="diff-note">二进制文件,不显示逐行 diff。</div>
      ) : file.hunks.length === 0 ? (
        <div className="diff-note">无内容改动(仅重命名/模式变更)。</div>
      ) : (
        file.hunks.map((h, i) => (
          <HunkView
            key={i}
            hunk={h}
            lang={lang}
            byLine={byLine}
            focusFindingId={focusFindingId}
            onTriage={onTriage}
            onUpdate={onUpdate}
          />
        ))
      )}
    </section>
  );
}

/**
 * 单个 hunk:在锚点行处把 code 表切段,插入内联卡(对齐 mockup 的
 * table → .inline card → table 交替结构)。
 */
function HunkView({
  hunk,
  lang,
  byLine,
  focusFindingId,
  onTriage,
  onUpdate,
}: {
  hunk: DiffHunk;
  lang: string | null;
  byLine: Map<number, Finding[]>;
  focusFindingId: string | null;
  onTriage?: (finding: Finding, triage: Triage) => void;
  onUpdate?: (input: FindingEditInput) => void;
}) {
  // 把行流按「命中锚点即断段」切成 [段, 卡, 段, 卡, …]
  const segments: { lines: DiffLine[]; cardsAfter: Finding[] }[] = [];
  let cur: DiffLine[] = [];
  for (const l of hunk.lines) {
    cur.push(l);
    const hit = l.newLine != null ? byLine.get(l.newLine) : undefined;
    if (hit && hit.length > 0) {
      segments.push({ lines: cur, cardsAfter: hit });
      cur = [];
    }
  }
  if (cur.length > 0) segments.push({ lines: cur, cardsAfter: [] });

  return (
    <div className="hunk">
      <div className="hunk-label">
        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        {hunk.section && <span className="ctx">{hunk.section}</span>}
      </div>
      {segments.map((seg, i) => (
        <div key={i}>
          <table className="code">
            <tbody>
              {seg.lines.map((l, j) => (
                <LineRow key={j} line={l} lang={lang} />
              ))}
            </tbody>
          </table>
          {seg.cardsAfter.map((f) => (
            <InlineCard
              key={f.id}
              finding={f}
              focused={f.id === focusFindingId}
              onTriage={onTriage}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function LineRow({ line, lang }: { line: DiffLine; lang: string | null }) {
  const gutter = line.kind === 'add' ? '＋' : line.kind === 'del' ? '−' : '';
  const lineNo = line.kind === 'del' ? line.oldLine : line.newLine;
  const html = line.text === '' ? '&nbsp;' : highlightLine(line.text, lang);
  return (
    <tr className={`row${line.kind === 'add' ? ' add' : line.kind === 'del' ? ' del' : ''}`}>
      <td className="ln">{lineNo}</td>
      <td className="gutter">{gutter}</td>
      <td className="src" dangerouslySetInnerHTML={{ __html: html }} />
    </tr>
  );
}
