import { defineStore } from 'pinia';
import type { UserSettingsDto, UserSettingsPatch } from '@rapid-ai-document-review/shared/contracts/http';
import { httpClient } from '../transport/http-client.js';
import type { ServerFrame } from '../transport/ws-client.js';

export interface SettingsState {
  settings: UserSettingsDto | null;
  loaded: boolean;
}

const DEFAULTS: UserSettingsDto = {
  thinkingVisible: false,
  revisionDebounceMs: 300_000,
  maxConcurrentAgents: 3,
  maxEditingDepth: 2,
  maxConversationDepth: 3,
  maxReplacementAttempts: 2,
};

/** `user_settings` singleton (data-model.md §8) — limits and the reasoning-visibility toggle. */
export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => ({ settings: null, loaded: false }),

  getters: {
    thinkingVisible: (state): boolean => state.settings?.thinkingVisible ?? DEFAULTS.thinkingVisible,
  },

  actions: {
    async load(): Promise<void> {
      this.settings = await httpClient.getSettings();
      this.loaded = true;
    },

    async update(patch: UserSettingsPatch): Promise<void> {
      this.settings = await httpClient.patchSettings(patch);
    },

    handleServerFrame(frame: ServerFrame): void {
      if (frame.kind !== 'event') return;
      if (frame.frame.type === 'settings_changed') {
        this.settings = { ...frame.frame.data };
      }
    },
  },
});
