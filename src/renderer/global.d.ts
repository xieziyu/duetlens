import type { DuetlensApi } from '@shared/ipc';

declare global {
  interface Window {
    duetlens: DuetlensApi;
  }
}

export {};
