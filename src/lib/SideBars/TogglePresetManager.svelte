<script lang="ts">
    import {
        ChevronDownIcon,
        ChevronUpIcon,
        CopyIcon,
        DownloadIcon,
        EllipsisVerticalIcon,
        PencilIcon,
        PlusIcon,
        RefreshCwIcon,
        TrashIcon,
        UploadIcon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm, alertError, alertInput, notifySuccess } from 'src/ts/alert'
    import { downloadFile } from 'src/ts/globalApi.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { selectSingleFile } from 'src/ts/util'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import ShDropdownMenu from '../UI/GUI/ShDropdownMenu.svelte'
    import ShDropdownMenuContent from '../UI/GUI/ShDropdownMenuContent.svelte'
    import ShDropdownMenuItem from '../UI/GUI/ShDropdownMenuItem.svelte'
    import ShDropdownMenuSeparator from '../UI/GUI/ShDropdownMenuSeparator.svelte'
    import ShDropdownMenuTrigger from '../UI/GUI/ShDropdownMenuTrigger.svelte'
    import ShSwitch from '../UI/GUI/ShSwitch.svelte'

    interface Props {
        open: boolean
        currentPromptPresetName?: string
        snapshotValues: () => Record<string, string>
        applyValues: (values: Record<string, string>) => void
        onOpenChange: (open: boolean) => void
    }

    let { open, currentPromptPresetName, snapshotValues, applyValues, onOpenChange }: Props = $props()
    let showAll = $state(false)

    function close() {
        onOpenChange(false)
    }

    function commitPresets() {
        DBState.db.togglePresets = [...(DBState.db.togglePresets ?? [])]
    }

    async function importPreset() {
        let file: { name: string, data: Uint8Array } | undefined
        try {
            file = await selectSingleFile(['json'])
        }
        catch {
            return
        }
        if (!file) return

        try {
            const data = JSON.parse(Buffer.from(file.data).toString('utf-8'))
            if (typeof data.name !== 'string' || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
                alertError(language.togglePresetImportError)
                return
            }
            const values: Record<string, string> = {}
            for (const [key, value] of Object.entries(data.values)) {
                if (typeof key === 'string' && typeof value === 'string') values[key] = value
            }
            DBState.db.togglePresets ??= []
            DBState.db.togglePresets.push({
                name: data.name,
                values,
                promptPresetName: typeof data.promptPresetName === 'string' ? data.promptPresetName : undefined,
            })
            commitPresets()
            notifySuccess((language.togglePresetImported as any)(data.name))
        }
        catch {
            alertError(language.togglePresetImportError)
        }
    }
</script>

