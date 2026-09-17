<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShAccordion from 'src/lib/UI/GUI/ShAccordion.svelte'
    import ShLoadingDialog from 'src/lib/UI/GUI/ShLoadingDialog.svelte'
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte'
    import { Tooltip } from 'bits-ui'
    import {
        RefreshCwIcon,
        HardDriveIcon,
        UsersIcon,
        SparklesIcon,
        TriangleAlertIcon,
        InfoIcon,
        BlocksIcon,
    } from '@lucide/svelte'
    import { alertConfirm, alertMd, notifyError, notifySuccess } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { settingsOpen } from 'src/ts/stores.svelte'
    import { getDatabase } from 'src/ts/storage/database.svelte'
    import { changeChar } from 'src/ts/characters'
    import { language } from 'src/lang'

    // ── Types ────────────────────────────────────────────────────────────────
    interface PrefixInfo { totalSize: number; count: number }
    interface Stats {
        files: { db: number }
        disk: { free: number | null; total: number | null }
        storage: { reclaimable: number; mode: string }
        prefixes: Record<string, PrefixInfo>
        kvRows: number
        kvTotalBytes: number
        inlayFsBytes?: number
        trashed: { count: number; expiredCount: number; available: boolean }
        orphan: { count: number; totalSize: number; available: boolean }
        etag: string | null
    }
    interface CharBreakdown {
        chaId: string; name: string; image: string; trashed: boolean
        cardBytes: number; imgBytes: number; chatBytes: number; totalBytes: number
    }
    interface CharStats {
        characters: CharBreakdown[]
        orphan: { count: number; totalSize: number }
    }
    interface ModuleBreakdown {
        id: string; name: string
        bodyBytes: number; assetBytes: number; totalBytes: number
    }
    interface ModuleStats {
        modules: ModuleBreakdown[]
    }

    // ── State ────────────────────────────────────────────────────────────────
    let stats = $state<Stats | null>(null)
    let loading = $state(false)
    let loadError = $state<string | null>(null)

    let characters = $state<CharStats | null>(null)
    let charLoading = $state(false)
    let charError = $state<string | null>(null)
    let charElapsed = $state<number | null>(null)
    let charShown = $state(50)

    let modules = $state<ModuleStats | null>(null)
    let modLoading = $state(false)
    let modError = $state<string | null>(null)
    let modElapsed = $state<number | null>(null)
    let modShown = $state(50)

    let orphanCleanupOpen = $state(false)

    // Default off = show only RisuAI internal breakdown (smaller scope, more
    // useful at-a-glance). Toggle on to expand the bar to disk-total scale
    // including "Other (system & apps)" and "Free space".
    let showFullDisk = $state(false)

    const PAGE_SIZE = 50

    // ── Format helpers ───────────────────────────────────────────────────────
    function fmtBytes(n: number | null | undefined): string {
        if (n == null) return '—'
        if (n < 1024) return `${n} B`
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
        if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
        return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }
    // ── Fetch ────────────────────────────────────────────────────────────────
    async function loadStats() {
        loading = true
        loadError = null
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/stats', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const payload = await res.json()
            stats = {
                ...payload,
                storage: payload.storage ?? {
                    reclaimable: payload.sqlite?.reclaimable ?? 0,
                    mode: payload.sqlite?.journalMode ?? 'legacy',
                },
            }
        } catch (err) {
            loadError = err instanceof Error ? err.message : String(err)
        } finally {
            loading = false
        }
    }

    async function loadCharacters() {
        charLoading = true
        charError = null
        const t0 = Date.now()
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/stats/characters', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            characters = await res.json()
            charElapsed = Date.now() - t0
            charShown = PAGE_SIZE
        } catch (err) {
            charError = err instanceof Error ? err.message : String(err)
        } finally {
            charLoading = false
        }
    }

    async function loadModules() {
        modLoading = true
        modError = null
        const t0 = Date.now()
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/stats/modules', { headers: { 'risu-auth': auth } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            modules = await res.json()
            modElapsed = Date.now() - t0
            modShown = PAGE_SIZE
        } catch (err) {
            modError = err instanceof Error ? err.message : String(err)
        } finally {
            modLoading = false
        }
    }

    async function cleanupAllOrphans() {
        if (!stats) return
        const hypa = stats.prefixes['cache/hypa-vector/'] ?? { count: 0, totalSize: 0 }
        const ok = await alertConfirm(language.storageOrphanCleanupConfirm(
            stats.orphan.available ? stats.orphan.count : 0,
            stats.orphan.available ? stats.orphan.totalSize : 0,
            hypa.count,
            hypa.totalSize,
            stats.storage.reclaimable,
        ))
        if (!ok) return
        orphanCleanupOpen = true
        try {
            const auth = await forageStorage.createAuth()
            const res = await fetch('/api/db/orphans/cleanup', {
                method: 'POST',
                headers: { 'risu-auth': auth },
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) {
                notifyError(language.storageOrphanCleanupFailed + ': ' + (json?.error || `HTTP ${res.status}`))
                return
            }
            notifySuccess(language.storageOrphanCleanupDone(
                json.assets?.count ?? 0,
                json.hypaVectors?.count ?? 0,
                json.objects?.count ?? 0,
                json.reclaimed ?? 0,
            ))
            characters = null
            await loadStats()
        } catch (err) {
            notifyError(language.storageOrphanCleanupFailed + ': ' + (err instanceof Error ? err.message : String(err)))
        } finally {
            orphanCleanupOpen = false
        }
    }

    // ── Disk usage rows ──────────────────────────────────────────────────────
    // 10 distinct hues spanning the wheel — visually separable even at narrow
    // bar widths, and intuitive grouping (red/orange = data, green/teal = media,
    // blue/violet = backups, gray = overhead).
    interface DiskRow {
        id: string
        label: string
        desc: string
        size: number
        color: string
    }

    const diskRows = $derived.by<DiskRow[]>(() => {
        if (!stats) return []
        const p = stats.prefixes
        const get = (k: string) => p[k]?.totalSize ?? 0
        // Two separate quantities for inlay:
        //  - inlayKvTotal: bytes inside the compatibility object store (counts against
        //    kvTotalBytes for uncategorized accounting).
        //  - inlayTotal:   what we display in the chart, includes fs payload
        //    that lives in save/inlays/ post-migration.
        const inlayKvTotal = get('inlay/') + get('inlay_thumb/') + get('inlay_meta/') + get('inlay_info/')
        const inlayFsBytes = stats.inlayFsBytes ?? 0
        const inlayTotal = inlayKvTotal + inlayFsBytes
        // database.bin is a rebuildable compatibility projection stored as one
        // file-KV value. SQL blob chunking is no longer part of the runtime.
        const dbRowSize = get('database/database.bin')
        // Known kv prefixes I track explicitly — kv-side only. If anything
        // else lives in kv (test keys, migration leftovers), it shows up
        // under "uncategorized" so the bar always sums correctly.
        const knownKv =
            get('assets/') + inlayKvTotal + get('remotes/') + get('coldstorage/') + dbRowSize
        const uncategorizedKv = Math.max(0, stats.kvTotalBytes - knownKv)
        // File-store structural metadata and unreachable content-addressed
        // objects are reported through the legacy-compatible stats shape.
        const reclaimable = stats.storage.reclaimable
        const structuralOverhead = Math.max(0, stats.files.db - stats.kvTotalBytes - reclaimable)
        const rows: DiskRow[] = [
            { id: 'kv-database',     label: language.storageRowKvDatabase,     desc: language.storageRowKvDatabaseDesc,     size: dbRowSize,                     color: 'bg-danger' },
            { id: 'kv-assets',       label: language.storageRowKvAssets,       desc: language.storageRowKvAssetsDesc,       size: get('assets/'),                color: 'bg-warning' },
            { id: 'kv-inlay',        label: language.storageRowKvInlay,        desc: language.storageRowKvInlayDesc,        size: inlayTotal,                    color: 'bg-success' },
            { id: 'kv-remotes',      label: language.storageRowKvRemotes,      desc: language.storageRowKvRemotesDesc,      size: get('remotes/'),               color: 'bg-info' },
            { id: 'kv-cold',         label: language.storageRowKvColdStorage,  desc: language.storageRowKvColdStorageDesc,  size: get('coldstorage/'),           color: 'bg-textcolor2' },
            { id: 'kv-uncat',        label: language.storageRowKvUncategorized, desc: language.storageRowKvUncategorizedDesc, size: uncategorizedKv,             color: 'bg-darkbutton' },
            { id: 'overhead',        label: language.storageRowSqliteOverhead, desc: language.storageRowSqliteOverheadDesc, size: structuralOverhead,            color: 'bg-borderc' },
            { id: 'reclaimable',     label: language.storageRowReclaimablePages, desc: language.storageRowReclaimablePagesDesc, size: reclaimable,               color: 'bg-warning' },
        ]
        return rows.filter(r => r.size > 0)
    })

    const risuFootprint = $derived(
        stats
            ? stats.files.db + (stats.inlayFsBytes ?? 0)
            : 0
    )

    const diskTotal = $derived(stats?.disk.total ?? null)
    const diskFree = $derived(stats?.disk.free ?? null)
    const diskUsed = $derived(diskTotal != null && diskFree != null ? diskTotal - diskFree : null)
    const otherUsed = $derived(diskUsed != null ? Math.max(0, diskUsed - risuFootprint) : null)
    const diskUsedPct = $derived(
        diskTotal != null && diskUsed != null && diskTotal > 0 ? (diskUsed / diskTotal) * 100 : null
    )
    // 90-94% → yellow warn, 95%+ → red destructive.
    const diskUsageLevel = $derived<'none' | 'warn' | 'crit'>(
        diskUsedPct == null ? 'none'
            : diskUsedPct >= 95 ? 'crit'
            : diskUsedPct >= 90 ? 'warn'
            : 'none'
    )

    // Bar denominator depends on view mode.
    //   Disk mode: full disk total — RisuAI slices may be near-invisible slivers.
    //   Internal mode: RisuAI footprint — every slice expands proportionally.
    const barDenominator = $derived(showFullDisk ? (diskTotal ?? Math.max(1, risuFootprint)) : Math.max(1, risuFootprint))

    function slicePct(size: number): number {
        if (size <= 0 || barDenominator <= 0) return 0
        return (size / barDenominator) * 100
    }

    // ── Per-row helpers ─────────────────────────────────────────────────────
    function pctOf(part: number, whole: number): number {
        if (whole <= 0) return 0
        return Math.max(0, Math.min(100, (part / whole) * 100))
    }

    // Close the dashboard and select the character this row represents.
    // Trashed rows aren't in the live characters array, so there's nothing to jump to.
    function jumpToCharacter(c: CharBreakdown) {
        if (c.trashed) return
        const index = getDatabase().characters.findIndex((ch) => ch.chaId === c.chaId)
        if (index === -1) return
        void changeChar(index)
        settingsOpen.set(false)
    }

    const charSlice = $derived(characters?.characters.slice(0, charShown) ?? [])
    const charRemaining = $derived((characters?.characters.length ?? 0) - charShown)
    const modSlice = $derived(modules?.modules.slice(0, modShown) ?? [])
    const modRemaining = $derived((modules?.modules.length ?? 0) - modShown)

    const hypaCache = $derived(stats?.prefixes['cache/hypa-vector/'] ?? { count: 0, totalSize: 0 })
    const hasCleanupCandidates = $derived(!!stats && (
        (stats.orphan.available && stats.orphan.count > 0)
        || hypaCache.count > 0
        || stats.storage.reclaimable > 0
    ))

    // ⓘ button: opens a small markdown modal. Works on touch (where hover
    // tooltips are unreachable) and via keyboard.
    function openRowDetails(label: string, desc: string, size: number) {
        alertMd(`### ${label}\n\n${fmtBytes(size)}\n\n${desc}`)
    }

    $effect(() => { loadStats() })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.storageDashboardDesc}</p>

