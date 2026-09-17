import { alertError, alertStore, alertWait, alertMd, alertConfirm, alertConfirmMulti, alertClear, waitAlert, notifySuccess, notifyInfo, notifyError } from "../alert";
import { downloadFile, LocalWriter, forageStorage, requestImmediateSave } from "../globalApi.svelte";
import { encodeRisuSaveLegacy } from "../storage/risuSave";
import { getDatabase, type Chat } from "../storage/database.svelte";
import { hydrateSummaryCharacters } from '../storage/sql/sqlRuntimeHydration'
import { chatNeedsServerFetch, fetchChatFromServer } from "../storage/chatStorage";
import { isSqlWindowPartial } from "../storage/sql/sqlRuntimeWindow";
import { isRootKeyDeferred } from "../storage/sql/deferredRootKeys";
import { ensureRootKeyHydrated } from "../storage/sql/sqlRuntimeHydration";
import { language } from "src/lang";
import { withSaverScope } from '../performance/saverMode';

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function pickNativeBackupFile(fallbackName: string): Promise<FileSystemFileHandle | null> {
    if (typeof window.showSaveFilePicker !== 'function') return null
    return await window.showSaveFilePicker({
        suggestedName: fallbackName,
        types: [{
            description: 'Risu backup',
            accept: { 'application/octet-stream': ['.bin'] },
        }],
    })
}

/**
 * Persist before a backup is built, and refuse the backup if that fails.
 *
 * `withSaverScope('export')` flushes the SQL runtime for itself, so on the
 * metadata-first path this is a second, empty flush. It stays because it is the
 * call that refuses a backup while external canonical-file editing has
 * persistence paused, and on the legacy patch-sync path it is the one that
 * pushes `database.bin` to the server before the server reads it.
 */
async function persistCurrentStateForBackup() {
    await requestImmediateSave({ flushServer: true, rejectOnFailure: true })
}

async function streamBackupToDisk(
    response: Response,
    fallbackName: string,
    nativeFile: FileSystemFileHandle | null = null,
){
    const disposition = response.headers.get('content-disposition') ?? ''
    const fileName = disposition.match(/filename=\"?([^"]+)\"?/)?.[1] ?? fallbackName
    const totalBytes = Number(response.headers.get('content-length') ?? '0')

    if (response.body || nativeFile) {
        const writableStream = nativeFile
            ? await nativeFile.createWritable()
            : (await import('streamsaver')).createWriteStream(fileName)
        const writer = writableStream.getWriter()
        let downloadedBytes = 0

        if (response.body) {
            const reader = response.body.getReader()
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                downloadedBytes += value.length
                if (totalBytes > 0) {
                    const progress = ((downloadedBytes / totalBytes) * 100).toFixed(2)
                    alertWait(`Saving local backup... (${progress}%)`)
                } else {
                    alertWait(`Saving local backup... (${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB)`)
                }
                await writer.write(value)
            }
        } else {
            await writer.write(new Uint8Array(await response.arrayBuffer()))
        }
        await writer.close()
    } else {
        await downloadFile(fileName, new Uint8Array(await response.arrayBuffer()))
    }
}

export async function SaveLocalBackup(){
    try {
        const fallbackName = `risu-backup-${Date.now()}.bin`
        const nativeFile = await pickNativeBackupFile(fallbackName)
        alertWait("Saving local backup...")
        await persistCurrentStateForBackup()
        await withSaverScope('export', async () => {
            const response = await forageStorage.exportBackup()
            await streamBackupToDisk(response, fallbackName, nativeFile)
        })
        notifySuccess('Success')
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            alertClear()
            return
        }
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Failed')
    }
}

/**
 * Saves a settings-only backup — the full backup minus characters, chats and
 * inlay images. Intended for seeding a fresh instance: modules, plugins, prompt
 * presets, personas, lorebooks, theme and API keys all travel.
 *
 * Asks about module assets first. Asset-pack modules routinely hold thousands
 * of images, so for those users the module images — not the character library —
 * are what makes the file big, and it is worth one question rather than a
 * silent multi-GB download. Excluding them ships the module definitions with
 * their images missing, which is why it is never the default.
 *
 * The server does the trimming (see /api/backup/export?mode=settings) so the
 * character library never has to cross the network.
 */
