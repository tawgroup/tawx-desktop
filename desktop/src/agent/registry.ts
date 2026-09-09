import type {
  AgentCapabilityRegistration,
  TaskRegistrationContext,
  TaskToolRegistration,
  ToolCapability,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolUndoResult,
} from './types.js';
import type { Tool } from '../providers/types.js';

interface RegisteredTool {
  owner: AgentCapabilityRegistration;
  registration: TaskToolRegistration;
  definition: Tool;
}

export class CapabilityRegistry {
  private readonly registrations = new Map<string, AgentCapabilityRegistration>();

  register(registration: AgentCapabilityRegistration): void {
    if (this.registrations.has(registration.id)) {
      throw new Error(`capability registration '${registration.id}' already exists`);
    }
    this.registrations.set(registration.id, registration);
  }

  listCapabilities(): ToolCapability[] {
    const seen = new Set<string>();
    const capabilities: ToolCapability[] = [];
    for (const registration of this.registrations.values()) {
      for (const capability of registration.capabilities) {
        if (seen.has(capability.name)) continue;
        seen.add(capability.name);
        capabilities.push({ ...capability });
      }
    }
    return capabilities;
  }

  async createToolset(
    context: TaskRegistrationContext,
    recoveryStates: Record<string, unknown> = {},
  ): Promise<TaskToolset> {
    const tools = new Map<string, RegisteredTool>();
    const instances = new Map<string, TaskToolRegistration>();

    for (const owner of this.registrations.values()) {
      const registration = await owner.create({ ...context, recoveryState: recoveryStates[owner.id] });
      instances.set(owner.id, registration);
      for (const definition of registration.definitions) {
        const name = definition.function?.name;
        if (!name) continue;
        if (tools.has(name)) throw new Error(`tool '${name}' is registered more than once`);
        tools.set(name, { owner, registration, definition });
      }
    }

    return new TaskToolset(tools, instances);
  }
}

export class TaskToolset {
  constructor(
    private readonly tools: Map<string, RegisteredTool>,
    private readonly registrations: Map<string, TaskToolRegistration>,
  ) {}

  get definitions(): Tool[] {
    return [...this.tools.values()].map(({ definition }) => definition);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<{ registrationId: string; result: ToolExecutionResult }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        registrationId: '',
        result: { ok: false, output: null, error: `unknown or disabled tool '${name}'` },
      };
    }
    return {
      registrationId: tool.owner.id,
      result: await tool.registration.execute(name, args, context),
    };
  }

  async undo(
    registrationId: string,
    checkpointId: string,
    context: ToolExecutionContext,
  ): Promise<ToolUndoResult | void> {
    const registration = this.registrations.get(registrationId);
    if (!registration?.undo) throw new Error(`capability '${registrationId}' cannot undo changes`);
    return registration.undo(checkpointId, context);
  }

  exportStates(): Record<string, unknown> {
    const states: Record<string, unknown> = {};
    for (const [id, registration] of this.registrations) {
      if (registration.exportState) states[id] = registration.exportState();
    }
    return states;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.registrations.values()].map((registration) => registration.dispose?.()));
  }
}
