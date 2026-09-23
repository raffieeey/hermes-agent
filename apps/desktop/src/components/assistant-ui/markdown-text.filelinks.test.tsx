import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW, SessionViewProvider } from '@/app/chat/session-view'
import {
  $connection,
  $selectedStoredSessionId,
  $sessions,
  _resetSessionOwnerHintsForTests,
  setSessionOwnerHint
} from '@/store/session'
import { $sessionTiles } from '@/store/session-states'

import { MarkdownTextContent, MessageTextContent } from './markdown-text'

function mountLocalFileBridge(openFile: (path: string) => Promise<{ ok: boolean; error?: string }>) {
  window.hermesDesktop = { openFile } as never
}

// Regression for #82140: a plain filesystem href in assistant markdown
// (`[report](/home/user/report.md)`) rendered as a bare dead anchor —
// file:// is blocked in the renderer, and on a remote gateway the path
// isn't on this disk at all. Such links route through PreviewAttachment:
// local files offer an additional OS-native Open original action, while
// remote files retain Download/preview through the authenticated bridge.
// Media-extension paths keep their inline player instead.
describe('MarkdownLink filesystem hrefs', () => {
  afterEach(() => {
    cleanup()
    $connection.set(null)
    $selectedStoredSessionId.set(null)
    $sessions.set([])
    $sessionTiles.set([])
    _resetSessionOwnerHintsForTests({ storage: true })
    window.hermesDesktop = undefined as never
  })

  it.each(['pdf', 'docx', 'xlsx', 'pptx'])(
    'adds native open for a local %s without removing download or preview',
    async ext => {
      const openFile = vi.fn(async () => ({ ok: true }))
      mountLocalFileBridge(openFile)
      $connection.set({ mode: 'local' } as never)

      render(<MarkdownTextContent isRunning={false} text={`[memo](file:///home/user/My%20Report.${ext})`} />)

      expect(await screen.findByText(`My Report.${ext}`)).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Open preview' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Open original' }))
      await waitFor(() => expect(openFile).toHaveBeenCalledWith(`file:///home/user/My%20Report.${ext}`, undefined))
    }
  )

  it('renders a MEDIA target inside an authored link without stray Markdown punctuation', async () => {
    const openFile = vi.fn(async () => ({ ok: true }))
    mountLocalFileBridge(openFile)
    $connection.set({ mode: 'local' } as never)

    const { container } = render(
      <MessageTextContent text="- [Editable memo (Word)](MEDIA:/home/user/out/report.docx)" />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Open original' }))
    await waitFor(() => expect(openFile).toHaveBeenCalledWith('/home/user/out/report.docx', undefined))
    expect(container.textContent).not.toContain('[Editable memo (Word)](')
    expect(container.textContent).not.toContain('MEDIA:')
    expect(container.textContent).not.toContain('report.docx)')
  })

  it('opens the exact file URL without invoking preview normalization first', async () => {
    const openFile = vi.fn(async (_target: string, _cwd?: string) => ({ ok: true }))

    const normalizePreviewTarget = vi.fn(async () => {
      throw new Error('Preview normalization must not touch the filesystem for native opening')
    })

    window.hermesDesktop = { openFile, normalizePreviewTarget } as never
    $connection.set({ mode: 'local' } as never)

    render(<MarkdownTextContent isRunning={false} text="[memo](file:///tmp/a%23b.docx)" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open original' }))
    await waitFor(() => expect(openFile.mock.calls[0]?.[0]).toBe('file:///tmp/a%23b.docx'))

    expect(normalizePreviewTarget).not.toHaveBeenCalled()
  })

  it('preserves a local file URL and surfaces a failed OS opener', async () => {
    const openFile = vi.fn(async () => ({ ok: false, error: 'No application can open this file' }))
    mountLocalFileBridge(openFile)
    $connection.set({ mode: 'local' } as never)

    render(<MarkdownTextContent isRunning={false} text="[memo](file:///home/user/My%20Report.docx)" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open original' }))
    await waitFor(() => expect(openFile).toHaveBeenCalledWith('file:///home/user/My%20Report.docx', undefined))
    // The Desktop notification system receives the native open error.
    const { $notifications } = await import('@/store/notifications')
    await waitFor(() => expect(JSON.stringify($notifications.get())).toContain('No application can open this file'))
  })

  it('does not offer an OS open for a remote file', async () => {
    const openFile = vi.fn(async () => ({ ok: true }))
    window.hermesDesktop = { openFile } as never
    $connection.set({ mode: 'remote' } as never)

    render(<MarkdownTextContent isRunning={false} text="[report](/home/remote/report.docx)" />)

    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open preview' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open original' })).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('does not offer an OS open before the connection is known', async () => {
    window.hermesDesktop = { openFile: vi.fn() } as never

    render(<MarkdownTextContent isRunning={false} text="[report](/home/user/report.docx)" />)

    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open original' })).toBeNull()
  })

  it('does not native-open a remote session shown beside a local session', async () => {
    const openFile = vi.fn(async () => ({ ok: true }))
    window.hermesDesktop = { openFile } as never
    $connection.set({ mode: 'local' } as never)
    $selectedStoredSessionId.set('stored-remote')
    setSessionOwnerHint('stored-remote', { connectionId: 'remote-host', mode: 'remote', profile: 'default' })

    render(<MarkdownTextContent isRunning={false} text="[report](/home/remote/report.docx)" />)

    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open original' })).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('does not native-open a connection-tagged remote row when its owner hint is absent', async () => {
    const openFile = vi.fn(async () => ({ ok: true }))
    window.hermesDesktop = { openFile } as never
    $connection.set({ mode: 'local' } as never)
    $selectedStoredSessionId.set('stored-remote')
    $sessions.set([{ id: 'stored-remote', connection_id: 'remote-host', profile: 'default' }] as never)

    render(<MarkdownTextContent isRunning={false} text="[report](/home/remote/report.docx)" />)

    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open original' })).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('shows native open on a local tile even while the ambient connection is remote', async () => {
    const openFile = vi.fn(async () => ({ ok: true }))
    mountLocalFileBridge(openFile)
    $connection.set({ mode: 'remote' } as never)
    $sessionTiles.set([
      { storedSessionId: 'local-tile', ownerRoute: { connectionId: 'local', profile: 'default' } }
    ] as never)

    render(
      <SessionViewProvider value={{ ...PRIMARY_SESSION_VIEW, kind: 'tile', $storedId: atom('local-tile') }}>
        <MarkdownTextContent isRunning={false} text="[memo](/home/user/report.docx)" />
      </SessionViewProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Open original' }))
    await waitFor(() => expect(openFile).toHaveBeenCalledWith('/home/user/report.docx', undefined))
  })

  it.each(['file://other-host/tmp/report.docx', 'file:///tmp/a%2Fb.docx'])(
    'passes rejected %s unchanged to Electron rather than decoding a different path',
    async target => {
      const openFile = vi.fn(async () => ({ ok: false, error: 'Invalid file URL' }))
      window.hermesDesktop = { openFile } as never
      $connection.set({ mode: 'local' } as never)

      render(<MarkdownTextContent isRunning={false} text={`[memo](${target})`} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Open original' }))
      await waitFor(() => expect(openFile).toHaveBeenCalledWith(target, undefined))
    }
  )

  it('keeps web URL preview cards available on a local connection', async () => {
    window.hermesDesktop = { openFile: vi.fn() } as never
    $connection.set({ mode: 'local' } as never)

    render(<MarkdownTextContent isRunning={false} text="[preview](#preview/https%3A%2F%2Fexample.com)" />)

    expect(await screen.findByRole('button', { name: 'Open preview' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open original' })).toBeNull()
  })

  it('routes an absolute file path link through the preview attachment', async () => {
    render(<MarkdownTextContent isRunning={false} text="Wrote it: [report](/home/user/report.md)" />)

    // In a legacy shell without openFile, the preview action remains the
    // fallback, not a dead <a>.
    await screen.findByText('report.md')
    expect(screen.getByRole('button', { name: 'Open preview' })).toBeTruthy()
    expect(globalThis.document.querySelector('a[href="/home/user/report.md"]')).toBeNull()
  })

  it('routes file:// and ~/ links the same way', async () => {
    render(
      <MarkdownTextContent isRunning={false} text={'See [notes](file:///srv/data/notes.txt) and [todo](~/todo.md)'} />
    )

    await screen.findByText('notes.txt')
    await screen.findByText('todo.md')
    expect(screen.getAllByRole('button', { name: 'Open preview' })).toHaveLength(2)
  })

  it('renders a media player for a media-extension path link', async () => {
    const { container } = render(<MarkdownTextContent isRunning={false} text="[clip](/tmp/demo.mp4)" />)

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    expect(container.querySelector('a[href="/tmp/demo.mp4"]')).toBeNull()
  })

  it('leaves anchors and relative links out of the preview pipeline', () => {
    render(
      <MarkdownTextContent
        isRunning={false}
        text={'[frag](#section-2) and [rel](docs/guide.md) and [site](https://example.com)'}
      />
    )

    // Fragment anchors survive untouched; relative links are NOT rewritten
    // (they keep Streamdown's pre-existing handling) — neither gains a
    // preview affordance.
    expect(screen.queryByRole('button', { name: 'Open preview' })).toBeNull()
    expect(globalThis.document.querySelector('a[href="#section-2"]')).not.toBeNull()
  })
})
