import type { CapabilityAdapter, CapabilityStatus, CapabilityTool } from '../integrations/capabilities.js';
import { ArtifactStore, type ArtifactPreview, type CreateArtifactInput } from './store.js';

export class ArtifactAdapter implements CapabilityAdapter {
  readonly id = 'artifacts';

  constructor(readonly store = new ArtifactStore()) {}

  async status(): Promise<CapabilityStatus> {
    return {
      id: this.id,
      name: 'Artifacts',
      available: true,
      configured: true,
      detail: 'Ready. Deliverables are stored inside the selected project at .tawx/artifacts.',
      toolCount: 3,
    };
  }

  async tools(): Promise<readonly CapabilityTool[]> {
    return [this.createTool(), this.listTool(), this.readTool()];
  }

  private createTool(): CapabilityTool {
    return {
      definition: {
        type: 'function',
        function: {
          name: 'artifact_create',
          description: 'Create or replace a previewable deliverable under .tawx/artifacts in the selected project.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'content'],
            properties: {
              path: { type: 'string', description: 'Relative artifact path, for example reports/summary.md' },
              content: { type: 'string', description: 'UTF-8 text or base64-encoded binary content' },
              encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
            },
          },
        },
      },
      risk: 'write',
      approvalDetail: (input) => `Create artifact ${readInput(input).path} inside .tawx/artifacts`,
      auditInput: (input) => {
        const artifact = readInput(input);
        return { path: artifact.path, encoding: artifact.encoding ?? 'utf8', content: '[REDACTED]' };
      },
      auditResult: artifactAuditSummary,
      invoke: async (input, context) => this.store.create(context.workspace, readInput(input)),
    };
  }

  private listTool(): CapabilityTool {
    return {
      definition: {
        type: 'function',
        function: {
          name: 'artifact_list',
          description: 'List deliverables previously created in the selected project.',
          parameters: { type: 'object', additionalProperties: false, properties: {} },
        },
      },
      risk: 'read',
      approvalDetail: () => 'List project artifacts',
      auditResult: (result) => ({ count: Array.isArray(result) ? result.length : 0 }),
      invoke: async (_input, context) => this.store.list(context.workspace),
    };
  }

  private readTool(): CapabilityTool {
    return {
      definition: {
        type: 'function',
        function: {
          name: 'artifact_read',
          description: 'Read bounded preview content and metadata for a project artifact.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string', description: 'Opaque artifact id returned by artifact_create or artifact_list' } },
          },
        },
      },
      risk: 'read',
      approvalDetail: () => 'Preview a project artifact',
      auditResult: artifactAuditSummary,
      invoke: async (input, context) => this.store.read(context.workspace, requiredId(input)),
    };
  }
}

function readInput(input: unknown): CreateArtifactInput {
  if (!input || typeof input !== 'object') throw new Error('artifact input must be an object');
  const record = input as Record<string, unknown>;
  if (typeof record.path !== 'string' || typeof record.content !== 'string') {
    throw new Error("artifact 'path' and 'content' must be strings");
  }
  const encoding = record.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
    throw new Error("artifact encoding must be 'utf8' or 'base64'");
  }
  return { path: record.path, content: record.content, encoding };
}

function requiredId(input: unknown): string {
  if (!input || typeof input !== 'object') throw new Error("artifact 'id' must be a string");
  const record = input as Record<string, unknown>;
  if (typeof record.id !== 'string') throw new Error("artifact 'id' must be a string");
  return record.id;
}

function artifactAuditSummary(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const artifact = result as Partial<ArtifactPreview>;
  return {
    id: artifact.id,
    path: artifact.path,
    mimeType: artifact.mimeType,
    size: artifact.size,
    previewKind: artifact.preview?.kind,
    previewTruncated: artifact.preview?.truncated,
  };
}
