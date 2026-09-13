import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertClear: vi.fn(),
    alertError: vi.fn(),
    alertWait: vi.fn(),
    createWriteStream: vi.fn(),
    exportBackup: vi.fn(),
    notifySuccess: vi.fn(),
    requestImmediateSave: vi.fn(),
}))

vi.mock('../alert', () => ({
    alertClear: mocks.alertClear,
    alertConfirm: vi.fn(),
    alertConfirmMulti: vi.fn(),
    alertError: mocks.alertError,
    alertMd: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: mocks.alertWait,
    notifyError: vi.fn(),
    notifyInfo: vi.fn(),
    notifySuccess: mocks.notifySuccess,
    waitAlert: vi.fn(),
}))

vi.mock('../globalApi.svelte', () => ({
    downloadFile: vi.fn(),
    forageStorage: {
        exportBackup: mocks.exportBackup,
    },
    LocalWriter: class {},
    requestImmediateSave: mocks.requestImmediateSave,
}))

vi.mock('../storage/risuSave', () => ({ encodeRisuSaveLegacy: vi.fn() }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn(() => ({ characters: [] })) }))
vi.mock('../storage/chatStorage', () => ({ fetchChatFromServer: vi.fn() }))
vi.mock('src/lang', () => ({ language: {} }))
vi.mock('streamsaver', () => ({
    createWriteStream: mocks.createWriteStream,
    default: { createWriteStream: mocks.createWriteStream },
}))

import { SaveLocalBackup } from './backuplocal'

describe('local backup download', () => {
    const originalShowSaveFilePicker = window.showSaveFilePicker

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.requestImmediateSave.mockResolvedValue(undefined)
        delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
    })

    afterEach(() => {
        if (originalShowSaveFilePicker) {
            Object.defineProperty(window, 'showSaveFilePicker', {
                configurable: true,
                value: originalShowSaveFilePicker,
            })
        } else {
            delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
        }
    })

    it('streams to a native file handle without using the failing StreamSaver close path', async () => {
        const expected = new Uint8Array([1, 2, 3, 4])
        const written: number[] = []
        const nativeWritable = new WritableStream<Uint8Array>({
            write(chunk) {
                written.push(...chunk)
            },
        })
        const fileHandle = {
            createWritable: vi.fn(async () => nativeWritable),
        }
        const showSaveFilePicker = vi.fn(async () => fileHandle)
        Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value: showSaveFilePicker,
        })
        mocks.exportBackup.mockResolvedValue(new Response(expected, {
            headers: {
                'content-disposition': 'attachment; filename="risu-backup-test.bin"',
                'content-length': String(expected.byteLength),
            },
        }))
        mocks.createWriteStream.mockReturnValue({
            getWriter: () => ({
                write: vi.fn(),
                close: vi.fn(async () => { throw new Error('StreamSaver close failed') }),
            }),
        })

        await SaveLocalBackup()

        expect(showSaveFilePicker).toHaveBeenCalledOnce()
        expect(showSaveFilePicker.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.requestImmediateSave.mock.invocationCallOrder[0],
        )
        expect(mocks.requestImmediateSave).toHaveBeenCalledWith({ flushServer: true, rejectOnFailure: true })
        expect(mocks.requestImmediateSave.mock.invocationCallOrder[0]).toBeLessThan(mocks.exportBackup.mock.invocationCallOrder[0])
        expect(fileHandle.createWritable).toHaveBeenCalledOnce()
        expect(written).toEqual([...expected])
        expect(mocks.createWriteStream).not.toHaveBeenCalled()
        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).toHaveBeenCalledWith('Success')
    })

    it('does not export or report success when the current state cannot be persisted', async () => {
        const error = new Error('disk flush failed')
        mocks.requestImmediateSave.mockRejectedValue(error)
        Object.defineProperty(window, 'showSaveFilePicker', {
            configurable: true,
            value: vi.fn(async () => ({ createWritable: vi.fn() })),
        })

        await SaveLocalBackup()

        expect(mocks.exportBackup).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        expect(mocks.alertError).toHaveBeenCalledWith('disk flush failed')
    })
})