<ShDialog {open} onOpenChange={(next) => { if (!next) close() }} tier="base">
    {#snippet title()}{language.togglePresetSelectTitle}{/snippet}

    {#if open}
        <div class="flex flex-col gap-3">
            <label class="flex items-center gap-2 text-sm text-textcolor2 self-start cursor-pointer select-none">
                <ShSwitch bind:checked={showAll} />
                {language.togglePresetFilterShowAll}
            </label>

            {#if !DBState.db.togglePresets?.length}
                <p class="text-textcolor2 text-sm">{language.togglePresetEmpty}</p>
            {:else}
                {@const filteredPresets = showAll
                    ? DBState.db.togglePresets.map((preset, index) => ({ preset, index }))
                    : DBState.db.togglePresets.map((preset, index) => ({ preset, index }))
                        .filter(({ preset }) => preset.promptPresetName === currentPromptPresetName)}
                {#if filteredPresets.length === 0}
                    <p class="text-textcolor2 text-sm">{language.togglePresetEmptyFiltered}</p>
                {:else}
                    <div class="flex flex-col gap-1">
                        {#each filteredPresets as { preset, index }}
                            <div class="flex items-center border border-darkborderc rounded-md hover:ring-1 hover:ring-borderc/50 transition-shadow">
                                <button class="flex-1 min-w-0 p-2 text-left cursor-pointer text-textcolor truncate hover:bg-selected/30 rounded-l-md transition-colors" onclick={async () => {
                                    const mismatch = preset.promptPresetName !== currentPromptPresetName
                                    const confirmed = await alertConfirm(mismatch ? language.togglePresetMismatchConfirm : language.togglePresetApplyConfirm)
                                    if (!confirmed) return
                                    applyValues($state.snapshot(preset.values))
                                    notifySuccess((language.togglePresetApplied as any)(preset.name))
                                    close()
                                }}>
                                    <div class="text-xs text-textcolor2 leading-tight">{preset.promptPresetName ?? language.togglePresetNoPromptPreset}</div>
                                    {preset.name}
                                </button>
                                <div class="flex items-center shrink-0 pr-1 gap-0.5">
                                    {#if showAll}
                                        <ShButton variant="ghost" size="icon-xs" onclick={() => {
                                            if (index <= 0) return
                                            const presets = DBState.db.togglePresets!
                                            ;[presets[index - 1], presets[index]] = [presets[index], presets[index - 1]]
                                            commitPresets()
                                        }}><ChevronUpIcon size={14} /></ShButton>
                                        <ShButton variant="ghost" size="icon-xs" onclick={() => {
                                            const presets = DBState.db.togglePresets!
                                            if (index >= presets.length - 1) return
                                            ;[presets[index], presets[index + 1]] = [presets[index + 1], presets[index]]
                                            commitPresets()
                                        }}><ChevronDownIcon size={14} /></ShButton>
                                    {/if}
                                    <ShDropdownMenu>
                                        <ShDropdownMenuTrigger>
                                            {#snippet child({ props })}
                                                <ShButton {...props} variant="ghost" size="icon-xs"><EllipsisVerticalIcon size={14} /></ShButton>
                                            {/snippet}
                                        </ShDropdownMenuTrigger>
                                        <ShDropdownMenuContent class="min-w-40" align="end">
                                            <ShDropdownMenuItem onSelect={async () => {
                                                const name = DBState.db.togglePresets![index].name
                                                if (!await alertConfirm((language.togglePresetOverwriteConfirm as any)(name))) return
                                                DBState.db.togglePresets![index].values = snapshotValues()
                                                DBState.db.togglePresets![index].promptPresetName = currentPromptPresetName
                                                commitPresets()
                                                notifySuccess((language.togglePresetOverwritten as any)(name))
                                            }}><RefreshCwIcon size={14} />{language.togglePresetMenuOverwrite}</ShDropdownMenuItem>
                                            <ShDropdownMenuItem onSelect={async () => {
                                                const oldName = DBState.db.togglePresets![index].name
                                                const name = await alertInput(language.togglePresetRename, [], oldName)
                                                if (!name || name === oldName) return
                                                DBState.db.togglePresets![index].name = name
                                                commitPresets()
                                                notifySuccess((language.togglePresetRenamed as any)(oldName, name))
                                            }}><PencilIcon size={14} />{language.togglePresetMenuRename}</ShDropdownMenuItem>
                                            <ShDropdownMenuItem onSelect={() => {
                                                const copy = $state.snapshot(preset)
                                                copy.name = `${preset.name} (Copy)`
                                                DBState.db.togglePresets!.splice(index + 1, 0, copy)
                                                commitPresets()
                                                notifySuccess((language.togglePresetDuplicated as any)(copy.name))
                                            }}><CopyIcon size={14} />{language.togglePresetMenuDuplicate}</ShDropdownMenuItem>
                                            <ShDropdownMenuItem onSelect={() => {
                                                const data = { name: preset.name, values: preset.values, promptPresetName: preset.promptPresetName }
                                                downloadFile(`${preset.name}_toggle.json`, Buffer.from(JSON.stringify(data, null, 2), 'utf-8'))
                                                notifySuccess((language.togglePresetExported as any)(preset.name))
                                            }}><DownloadIcon size={14} />{language.togglePresetMenuExport}</ShDropdownMenuItem>
                                            <ShDropdownMenuSeparator />
                                            <ShDropdownMenuItem variant="destructive" onSelect={async () => {
                                                const name = DBState.db.togglePresets![index].name
                                                if (!await alertConfirm((language.togglePresetDeleteConfirm as any)(name))) return
                                                DBState.db.togglePresets!.splice(index, 1)
                                                commitPresets()
                                                notifySuccess((language.togglePresetDeleted as any)(name))
                                            }}><TrashIcon size={14} />{language.togglePresetMenuDelete}</ShDropdownMenuItem>
                                        </ShDropdownMenuContent>
                                    </ShDropdownMenu>
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}

            <div class="flex flex-col sm:flex-row gap-2 mt-1">
                <ShButton variant="outline" className="w-full sm:flex-1 sm:w-auto" onclick={async () => {
                    const name = await alertInput(language.togglePresetNamePrompt)
                    if (!name) return
                    DBState.db.togglePresets ??= []
                    DBState.db.togglePresets.push({ name, values: snapshotValues(), promptPresetName: currentPromptPresetName })
                    commitPresets()
                    notifySuccess((language.togglePresetSaved as any)(name))
                }}><PlusIcon size={16} />{language.togglePresetSaveNew}</ShButton>
                <ShButton variant="outline" className="w-full sm:flex-1 sm:w-auto" onclick={importPreset}>
                    <UploadIcon size={16} />{language.togglePresetImport}
                </ShButton>
            </div>
        </div>
    {/if}
</ShDialog>
