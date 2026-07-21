import { useEffect, useRef } from 'react';
import type { DiffFile, DiffHunk, DiffLine } from '@shared/diff';

/** 文件锚点 id:供左栏点击滚动定位。路径里的非单词字符替换成 -。 */
export function fileAnchorId(path: string): string {
  return 'df-' + path.replace(/[^\w]+/g, '-');
}

export interface DiffPaneProps {
  files: DiffFile[];
  /** 左栏选中的文件路径;变化时滚动到对应 file-header */
  activePath: string | null;
}

/**
 * 中栏 diff 主场(对齐 mockup .diff):只读 unified 渲染。
 * split 视图、内联 finding 卡、框选发起 discussion 归后续切片。
 */
export function DiffPane({ files, activePath }: DiffPaneProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activePath || !ref.current) return;
    const el = ref.current.querySelector(`#${CSS.escape(fileAnchorId(activePath))}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [activePath]);

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
        <DiffFileView key={f.path} file={f} />
      ))}
    </div>
  );
}

function DiffFileView({ file }: { file: DiffFile }) {
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
          {!file.binary && (
            <>
              <span className="mini add">+{file.additions}</span>
              <span className="mini del">−{file.deletions}</span>
            </>
          )}
        </span>
      </div>

      {file.binary ? (
        <div className="diff-note">二进制文件,不显示逐行 diff。</div>
      ) : file.hunks.length === 0 ? (
        <div className="diff-note">无内容改动(仅重命名/模式变更)。</div>
      ) : (
        file.hunks.map((h, i) => <HunkView key={i} hunk={h} />)
      )}
    </section>
  );
}

function HunkView({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="hunk">
      <div className="hunk-label">
        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        {hunk.section && <span className="ctx">{hunk.section}</span>}
      </div>
      <table className="code">
        <tbody>
          {hunk.lines.map((l, i) => (
            <LineRow key={i} line={l} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineRow({ line }: { line: DiffLine }) {
  const gutter = line.kind === 'add' ? '＋' : line.kind === 'del' ? '−' : '';
  const lineNo = line.kind === 'del' ? line.oldLine : line.newLine;
  return (
    <tr className={`row${line.kind === 'add' ? ' add' : line.kind === 'del' ? ' del' : ''}`}>
      <td className="ln">{lineNo}</td>
      <td className="gutter">{gutter}</td>
      <td className="src">{line.text === '' ? ' ' : line.text}</td>
    </tr>
  );
}
