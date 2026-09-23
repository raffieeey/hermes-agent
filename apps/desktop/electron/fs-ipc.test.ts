/**
 * `hermes:fs:reveal` answers what it did (#115167). `shell.showItemInFolder`
 * selects an existing item and silently no-ops on a missing one, and a remote
 * backend's paths are missing on this computer by construction — a `true` for
 * them left the renderer nothing to say.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler)
  },
  shell: {
    showItemInFolder: electron.showItemInFolder,
    openPath: electron.openPath
  }
}))

vi.mock('./desktop-plugin-install', () => ({ installDesktopPluginFromGit: vi.fn(), probePluginRepo: vi.fn() }))
vi.mock('./desktop-plugins-root', () => ({
  DESKTOP_PLUGINS_DIR: 'desktop-plugins',
  ensureDir: vi.fn(),
  migrateProfileScopedDesktopPlugins: vi.fn(),
  reconcileUnifiedDesktopHalves: vi.fn()
}))

import { type FsIpcDeps, registerFsIpc } from './fs-ipc'
import { resolveRequestedPathForIpc } from './hardening'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-fs-ipc-'))

const fsIpcDeps: FsIpcDeps = {
  hermesHome: scratch,
  readActiveDesktopProfile: () => null,
  // `~/` resolves under the scratch dir so tilde paths can be exercised.
  expandUserPath: value => (value.startsWith('~/') ? path.join(scratch, value.slice(2)) : value),
  resolveRequestedPathForIpc,
  directoryExists: value => fs.existsSync(value),
  resolveGitBinary: () => 'git'
}

registerFsIpc(fsIpcDeps)

const reveal = (target: string) => electron.handlers.get('hermes:fs:reveal')!({}, target)
const openFile = (target: string, cwd?: string) => electron.handlers.get('hermes:fs:openFile')!({}, target, cwd)

afterEach(() => {
  electron.showItemInFolder.mockClear()
  electron.openPath.mockReset()
  electron.openPath.mockResolvedValue('')
})

describe('hermes:fs:openFile', () => {
  it('uses the OS file association on the original path, including a spaced file URL', async () => {
    const file = path.join(scratch, 'My Report.docx')
    fs.writeFileSync(file, 'document fixture')

    await expect(openFile(file)).resolves.toEqual({ ok: true })
    await expect(openFile(new URL(`file://${file.replaceAll(' ', '%20')}`).href)).resolves.toEqual({ ok: true })
    expect(electron.openPath).toHaveBeenCalledTimes(2)
    expect(electron.openPath).toHaveBeenCalledWith(file)
  })

  it('resolves a relative attachment against its owning session cwd', async () => {
    const file = path.join(scratch, 'relative.docx')
    fs.writeFileSync(file, 'document fixture')

    await expect(openFile('relative.docx', scratch)).resolves.toEqual({ ok: true })
    expect(electron.openPath).toHaveBeenCalledWith(file)
  })

  it('rejects a missing file and a directory without starting another application', async () => {
    await expect(openFile(path.join(scratch, 'missing.docx'))).resolves.toMatchObject({ ok: false })
    await expect(openFile(scratch)).resolves.toMatchObject({ ok: false })
    expect(electron.openPath).not.toHaveBeenCalled()
  })

  it('returns an OS association error instead of reporting success', async () => {
    const file = path.join(scratch, 'unassociated.pptx')
    fs.writeFileSync(file, 'fixture')
    electron.openPath.mockResolvedValueOnce('No application can open this file')

    await expect(openFile(file)).resolves.toEqual({ ok: false, error: 'No application can open this file' })
  })

  it('rejects non-file URL schemes before the OS opener', async () => {
    await expect(openFile('https://example.com/report.docx')).resolves.toMatchObject({ ok: false })
    expect(electron.openPath).not.toHaveBeenCalled()
  })
  it.each(['file://other-host/tmp/report.docx', 'file:///tmp/a%2Fb.docx'])(
    'does not reinterpret a rejected file URL as a local path: %s',
    async url => {
      await expect(openFile(url)).resolves.toMatchObject({ ok: false })
      expect(electron.openPath).not.toHaveBeenCalled()
    }
  )

  it('rejects a foreign-host file URL before Windows can stat the UNC share', async () => {
    // Windows fileURLToPath accepts file://other-host/share as a UNC path;
    // its stat can authenticate to the remote host even if openPath never runs.
    const resolve = vi.fn(() => '\\\\other-host\\share\\report.docx')
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as fs.Stats)
    registerFsIpc({ ...fsIpcDeps, resolveRequestedPathForIpc: resolve })

    try {
      await expect(openFile('file://other-host/share/report.docx')).resolves.toMatchObject({ ok: false })
      expect(resolve).not.toHaveBeenCalled()
      expect(stat).not.toHaveBeenCalled()
      expect(electron.openPath).not.toHaveBeenCalled()
    } finally {
      registerFsIpc(fsIpcDeps)
      stat.mockRestore()
    }
  })
})

describe('hermes:fs:reveal', () => {
  it('reveals a path that exists on this computer', async () => {
    const file = path.join(scratch, 'workspace')
    fs.mkdirSync(file)

    await expect(reveal(file)).resolves.toBe(true)
    expect(electron.showItemInFolder).toHaveBeenCalledWith(file)
  })

  // A remote backend's workspace is not on this machine: showItemInFolder
  // would silently no-op, so the door must report the miss instead of success.
  it('reports false without touching the file manager when the path is missing', async () => {
    await expect(reveal(path.join(scratch, 'not-here'))).resolves.toBe(false)
    expect(electron.showItemInFolder).not.toHaveBeenCalled()
  })

  it('reports false for a path that is not on this computer, and only shows one that is', async () => {
    const here = path.join(scratch, 'notes.md')

    fs.writeFileSync(here, 'x')

    await expect(reveal('/home/hermes/.hermes/attachments/report.zip')).resolves.toBe(false)
    expect(electron.showItemInFolder).not.toHaveBeenCalled()

    await expect(reveal(here)).resolves.toBe(true)
    expect(electron.showItemInFolder).toHaveBeenCalledTimes(1)
    expect(electron.showItemInFolder).toHaveBeenCalledWith(here)
  })

  // The renderer may hand over a tilde path; the existence check runs on the
  // expanded path, and the expanded path is what the file manager is shown.
  it('expands a tilde path before checking and revealing it', async () => {
    const here = path.join(scratch, 'tilde.md')

    fs.writeFileSync(here, 'x')

    await expect(reveal('~/tilde.md')).resolves.toBe(true)
    expect(electron.showItemInFolder).toHaveBeenCalledWith(here)
  })
})
