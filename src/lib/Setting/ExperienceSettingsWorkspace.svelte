<script lang="ts">
    import { language } from 'src/lang'
    import { SettingsRoute, type SettingsRouteValue } from 'src/ts/routing'
    import AccessibilitySettings from './Pages/AccessibilitySettings.svelte'
    import DisplaySettings from './Pages/DisplaySettings.svelte'
    import LanguageSettings from './Pages/LanguageSettings.svelte'
    import SettingsSectionTabs from 'src/lib/UI/GUI/SettingsSectionTabs.svelte'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'

    interface Props {
        activeRoute: SettingsRouteValue
        onNavigate: (route: SettingsRouteValue) => void
    }

    let { activeRoute, onNavigate }: Props = $props()

    const sections = [
        { id: 'display', route: SettingsRoute.Display, title: () => language.display },
        { id: 'language', route: SettingsRoute.Language, title: () => language.language },
        { id: 'accessibility', route: SettingsRoute.Accessibility, title: () => language.accessibility },
    ] as const

    let activeSection = $derived(sections.find((section) => section.route === activeRoute) ?? sections[0])
    let sectionTabs = $derived(sections.map((section) => ({
        label: section.title(),
        value: section.route,
    })))

    function sectionDescription(id: typeof sections[number]['id']): string {
        return language.settingsWorkspace.experienceWorkspace.sections[id]
    }
</script>

<div data-experience-settings-workspace>
    <SettingPage
        title={language.settingsWorkspace.sections.experience}
        description={language.settingsWorkspace.experienceWorkspace.description}
    >
        <SettingsSectionTabs
            tabs={sectionTabs}
            selected={activeRoute}
            onSelect={onNavigate}
            ariaLabel={language.settingsWorkspace.experienceWorkspace.sectionNavigation}
            variant="prominent"
        />

        <section class="section-detail" aria-labelledby="active-experience-section-title">
            <header class="section-heading">
                <span>{language.settingsWorkspace.experienceWorkspace.currentSection}</span>
                <h2 id="active-experience-section-title">{activeSection.title()}</h2>
                <p>{sectionDescription(activeSection.id)}</p>
            </header>

            <div class="embedded-settings">
                {#if activeRoute === SettingsRoute.Display}
                    <DisplaySettings embedded />
                {:else if activeRoute === SettingsRoute.Language}
                    <LanguageSettings embedded />
                {:else}
                    <AccessibilitySettings embedded />
                {/if}
            </div>
        </section>
    </SettingPage>
</div>

<style>
    .section-detail,
    .embedded-settings {
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
        color: var(--risu-theme-textcolor);
        font-size: 1.35rem;
        font-weight: 680;
        letter-spacing: -.02em;
    }

    .section-heading p {
        max-width: 42rem;
        margin: .35rem 0 0;
        color: var(--risu-theme-textcolor2);
        font-size: .82rem;
        line-height: 1.6;
    }
</style>
