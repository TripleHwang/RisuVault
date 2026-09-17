<script lang="ts">
    import { language } from 'src/lang'
    import type { SettingsRouteValue } from 'src/ts/routing'
    import {
        aiSettingsSections,
        getAISettingsSection,
        type AISettingsSectionId,
    } from 'src/ts/setting/aiSettingsSections'
    import BotSettings from './Pages/BotSettings.svelte'
    import ModelPresetSettings from './Pages/Model/ModelPresetSettings.svelte'
    import OtherBotSettings from './Pages/OtherBotSettings.svelte'
    import SettingsSectionTabs from 'src/lib/UI/GUI/SettingsSectionTabs.svelte'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'

    interface Props {
        activeRoute: SettingsRouteValue
        onNavigate: (route: SettingsRouteValue) => void
    }

    let { activeRoute, onNavigate }: Props = $props()
    let activeSection = $derived(getAISettingsSection(activeRoute) ?? aiSettingsSections[0])
    let sectionTabs = $derived(aiSettingsSections.map((section) => ({
        label: sectionTitle(section.id),
        value: section.route,
    })))

    function sectionTitle(id: AISettingsSectionId): string {
        return language.settingsWorkspace.aiWorkspace.sections[id].title
    }

    function sectionDescription(id: AISettingsSectionId): string {
        return language.settingsWorkspace.aiWorkspace.sections[id].description
    }

</script>

<div data-ai-settings-workspace>
    <SettingPage
        title={language.settingsWorkspace.aiWorkspace.title}
        description={language.settingsWorkspace.aiWorkspace.description}
    >
        <SettingsSectionTabs
            tabs={sectionTabs}
            selected={activeRoute}
            onSelect={onNavigate}
            ariaLabel={language.settingsWorkspace.aiWorkspace.sectionNavigation}
            variant="prominent"
        />

        <section class="section-detail" aria-labelledby="active-ai-section-title">
            <header class="section-heading">
                <span>{language.settingsWorkspace.aiWorkspace.currentSection}</span>
                <h2 id="active-ai-section-title">{sectionTitle(activeSection.id)}</h2>
                <p>{sectionDescription(activeSection.id)}</p>
            </header>

            <div class="embedded-settings">
                {#if activeSection.id === 'model-presets'}
                    <ModelPresetSettings embedded />
                {:else if activeSection.id === 'legacy-model'}
                    <BotSettings embedded />
                {:else}
                    <OtherBotSettings embedded />
                {/if}
            </div>
        </section>
    </SettingPage>
</div>

<style>
    .section-heading p {
        margin: .7rem 0 0;
        color: var(--risu-theme-textcolor2);
        line-height: 1.65;
    }

    .section-detail {
        min-width: 0;
    }

    .section-heading {
        margin-bottom: 1.4rem;
        padding-bottom: 1.2rem;
        border-bottom: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 65%, transparent);
    }

    .section-heading > span {
        color: var(--risu-theme-textcolor2);
        font-size: .68rem;
        font-weight: 650;
        letter-spacing: .075em;
        text-transform: uppercase;
        opacity: .75;
    }

    .section-heading h2 {
        margin: .3rem 0 0;
        font-size: 1.35rem;
        font-weight: 680;
        letter-spacing: -.02em;
    }

    .section-heading p {
        margin-top: .35rem;
        font-size: .82rem;
    }

    .embedded-settings {
        min-width: 0;
    }

</style>