<div class="flex justify-end mb-3">
    <ShButton variant="outline" size="default" onclick={loadStats} disabled={loading}>
        <RefreshCwIcon size={16} class={loading ? 'animate-spin' : ''} />
        <span class="hidden sm:inline">{loading ? language.storageLoading : language.storageRefresh}</span>
    </ShButton>
</div>

{#if loadError}
    <ShAlert variant="destructive" className="mb-4">
        {#snippet icon()}<TriangleAlertIcon />{/snippet}
        {language.storageFailedLoad}: {loadError}
    </ShAlert>
{/if}

{#if stats}
    <Tooltip.Provider delayDuration={300}>

    <!-- ① Storage (macOS-style) ──────────────────────────────────────────── -->
    <div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
        <div class="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
            <div class="flex items-center gap-2 text-textcolor">
                <HardDriveIcon size={16} />
                <span class="font-medium">{language.storageDiskUsage}</span>
            </div>
            <span class="text-textcolor2 text-sm tabular-nums">
                {#if !showFullDisk}
                    {language.storageDiskRisuTotal(risuFootprint)}
                {:else if diskTotal != null && diskUsed != null}
                    {language.storageDiskHeader(diskUsed, diskTotal)}
                {:else}
                    {language.storageDiskHeaderUnknown}
                {/if}
            </span>
        </div>

        {#if diskUsageLevel === 'crit' && diskUsedPct != null}
            <div class="bg-draculared/20 border border-draculared/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-danger">
                <TriangleAlertIcon class="size-4 shrink-0 text-danger" />
                <span class="leading-relaxed text-sm">{language.storageDiskUsageHighWarning(diskUsedPct)}</span>
            </div>
        {:else if diskUsageLevel === 'warn' && diskUsedPct != null}
            <div class="bg-warning-bg border border-warning-border/40 rounded-md px-4 py-3 mb-3 flex items-center gap-2.5 text-warning">
                <TriangleAlertIcon class="size-4 shrink-0 text-warning" />
                <span class="leading-relaxed text-sm">{language.storageDiskUsageHighWarning(diskUsedPct)}</span>
            </div>
        {/if}

        <!-- Stacked bar — each slice is a Tooltip trigger so hover shows label + size. -->
        <div class="flex h-7 bg-bgcolor border border-darkborderc rounded-md overflow-hidden mb-3">
            {#each diskRows as row (row.id)}
                <Tooltip.Root>
                    <Tooltip.Trigger>
                        {#snippet child({ props })}
                            <div {...props} class={row.color + ' cursor-help'} style:width={slicePct(row.size).toFixed(3) + '%'}></div>
                        {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                        <Tooltip.Content
                            class="bg-darkbg border border-darkborderc rounded-md px-3 py-2 text-xs text-textcolor shadow-lg z-50 leading-relaxed"
                            sideOffset={4}
                            collisionPadding={8}
                        >
                            <div class="font-medium">{row.label}</div>
                            <div class="text-textcolor2 tabular-nums">{fmtBytes(row.size)}</div>
                        </Tooltip.Content>
                    </Tooltip.Portal>
                </Tooltip.Root>
            {/each}
            {#if showFullDisk && otherUsed != null && otherUsed > 0}
                <Tooltip.Root>
                    <Tooltip.Trigger>
                        {#snippet child({ props })}
                            <div {...props} class="bg-textcolor2/40 cursor-help" style:width={slicePct(otherUsed).toFixed(3) + '%'}></div>
                        {/snippet}
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                        <Tooltip.Content
                            class="bg-darkbg border border-darkborderc rounded-md px-3 py-2 text-xs text-textcolor shadow-lg z-50 leading-relaxed"
                            sideOffset={4}
                            collisionPadding={8}
                        >
                            <div class="font-medium">{language.storageDiskOther}</div>
                            <div class="text-textcolor2 tabular-nums">{fmtBytes(otherUsed)}</div>
                        </Tooltip.Content>
                    </Tooltip.Portal>
                </Tooltip.Root>
            {/if}
        </div>

        <!-- Detail list -->
        <div class="flex flex-col">
            {#each diskRows as row (row.id)}
                <div class="flex items-center gap-2 py-1.5 border-b border-darkborderc/30 last:border-b-0">
                    <span class={'inline-block size-3 rounded-sm shrink-0 ' + row.color}></span>
                    <span class="text-textcolor text-sm flex-1 min-w-0 truncate">{row.label}</span>
                    <Tooltip.Root>
                        <Tooltip.Trigger>
                            {#snippet child({ props })}
                                <button
                                    {...props}
                                    type="button"
                                    class="text-textcolor2 hover:text-primary cursor-pointer shrink-0 leading-none"
                                    aria-label={row.label}
                                    onclick={() => openRowDetails(row.label, row.desc, row.size)}
                                >
                                    <InfoIcon size={14} />
                                </button>
                            {/snippet}
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                            <Tooltip.Content
                                class="bg-darkbg border border-darkborderc rounded-md px-3 py-2 text-xs text-textcolor shadow-lg z-50 max-w-70 leading-relaxed"
                                sideOffset={4}
                                collisionPadding={8}
                            >
                                {row.desc}
                            </Tooltip.Content>
                        </Tooltip.Portal>
                    </Tooltip.Root>
                    <span class="text-textcolor text-sm tabular-nums shrink-0 w-20 text-right">{fmtBytes(row.size)}</span>
                </div>
            {/each}
            {#if showFullDisk && otherUsed != null && otherUsed > 0}
                <div class="flex items-center gap-2 py-1.5 border-b border-darkborderc/30 last:border-b-0">
                    <span class="inline-block size-3 rounded-sm shrink-0 bg-textcolor2/40"></span>
                    <span class="text-textcolor text-sm flex-1 min-w-0 truncate">{language.storageDiskOther}</span>
                    <span class="size-3.5 shrink-0"></span>
                    <span class="text-textcolor text-sm tabular-nums shrink-0 w-20 text-right">{fmtBytes(otherUsed)}</span>
                </div>
            {/if}
            {#if showFullDisk && diskFree != null}
                <div class="flex items-center gap-2 py-1.5 border-b border-darkborderc/30 last:border-b-0">
                    <span class="inline-block size-3 rounded-sm shrink-0 border border-darkborderc bg-bgcolor"></span>
                    <span class="text-textcolor text-sm flex-1 min-w-0 truncate">{language.storageDiskFree}</span>
                    <span class="size-3.5 shrink-0"></span>
                    <span class="text-textcolor text-sm tabular-nums shrink-0 w-20 text-right">{fmtBytes(diskFree)}</span>
                </div>
            {/if}
        </div>

        <!-- Footer: internal-only switch -->
        <div class="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-darkborderc/50">
            <label class="flex items-center gap-2 cursor-pointer select-none">
                <ShSwitch bind:checked={showFullDisk} />
                <span class="text-textcolor text-sm">{language.storageInternalOnly}</span>
            </label>
            <span class="text-textcolor2 text-xs hidden sm:inline">{language.storageInternalOnlyHint}</span>
        </div>
    </div>

    <!-- ③ Orphan cleanup ──────────────────────────────────────────────── -->
    <div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
        <div class="flex items-center gap-2 text-textcolor mb-2">
            <SparklesIcon size={16} />
            <span class="font-medium">{language.storageOrphanCleanupTitle}</span>
        </div>
        <p class="text-textcolor2 text-sm leading-relaxed mb-3">{language.storageOrphanCleanupDesc}</p>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3" aria-live="polite">
            <div class="rounded-md border border-darkborderc bg-bgcolor/60 p-3">
                <div class="text-textcolor2 text-xs mb-1">{language.storageOrphanCleanupMedia}</div>
                <div class="text-textcolor text-sm font-medium tabular-nums">
                    {stats.orphan.available
                        ? language.storageOrphanCleanupCountSize(stats.orphan.count, stats.orphan.totalSize)
                        : language.storageOrphanCleanupUnavailable}
                </div>
            </div>
            <div class="rounded-md border border-darkborderc bg-bgcolor/60 p-3">
                <div class="text-textcolor2 text-xs mb-1">{language.storageOrphanCleanupHypa}</div>
                <div class="text-textcolor text-sm font-medium tabular-nums">
                    {language.storageOrphanCleanupCountSize(hypaCache.count, hypaCache.totalSize)}
                </div>
            </div>
            <div class="rounded-md border border-darkborderc bg-bgcolor/60 p-3">
                <div class="text-textcolor2 text-xs mb-1">{language.storageOrphanCleanupObjects}</div>
                <div class="text-textcolor text-sm font-medium tabular-nums">
                    {language.storageOrphanCleanupSize(stats.storage.reclaimable)}
                </div>
            </div>
        </div>

        <p class="text-textcolor2 text-xs leading-relaxed mb-3">{language.storageOrphanCleanupInlayNote}</p>
        <div class="flex justify-end">
            <ShButton variant="primary" onclick={cleanupAllOrphans} disabled={orphanCleanupOpen || !hasCleanupCandidates}>
                <SparklesIcon size={16} />
                {language.storageOrphanCleanupAll}
            </ShButton>
        </div>
    </div>

    <!-- ⑤ Per-character ─────────────────────────────────────────────────── -->
    <div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
        <div class="flex items-center justify-between gap-2 mb-3">
            <div class="flex items-center gap-2 text-textcolor">
                <UsersIcon size={16} />
                <span class="font-medium">{language.storageCharacters}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={loadCharacters} disabled={charLoading}>
                {charLoading ? language.storageCharactersMeasuring : language.storageCharactersMeasure}
            </ShButton>
        </div>
        {#if !characters && !charError && !charLoading}
            <div class="text-textcolor2 text-sm">{language.storageCharactersDesc}</div>
        {/if}
        {#if charError}
            <ShAlert variant="destructive">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {charError}
            </ShAlert>
        {/if}
        {#if characters}
            <div class="text-textcolor2 text-xs mb-3 flex items-baseline justify-between gap-2 flex-wrap">
                <span>{language.storageCharactersDone(charElapsed ?? 0, characters.characters.length)}</span>
                {#if characters.characters.length > 0}
                    <span class="tabular-nums">{language.storageShowingOf(Math.min(charShown, characters.characters.length), characters.characters.length)}</span>
                {/if}
            </div>
            {#if characters.characters.length === 0}
                <div class="text-textcolor2 text-sm">{language.storageCharactersEmpty}</div>
            {:else}
                <div class="flex flex-col gap-2 mb-3">
                    {#each charSlice as c (c.chaId || c.name)}
                        <button
                            type="button"
                            disabled={c.trashed}
                            onclick={() => jumpToCharacter(c)}
                            aria-label={c.trashed ? undefined : language.storageCharactersGoTo}
                            class="block w-full text-left border border-darkborderc/50 rounded-md p-2 transition-colors enabled:cursor-pointer enabled:hover:border-borderc enabled:hover:bg-selected/10 disabled:cursor-default"
                        >
                            <div class="flex items-baseline justify-between gap-2 mb-1">
                                <div class="flex items-center gap-2 min-w-0">
                                    {#if c.trashed}
                                        <ShBadge variant="secondary">{language.storageCharactersTrashed}</ShBadge>
                                    {/if}
                                    <span class="text-textcolor text-sm truncate">{c.name || '(unnamed)'}</span>
                                </div>
                                <span class="text-textcolor text-sm tabular-nums shrink-0">{fmtBytes(c.totalBytes)}</span>
                            </div>
                            <div class="flex h-1.5 bg-bgcolor border border-darkborderc rounded-md overflow-hidden">
                                <div class="bg-danger" style:width={pctOf(c.cardBytes, c.totalBytes).toFixed(2) + '%'}></div>
                                <div class="bg-warning" style:width={pctOf(c.imgBytes, c.totalBytes).toFixed(2) + '%'}></div>
                                <div class="bg-info" style:width={pctOf(c.chatBytes, c.totalBytes).toFixed(2) + '%'}></div>
                            </div>
                            <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-textcolor2 text-xs mt-1 tabular-nums">
                                <span><span class="inline-block size-2 bg-danger rounded-sm align-middle mr-1"></span>{language.storageCharactersCard} {fmtBytes(c.cardBytes)}</span>
                                <span><span class="inline-block size-2 bg-warning rounded-sm align-middle mr-1"></span>{language.storageCharactersImage} {fmtBytes(c.imgBytes)}</span>
                                <span><span class="inline-block size-2 bg-info rounded-sm align-middle mr-1"></span>{language.storageCharactersChat} {fmtBytes(c.chatBytes)}</span>
                            </div>
                        </button>
                    {/each}
                </div>
                {#if charRemaining > 0}
                    <div class="flex justify-center mb-3">
                        <ShButton variant="outline" size="sm" onclick={() => charShown += PAGE_SIZE}>
                            {language.storageLoadMore(charRemaining)}
                        </ShButton>
                    </div>
                {/if}
            {/if}
            {#if characters.orphan.count > 0}
                <ShAlert variant="warning">
                    {#snippet icon()}<TriangleAlertIcon />{/snippet}
                    {language.storageCharactersOrphan(characters.orphan.count, characters.orphan.totalSize)}
                </ShAlert>
            {/if}
        {/if}
    </div>

    <!-- ⑥ Per-module ────────────────────────────────────────────────────── -->
    <div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
        <div class="flex items-center justify-between gap-2 mb-3">
            <div class="flex items-center gap-2 text-textcolor">
                <BlocksIcon size={16} />
                <span class="font-medium">{language.storageModules}</span>
            </div>
            <ShButton variant="outline" size="sm" onclick={loadModules} disabled={modLoading}>
                {modLoading ? language.storageModulesMeasuring : language.storageModulesMeasure}
            </ShButton>
        </div>
        {#if !modules && !modError && !modLoading}
            <div class="text-textcolor2 text-sm">{language.storageModulesDesc}</div>
        {/if}
        {#if modError}
            <ShAlert variant="destructive">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                {modError}
            </ShAlert>
        {/if}
        {#if modules}
            <div class="text-textcolor2 text-xs mb-3 flex items-baseline justify-between gap-2 flex-wrap">
                <span>{language.storageModulesDone(modElapsed ?? 0, modules.modules.length)}</span>
                {#if modules.modules.length > 0}
                    <span class="tabular-nums">{language.storageShowingOf(Math.min(modShown, modules.modules.length), modules.modules.length)}</span>
                {/if}
            </div>
            {#if modules.modules.length === 0}
                <div class="text-textcolor2 text-sm">{language.storageModulesEmpty}</div>
            {:else}
                <div class="flex flex-col gap-2 mb-3">
                    {#each modSlice as m (m.id || m.name)}
                        <div class="border border-darkborderc/50 rounded-md p-2">
                            <div class="flex items-baseline justify-between gap-2 mb-1">
                                <span class="text-textcolor text-sm truncate min-w-0">{m.name || '(unnamed)'}</span>
                                <span class="text-textcolor text-sm tabular-nums shrink-0">{fmtBytes(m.totalBytes)}</span>
                            </div>
                            <div class="flex h-1.5 bg-bgcolor border border-darkborderc rounded-md overflow-hidden">
                                <div class="bg-secondary" style:width={pctOf(m.bodyBytes, m.totalBytes).toFixed(2) + '%'}></div>
                                <div class="bg-warning" style:width={pctOf(m.assetBytes, m.totalBytes).toFixed(2) + '%'}></div>
                            </div>
                            <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-textcolor2 text-xs mt-1 tabular-nums">
                                <span><span class="inline-block size-2 bg-secondary rounded-sm align-middle mr-1"></span>{language.storageModulesBody} {fmtBytes(m.bodyBytes)}</span>
                                <span><span class="inline-block size-2 bg-warning rounded-sm align-middle mr-1"></span>{language.storageModulesAssets} {fmtBytes(m.assetBytes)}</span>
                            </div>
                        </div>
                    {/each}
                </div>
                {#if modRemaining > 0}
                    <div class="flex justify-center">
                        <ShButton variant="outline" size="sm" onclick={() => modShown += PAGE_SIZE}>
                            {language.storageLoadMore(modRemaining)}
                        </ShButton>
                    </div>
                {/if}
            {/if}
        {/if}
    </div>

    <!-- ⑦ Debug ─────────────────────────────────────────────────────────── -->
    <ShAccordion name={language.storageDebug} variant="card">
        <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-textcolor2 text-sm font-mono">
            <div>storage_mode</div><div class="text-textcolor">{stats.storage.mode}</div>
            <div>object_count</div><div class="text-textcolor tabular-nums">{stats.kvRows.toLocaleString()}</div>
            <div>object_bytes</div><div class="text-textcolor tabular-nums">{fmtBytes(stats.kvTotalBytes)}</div>
            <div>reclaimable</div><div class="text-textcolor tabular-nums">{fmtBytes(stats.storage.reclaimable)}</div>
            <div>etag</div><div class="text-textcolor truncate">{stats.etag ?? '—'}</div>
        </div>
    </ShAccordion>

    </Tooltip.Provider>
{/if}

<ShLoadingDialog open={orphanCleanupOpen} message={language.storageOrphanCleanuping} tier="top" />
