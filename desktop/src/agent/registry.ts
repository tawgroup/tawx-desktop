import { Effect } from 'effect';
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

// Bounds for capability factories and tool calls at this boundary. The
// factories themselves (builtins/tools/integrations) keep their Promise
// signatures — untouched clusters — and are only wrapped + timed here.
const CAPABILITY_CREATE_TIMEOUT_MS = 30_000;
const TOOL_CALL_TIMEOUT_MS = 120_000;

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
      // Legacy Promise factory (builtins/integrations clusters own it — it may
      // even return synchronously); wrapped with a timeout so a wedged
      // factory fails toolset creation instead of hanging the task fiber.
      const registration = await Effect.runPromise(
        Effect.tryPromise({
          try: () => Promise.resolve().then(() => owner.create({ ...context, recoveryState: recoveryStates[owner.id] })),
          catch: (error) => error,
        }).pipe(Effect.timeout(CAPABILITY_CREATE_TIMEOUT_MS)),
      );
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
      // Timeout failures propagate to the caller's catch (executeToolCall),
      // which records them as tool errors — same path as a throwing tool.
      result: await Effect.runPromise(
        Effect.tryPromise({
          try: () => tool.registration.execute(name, args, context),
          catch: (error) => error,
        }).pipe(Effect.timeout(TOOL_CALL_TIMEOUT_MS)),
      ),
    };
  }

  async undo(
    registrationId: string,
    checkpointId: string,
    context: ToolExecutionContext,
  ): Promise<ToolUndoResult | void> {
    const registration = this.registrations.get(registrationId);
    if (!registration?.undo) throw new Error(`capability '${registrationId}' cannot undo changes`);
    return Effect.runPromise(
      Effect.tryPromise({
        try: () => registration.undo!(checkpointId, context),
        catch: (error) => error,
      }).pipe(Effect.timeout(TOOL_CALL_TIMEOUT_MS)),
    );
  }

  exportStates(): Record<string, unknown> {
    const states: Record<string, unknown> = {};
    for (const [id, registration] of this.registrations) {
      if (registration.exportState) states[id] = registration.exportState();
    }
    return states;
  }

  async dispose(): Promise<void> {
    // Structured fan-out mirroring Promise.all: unbounded concurrency, first
    // failure surfaces while siblings are interrupted — no dangling dispose.
    await Effect.runPromise(
      Effect.forEach(
        [...this.registrations.values()],
        (registration) =>
          Effect.tryPromise({
            try: () => Promise.resolve().then(() => registration.dispose?.()),
            catch: (error) => error,
          }).pipe(Effect.asVoid),
        { concurrency: 'unbounded', discard: true },
      ),
    );
  }
}
