import { create } from 'zustand';

export interface ToolCapability {
  name: string;
  description: string;
  category: string;
}

type RuntimeStatus = 'idle' | 'loading' | 'connected' | 'unavailable';

interface ToolCapabilitiesState {
  tools: ToolCapability[];
  status: RuntimeStatus;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
}

function parseCapabilities(value: unknown): ToolCapability[] {
  if (!value || typeof value !== 'object' || !('tools' in value) || !Array.isArray(value.tools)) {
    throw new Error('Desktop runtime returned an invalid capability response.');
  }

  const tools: ToolCapability[] = [];
  for (const candidate of value.tools) {
    if (!candidate || typeof candidate !== 'object'
      || !('name' in candidate) || typeof candidate.name !== 'string'
      || !('description' in candidate) || typeof candidate.description !== 'string') continue;
    const category = 'category' in candidate
      && typeof candidate.category === 'string'
      && candidate.category.trim()
      ? candidate.category
      : 'other';
    tools.push({ name: candidate.name, description: candidate.description, category });
  }
  return tools;
}

export const useToolCapabilities = create<ToolCapabilitiesState>((set, get) => ({
  tools: [],
  status: 'idle',
  error: null,

  load: async (force = false) => {
    const currentStatus = get().status;
    if (currentStatus === 'loading' || (!force && currentStatus === 'connected')) return;
    set({ status: 'loading', error: null });
    try {
      const response = await fetch('/desktop/capabilities', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Desktop runtime capability request failed (${response.status}).`);
      const tools = parseCapabilities(await response.json());
      set({ tools, status: 'connected', error: null });
    } catch (cause) {
      set({
        tools: [],
        status: 'unavailable',
        error: cause instanceof Error ? cause.message : 'Desktop runtime capabilities are unavailable.',
      });
    }
  },
}));