export async function SaveSettingsOnlyBackup(){
    let includeModuleAssets = true
    try {
        alertWait(language.backupSettingsOnlyEstimating)
        await persistCurrentStateForBackup()
        const estimate = await forageStorage.settingsBackupEstimate()
        alertClear()

        const baseBytes = estimate.dbBytes + estimate.baseAssets.bytes
        if (estimate.moduleAssets.count > 0) {
            // The dialog supplies its own Cancel, so only the two real choices
            // go in here. Sizes sit on the buttons because that is the whole
            // decision being made.
            const choice = await alertConfirmMulti(
                language.backupSettingsOnly,
                [
                    language.backupSettingsOnlyWithModuleAssets(
                        formatBytes(baseBytes + estimate.moduleAssets.bytes),
                    ),
                    language.backupSettingsOnlyWithoutModuleAssets(formatBytes(baseBytes)),
                ],
                language.backupSettingsOnlyBreakdown(
                    formatBytes(baseBytes),
                    estimate.moduleAssets.moduleCount,
                    estimate.moduleAssets.count,
                    formatBytes(estimate.moduleAssets.bytes),
                ),
            )
            if (choice !== 0 && choice !== 1) return
            includeModuleAssets = choice === 0
        } else {
            // Nothing worth asking about — a plain confirm with the size.
            if (!(await alertConfirm(language.backupSettingsOnlyConfirm(formatBytes(baseBytes))))) return
        }
    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Failed')
        return
    }

    try {
        alertWait("Saving settings backup...")
        await withSaverScope('export', async () => {
            const response = await forageStorage.exportBackup({ mode: 'settings', moduleAssets: includeModuleAssets })
            await streamBackupToDisk(response, `risu-settings-${Date.now()}.bin`)
        })
        if (!includeModuleAssets) {
            alertMd(language.backupSettingsOnlyModuleAssetsSkipped)
        } else {
            notifySuccess('Success')
        }
    } catch (error) {
        console.error(error)
        alertError('Failed')
    }
}

export async function SaveLocalBackupForUpstream(){
    try {
        alertWait("Saving local backup...")
        await persistCurrentStateForBackup()
        const response = await forageStorage.exportBackup({ target: 'upstream' })
        await streamBackupToDisk(response, `risu-backup-${Date.now()}-upstream.bin`)
        notifySuccess('Success')
    } catch (error) {
        console.error(error)
        alertError('Failed')
    }
}

/**
 * Saves a partial local backup with only critical assets.
 * 
 * Differences from SaveLocalBackup:
 * - Only includes profile images for characters/groups (excludes emotion images, additional assets, VITS files, CC assets)
 * - Additionally includes: persona icons, folder images, bot preset images
 * - Processes only assets in assetMap (selective) instead of all .png files in assets folder
 * - Faster and more efficient for quick backups
 * - Ideal for backing up core visual identity without bulk data
 */
