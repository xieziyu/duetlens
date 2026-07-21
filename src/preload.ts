import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, IpcEvents, type DuetlensApi, type ReviewEvent } from '@shared/ipc';
import type { UiSettings } from '@shared/domain';

// 唯一暴露给 renderer 的桥;沿 contextIsolation 边界只透出白名单方法。
const api: DuetlensApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.appGetInfo),
  review: {
    list: () => ipcRenderer.invoke(IpcChannels.reviewList),
    get: (id) => ipcRenderer.invoke(IpcChannels.reviewGet, id),
    findings: (reviewId) => ipcRenderer.invoke(IpcChannels.reviewFindings, reviewId),
    diff: (reviewId) => ipcRenderer.invoke(IpcChannels.reviewDiff, reviewId),
    discussions: (reviewId) => ipcRenderer.invoke(IpcChannels.reviewDiscussions, reviewId),
    messages: (discussionId) => ipcRenderer.invoke(IpcChannels.reviewMessages, discussionId),
    start: (input) => ipcRenderer.invoke(IpcChannels.reviewStart, input),
    startDemo: () => ipcRenderer.invoke(IpcChannels.reviewStartDemo),
    resume: (reviewId) => ipcRenderer.invoke(IpcChannels.reviewResume, reviewId),
    release: (reviewId) => ipcRenderer.invoke(IpcChannels.reviewRelease, reviewId),
    addDiscussion: (reviewId, anchor) =>
      ipcRenderer.invoke(IpcChannels.reviewAddDiscussion, reviewId, anchor),
    sendMessage: (reviewId, discussionId, text) =>
      ipcRenderer.invoke(IpcChannels.reviewSendMessage, reviewId, discussionId, text),
    setTriage: (reviewId, findingId, triage) =>
      ipcRenderer.invoke(IpcChannels.reviewSetTriage, reviewId, findingId, triage),
    setFindingAnchor: (reviewId, findingId, line) =>
      ipcRenderer.invoke(IpcChannels.reviewSetFindingAnchor, reviewId, findingId, line),
    addFinding: (reviewId, input) => ipcRenderer.invoke(IpcChannels.reviewAddFinding, reviewId, input),
    promoteDiscussion: (reviewId, discussionId) =>
      ipcRenderer.invoke(IpcChannels.reviewPromoteDiscussion, reviewId, discussionId),
    updateFinding: (reviewId, input) =>
      ipcRenderer.invoke(IpcChannels.reviewUpdateFinding, reviewId, input),
    updateSummary: (reviewId, body) =>
      ipcRenderer.invoke(IpcChannels.reviewUpdateSummary, reviewId, body),
    submit: (reviewId, input) => ipcRenderer.invoke(IpcChannels.reviewSubmit, reviewId, input),
    getUiState: (reviewId) => ipcRenderer.invoke(IpcChannels.reviewGetUiState, reviewId),
    saveUiState: (reviewId, state) =>
      ipcRenderer.invoke(IpcChannels.reviewSaveUiState, reviewId, state),
    onEvent: (handler: (e: ReviewEvent) => void) => {
      const listener = (_e: IpcRendererEvent, payload: ReviewEvent) => handler(payload);
      ipcRenderer.on(IpcEvents.reviewEvent, listener);
      return () => ipcRenderer.off(IpcEvents.reviewEvent, listener);
    },
  },
  ui: {
    getSettings: () => ipcRenderer.invoke(IpcChannels.uiGetSettings),
    saveSettings: (settings: UiSettings) => ipcRenderer.invoke(IpcChannels.uiSaveSettings, settings),
  },
  prompt: {
    get: (cwd) => ipcRenderer.invoke(IpcChannels.promptGet, cwd),
    save: (input) => ipcRenderer.invoke(IpcChannels.promptSave, input),
  },
  dialog: {
    pickDirectory: () => ipcRenderer.invoke(IpcChannels.dialogPickDirectory),
    saveTextFile: (defaultName, content) =>
      ipcRenderer.invoke(IpcChannels.dialogSaveTextFile, defaultName, content),
  },
};

contextBridge.exposeInMainWorld('duetlens', api);
