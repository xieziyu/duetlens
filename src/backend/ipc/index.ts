import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  IpcChannels,
  IpcEvents,
  type AppInfo,
  type DiscussionAnchor,
  type AddFindingInput,
  type FindingEditInput,
  type ReviewEvent,
  type ReviewStartInput,
  type SubmitReviewInput,
} from '@shared/ipc';
import type { ReviewUiState, Triage, UiSettings } from '@shared/domain';
import type { ReviewManager } from '../review/review-manager';

export interface IpcDeps {
  manager: ReviewManager;
  /** 把领域事件推给所有 renderer(main 提供,通常遍历 BrowserWindow) */
  broadcast: (channel: string, payload: unknown) => void;
}

/** 注册 main 侧全部 IPC handler,并把 ReviewManager 事件转发给 renderer。 */
export function registerIpcHandlers({ manager, broadcast }: IpcDeps): void {
  ipcMain.handle(IpcChannels.appGetInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

  ipcMain.handle(IpcChannels.reviewList, () => manager.listReviews());
  ipcMain.handle(IpcChannels.reviewGet, (_e, id: string) => manager.getReview(id));
  ipcMain.handle(IpcChannels.reviewFindings, (_e, reviewId: string) => manager.getFindings(reviewId));
  ipcMain.handle(IpcChannels.reviewDiff, (_e, reviewId: string) => manager.getDiff(reviewId));
  ipcMain.handle(IpcChannels.reviewDiscussions, (_e, reviewId: string) => manager.getDiscussions(reviewId));
  ipcMain.handle(IpcChannels.reviewMessages, (_e, discussionId: string) => manager.getMessages(discussionId));
  ipcMain.handle(IpcChannels.reviewStart, (_e, input: ReviewStartInput) =>
    manager.startReview({
      source: input.source,
      ref: input.ref,
      repoPath: input.repoPath ?? '',
      baseRef: input.baseRef,
    }),
  );
  ipcMain.handle(IpcChannels.reviewStartDemo, () => manager.startDemoReview());
  ipcMain.handle(IpcChannels.reviewResume, (_e, reviewId: string) => manager.resumeReview(reviewId));
  ipcMain.handle(IpcChannels.reviewRelease, (_e, reviewId: string) => manager.disposeReview(reviewId));
  ipcMain.handle(IpcChannels.reviewAddDiscussion, (_e, reviewId: string, anchor: DiscussionAnchor) =>
    manager.addUserDiscussion(reviewId, anchor),
  );
  ipcMain.handle(IpcChannels.reviewSendMessage, (_e, reviewId: string, discussionId: string, text: string) =>
    manager.sendMessage(reviewId, discussionId, text),
  );
  ipcMain.handle(IpcChannels.reviewSetTriage, (_e, reviewId: string, findingId: string, triage: Triage) =>
    manager.setTriage(reviewId, findingId, triage),
  );
  ipcMain.handle(IpcChannels.reviewAddFinding, (_e, reviewId: string, input: AddFindingInput) =>
    manager.addManualFinding(reviewId, input),
  );
  ipcMain.handle(IpcChannels.reviewPromoteDiscussion, (_e, reviewId: string, discussionId: string) =>
    manager.promoteDiscussion(reviewId, discussionId),
  );
  ipcMain.handle(IpcChannels.reviewUpdateFinding, (_e, reviewId: string, input: FindingEditInput) =>
    manager.updateFinding(reviewId, input),
  );
  ipcMain.handle(IpcChannels.reviewUpdateSummary, (_e, reviewId: string, body: string) =>
    manager.updateSummary(reviewId, body),
  );
  ipcMain.handle(IpcChannels.reviewSubmit, (_e, reviewId: string, input: SubmitReviewInput) =>
    manager.submitReview(reviewId, input),
  );
  ipcMain.handle(IpcChannels.reviewGetUiState, (_e, reviewId: string) =>
    manager.getReviewUiState(reviewId),
  );
  ipcMain.handle(IpcChannels.reviewSaveUiState, (_e, reviewId: string, state: ReviewUiState) =>
    manager.saveReviewUiState(reviewId, state),
  );

  ipcMain.handle(IpcChannels.uiGetSettings, () => manager.getUiSettings());
  ipcMain.handle(IpcChannels.uiSaveSettings, (_e, settings: UiSettings) => manager.saveUiSettings(settings));

  ipcMain.handle(IpcChannels.dialogPickDirectory, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openDirectory' as const] };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle(IpcChannels.dialogSaveTextFile, async (_e, defaultName: string, content: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, content, 'utf8');
    return res.filePath;
  });

  manager.on('review-event', (e: ReviewEvent) => broadcast(IpcEvents.reviewEvent, e));
}