export async function SavePartialLocalBackup(){
    // First confirmation: Explain the difference from regular backup
    const firstConfirm = await alertConfirm(language.partialBackupFirstConfirm)
    
    if (!firstConfirm) {
        return
    }
    
    // Second confirmation: Final warning about not saving assets
    const secondConfirm = await alertConfirm(language.partialBackupSecondConfirm)
    
    if (!secondConfirm) {
        return
    }
    
    alertWait("Saving partial local backup...")
    const writer = new LocalWriter()
    const r = await writer.init()
    if(!r){
        alertError('Failed')
        return
    }

    const db = getDatabase()
    // A backup written from a deferred plugin storage map would encode it as
    // absent, so restoring that file would wipe every plugin's stored data.
    // This function already refuses to back up partially-loaded chats for the
    // same reason; plugin storage gets the same treatment.
    if (isRootKeyDeferred('pluginCustomStorage')) {
        alertWait('Saving partial local backup... (Loading plugin storage)')
        try {
            await ensureRootKeyHydrated(db, 'pluginCustomStorage')
        } catch (error) {
            alertError(
                'Plugin storage could not be loaded, so this backup would record it as empty and '
                + `restoring the file would erase it. Backup aborted to prevent data loss.\n\n${error}`
            )
            return
        }
    }
    const assetMap = new Map<string, { charName: string, assetName: string }>()
    
    // Only collect main profile images for both characters and groups
    if (db.characters) {
        for (const char of db.characters) {
            if (!char) continue
            const charName = char.name ?? 'Unknown Character'
            
            // Save the main profile image (supports both character and group types)
            // Note: emotionImages are intentionally excluded from partial backup
            if (char.image) {
                assetMap.set(char.image, { charName: charName, assetName: 'Profile Image' })
            }
        }
    }
    
    // User icon
    if (db.userIcon) {
        assetMap.set(db.userIcon, { charName: 'User Settings', assetName: 'User Icon' })
    }
    
    // Persona icons
    if (db.personas) {
        for (const persona of db.personas) {
            if (persona && persona.icon) {
                assetMap.set(persona.icon, { charName: 'Persona', assetName: `${persona.name} Icon` })
            }
        }
    }
    
    // Custom background
    if (db.customBackground) {
        assetMap.set(db.customBackground, { charName: 'User Settings', assetName: 'Custom Background' })
    }
    
    // Folder images in characterOrder
    if (db.characterOrder) {
        for (const item of db.characterOrder) {
            if (typeof item !== 'string' && item.img) {
                assetMap.set(item.img, { charName: 'Folder', assetName: `${item.name} Folder Image` })
            }
            if (typeof item !== 'string' && item.imgFile) {
                assetMap.set(item.imgFile, { charName: 'Folder', assetName: `${item.name} Folder Image File` })
            }
        }
    }
    
    // Bot preset images
    if (db.botPresets) {
        for (const preset of db.botPresets) {
            if (preset && preset.image) {
                assetMap.set(preset.image, { charName: 'Preset', assetName: `${preset.name} Preset Image` })
            }
        }
    }
    
    const missingAssets: string[] = []

    const assetKeys = Array.from(assetMap.keys())

    for(let i=0;i<assetKeys.length;i++){
        const key = assetKeys[i]
        let message = `Saving partial local backup... (${i + 1} / ${assetKeys.length})`
        if (missingAssets.length > 0) {
            const skippedItems = missingAssets.map(key => {
                const assetInfo = assetMap.get(key);
                return assetInfo ? `'${assetInfo.assetName}' from ${assetInfo.charName}` : `'${key}'`;
            }).join(', ');
            message += `\n(Skipping... ${skippedItems})`;
        }
        alertWait(message)

        if(!key || !key.endsWith('.png')){
            continue
        }

        const data = await forageStorage.getItem(key) as unknown as Uint8Array

        if (data) {
            await writer.writeBackup(key, data)
        } else {
            missingAssets.push(key)
        }
    }

    // Reassemble full chats from server for placeholders (runtime lazy load)
    alertWait(`Saving partial local backup... (Assembling chat data)`)
    // Characters load as bootstrap summaries -- name, image, chat list,
    // timestamps -- and the description, first message, lorebook, scripts and
    // emotion images arrive only when one is opened. Cloning the live database
    // without hydrating them first writes those stubs into the archive, and a
    // backup missing most of every character the user never opened looks
    // completely normal until the day they restore it.
    //
    // Chats already had this treatment; characters never got it. Failing is the
    // right direction: a refused backup is recoverable, a silently short one is
    // not.
    await hydrateSummaryCharacters(db)

    const dbCopy = structuredClone({ ...db, account: undefined })
    for (const char of dbCopy.characters) {
        for (let i = 0; i < char.chats.length; i++) {
            const chat = char.chats[i]
            // Residency trimming leaves a long chat holding a slice with
            // `messagesLoaded` still true, so the old condition skipped the
            // fetch and fell into the refusal below -- which told the user to
            // load earlier messages, the one action that makes the slice
            // smaller. Any chat that is not its whole history is fetched.
            //
            // Read through the flag rather than the symbol-keyed window:
            // `dbCopy` came from `structuredClone`, which does not carry symbol
            // properties, so the window is not on these objects at all.
            const partial = chatNeedsServerFetch(chat)
                || (chat as Chat & { messagesFullyLoaded?: boolean }).messagesFullyLoaded === false
            if (partial && chat.id) {
                const full = await fetchChatFromServer(char.chaId, i, chat.id)
                if (full) {
                    char.chats[i] = full as Chat
                } else {
                    throw new Error(`Chat data missing for "${char.name}" / "${chat.name}" (${chat.id}). Backup aborted to prevent data loss.`)
                }
            }
            const hydrated = char.chats[i] as Chat & { messagesFullyLoaded?: boolean }
            if (hydrated._placeholder || hydrated.messagesFullyLoaded === false || isSqlWindowPartial(hydrated)) {
                throw new Error(`Load earlier messages before backup: "${hydrated.name}".`)
            }
        }
    }
    const dbData = encodeRisuSaveLegacy(dbCopy, 'compression')

    alertWait(`Saving partial local backup... (Saving database)`) 

    await writer.writeBackup('database.risudat', dbData)
    await writer.close()

    if (missingAssets.length > 0) {
        let message = 'Partial backup successful, but the following profile images were missing and skipped:\n\n'
        for (const key of missingAssets) {
            const assetInfo = assetMap.get(key)
            if (assetInfo) {
                message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`
            } else {
                message += `* **Unknown Asset**  \n  *File: ${key}*\n`
            }
        }
        alertMd(message)
    } else {
        notifySuccess('Success')
    }
}

export function LoadLocalBackup(){
    try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.bin';
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) {
                input.remove();
                return;
            }
            const file = input.files[0];
            input.remove();
            alertWait(`Loading local Backup... (Uploading ${file.name})`);
            const result = await withSaverScope('import', () => forageStorage.importBackup(file, (loaded, total, phase) => {
                if (phase === 'processing') {
                    alertWait('Loading local Backup... (Processing backup entries)')
                    return
                }
                if (phase === 'validating') {
                    alertWait('Loading local Backup... (Validating backup)')
                    return
                }
                if (phase === 'publishing') {
                    alertWait('Loading local Backup... (Publishing restored data)')
                    return
                }
                if (phase === 'finalizing') {
                    alertWait('Loading local Backup... (Finalizing restore)')
                    return
                }
                const progress = total > 0 ? ((loaded / total) * 100).toFixed(2) : '0.00'
                alertWait(`Loading local Backup... (${progress}%)`)
            }))
            if (result.coldStorageFailed && result.coldStorageFailed > 0) {
                alertError(`Warning: ${result.coldStorageFailed} character(s) could not be restored from cold storage. The imported save may be incomplete. The app will now reload.`)
                await waitAlert()
            } else {
                alertStore.set({
                    type: "wait",
                    msg: "Success, Refreshing your app."
                });
            }
            location.search = ''
            location.reload()
        };

        input.click();
    } catch (error) {
        console.error(error);
        alertError('Failed, Is file corrupted?')
    }
}

export async function ImportFromSaveZip() {
    try {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.zip'
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) {
                input.remove()
                return
            }
            const file = input.files[0]
            input.remove()

            if (!(await alertConfirm(language.importSaveFolderConfirmZip(file.name, formatBytes(file.size))))) return
            if (!(await alertConfirm(language.backupLoadConfirm2))) return

            alertWait(`Uploading ${file.name}...`)
            const result = await withSaverScope('import', () => forageStorage.uploadSaveFolderZip(file, (loaded, total) => {
                const progress = total > 0 ? ((loaded / total) * 100).toFixed(2) : '0.00'
                alertWait(`Uploading ${file.name}... (${progress}%)`)
            }))

            alertStore.set({
                type: "wait",
                msg: `${language.importSaveFolderSuccess} (${result.imported} files). Refreshing...`
            })
            location.search = ''
            location.reload()
        }

        input.click()
    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Import failed')
    }
}

export async function CleanupMigratedFiles() {
    try {
        alertWait(language.importSaveFolderScanning)
        let scan: { count: number, totalSize: number }
        try {
            scan = await forageStorage.scanCleanup()
        } catch (error) {
            notifyError(error instanceof Error ? error.message : language.cleanupMigratedNotReady)
            return
        }

        if (scan.count === 0) {
            notifyInfo(language.cleanupMigratedNoFiles)
            return
        }

        const sizeStr = formatBytes(scan.totalSize)
        if (!(await alertConfirm(language.cleanupMigratedConfirm(scan.count, sizeStr)))) return

        alertWait(language.cleanupMigratedCleaning)
        const result = await forageStorage.executeCleanup()

        notifySuccess(language.cleanupMigratedSuccess(result.removed, formatBytes(result.freedBytes)))
    } catch (error) {
        console.error(error)
        notifyError(error instanceof Error ? error.message : 'Cleanup failed')
    }
}

// ── Server-side backup functions ─────────────────────────────────────────────

export async function SaveServerBackup() {
    try {
        alertWait(language.serverBackupSaving)
        await persistCurrentStateForBackup()
        // Same scope the download path uses. The server builds this backup from
        // SQL, so anything the client is still holding dirty would be missing
        // from it -- and a server backup is the one you restore from, which
        // resets the relational store and rebuilds it from the file.
        const result = await withSaverScope('export', () => forageStorage.saveServerBackup((current, total, bytes) => {
            const pct = total > 0 ? ((current / total) * 100).toFixed(1) : '0'
            const bytesStr = formatBytes(bytes)
            alertWait(`${language.serverBackupSaving} (${pct}% - ${bytesStr})`)
        }))
        notifySuccess(language.serverBackupSaveSuccess(result.filename, formatBytes(result.size)))
    } catch (error) {
        console.error(error)
        alertError(error instanceof Error ? error.message : 'Server backup failed')
    }
}
