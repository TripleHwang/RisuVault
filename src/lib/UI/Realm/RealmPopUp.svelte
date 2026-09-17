<script lang="ts">
    import { BookIcon, DownloadIcon, FlagIcon, ImageIcon, LinkIcon, SmileIcon, TrashIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { alertConfirm, alertInput, alertNormal, notifyInfo } from 'src/ts/alert';
    import { hubURL, type hubType, downloadRisuHub, getRealmInfo } from 'src/ts/characterCards';
    import { DBState } from 'src/ts/stores.svelte';
    import RealmLicense from './RealmLicense.svelte';
    import MultiLangDisplay from '../GUI/MultiLangDisplay.svelte';
    import ShButton from '../GUI/ShButton.svelte';
    import ShDialog from '../GUI/ShDialog.svelte';
    import { tooltip } from 'src/ts/gui/tooltip';

    interface Props {
        openedData: hubType;
    }

    let { openedData = $bindable() }: Props = $props();
    let isKorean = $derived(DBState.db.language === 'ko');
    let ui = $derived(isKorean ? {
        madeBy: '제작자',
        viewOriginal: '원본 캐릭터 보기',
        emotions: '감정 이미지 포함',
        assets: '추가 에셋 포함',
        lorebook: '로어북 포함',
        download: '다운로드 후 채팅',
        copyLink: 'RisuRealm 링크 복사',
        report: '캐릭터 신고',
        reportConfirm: '이 캐릭터를 신고할까요?',
        reportPrompt: '관리자에게 전달할 신고 내용을 입력하세요. 저작권 문제는 이메일을 이용해 주세요.',
        remove: '캐릭터 삭제',
        removeConfirm: '이 캐릭터를 RisuRealm에서 삭제할까요?',
    } : {
        madeBy: 'Made by',
        viewOriginal: 'View original character',
        emotions: 'Emotion images',
        assets: 'Additional assets',
        lorebook: 'Lorebook',
        download: 'Download & Chat',
        copyLink: 'Copy RisuRealm link',
        report: 'Report character',
        reportConfirm: 'Report this character?',
        reportPrompt: 'Write a report text that would be sent to the admin (for copyright issues, use email)',
        remove: 'Remove character',
        removeConfirm: 'Do you want to remove this character from Realm?',
    });

    function close() {
        openedData = null;
    }
</script>

<ShDialog
    open={true}
    onOpenChange={(open) => { if (!open) close(); }}
    size="lg"
    closeOnEscape={true}
    closeOnOutsideClick={true}
    contentClass="max-h-[calc(100dvh-1rem)] gap-0 rounded-2xl p-0 overflow-hidden"
    bodyClass="min-h-0 min-w-0 flex-1 overflow-y-auto"
    closeClass="right-5 top-5 z-10 rounded-full border border-darkborderc bg-darkbg/90 p-1.5"
>
    {#snippet title()}
        <span class="sr-only">{openedData.name}</span>
    {/snippet}

    <div class="grid min-w-0 gap-0 md:grid-cols-[15rem_minmax(0,1fr)]">
        <div class="relative min-h-56 overflow-hidden border-b border-darkborderc bg-bgcolor md:min-h-[26rem] md:border-b-0 md:border-r">
            {#if DBState.db.hideAllImages}
                <div class="flex size-full min-h-56 items-center justify-center text-5xl text-textcolor2">?</div>
            {:else}
                <img class="absolute inset-0 size-full object-cover object-top" alt={openedData.name} src={`${hubURL}/resource/` + openedData.img} />
                <div class="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-media-bg/55 to-transparent"></div>
            {/if}
            <div class="absolute bottom-3 left-3 flex flex-wrap gap-1.5 pr-3">
                {#each openedData.tags.slice(0, 4) as tag}
                    <span class="rounded-full border border-media-text/15 bg-media-bg/55 px-2 py-1 text-xs text-media-text backdrop-blur-sm">#{tag}</span>
                {/each}
            </div>
        </div>

        <div class="flex min-w-0 flex-col p-5 sm:p-6">
            <div class="pr-10">
                <h1 class="wrap-break-word text-2xl font-semibold tracking-tight text-textcolor">{openedData.name}</h1>
                {#if openedData.authorname}
                    <p class="mt-1 text-sm text-borderc">{ui.madeBy} {openedData.authorname}</p>
                {/if}
                {#if openedData.original}
                    <button class="mt-2 text-sm text-borderc hover:underline" onclick={() => {
                        const original = openedData.original;
                        close();
                        void getRealmInfo(original);
                    }}>{ui.viewOriginal}</button>
                {/if}
            </div>

            <div class="mt-5 max-h-none min-w-0 overflow-visible rounded-xl border border-darkborderc bg-bgcolor/30 p-3 text-sm leading-relaxed selection:bg-primary/35 md:max-h-64 md:overflow-y-auto">
                <MultiLangDisplay value={openedData.desc} markdown={true} linkify={true} />
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-2 text-sm text-textcolor2">
                <span use:tooltip={language.popularityLevelDesc}>
                    {language.popularityLevel.replace('{}', openedData.download.toString())}
                </span>
                {#if openedData.hasEmotion}<span class="rounded-md border border-darkborderc p-1.5" title={ui.emotions}><SmileIcon size={16} /></span>{/if}
                {#if openedData.hasAsset}<span class="rounded-md border border-darkborderc p-1.5" title={ui.assets}><ImageIcon size={16} /></span>{/if}
                {#if openedData.hasLore}<span class="rounded-md border border-darkborderc p-1.5" title={ui.lorebook}><BookIcon size={16} /></span>{/if}
            </div>

            <div class="mt-3"><RealmLicense license={openedData.license} /></div>

            <div class="mt-auto flex flex-wrap items-center gap-2 border-t border-darkborderc pt-4">
                <ShButton variant="primary" className="grow" onclick={() => {
                    void downloadRisuHub(openedData.id);
                    close();
                }}><DownloadIcon size={17} /> {ui.download}</ShButton>

                <ShButton variant="ghost" size="icon" aria-label={ui.copyLink} onclick={async () => {
                    await navigator.clipboard.writeText(`https://realm.risuai.net/character/${openedData.id}`);
                    notifyInfo(language.clipboardSuccess);
                }}><LinkIcon size={18} /></ShButton>

                <ShButton variant="ghost" size="icon" aria-label={ui.report} onclick={async () => {
                    const conf = await alertConfirm(ui.reportConfirm);
                    if (!conf) return;
                    const report = await alertInput(ui.reportPrompt);
                    const response = await fetch(hubURL + '/hub/report', {
                        method: 'POST',
                        body: JSON.stringify({ id: openedData.id, report }),
                    });
                    alertNormal(await response.text());
                }}><FlagIcon size={18} /></ShButton>

                {#if (DBState.db.account?.token?.split('-') ?? [])[1] === openedData.creator}
                    <ShButton variant="ghost" size="icon" aria-label={ui.remove} className="text-danger" onclick={async () => {
                        const conf = await alertConfirm(ui.removeConfirm);
                        if (!conf) return;
                        const response = await fetch(hubURL + '/hub/remove', {
                            method: 'POST',
                            body: JSON.stringify({ id: openedData.id, token: DBState.db.account?.token }),
                        });
                        alertNormal(await response.text());
                    }}><TrashIcon size={18} /></ShButton>
                {/if}
            </div>
        </div>
    </div>
</ShDialog>
