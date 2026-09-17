<script lang="ts">
    import { language } from 'src/lang'
    import type { BardLoreActivation } from 'src/ts/lorebook/bardLore'

    interface Props {
        activation: BardLoreActivation
    }

    let { activation }: Props = $props()
    let label = $derived({
        required: language.lorebookWorkspace.bardRequired,
        keyed: language.lorebookWorkspace.bardKeyed,
        retrieve: language.lorebookWorkspace.bardRetrieve,
        never: language.lorebookWorkspace.bardNever,
    }[activation])
</script>

<span
    class="bard-activation-label"
    data-bard-lore-activation-label={activation}
    title={label}
>[{label}]</span>

<style>
    .bard-activation-label {
        color: var(--color-textcolor2);
        font-size: .68rem;
        font-weight: 650;
        line-height: 1.2;
        white-space: nowrap;
    }
</style>
