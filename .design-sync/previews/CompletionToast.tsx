import { CompletionToast } from 'duetlens';

const noop = () => {};

// .toast-wrap 是 position:fixed(右下角)。带 transform 的祖先会成为它的包含块,
// 浮层因此落在这一格的右下角,而不是跑到卡外的视口角上。
const stage: React.CSSProperties = {
  position: 'relative',
  transform: 'translateZ(0)',
  width: 420,
  height: 170,
};

/** 首轮机审跑完:点它直接打开那条 review。 */
export const ScanDone = () => (
  <div style={stage}>
    <CompletionToast
      notice={{
        reviewId: 'r1',
        kind: 'scan-done',
        title: '扫描完成 · #482 feat: streaming transcode pipeline',
        body: '报出 7 条 finding,其中 2 条 high',
      }}
      onOpen={noop}
      onDismiss={noop}
    />
  </div>
);

/** 追问有了回复:带 discussionId,点击时定位到具体线程。 */
export const ReplyArrived = () => (
  <div style={stage}>
    <CompletionToast
      notice={{
        reviewId: 'r2',
        kind: 'reply',
        title: 'agent 回复了追问',
        body: '关于 transcode 超时重试的那条,已给出复现路径',
        discussionId: 'd7',
      }}
      onOpen={noop}
      onDismiss={noop}
    />
  </div>
);
