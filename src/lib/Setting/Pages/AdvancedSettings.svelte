<script lang="ts">
    import { AlertTriangleIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { SettingItem } from "src/ts/setting/types";
    import { AdvancedSubmenuIndex } from "src/ts/stores.svelte";
    import {
        advancedCompatibilityItems,
        advancedContextItems,
        advancedExperimentalItems,
        advancedFeatureItems,
        advancedInterfaceItems,
        advancedPromptItems,
        advancedRequestItems,
        advancedResponseItems,
        advancedUtilityItems,
    } from "src/ts/setting/advancedSettingsData";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import SettingTabs from "src/lib/UI/GUI/SettingTabs.svelte";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";

    const copy = language.settingsWorkspace.advancedWorkspace;
</script>

{#snippet settingsSection(id: string, title: string, description: string, items: SettingItem[])}
    <section class="advanced-section" aria-labelledby={id}>
        <header>
            <h2 id={id}>{title}</h2>
            <p>{description}</p>
        </header>
        <SettingRenderer {items} layout="row" />
    </section>
{/snippet}

<SettingPage title={language.advancedSettings} description={copy.description}>
    <ShAlert variant="warning" className="mb-5">
        {#snippet icon()}<AlertTriangleIcon />{/snippet}
        {language.advancedSettingsWarn}
    </ShAlert>

    <SettingTabs
        tabs={[
            { label: copy.tabs.context, value: 0 },
            { label: copy.tabs.request, value: 1 },
            { label: copy.tabs.features, value: 2 },
            { label: copy.tabs.experimental, value: 3 },
        ]}
        bind:selected={$AdvancedSubmenuIndex}
        variant="prominent"
    />

    <div class="advanced-sections">
        {#if $AdvancedSubmenuIndex === 0}
            {@render settingsSection('advanced-context', copy.sections.context.title, copy.sections.context.description, advancedContextItems)}
            {@render settingsSection('advanced-prompts', copy.sections.prompts.title, copy.sections.prompts.description, advancedPromptItems)}
        {:else if $AdvancedSubmenuIndex === 1}
            {@render settingsSection('advanced-request', copy.sections.request.title, copy.sections.request.description, advancedRequestItems)}
            {@render settingsSection('advanced-response', copy.sections.response.title, copy.sections.response.description, advancedResponseItems)}
        {:else if $AdvancedSubmenuIndex === 2}
            {@render settingsSection('advanced-interface', copy.sections.interface.title, copy.sections.interface.description, advancedInterfaceItems)}
            {@render settingsSection('advanced-features', copy.sections.features.title, copy.sections.features.description, advancedFeatureItems)}
            {@render settingsSection('advanced-utilities', copy.sections.utilities.title, copy.sections.utilities.description, advancedUtilityItems)}
        {:else}
            {@render settingsSection('advanced-experimental', copy.sections.experimental.title, copy.sections.experimental.description, advancedExperimentalItems)}
            {@render settingsSection('advanced-compatibility', copy.sections.compatibility.title, copy.sections.compatibility.description, advancedCompatibilityItems)}
        {/if}
    </div>
</SettingPage>

<style>
    .advanced-sections {
        display: flex;
        flex-direction: column;
        gap: 2.4rem;
        padding-top: 1.65rem;
    }

    .advanced-section > header {
        margin: 0 .15rem .8rem;
    }

    .advanced-section h2 {
        margin: 0;
        color: var(--risu-theme-textcolor);
        font-size: 1rem;
        font-weight: 620;
        letter-spacing: -.012em;
    }

    .advanced-section p {
        max-width: 42rem;
        margin: .3rem 0 0;
        color: var(--risu-theme-textcolor2);
        font-size: .76rem;
        line-height: 1.5;
    }

    .advanced-section :global(.settings-standard-group) {
        margin-bottom: 0;
    }

    @media (max-width: 767px) {
        .advanced-sections {
            gap: 2rem;
            padding-top: 1.25rem;
        }
    }
</style>
