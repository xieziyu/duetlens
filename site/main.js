// 官网入口。产品截面的样式直接取应用那几份 —— 组件形态与配色跟着应用走,
// 这里不另抄一份(见 landing.css 顶部的说明)。
import '../src/renderer/theme/tokens.css';
import '../src/renderer/screens/ReviewScreen.css';
import '../src/renderer/screens/review/review-syntax.css';
import '../src/renderer/screens/submit/SubmitGitHubScreen.css';
// wordmark(duet + lens 天蓝 + _ 琥珀闪烁)与 .dl-mark 的调色板都在这份里
import '../src/renderer/App.css';
import './landing.css';
// 标记的几何唯一来源是 build/logo/*.svg —— 同应用的 LogoMark,这里只做同样的调色板替换
import markSmall from '../build/logo/mark-small.svg?raw';
import markTiny from '../build/logo/mark-tiny.svg?raw';
// 仓库 / issue / 作者外链的唯一来源同样是应用里那份,别在页面上再抄一遍地址
import { PROJECT_LINKS } from '../src/shared/links';

// 发布页与 CHANGELOG 由 repo 现推 —— links.ts 只收口"项目在哪",不收口仓库内的路径
const LINKS = {
  ...PROJECT_LINKS,
  releases: `${PROJECT_LINKS.repo}/releases/latest`,
  changelog: `${PROJECT_LINKS.repo}/blob/main/CHANGELOG.md`,
  license: `${PROJECT_LINKS.repo}/blob/main/LICENSE`,
};
document.querySelectorAll('[data-link]').forEach((a) => {
  const href = LINKS[a.dataset.link];
  if (!href) return;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
});
document.getElementById('year').textContent = String(new Date().getFullYear());

