<script lang="ts">
    import SettingsSectionTabs from './SettingsSectionTabs.svelte'

    interface Tab {
        label: string;
        value: number;
    }

    let {
        tabs,
        selected = $bindable(0),
        variant = 'default',
    }: {
        tabs: Tab[];
        selected?: number;
        variant?: 'default' | 'prominent';
    } = $props();
</script>

<SettingsSectionTabs
    {tabs}
    {selected}
    {variant}
    onSelect={(value) => { selected = value }}
/>
