import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseKeyedFields,
  serializeKeyedFields,
  type EditablePromptLayer,
  type PromptFieldSection,
  type PromptLayer,
  type PromptLayerSection,
  type PromptSectionKey,
  type ReviewPromptView,
} from '@shared/prompt';
import { imeComposing } from '../keys';
import './PromptRulesScreen.css';

// 三层审核规则提示词编辑器。
// 合并模型=分节覆盖:每节独立取 project ▸ global ▸ builtin 里最高优先且有定义的层。
// project 层落 `<cwd>/.duetlens/review.md`,需先选仓库目录;global 层落 `~/.duetlens/review.md`。
//
// 这里只呈现**可配置节**。与 MCP 契约绑定的锁定段(角色/工具流程/字段协议)由后端拼进
// baseInstructions,不下发也不展示。
// structured 节(审核重点 / 严重度)按字段编辑:字段名锁死,只有各字段正文可改。
// 审核重点的字段就是 finding 分类(FINDING_CATEGORIES),逐类别独立覆盖。
//
// 不另开一栏做合并预览:编辑区本身就是所见即所得 —— 每张卡要么显示本层覆盖的正文,要么显示
// 「继承自 X」的实际继承文本,节头再标出生效层,合并结果读这一栏即可。

const LAYER_DESC: Record<PromptLayer, string> = {
  project: '本仓库的审核规则,随代码提交、团队共享;覆盖 global 与 builtin。',
  global: '你的个人审核偏好,跨所有仓库生效;覆盖 builtin,被 project 覆盖。',
  builtin: 'Duetlens 内置基线,提供每一节的默认值;只读,通过上层覆盖来调整。',
};

const SRC_LABEL: Record<PromptLayer, string> = {
  project: 'project 覆盖',
  global: 'global 覆盖',
  builtin: '默认',
};

/** 定位正在编辑的目标:free 节只有 key,structured 节还要 field。 */
interface EditTarget {
  key: PromptSectionKey;
  field?: string;
}

const sameTarget = (a: EditTarget | null, key: PromptSectionKey, field?: string): boolean =>
  a?.key === key && a.field === field;

