import type { Attachment } from '../types';

interface Props {
  attachments: readonly Attachment[];
  onRemove?: (id: string) => void;
}

function AttachmentItem({ attachment, onRemove }: { attachment: Attachment; onRemove?: (id: string) => void }) {
  const size = attachment.size < 1024
    ? `${attachment.size} B`
    : attachment.size < 1024 * 1024
      ? `${Math.ceil(attachment.size / 1024)} KB`
      : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;

  if (attachment.kind === 'image' && attachment.dataUrl) {
    return (
      <li className="relative h-20 w-20 overflow-hidden rounded-xl border border-surface-200 bg-surface-100 dark:border-surface-700 dark:bg-surface-800">
        <img
          src={attachment.dataUrl}
          alt={`Attached image: ${attachment.name}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        {onRemove && (
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-surface-950/80 text-sm text-white shadow-sm hover:bg-surface-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
            aria-label={`Remove ${attachment.name}`}
          >
            ×
          </button>
        )}
        <span className="absolute inset-x-0 bottom-0 truncate bg-surface-950/70 px-1.5 py-1 text-[10px] text-white" title={`${attachment.name} · ${size}`}>
          {attachment.name}
        </span>
      </li>
    );
  }

  return (
    <li className="flex min-w-0 max-w-64 items-center gap-2 rounded-xl border border-surface-200 bg-surface-50 px-2.5 py-2 dark:border-surface-700 dark:bg-surface-800">
      <span aria-hidden className="text-base">▤</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium" title={attachment.name}>{attachment.name}</span>
        <span className="block truncate text-[11px] text-surface-500 dark:text-surface-400">
          {attachment.mimeType === 'application/pdf' ? 'PDF text' : 'Text'} · {size}{attachment.truncated ? ' · context trimmed' : ' · ready'}
        </span>
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-base text-surface-500 hover:bg-surface-200 hover:text-surface-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent dark:hover:bg-surface-700 dark:hover:text-white"
          aria-label={`Remove ${attachment.name}`}
        >
          ×
        </button>
      )}
    </li>
  );
}

export default function AttachmentTray({ attachments, onRemove }: Props) {
  if (!attachments.length) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <AttachmentItem key={attachment.id} attachment={attachment} onRemove={onRemove} />
      ))}
    </ul>
  );
}
