import type { PanelView } from '../../panelView'
import { toolStatusDotClass } from './toolStatus'

export interface PanelHeader {
  dot: string
  fileLabel: string
  statusText: string
  statusClass: string
  /** Tooltip on the library dropdown when the doc was copied out of the workspace. */
  pickerTitle?: string
}

/**
 * The header line — dot, file label, status word — for whatever the panel shows.
 * The preview baseline covers the empty and content cases; each focusable view
 * overrides what changes, so adding a view kind cannot silently forget a status.
 */
export function panelHeader(view: PanelView, docPath: string | null): PanelHeader {
  const base: PanelHeader = {
    dot: 'bg-raised',
    fileLabel: docPath ?? 'content.md',
    statusText: 'preview',
    statusClass: 'text-faint',
  }
  switch (view.kind) {
    case 'approval':
      return {
        ...base,
        dot: 'bg-warn animate-pulse',
        fileLabel: view.approval.path ?? (view.approval.kind === 'bash' ? 'shell' : base.fileLabel),
        statusText: 'pending approval',
        statusClass: 'text-warn',
      }
    case 'tool':
      return {
        ...base,
        dot: toolStatusDotClass(view.call),
        fileLabel: view.call.path ?? view.call.label,
        statusText: 'tool call',
        statusClass: 'text-info',
      }
    case 'content':
      return {
        ...base,
        dot: 'bg-ok',
        fileLabel: view.doc.path,
        pickerTitle: view.doc.sourcePath ? `copied from ${view.doc.sourcePath}` : undefined,
      }
    default:
      return base
  }
}