// ---- 品牌标记:几何取自 build/logo,固定色板换成 .dl-mark 上的变量,defs id 按实例改写 ----
const MARK_PALETTE = [
  [/#4a5261/g, 'var(--mk-code)'],
  [/#7a8698/g, 'var(--mk-ctx)'],
  [/#58a6f7/g, 'var(--mk-agent)'],
  [/#e8a24d/g, 'var(--mk-human)'],
  [/#8b98aa|#9aa6b8/g, 'var(--mk-ring)'],
  [/#fff\b/g, 'var(--mk-gloss)'],
];
document.querySelectorAll('.dl-mark').forEach((svg, i) => {
  // 分档同 LogoMark:20px 以下的细行会糊成噪点,降到 tiny
  const src = Number(svg.getAttribute('width')) > 20 ? markSmall : markTiny;
  let inner = src.slice(src.indexOf('>', src.indexOf('<svg')) + 1, src.lastIndexOf('</svg>'));
  for (const [re, v] of MARK_PALETTE) inner = inner.replace(re, v);
  svg.innerHTML = inner
    .replace(/id="([\w-]+)"/g, `id="$1-${i}"`)
    .replace(/url\(#([\w-]+)\)/g, `url(#$1-${i})`);
});

const panels = [...document.querySelectorAll('.stage-panel')];
const acts = [...document.querySelectorAll('.lp-act')];
const bars = [...document.querySelectorAll('.lp-rail .bars i')];
const railName = document.getElementById('railName');
const nav = document.getElementById('nav');

const RAIL = ['01 — 机审边扫边落', '02 — 在 diff 上对话', '03 — 重跑复核三态', '04 — 提交 / 导出'];
// 底部状态栏跟着幕次走:它在应用里就是运行态的唯一常驻出口
const STATUS = [
  { cls: 's-reviewing', tx: '扫描中', round: '第 1 轮', ctx: '63K / 258K · 24%' },
  { cls: 's-reviewing', tx: '进行中', round: '第 1 轮 · 8 条讨论', ctx: '96K / 258K · 37%' },
  { cls: 's-reviewing', tx: '第 2 轮', round: '第 2 轮 · 修 1 · 新 1 · 抑 2', ctx: '58K / 258K · 22%' },
  { cls: 's-completed', tx: '已完成', round: '4 条待提交', ctx: '58K / 258K · 22%' },
];

const REPLY =
  '近似进度也要跨线程,所以仍需原子类型,但 Relaxed 顺序就够 —— ' +
  '它只保证单变量自身的原子性、不约束周围读写的重排,开销接近裸加:' +
  'counter.fetch_add(1, Ordering::Relaxed);';

let current = -1;
let timers = [];

function clearTimers() {
  timers.forEach((t) => {
    clearTimeout(t);
    clearInterval(t);
  });
  timers = [];
}
const later = (fn, ms) => timers.push(setTimeout(fn, ms));

// 光束扫完整块代码用时;幕 1 里"某件事几时发生"一律由它 + 那一行的位置推出来,
// 不另写时刻表 —— 否则改一行代码就得回来对时间,而对不上就是"还没扫到就冒出了 finding"。
const BEAM_MS = 3200;
/** 各处落位的时刻(ms),layoutScan() 按真实行位置算出来 */
let scanCue = { findings: [], badge2: 0 };

function layoutScan() {
  const host = document.querySelector('.scan-host');
  if (!host) return;
  const hostH = host.clientHeight;
  const hostTop = host.getBoundingClientRect().top;
  host.style.setProperty('--beam-dur', `${BEAM_MS}ms`);

  // 光束扫到某一行"中线"的时刻
  const timeAt = (el) => {
    const r = el.getBoundingClientRect();
    return Math.round(((r.top - hostTop + r.height / 2) / hostH) * BEAM_MS);
  };
  const setD = (el, ms) => el && el.style.setProperty('--d', `${ms}ms`);

  const hits = [...host.querySelectorAll('tr[data-anchor]')].map(timeAt);
  host.querySelectorAll('tr[data-anchor]').forEach((tr, i) => {
    setD(tr.querySelector('.anchor'), hits[i]);
    setD(tr.querySelector('.gsign'), hits[i]);
  });

  const last = hits[hits.length - 1] ?? 0;
  const panel = document.querySelector('.stage-panel[data-panel="0"]');
  // 卡片挂在第一处锚点上,就跟在那一行被扫到之后落下 —— 先扫到,才谈得上"报出来"
  setD(panel.querySelector('.inline.drop'), (hits[0] ?? 0) + 320);
  setD(panel.querySelector('.fh-fnd'), last);
  setD(panel.querySelector('.badge.f[data-badge="1"]'), last);
  setD(panel.querySelector('.badge.f[data-badge="2"]'), last + 900);
  scanCue = { findings: hits, badge2: last + 900 };
}

/** 幕 1:findings 计数跟着光束扫到的位置跳 */
function playScan() {
  const cnt = document.getElementById('scanCnt');
  cnt.textContent = '＋0 findings';
  scanCue.findings.forEach((t, i) => later(() => (cnt.textContent = `＋${i + 1} findings`), t));
  later(() => (cnt.textContent = `＋${scanCue.findings.length + 1} findings`), scanCue.badge2);
}

const calm = matchMedia('(prefers-reduced-motion: reduce)');

/** 幕 2:先打字指示器,再逐字吐出回答 */
function playThread() {
  const dots = document.getElementById('typingDots');
  const out = document.getElementById('typeOut');
  out.textContent = '';
  dots.style.display = '';
  if (calm.matches) {
    dots.style.display = 'none';
    out.textContent = REPLY;
    return;
  }
  later(() => {
    dots.style.display = 'none';
    let i = 0;
    const t = setInterval(() => {
      out.textContent = REPLY.slice(0, ++i);
      if (i >= REPLY.length) clearInterval(t);
    }, 22);
    timers.push(t);
  }, 2100);
}

/** 幕 4:勾选逐条打上,再提交 */
function playSubmit() {
  const boxes = [...document.querySelectorAll('.sub-fnd.kept .chk')];
  const tally = document.getElementById('keepTally');
  const btn = document.getElementById('submitBtn');
  const note = document.getElementById('footNote');
  const banner = document.getElementById('okBanner');
  boxes.forEach((b) => b.classList.remove('on'));
  banner.classList.remove('on');
  btn.classList.remove('done');
  btn.textContent = '提交 review · 4 条';
  note.textContent = '本地分支没有 PR 可提交时,这里是「导出 Markdown」';
  if (calm.matches) {
    boxes.forEach((b) => b.classList.add('on'));
    btn.classList.add('done');
    btn.textContent = '✓ 已提交';
    note.textContent = 'findings 已标记为已提交(锁定)';
    banner.classList.add('on');
    return;
  }
  boxes.forEach((b, i) => later(() => b.classList.add('on'), 700 + i * 320));
  later(() => (tally.textContent = '保留 4'), 1700);
  later(() => {
    btn.textContent = '正在提交 review…';
  }, 2600);
  later(() => {
    btn.classList.add('done');
    btn.textContent = '✓ 已提交';
    note.textContent = 'findings 已标记为已提交(锁定)';
    banner.classList.add('on');
  }, 3400);
}

function setAct(i) {
  if (i === current) return;
  current = i;
  clearTimers();

  panels.forEach((p, k) => {
    p.classList.remove('on');
    p.setAttribute('aria-hidden', k === i ? 'false' : 'true');
  });
  // 去掉再加,才能让 CSS 动画重播 —— 每次滚回来都该重看一遍
  const panel = panels[i];
  void panel.offsetWidth;
  panel.classList.add('on');

  acts.forEach((a, k) => a.classList.toggle('on', k === i));
  bars.forEach((b, k) => b.classList.toggle('on', k <= i));
  railName.textContent = RAIL[i];

  const s = STATUS[i];
  const st = document.getElementById('sbStatus');
  st.className = `sb-status ${s.cls}`;
  document.getElementById('sbStatusTx').textContent = s.tx;
  document.getElementById('sbRound').textContent = s.round;
  document.getElementById('sbCtx').textContent = s.ctx;
  document.getElementById('ctaBadge').textContent = i >= 2 ? '8' : '5';
  document.getElementById('rerunCta').classList.toggle('hot', i === 2);

  if (i === 0) playScan();
  if (i === 1) playThread();
  if (i === 3) playSubmit();
}

// 判定当前幕:取"顶边已越过视口 20% 线"的最后一幕。
// 阈值配合 scroll-snap 的居中吸附 —— 吸住时该幕顶边约在 6vh,稳定落在活跃区间内。
const show = document.querySelector('.lp-show');
// 页面一打开就把第一幕跑掉的话,等用户滚到舞台时动画早演完了。
// 所以:未进入视野时只静态摆着,真正滚到时再重放当前这一幕。
let armed = false;

function update() {
  if (!armed && show.getBoundingClientRect().top < innerHeight * 0.55) {
    armed = true;
    current = -1;
  }
  const line = innerHeight * 0.2;
  let best = 0;
  acts.forEach((a, i) => {
    if (a.getBoundingClientRect().top <= line) best = i;
  });
  setAct(best);
  nav.classList.toggle('stuck', scrollY > 20);
}

// 直接在 scroll 里跑:浏览器本来就把 scroll 合并到每帧最多一次,
// 而 update() 只读 4 个 rect。用 rAF 再包一层反而会在后台标签页里被挂起 ——
// 那时 rAF 不派发,"已排队"的标志位再也清不掉,整条驱动就静默死了。
addEventListener('scroll', update, { passive: true });
addEventListener('resize', () => {
  layoutScan();
  update();
});
layoutScan();
update();