/** 字段 id → CSS 安全的档位标签类名(severity 的 high/low 命中配色;focus 类别名带空格,归一为中性 chip)。 */
const fieldClass = (id: string): string => `pr-lvl ${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** 后端给的是绝对路径;home 从 globalPath(`<home>/.duetlens/review.md`)反推,不为拿 homedir 另开一条 IPC。 */
function tildify(p: string, globalPath: string): string {
  const home = globalPath.slice(0, globalPath.lastIndexOf('/.duetlens/'));
  return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

const repoDirOf = (projectPath: string): string => projectPath.replace(/\/\.duetlens\/review\.md$/, '');
const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** 某节在指定层之下最近一层的继承文本(供「＋ 覆盖此节」起编与继承提示)。 */
function belowText(s: PromptLayerSection, layer: EditablePromptLayer): { layer: PromptLayer; text: string } {
  if (layer === 'project' && s.global != null) return { layer: 'global', text: s.global };
  return { layer: 'builtin', text: s.builtin };
}

function belowField(f: PromptFieldSection, layer: EditablePromptLayer): { layer: PromptLayer; text: string } {
  if (layer === 'project' && f.global != null) return { layer: 'global', text: f.global };
  return { layer: 'builtin', text: f.builtin };
}

function layerText(s: PromptLayerSection, layer: PromptLayer): string | null {
  if (layer === 'project') return s.project;
  if (layer === 'global') return s.global;
  return s.builtin;
}

function fieldText(f: PromptFieldSection, layer: PromptLayer): string | null {
  if (layer === 'project') return f.project;
  if (layer === 'global') return f.global;
  return f.builtin;
}

function winnerText(s: PromptLayerSection): string {
  return s.winner === 'project' ? (s.project ?? '') : s.winner === 'global' ? (s.global ?? '') : s.builtin;
}

function fieldWinnerText(f: PromptFieldSection): string {
  return f.winner === 'project' ? (f.project ?? '') : f.winner === 'global' ? (f.global ?? '') : f.builtin;
}

/** 从视图重建某层的全部覆盖 map(整层重写用)。 */
function layerOverrides(
  view: ReviewPromptView,
  layer: EditablePromptLayer,
): Partial<Record<PromptSectionKey, string>> {
  const out: Partial<Record<PromptSectionKey, string>> = {};
  for (const s of view.sections) {
    const v = layerText(s, layer);
    if (v != null) out[s.key] = v;
  }
  return out;
}

export function PromptRulesScreen({
  reviewId = null,
  onBack,
}: { reviewId?: string | null; onBack?: () => void }): React.JSX.Element {
  // view 必须自证属于哪个 cwd:切仓库时旧请求可能后到,而 persistLayer 是拿 view 的整层覆盖 map
  // 往当前 cwd 写的 —— 错配一次就是把 A 仓库的规则批量写进 B 仓库的文件。
  const [loaded, setLoaded] = useState<{ cwd: string | null; view: ReviewPromptView } | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  // 仓库是继承来的而非手选 —— 只用于在仓库条上标明来源,手动切换后失效
  const [fromReview, setFromReview] = useState(false);
  // 继承没成时的原因,空态卡要说清「为什么没自动带上」
  const [inheritNote, setInheritNote] = useState<string | null>(null);
  // 继承未落定前不加载:否则先按「无仓库」拉一次视图,继承到仓库再拉一次,project 层闪一下空态
  const [inheritDone, setInheritDone] = useState(reviewId == null);
  const view = loaded && loaded.cwd === cwd ? loaded.view : null;
  const [curLayer, setCurLayer] = useState<PromptLayer>('project');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // 记下失败发生在哪一层:横幅拼 curLayer 的话,切个层就把排查方向指到另一个文件上
  const [saveError, setSaveError] = useState<{ layer: EditablePromptLayer; message: string } | null>(
    null,
  );
  // 读不到规则时 view 恒为 null,整屏都渲染不出来 —— 没有这条就只剩一个不会结束的「加载中」
  const [loadError, setLoadError] = useState<string | null>(null);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // 写盘是异步的,回来时 UI 可能已经换了仓库、换了编辑目标,或就在同一个框里继续打字;
  // 三处都要按「发起时」的身份收尾
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // 开头清 loadError 兼作「重试」的反馈:错误面板立刻换回加载态,失败再挂回来。
  const load = useCallback(async (dir: string | null) => {
    setLoadError(null);
    try {
      const v = await window.duetlens.prompt.get(dir ?? undefined);
      if (cwdRef.current !== dir) return; // 已切到别的仓库,这条响应作废
      setLoaded({ cwd: dir, view: v });
    } catch (e) {
      if (cwdRef.current !== dir) return;
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 缺省编辑「当前审核那个仓库」的规则;审核无本地仓库(如 github-pr)时不继承,留给用户手选。
  useEffect(() => {
    if (reviewId == null) return;
    let alive = true;
    void (async () => {
      try {
        const r = await window.duetlens.review.get(reviewId);
        if (!alive || !r) return;
        if (!r.repoPath) {
          setInheritNote('当前审核没有本地仓库目录,没法自动带上。');
          return;
        }
        // 历史审核的 repoPath 可能已被移动或删除:后端读不到只当作「无覆盖」,但保存时
        // mkdir -p 会把规则写进一个已经不是仓库的位置,所以继承前先确认它还是个 git 仓库。
        const repo = await window.duetlens.source.inspectRepo(r.repoPath);
        if (!alive) return;
        if (!repo.isGit) {
          setInheritNote(`当前审核的仓库目录已不可用:${r.repoPath}`);
          return;
        }
        setCwd(repo.repoPath);
        setFromReview(true);
      } catch {
        if (alive) setInheritNote('读取当前审核失败,没法自动带上仓库。');
      } finally {
        // 失败也要放行,否则 prompt.get 永远被门控,连 global / builtin 层都看不了
        if (alive) setInheritDone(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reviewId]);

  useEffect(() => {
    if (!inheritDone) return;
    void load(cwd);
  }, [load, cwd, inheritDone]);

  const overrideCount = useMemo(() => {
    if (!view) return { project: 0, global: 0 };
    return {
      project: view.sections.filter((s) => s.project != null).length,
      global: view.sections.filter((s) => s.global != null).length,
    };
  }, [view]);

  const pickRepo = async (): Promise<void> => {
    const dir = await window.duetlens.dialog.pickDirectory();
    if (dir) {
      setEditing(null);
      setFromReview(false);
      setInheritNote(null);
      setSaveError(null);
      setCwd(dir);
    }
  };

  const startEdit = (target: EditTarget, initial: string): void => {
    setEditing(target);
    setDraft(initial);
  };
  const cancelEdit = (): void => {
    setEditing(null);
    setDraft('');
  };

  // 整层重写:以当前层覆盖 map 为基,应用一处增删,落库并回读合并视图。
  // closeAfter 指名成功后该收起哪个编辑器;重置类操作不由编辑框发起,传 null。
  const persistLayer = async (
    layer: EditablePromptLayer,
    mutate: (o: Partial<Record<PromptSectionKey, string>>) => void,
    closeAfter: EditTarget | null = null,
  ): Promise<void> => {
    if (!view || saving) return;
    const dir = cwd;
    const sentDraft = draft;
    const sections = layerOverrides(view, layer);
    mutate(sections);
    setSaving(true);
    setSaveError(null);
    try {
      const next = await window.duetlens.prompt.save({ layer, cwd: dir ?? undefined, sections });
      if (cwdRef.current !== dir) return;
      setLoaded({ cwd: dir, view: next });
      // 只收起发起这次保存的那个编辑框,且草稿一字未动(失败时也不收,draft 原样留着重试)。
      // 写盘期间用户可能切层另开编辑器,也可能就在这个框里继续打字 —— 后者不改 editing,
      // 只认目标就会把请求发出后新增、并未落盘的那几个字吞掉。
      if (
        closeAfter &&
        sameTarget(editingRef.current, closeAfter.key, closeAfter.field) &&
        draftRef.current === sentDraft
      ) {
        setEditing(null);
        setDraft('');
      }
    } catch (e) {
      // 目录只读 / 磁盘满 / 仓库挂载失效都从这里出来;吞掉就只剩「点了没反应」
      if (cwdRef.current === dir)
        setSaveError({ layer, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const commitSection = (layer: EditablePromptLayer, key: PromptSectionKey): void => {
    const text = draft.trim();
    void persistLayer(
      layer,
      (o) => {
        if (text) o[key] = draft;
        else delete o[key];
      },
      { key },
    );
  };
  const resetSection = (layer: EditablePromptLayer, key: PromptSectionKey): void => {
    void persistLayer(layer, (o) => {
      delete o[key];
    });
  };

  // structured 节按字段增删:改一个字段 → 重新序列化该节该层的全部字段(空节即整节不覆盖)。
  const writeField = (
    layer: EditablePromptLayer,
    s: PromptLayerSection,
    field: string,
    text: string | null,
  ): void => {
    const ids = (s.fields ?? []).map((f) => f.id);
    void persistLayer(
      layer,
      (o) => {
        const values = parseKeyedFields(o[s.key] ?? '', ids);
        if (text?.trim()) values[field] = text.trim();
        else delete values[field];
        const next = serializeKeyedFields(values, ids);
        if (next) o[s.key] = next;
        else delete o[s.key];
      },
      text != null ? { key: s.key, field } : null,
    );
  };

  // 换仓库期间 view 归 null(而不是继续显示上一个仓库的规则),编辑与保存一并被挡在门外
  if (!view) {
    // 读失败时 rail 也渲染不出来,返回/换仓库这两条出路得在这张卡里自带,否则整屏是死的
    if (loadError != null)
      return (
        <div className="pr-loadfail">
          <div className="msg">✕ 没能读到审核规则:{loadError}</div>
          <div className="acts">
            <button className="pr-btn" onClick={() => void load(cwd)}>
              重试
            </button>
            {/* 无 cwd 时失败的只可能是 global 侧,换仓库救不了,就别给这个按钮 */}
            {cwd != null && (
              <button className="pr-btn" onClick={() => void pickRepo()}>
                选择其他仓库目录…
              </button>
            )}
            {onBack && (
              <button className="pr-btn" onClick={onBack}>
                ← 返回
              </button>
            )}
          </div>
        </div>
      );
    return <div className="pr-loading">加载审核规则…</div>;
  }

  const repoDir = view.projectPath ? repoDirOf(view.projectPath) : null;
  // 只读的两种情形:内置基线本就不可改;project 层未选仓库则没有落点文件,只能看不能改
  const readOnly = curLayer === 'builtin' || (curLayer === 'project' && repoDir == null);

  /** 编辑框 + 取消/保存;free 节与 structured 字段共用。 */
  const editor = (onCommit: () => void, rows: number): React.JSX.Element => (
    <textarea
      className="pr-ta"
      autoFocus
      rows={rows}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (imeComposing(e)) return;
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        }
      }}
    />
  );

  const editActions = (onCommit: () => void): React.JSX.Element => (
    <>
      <button className="pr-btn" onClick={cancelEdit} disabled={saving}>
        取消
      </button>
      <button className="pr-save" onClick={onCommit} disabled={saving}>
        保存覆盖
      </button>
    </>
  );

  // 未覆盖:把「继承自 X」做成独立的来源标签,与继承来的规则正文分行,不再混排进正文里。
  const inheritBlock = (below: { layer: PromptLayer; text: string }): React.JSX.Element => (
    <div className="pr-inherit">
      <span className="tag">
        <span className={`d ${below.layer}`} />继承自 {below.layer}
      </span>
      <div className="txt body">{below.text.trim() || '(空)'}</div>
    </div>
  );

  /** structured 节:档位名锁死的字段行。 */
  const fieldRow = (
    s: PromptLayerSection,
    f: PromptFieldSection,
    layer: EditablePromptLayer,
  ): React.JSX.Element => {
    const overridden = fieldText(f, layer) != null;
    const isEditing = sameTarget(editing, s.key, f.id);
    const below = belowField(f, layer);
    const commit = (): void => writeField(layer, s, f.id, draft);
    return (
      <div className={`pr-frow${overridden ? ' overridden' : ''}`} key={f.id}>
        <div className="fk">
          <span className={fieldClass(f.id)}>{f.label}</span>
          {/* 未覆盖时右侧已写明「继承自 X」,再挂徽标是重复 */}
          {overridden && <span className={`win ${f.winner}`}>{SRC_LABEL[f.winner]}</span>}
        </div>
        <div className="fv">
          {isEditing ? (
            editor(commit, 2)
          ) : overridden ? (
            <div className="txt">{fieldText(f, layer)}</div>
          ) : (
            inheritBlock(below)
          )}
        </div>
        <div className="fa">
          {isEditing ? (
            editActions(commit)
          ) : overridden ? (
            <>
              <button className="pr-btn" onClick={() => startEdit({ key: s.key, field: f.id }, fieldText(f, layer) ?? '')}>
                ✎
              </button>
              <button
                className="pr-btn danger"
                onClick={() => writeField(layer, s, f.id, null)}
                disabled={saving}
                title="重置为继承"
              >
                ↺
              </button>
            </>
          ) : (
            <button className="pr-btn" onClick={() => startEdit({ key: s.key, field: f.id }, below.text)}>
              ＋ 覆盖
            </button>
          )}
        </div>
      </div>
    );
  };

  const sectionHead = (s: PromptLayerSection): React.JSX.Element => (
    <div className="sh">
      <div className="stwrap">
        <span className="st">{s.title}</span>
        <span className="shint">{s.hint}</span>
      </div>
      <span className={`win ${s.winner}`}>生效层 {s.winner}</span>
    </div>
  );

  /**
   * 只读卡。两种取值口径:builtin 层看内置默认;project 层未选仓库时看「global ▸ builtin」的
   * 生效值 —— 没有落点文件就编辑不了,但规则本身照样要能读到。
   */
  const readOnlyCard = (s: PromptLayerSection, source: 'builtin' | 'effective'): React.JSX.Element => {
    const eff = source === 'effective';
    const text = eff ? winnerText(s) : s.builtin;
    return (
      <div className="pr-card builtinlock" key={s.key}>
        {sectionHead(s)}
        <div className={`sb${s.kind === 'structured' ? ' structured' : ''}`}>
          {s.kind === 'structured' ? (
            (s.fields ?? []).map((f) => (
              <div className="pr-frow" key={f.id}>
                <div className="fk">
                  <span className={fieldClass(f.id)}>{f.label}</span>
                  {/* 整节徽标看不出「只改了 high」,逐档标出来源;内置层三档同源,不必标 */}
                  {eff && f.winner !== 'builtin' && (
                    <span className={`win ${f.winner}`}>{SRC_LABEL[f.winner]}</span>
                  )}
                </div>
                <div className="fv">
                  <div className="txt">{eff ? fieldWinnerText(f) : f.builtin}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="txt">
              {text.trim() ||
                (eff ? '(此节为空,不注入)' : '(无内置默认;由 project 层补充仓库背景)')}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="prompt-rules">
      <div className="pr-ribbon">
        <span>优先级</span>
        <div className="chain">
          <span className="lz project"><span className="d" />project</span>
          <span className="arw">▸</span>
          <span className="lz global"><span className="d" />global</span>
          <span className="arw">▸</span>
          <span className="lz builtin"><span className="d" />builtin</span>
        </div>
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>上层按节覆盖下层</span>
        <span className="note">这些规则决定 agent 的审核口径;上报字段的格式由 Duetlens 固定</span>
      </div>

      <div className="pr-main">
        {/* rail */}
        <div className="pr-rail">
          <div className="h">编辑层</div>
          <button
            className={`pr-layer${curLayer === 'project' ? ' on' : ''}`}
            onClick={() => {
              setCurLayer('project');
              setEditing(null);
            }}
          >
            <div className="top">
              <span className="pr-tag project" />
              <span className="nm">project</span>
              <span className={`badge${curLayer === 'project' ? ' act' : ''}`}>
                覆盖 {overrideCount.project} 节
              </span>
            </div>
            {/* 落点文件路径由编辑器头部的仓库条给全,这里只认仓库 */}
            <div className="path" title={repoDir ?? undefined}>
              {repoDir ? basename(repoDir) : '未选仓库'}
            </div>
            <div className="cnt">随仓库提交,团队共享</div>
          </button>
          <button
            className={`pr-layer${curLayer === 'global' ? ' on' : ''}`}
            onClick={() => {
              setCurLayer('global');
              setEditing(null);
            }}
          >
            <div className="top">
              <span className="pr-tag global" />
              <span className="nm">global</span>
              <span className={`badge${curLayer === 'global' ? ' act' : ''}`}>
                覆盖 {overrideCount.global} 节
              </span>
            </div>
            <div className="path">{tildify(view.globalPath, view.globalPath)} · 你</div>
            <div className="cnt">个人偏好,跨所有仓库</div>
          </button>
          <button
            className={`pr-layer${curLayer === 'builtin' ? ' on' : ''}`}
            onClick={() => {
              setCurLayer('builtin');
              setEditing(null);
            }}
          >
            <div className="top">
              <span className="pr-tag builtin" />
              <span className="nm">builtin</span>
              <span className="badge">只读基线</span>
            </div>
            <div className="path">Duetlens 内置</div>
            <div className="cnt">全部节的默认,不可编辑</div>
          </button>
          {onBack && (
            <button className="pr-btn" style={{ width: '100%', marginTop: 6 }} onClick={onBack}>
              ← 返回
            </button>
          )}
        </div>

        {/* editor */}
        <div className="pr-editor">
          <div className="pr-ed-head">
            <div className="t">
              <span className={`pr-tag ${curLayer}`} />
              {curLayer} 层
            </div>
            <div className="s">{LAYER_DESC[curLayer]}</div>
            {/* 保存在途时不许换仓库:那笔写入认的是切换前的 cwd */}
            {curLayer === 'project' &&
              (repoDir ? (
                <div className="pr-repo">
                  <span className="ic">⌂</span>
                  <span className="nm">{basename(repoDir)}</span>
                  {fromReview && <span className="src">来自当前审核</span>}
                  <span className="dir" title={repoDir}>
                    {tildify(repoDir, view.globalPath)}
                  </span>
                  <code className="rel">.duetlens/review.md</code>
                  <button className="pr-btn" onClick={() => void pickRepo()} disabled={saving}>
                    切换…
                  </button>
                </div>
              ) : (
                <div className="pr-pick">
                  <span className="ic">⌂</span>
                  <span className="nm">未选仓库</span>
                  <span className="msg">
                    {inheritNote ?? 'project 层规则随某个仓库提交,需先指定该仓库目录。'}
                  </span>
                  <code className="rel">&lt;仓库&gt;/.duetlens/review.md</code>
                  <button onClick={() => void pickRepo()} disabled={saving}>
                    选择仓库目录…
                  </button>
                </div>
              ))}
          </div>

          {/* 失败的动作可能在任意卡片上(整节 / 单字段 / 重置),所以错误挂在栏顶而不是某张卡里 */}
          {saveError && (
            <div className="pr-err">
              ✕ 没能保存到 {saveError.layer} 层:{saveError.message}
            </div>
          )}

          {/* 未选仓库时 project 层无处落盘,但下面照样把各节铺开 —— 此时的生效值就是 global ▸ builtin */}
          {readOnly && (
            <div className="pr-ronote">
              {curLayer === 'builtin'
                ? '内置基线只读,要调整就在上层覆盖对应的节。'
                : '未选仓库,project 层无覆盖:以下是当前生效的规则(global ▸ builtin),选定仓库后即可逐节覆盖。'}
            </div>
          )}

          {view.sections.map((s) => {
            if (readOnly) return readOnlyCard(s, curLayer === 'builtin' ? 'builtin' : 'effective');
            const layer = curLayer as EditablePromptLayer;
            const overridden = layerText(s, layer) != null;

            if (s.kind === 'structured') {
              return (
                <div className={`pr-card${overridden ? ' overridden' : ''}`} key={s.key}>
                  {sectionHead(s)}
                  <div className="sb structured">
                    {(s.fields ?? []).map((f) => fieldRow(s, f, layer))}
                  </div>
                </div>
              );
            }

            const isEditing = sameTarget(editing, s.key);
            const below = belowText(s, layer);
            const commit = (): void => commitSection(layer, s.key);
            return (
              <div className={`pr-card${overridden ? ' overridden' : ''}`} key={s.key}>
                {sectionHead(s)}
                <div className="sb">
                  {isEditing ? (
                    editor(commit, 8)
                  ) : overridden ? (
                    <div className="txt">{layerText(s, layer)}</div>
                  ) : (
                    inheritBlock(below)
                  )}
                </div>
                <div className="sf">
                  {isEditing ? (
                    editActions(commit)
                  ) : overridden ? (
                    <>
                      <button
                        className="pr-btn"
                        onClick={() => startEdit({ key: s.key }, layerText(s, layer) ?? '')}
                      >
                        ✎ 编辑
                      </button>
                      <button
                        className="pr-btn danger"
                        onClick={() => resetSection(layer, s.key)}
                        disabled={saving}
                      >
                        重置(改回继承)
                      </button>
                    </>
                  ) : (
                    <button className="pr-btn" onClick={() => startEdit({ key: s.key }, below.text)}>
                      ＋ 覆盖此节
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
