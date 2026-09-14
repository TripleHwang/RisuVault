<script lang="ts">
    import {
        ArrowRightIcon,
        ChevronDownIcon,
        FeatherIcon,
        LoaderCircleIcon,
        ShieldCheckIcon,
        SparklesIcon,
    } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { language } from 'src/lang'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { requestChatData } from 'src/ts/process/request/request'
    import type { NarrativeGraphViewSnapshot } from 'src/ts/risubard/memoryGraphView'
    import {
        applyCharacterPromotion,
        createCharacterPromotionPreview,
        createPromoteCharacterCommand,
        eligibleCharacterPromotionSources,
        requestCharacterPromotionDraft,
    } from 'src/ts/risubard/writerWorkbench'
    import type { CompiledWriterCommand } from '../../../packages/risubard-core/src/writerCommand'

    interface Props {
        graph: NarrativeGraphViewSnapshot
        characterId: string
        chatId: string
        onApplied?: (revision: number) => void | Promise<void>
    }

    let {
        graph,
        characterId,
        chatId,
        onApplied,
    }: Props = $props()
    let sourceId = $state('')
    let instruction = $state('')
    let name = $state('')
    let summary = $state('')
    let salience = $state(8)
    let preview = $state<CompiledWriterCommand | null>(null)
    let drafting = $state(false)
    let saving = $state(false)
    let error = $state('')
    let notice = $state('')
    let expanded = $state(true)

    let sources = $derived(eligibleCharacterPromotionSources(graph))
    let source = $derived(
        sources.find((node) => node.id === sourceId)
        ?? sources[0]
        ?? null
    )
    let relation = $derived(source?.kind === 'event' ? 'involves' : 'about')

    $effect(() => {
        if (!sourceId && sources[0]) sourceId = sources[0].id
    })

    function invalidatePreview() {
        preview = null
        notice = ''
    }

    async function draftWithAI() {
        if (!source) return
        drafting = true
        error = ''
        notice = ''
        try {
            const draft = await requestCharacterPromotionDraft({
                sourceNode: source,
                instruction,
                requestModel: (request, mode) =>
                    requestChatData(request, mode),
            })
            name = draft.name
            summary = draft.summary
            salience = draft.salience
            preview = null
        }
        catch (cause) {
            error = `${language.risuBardWriterDraftFailed} ${
                cause instanceof Error ? cause.message : String(cause)
            }`
        }
        finally {
            drafting = false
        }
    }

    function buildPreview() {
        if (!source) return
        error = ''
        notice = ''
        try {
            const command = createPromoteCharacterCommand({
                graph,
                sourceNodeId: source.id,
                draft: { name, summary, salience: Number(salience) },
            })
            preview = createCharacterPromotionPreview({ graph, command })
        }
        catch (cause) {
            preview = null
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    async function approve() {
        if (!preview || saving) return
        saving = true
        error = ''
        notice = ''
        try {
            const receipt = await applyCharacterPromotion({
                characterId,
                chatId,
                expectedRevision: graph.revision,
                command: preview.command,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            notice = language.risuBardWriterSaved
            preview = null
            await onApplied?.(receipt.revision)
        }
        catch (cause) {
            error = `${language.risuBardWriterApplyFailed} ${
                cause instanceof Error ? cause.message : String(cause)
            }`
        }
        finally {
            saving = false
        }
    }
</script>

<section class="writer-desk" data-writer-workbench>
    <header class="writer-heading">
        <div class="writer-mark" aria-hidden="true">
            <FeatherIcon size={19} />
        </div>
        <div class="writer-heading-copy">
            <span class="writer-kicker">RisuVault · Authoring</span>
            <h3>{language.risuBardWriterTitle}</h3>
            <p>{language.risuBardWriterDescription}</p>
        </div>
        <button
            type="button"
            class="writer-toggle"
            data-writer-toggle
            aria-expanded={expanded}
            aria-controls="risubard-writer-body"
            aria-label={expanded
                ? language.risuBardWriterCollapse
                : language.risuBardWriterExpand}
            onclick={() => expanded = !expanded}
        >
            <ChevronDownIcon size={18} class={expanded ? '' : 'collapsed'} />
        </button>
    </header>

    {#if expanded}
        <div id="risubard-writer-body" data-writer-body>
            {#if sources.length === 0}
                <div class="writer-empty">{language.risuBardWriterNoSources}</div>
            {:else}
                <div class="writer-grid">
            <div class="source-folio">
                <label>
                    <span>{language.risuBardWriterSource}</span>
                    <select
                        data-writer-source
                        bind:value={sourceId}
                        onchange={invalidatePreview}
                    >
                        {#each sources as candidate (candidate.id)}
                            <option value={candidate.id}>
                                {candidate.kind} · {candidate.title}
                            </option>
                        {/each}
                    </select>
                </label>
                {#if source}
                    <blockquote>
                        <strong>{source.title}</strong>
                        <span>{source.summary}</span>
                    </blockquote>
                {/if}
                <label>
                    <span>{language.risuBardWriterInstruction}</span>
                    <textarea
                        data-writer-instruction
                        bind:value={instruction}
                        maxlength="4000"
                        rows="3"
                        placeholder={language.risuBardWriterInstructionPlaceholder}
                    ></textarea>
                </label>
                <ShButton
                    variant="secondary"
                    size="sm"
                    data-writer-draft
                    onclick={draftWithAI}
                    disabled={drafting || !instruction.trim()}
                >
                    {#if drafting}
                        <LoaderCircleIcon class="animate-spin" size={14} />
                    {:else}
                        <SparklesIcon size={14} />
                    {/if}
                    {language.risuBardWriterDraft}
                </ShButton>
            </div>

            <div class="identity-card">
                <label>
                    <span>{language.risuBardWriterName}</span>
                    <input
                        data-writer-name
                        bind:value={name}
                        maxlength="120"
                        oninput={invalidatePreview}
                    />
                </label>
                <label>
                    <span>{language.risuBardWriterSummary}</span>
                    <textarea
                        data-writer-summary
                        bind:value={summary}
                        maxlength="2000"
                        rows="4"
                        oninput={invalidatePreview}
                    ></textarea>
                </label>
                <label class="salience-row">
                    <span>{language.risuBardWriterSalience}</span>
                    <strong>{salience}/10</strong>
                    <input
                        data-writer-salience
                        bind:value={salience}
                        type="range"
                        min="1"
                        max="10"
                        step="1"
                        oninput={invalidatePreview}
                    />
                </label>
                <ShButton
                    variant="outline"
                    size="sm"
                    data-writer-preview
                    onclick={buildPreview}
                    disabled={!name.trim() || !summary.trim()}
                >
                    <ArrowRightIcon size={14} />
                    {language.risuBardWriterPreview}
                </ShButton>
            </div>
                </div>

                <div class="proposal-ledger" class:ready={preview !== null}>
            <div>
                <span class="proposal-label">
                    {language.risuBardWriterProposal}
                </span>
                {#if preview && source}
                    <p data-writer-proposal>
                        <strong>{source.title}</strong>
                        <ArrowRightIcon size={13} />
                        <em>{relation}</em>
                        <ArrowRightIcon size={13} />
                        <strong>{preview.command.name}</strong>
                    </p>
                    <small>
                        v1 fact + native character + 2 relations ·
                        {preview.graphDelta.operations.length} operations
                    </small>
                {:else}
                    <p class="proposal-muted">
                        {language.risuBardWriterPreview}
                    </p>
                {/if}
            </div>
            <ShButton
                variant="success"
                size="sm"
                data-writer-apply
                onclick={approve}
                disabled={!preview || saving}
            >
                {#if saving}
                    <LoaderCircleIcon class="animate-spin" size={14} />
                {:else}
                    <ShieldCheckIcon size={14} />
                {/if}
                {language.risuBardWriterApply}
            </ShButton>
                </div>
            {/if}

            {#if error}
                <p class="writer-message error" role="alert">{error}</p>
            {:else if notice}
                <p class="writer-message success" role="status">{notice}</p>
            {/if}
        </div>
    {/if}
</section>

<style>
    .writer-desk {
        --writer-line: color-mix(in srgb, var(--risu-theme-primary) 30%, transparent);
        margin: .85rem;
        border: 1px solid var(--writer-line);
        border-radius: .8rem;
        overflow: hidden;
        background:
            radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--risu-theme-primary) 12%, transparent), transparent 32%),
            color-mix(in srgb, var(--risu-theme-darkbg) 96%, var(--color-bgcolor));
        box-shadow: 0 18px 42px color-mix(in srgb, var(--color-shadow) 16%, transparent);
    }
    .writer-heading {
        display: flex;
        align-items: center;
        gap: .75rem;
        padding: .85rem 1rem;
        border-bottom: 1px solid var(--writer-line);
    }
    .writer-heading-copy {
        min-width: 0;
        flex: 1;
    }
    .writer-toggle {
        display: grid;
        place-items: center;
        width: 2rem;
        height: 2rem;
        flex: none;
        border: 1px solid var(--writer-line);
        border-radius: 50%;
        color: var(--risu-theme-textcolor2);
        background: transparent;
        cursor: pointer;
        transition: color .15s ease, background .15s ease;
    }
    .writer-toggle:hover,
    .writer-toggle:focus-visible {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-primary) 9%, transparent);
    }
    .writer-toggle:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--risu-theme-primary) 55%, transparent);
        outline-offset: 2px;
    }
    .writer-toggle :global(svg) {
        transition: transform .18s ease;
    }
    .writer-toggle :global(svg.collapsed) {
        transform: rotate(-90deg);
    }
    .writer-mark {
        display: grid;
        place-items: center;
        width: 2.25rem;
        height: 2.25rem;
        flex: none;
        border: 1px solid var(--writer-line);
        border-radius: 50%;
        color: var(--risu-theme-primary);
    }
    .writer-kicker {
        font: 600 .62rem/1.2 ui-monospace, monospace;
        letter-spacing: .13em;
        text-transform: uppercase;
        color: var(--risu-theme-textcolor2);
    }
    .writer-heading h3 {
        margin: .12rem 0;
        font: 650 1rem/1.25 Georgia, serif;
        color: var(--risu-theme-textcolor);
    }
    .writer-heading p {
        margin: 0;
        color: var(--risu-theme-textcolor2);
        font-size: .78rem;
    }
    .writer-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
    .source-folio,
    .identity-card {
        display: grid;
        align-content: start;
        gap: .65rem;
        padding: .9rem 1rem;
    }
    .source-folio {
        border-right: 1px solid var(--writer-line);
    }
    label {
        display: grid;
        gap: .3rem;
        color: var(--risu-theme-textcolor2);
        font-size: .72rem;
        font-weight: 600;
    }
    input,
    select,
    textarea {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .45rem;
        padding: .5rem .58rem;
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 88%, var(--color-bgcolor));
        font: inherit;
        resize: vertical;
    }
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--risu-theme-primary) 55%, transparent);
        outline-offset: 1px;
    }
    blockquote {
        display: grid;
        gap: .25rem;
        margin: 0;
        padding: .6rem .7rem;
        border-left: 2px solid var(--risu-theme-primary);
        color: var(--risu-theme-textcolor2);
        background: color-mix(in srgb, var(--risu-theme-primary) 6%, transparent);
        font-size: .75rem;
    }
    blockquote strong {
        color: var(--risu-theme-textcolor);
    }
    .salience-row {
        grid-template-columns: 1fr auto;
    }
    .salience-row input {
        grid-column: 1 / -1;
        padding: 0;
        accent-color: var(--risu-theme-primary);
    }
    .proposal-ledger {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        min-height: 3.7rem;
        padding: .7rem 1rem;
        border-top: 1px solid var(--writer-line);
        background: color-mix(in srgb, var(--color-overlay) 8%, transparent);
    }
    .proposal-ledger.ready {
        background: color-mix(in srgb, var(--risu-theme-primary) 8%, transparent);
    }
    .proposal-label {
        font: 600 .62rem/1 ui-monospace, monospace;
        letter-spacing: .1em;
        text-transform: uppercase;
        color: var(--risu-theme-textcolor2);
    }
    .proposal-ledger p {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: .35rem;
        margin: .25rem 0 0;
        color: var(--risu-theme-textcolor);
        font-size: .78rem;
    }
    .proposal-ledger em {
        color: var(--risu-theme-primary);
        font: 600 .68rem/1 ui-monospace, monospace;
    }
    .proposal-ledger small {
        color: var(--risu-theme-textcolor2);
        font-size: .65rem;
    }
    .proposal-muted,
    .writer-empty {
        color: var(--risu-theme-textcolor2) !important;
    }
    .writer-empty {
        padding: 1rem;
        font-size: .8rem;
    }
    .writer-message {
        margin: 0;
        padding: .6rem 1rem;
        border-top: 1px solid var(--writer-line);
        font-size: .75rem;
    }
    .writer-message.error { color: var(--risu-theme-draculared); }
    .writer-message.success { color: var(--risu-theme-success); }
    @media (max-width: 760px) {
        .writer-grid { grid-template-columns: 1fr; }
        .source-folio {
            border-right: 0;
            border-bottom: 1px solid var(--writer-line);
        }
        .proposal-ledger {
            align-items: stretch;
            flex-direction: column;
        }
    }
</style>
