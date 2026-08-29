import { PR_COMMITS_CAP, type PrCommit } from '@shared/source-discovery';
import { BranchPicker, type BranchOption } from './BranchPicker';
import { Busy } from './Busy';
import type { DiffStatState } from './BasePicker';

/** 「整个 PR」这一档的取值。空串而非 sha —— 与 BaseRow 同一约定:默认档落库必须是 NULL。 */
export const WHOLE_PR = '';

/**
 * 「整个 PR」在选择器里的身份。**不能用显示名当身份** —— 身份一律是完整 oid,
 * 而这一档没有 oid,故给个不可能与 40 位十六进制撞上的哨兵值(含非 hex 字母)。
 */
const WHOLE_PR_KEY = 'whole-pr';

/**
 * 短 sha 一律 7 位:GitHub 自己也这么截,两边对照时不用数位数。
 * **只用于显示** —— 选中值、React key、落库一律走完整 oid,
 * 否则同一个 PR 里撞前缀的两条 commit 会共用 key、并让回查取错另一条。
 */
export const shortOid = (oid: string): string => oid.slice(0, 7);

/**
 * 「审核范围」一行:整个 PR / PR 里的某一个 commit + 按所选范围现算的改动面。
 *
 * 与 {@link BaseRow} 同构并共用 {@link BranchPicker} —— 两处都是「从候选里挑一条」,
 * 浮层的定高/上翻/筛选/键盘那套没有第二份的理由;摆成两个并排的行也让
 * 「选范围」与「选 base」看起来是同一级的两个选择,而它们确实是。
 */
export function CommitScopeRow({
  commits,
  value,
  onChange,
  stat,
  loading,
}: {
  commits: PrCommit[];
  /** 空串 = 整个 PR(默认档);否则是钉住的 commit sha */
  value: string;
  onChange: (oid: string) => void;
  stat: DiffStatState;
  loading?: boolean;
}) {
  const picks: BranchOption[] = [
    {
      name: WHOLE_PR_KEY,
      label: '整个 PR',
      kind: 'git',
      badge: '默认',
      tag: commits.length ? `全部 ${commits.length} 个提交` : '',
      meta: '',
      detail: '',
    },
    ...commits.map(
      (c): BranchOption => ({
        name: c.oid,
        label: shortOid(c.oid),
        kind: 'git',
        badge: c.isMerge ? 'merge' : undefined,
        tag: '',
        meta: `@${c.author}${c.committedDate ? ` · ${relTime(c.committedDate)}` : ''}`,
        detail: c.headline,
      }),
    ),
  ];

  return (
    <div className="picker-row base-row">
      <span className="lbl w">审核范围</span>
      <BranchPicker
        options={picks}
        value={value || WHOLE_PR_KEY}
        // 选回首行就落空串,让「跟随 PR head」与「钉死在这个 commit 上」可分(见 Review.headRef);
        // 其余情况 name 本身就是完整 oid,不必回查
        onChange={(name) => onChange(name === WHOLE_PR_KEY ? WHOLE_PR : name)}
        emptyHint="没有可选的提交"
        loading={loading}
      />
      <CommitMetric stat={stat} />
    </div>
  );
}

/**
 * 拉不到 commit 列表时的说明 + 重试。
 *
 * **只降级 commit 这一档增强能力,不挡默认路径** —— 选择器仍在、「整个 PR」仍可选、CTA 仍可点。
 * 拉取失败与「这个 PR 没有提交」必须可分:后者是事实,前者是故障,而两者都表现为空列表的话,
 * 用户只会以为这个 PR 没得选,连重试的念头都不会有。
 *
 * 画法直接复用 base 探测失败那一套(`.baseprobe.err` + `.bpr-*`),不新增样式;
 * 外层照 BaseProbeRow 摆成 `.picker-row`,靠 `.picker-row + .picker-row` 拿到行距与缩进对齐。
 */
export function CommitScopeError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="picker-row base-row">
      <span className="lbl w" />
      <div className="baseprobe err">
        <span className="bpr-ic">!</span>
        <span className="bpr-txt" title={message}>
          提交列表拉取失败 · 仍可按整个 PR 审
        </span>
        <button type="button" className="bpr-retry" onClick={onRetry}>
          重试
        </button>
      </div>
    </div>
  );
}

/**
 * 列表被 GitHub 封顶截断时的说明。不做懒加载:>250 个提交的 PR 靠翻列表找目标本就不现实,
 * 说清楚「只有最近这些」比默默少给要好。
 */
export function CommitTruncNote() {
  return (
    <div className="commit-basenote derived">
      <span className="ci">◇</span>
      <div>
        该 PR 提交数超出 GitHub 单次列举上限,仅显示<b>最近 {PR_COMMITS_CAP} 个提交</b>。
      </div>
    </div>
  );
}

function CommitMetric({ stat }: { stat: DiffStatState }) {
  // 与 BaseRow 的计量同款三态:失败要与在途可分,否则算不出的范围会永远转下去
  if (stat.state === 'error') {
    return (
      <span className="basemetric mono err" title={stat.message}>
        计量失败 · 这个范围可能已不可比
      </span>
    );
  }
  if (stat.state === 'loading') return <Busy>计量中…</Busy>;
  return (
    <span className="basemetric mono">
      {stat.value.files} files · <span className="a">+{stat.value.additions}</span>{' '}
      <span className="d">−{stat.value.deletions}</span>
    </span>
  );
}

/**
 * 钉住 commit 后原地替换 base 区的只读说明。
 * 单个 commit 的基线只可能是它的父提交,没得选 —— 留着一个选不动的选择器比撤掉更费解。
 */
export function CommitBaseNote() {
  return (
    <div className="commit-basenote derived">
      <span className="ci">◇</span>
      <div>
        相对其<b>父提交</b>审核 —— 只看这一个提交自己引入的改动,不含 PR 里它前后的其他提交。
      </div>
    </div>
  );
}

/** 相对时间(与 BranchSummary 同口径,只是入参是 ISO 串)。 */
function relTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
