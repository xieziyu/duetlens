import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  parseSeverityLevels,
  serializeSeverityLevels,
  type EditablePromptLayer,
  type PromptFieldSection,
  type PromptLayer,
  type PromptLayerSection,
  type PromptSectionKey,
  type ReviewPromptView,
} from '@shared/prompt';
import './PromptRulesScreen.css';

// 三层审核规则提示词编辑器(→ mockup/prompt-rules.html)。
// 合并模型=分节覆盖:每节独立取 project ▸ global ▸ builtin 里最高优先且有定义的层。
// project 层落 `<cwd>/.duetlens/review.md`,需先选仓库目录;global 层落 `~/.duetlens/review.md`。
//
// 这里只呈现**可配置节**。与 MCP 契约绑定的锁定段(角色/工具流程/字段协议)由后端拼进
// baseInstructions,不下发也不展示 —— 故右栏标题是「合并后的审核规则」而非「最终 prompt」。
// structured 节(严重度)按字段编辑:档位名锁死,只有判定标准可改。

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

export function PromptRulesScreen({ onBack }: { onBack?: () => void }): React.JSX.Element {
  const [view, setView] = useState<ReviewPromptView | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [curLayer, setCurLayer] = useState<PromptLayer>('project');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (dir: string | null) => {
    const v = await window.duetlens.prompt.get(dir ?? undefined);
    setView(v);
  }, []);

  useEffect(() => {
    void load(cwd);
  }, [load, cwd]);

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
  const persistLayer = async (
    layer: EditablePromptLayer,
    mutate: (o: Partial<Record<PromptSectionKey, string>>) => void,
  ): Promise<void> => {
    if (!view || saving) return;
    const sections = layerOverrides(view, layer);
    mutate(sections);
    setSaving(true);
    try {
      const next = await window.duetlens.prompt.save({ layer, cwd: cwd ?? undefined, sections });
      setView(next);
      setEditing(null);
      setDraft('');
    } finally {
      setSaving(false);
    }
  };

  const commitSection = (layer: EditablePromptLayer, key: PromptSectionKey): void => {
    const text = draft.trim();
    void persistLayer(layer, (o) => {
      if (text) o[key] = draft;
      else delete o[key];
    });
  };
  const resetSection = (layer: EditablePromptLayer, key: PromptSectionKey): void => {
    void persistLayer(layer, (o) => {
      delete o[key];
    });
  };

  // structured 节按字段增删:改一档 → 重新序列化该节该层的全部档位(空节即整节不覆盖)。
  const writeField = (
    layer: EditablePromptLayer,
    key: PromptSectionKey,
    field: string,
    text: string | null,
  ): void => {
    void persistLayer(layer, (o) => {
      const levels = parseSeverityLevels(o[key] ?? '');
      if (text?.trim()) levels[field as keyof typeof levels] = text.trim();
      else delete levels[field as keyof typeof levels];
      const next = serializeSeverityLevels(levels);
      if (next) o[key] = next;
      else delete o[key];
    });
  };

  if (!view) return <div className="pr-loading">加载审核规则…</div>;

  const projectDisabled = view.projectPath == null;

  /** 编辑框 + 取消/保存;free 节与 structured 字段共用。 */
  const editor = (onCommit: () => void, rows: number): React.JSX.Element => (
    <textarea
      className="pr-ta"
      autoFocus
      rows={rows}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
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

  /** structured 节:档位名锁死的字段行。 */
  const fieldRow = (
    s: PromptLayerSection,
    f: PromptFieldSection,
    layer: EditablePromptLayer,
  ): React.JSX.Element => {
    const overridden = fieldText(f, layer) != null;
    const isEditing = sameTarget(editing, s.key, f.id);
    const below = belowField(f, layer);
    const commit = (): void => writeField(layer, s.key, f.id, draft);
    return (
      <div className={`pr-frow${overridden ? ' overridden' : ''}`} key={f.id}>
        <div className="fk">
          <span className={`pr-lvl ${f.id}`}>{f.label}</span>
          {/* 未覆盖时右侧已写明「继承自 X」,再挂徽标是重复 */}
          {overridden && <span className={`win ${f.winner}`}>{SRC_LABEL[f.winner]}</span>}
        </div>
        <div className="fv">
          {isEditing ? (
            editor(commit, 2)
          ) : overridden ? (
            <div className="txt">{fieldText(f, layer)}</div>
          ) : (
            <div className="txt inherit">
              继承自 <span className="from">{below.layer}</span>:{below.text}
            </div>
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
                onClick={() => writeField(layer, s.key, f.id, null)}
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
            <div className="path">
              {view.projectPath ? '.duetlens/review.md · 本仓库' : '未选仓库'}
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
            <div className="path">~/.duetlens/review.md · 你</div>
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
          </div>

          {curLayer === 'project' && projectDisabled ? (
            <div className="pr-pick">
              project 层规则随某个仓库提交,需先指定该仓库目录。
              <br />
              选定后编辑落 <code>&lt;仓库&gt;/.duetlens/review.md</code>。
              <div>
                <button onClick={() => void pickRepo()}>选择仓库目录…</button>
              </div>
            </div>
          ) : (
            view.sections.map((s) => {
              if (curLayer === 'builtin') {
                return (
                  <div className="pr-card builtinlock" key={s.key}>
                    {sectionHead(s)}
                    <div className="sb">
                      {s.kind === 'structured' ? (
                        (s.fields ?? []).map((f) => (
                          <div className="pr-frow" key={f.id}>
                            <div className="fk">
                              <span className={`pr-lvl ${f.id}`}>{f.label}</span>
                            </div>
                            <div className="fv">
                              <div className="txt">{f.builtin}</div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="txt">{s.builtin || '(无内置默认;由 project 层补充仓库背景)'}</div>
                      )}
                    </div>
                  </div>
                );
              }
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
                      <div className="txt inherit">
                        继承自 <span className="from">{below.layer}</span>:{'\n'}
                        {below.text || '(空)'}
                      </div>
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
            })
          )}
        </div>

        {/* merged preview */}
        <div className="pr-merged">
          <div className="pr-mg-head">
            <div className="t">◈ 生效结果</div>
            <div className="s">按节取最高优先层,合并后交给审核 agent。</div>
          </div>
          <div className="pr-mg-body">
            {view.sections.map((s) => {
              if (s.kind === 'structured') {
                return (
                  <div className={`pr-mblock ${s.winner}`} key={s.key}>
                    <div className="mt">
                      {s.title}
                      <span className={`src ${s.winner}`}>{SRC_LABEL[s.winner]}</span>
                    </div>
                    <div className="mtx">
                      {(s.fields ?? []).map((f) => (
                        <div className="mlvl" key={f.id}>
                          <span className={`pr-lvl ${f.id}`}>{f.label}</span>
                          <span className="lv">{fieldWinnerText(f)}</span>
                          <span className={`dot ${f.winner}`} title={SRC_LABEL[f.winner]} />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              const text = winnerText(s);
              return (
                <div className={`pr-mblock ${s.winner}`} key={s.key}>
                  <div className="mt">
                    {s.title}
                    <span className={`src ${s.winner}`}>{SRC_LABEL[s.winner]}</span>
                  </div>
                  <div className={`mtx${text.trim() ? '' : ' empty'}`}>{text.trim() || '(此节为空,不注入)'}</div>
                </div>
              );
            })}
          </div>
          <div className="pr-mg-legend">
            <span><span className="d" style={{ background: 'var(--agent)' }} />project</span>
            <span><span className="d" style={{ background: 'var(--human)' }} />global</span>
            <span><span className="d" style={{ background: 'var(--text-faint)' }} />builtin</span>
          </div>
        </div>
      </div>
    </div>
  );
}
