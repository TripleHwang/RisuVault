<script lang="ts">
    import { downloadRisuHub, fetchRisuHubPage, hubAdditionalHTML, type hubType } from 'src/ts/characterCards';
    import { ArrowLeft, ArrowRight, HashIcon, MenuIcon, SearchIcon, SparklesIcon } from '@lucide/svelte';
    import { alertInput } from 'src/ts/alert';
    import { language } from 'src/lang';
    import { loadingActivity } from 'src/ts/gui/loadingActivity';
    import { DBState, RealmInitialOpenChar } from 'src/ts/stores.svelte';
    import { TagList } from 'src/ts/util';
    import ShButton from '../GUI/ShButton.svelte';
    import ShDialog from '../GUI/ShDialog.svelte';
    import RealmHubIcon from './RealmHubIcon.svelte';
    import RealmPopUp from './RealmPopUp.svelte';
    import LazyState from '../GUI/LazyState.svelte';
    import { createLazyResource } from 'src/ts/lazyResource.svelte';

    let openedData: null | hubType = $state(null);
    let page = $state(0);
    let sort = $state('recommended');
    let search = $state('');
    let tagSearch = $state('');
    let tagInputFocused = $state(false);
    let highlightedTagIndex = $state(0);
    let menuOpen = $state(false);
    let nsfw = $state(false);
    let isKorean = $derived(DBState.db.language === 'ko');
    let ui = $derived(isKorean ? {
        title: 'RisuRealm 둘러보기',
        subtitle: '이름, 설명, 제작자 또는 정확한 태그로 공유 캐릭터를 검색하세요.',
        searchLabel: 'RisuRealm 검색',
        searchPlaceholder: '캐릭터 검색',
        search: '검색',
        menu: 'RisuRealm 메뉴',
        tagLabel: '정확한 태그 검색',
        tagPlaceholder: '태그를 공백으로 구분해 입력',
        clear: '지우기',
        suggestions: '태그 자동완성',
        popular: '인기 태그',
        popularLabel: '현재 결과의 인기 태그',
        noResults: '검색 결과가 없습니다.',
        pages: 'RisuRealm 페이지',
        previousPage: '이전 페이지',
        nextPage: '다음 페이지',
        tools: 'RisuRealm 도구',
        toolsDescription: 'URL 또는 ID로 공유 캐릭터를 가져옵니다.',
        importCharacter: '캐릭터 가져오기',
        importPrompt: 'URL 또는 ID 입력',
        loadFailed: 'RisuRealm에 연결하지 못했습니다',
        loadFailedHint: '검색 결과가 없는 것이 아니라, 목록을 받아오지 못한 것입니다.',
        loading: '불러오는 중…',
    } : {
        title: 'Explore RisuRealm',
        subtitle: 'Search shared characters by name, description, creator, or an exact tag.',
        searchLabel: 'Search RisuRealm',
        searchPlaceholder: 'Search characters',
        search: 'Search',
        menu: 'RisuRealm menu',
        tagLabel: 'Search by exact tags',
        tagPlaceholder: 'Exact tags, separated by spaces',
        clear: 'Clear',
        suggestions: 'Tag suggestions',
        popular: 'Popular',
        popularLabel: 'Popular tags in current results',
        noResults: 'No RisuRealm characters found.',
        pages: 'RisuRealm pages',
        previousPage: 'Previous page',
        nextPage: 'Next page',
        tools: 'RisuRealm tools',
        toolsDescription: 'Import a shared character directly from its URL or ID.',
        importCharacter: 'Import character',
        importPrompt: 'Input URL or ID',
        loadFailed: 'Could not reach RisuRealm',
        loadFailedHint: 'This is not an empty search result. The list could not be fetched.',
        loading: 'Loading…',
    });

    /**
     * What the screen is currently asking the hub for.
     *
     * The text inputs are deliberately NOT part of this: typing must not fire a
     * request per keystroke. `submittedSearches` is the committed query pair, updated
     * only when the user submits. `requestNonce` is what makes pressing Search
     * again -- or re-picking "random" -- a real reload even though every other
     * field is unchanged.
     */
    // Upstream (0.9.34) also asks the hub for `author:<text>` when the text
    // box has a plain query, so a creator's name finds their characters. Both
    // queries are committed together so paging and re-sorting keep asking the
    // same pair; an empty box stays the single unfiltered request.
    let submittedSearches = $state<string[]>(['']);
    let requestNonce = $state(0);
    const realmQuery = $derived({ searches: submittedSearches, page, nsfw, sort, nonce: requestNonce });

    /**
     * RisuRealm loads only itself, in its own subtree, and says which of the
     * three things happened: loading, a real result (possibly empty), or a
     * failure. The old code collapsed the third into the second -- an
     * unreachable server rendered as "No RisuRealm characters found." -- so the
     * user was told something definite about their search that nobody had
     * actually found out.
     */
    const realmPage = createLazyResource<hubType[]>({
        scope: 'realm-page',
        key: () => JSON.stringify(realmQuery),
        load: async (key) => {
            const query = JSON.parse(key) as typeof realmQuery;
            const searches = query.searches;
            const results = await loadingActivity.read('RisuRealm', () => Promise.all(searches.map((current) => fetchRisuHubPage({
                search: current,
                page: query.page,
                nsfw: query.nsfw,
                sort: query.sort,
            }))));
            return [...new Map(results.flat().map((chara) => [chara.id, chara])).values()];
        },
    });

    /**
     * Safe to default here, and only here: these tags are a convenience strip
     * that is hidden when empty, so an empty list makes no claim. The result
     * grid and the "no results" message both live behind `realmPage.ready`.
     */
    let charas = $derived(realmPage.value ?? []);

    let popularTags = $derived.by(() => {
        const counts = new Map<string, number>();
        for (const chara of charas) {
            for (const tag of chara.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 7)
            .map(([tag]) => tag);
    });

    let tagWords = $derived(tagSearch.split(/\s+/).filter(Boolean));
    let tagFragment = $derived(tagSearch.endsWith(' ') ? '' : (tagWords.at(-1) ?? ''));
    let completedTags = $derived.by(() => new Set(
        (tagSearch.endsWith(' ') ? tagWords : tagWords.slice(0, -1))
            .map((tag) => tag.toLowerCase()),
    ));
    let tagSuggestions = $derived.by(() => {
        const query = tagFragment.toLowerCase();
        const matches = TagList.filter((tag) => {
            if (completedTags.has(tag.value.toLowerCase())) return false;
            if (!query) return true;
            return tag.value.toLowerCase().startsWith(query)
                || tag.alias.some((alias) => alias.toLowerCase().startsWith(query));
        }).sort((a, b) => a.value.localeCompare(b.value));
        return query ? matches.slice(0, 8) : matches;
    });
    let showTagSuggestions = $derived(tagInputFocused && tagSuggestions.length > 0);

    function currentSearch() {
        const tags = [...new Set(tagSearch.split(/\s+/).map((tag) => tag.trim()).filter(Boolean))];
        return [search.trim(), ...tags.map((tag) => `tag:${tag}`)]
            .filter(Boolean)
            .join(' ');
    }

    function currentAuthorSearch() {
        const textQuery = search.trim();
        if (!textQuery || textQuery.startsWith('author:')) return '';
        const tags = [...new Set(tagSearch.split(/\s+/).map((tag) => tag.trim()).filter(Boolean))];
        return [`author:${textQuery}`, ...tags.map((tag) => `tag:${tag}`)]
            .filter(Boolean)
            .join(' ');
    }

    function currentSearches() {
        const baseSearch = currentSearch();
        const authorSearch = currentAuthorSearch();
        const searches = authorSearch && authorSearch !== baseSearch
            ? [baseSearch, authorSearch]
            : [baseSearch];
        return searches;
    }

    function submitSearch(event?: SubmitEvent) {
        event?.preventDefault();
        if (sort === 'random' || sort === 'recommended') sort = '';
        page = 0;
        submittedSearches = currentSearches();
        requestNonce += 1;
    }

    function changeSort(type: string) {
        sort = type;
        page = 0;
        // Re-picking the same sort is still a reload -- "random" is supposed to
        // re-roll -- so the nonce moves even when nothing else does.
        requestNonce += 1;
    }

    function completeTag(tag: string) {
        const tags = tagSearch.trim().split(/\s+/).filter(Boolean);
        if (!tagSearch.endsWith(' ')) tags.pop();
        if (!tags.some((completed) => completed.toLowerCase() === tag.toLowerCase())) tags.push(tag);
        tagSearch = `${tags.join(' ')} `;
        highlightedTagIndex = 0;
    }

    function chooseTag(tag: string) {
        completeTag(tag);
        submitSearch();
    }

    function searchByAuthor(author: string) {
        search = author;
        tagSearch = '';
        submitSearch();
    }

    function handleTagKeydown(event: KeyboardEvent) {
        if (showTagSuggestions && event.key === 'ArrowDown') {
            event.preventDefault();
            highlightedTagIndex = (highlightedTagIndex + 1) % tagSuggestions.length;
            return;
        }
        if (showTagSuggestions && event.key === 'ArrowUp') {
            event.preventDefault();
            highlightedTagIndex = (highlightedTagIndex - 1 + tagSuggestions.length) % tagSuggestions.length;
            return;
        }
        if (showTagSuggestions && (event.key === 'Tab' || event.key === 'Enter')) {
            event.preventDefault();
            completeTag(tagSuggestions[highlightedTagIndex]?.value ?? tagSuggestions[0].value);
            return;
        }
        if (event.key === 'Escape') {
            tagInputFocused = false;
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            submitSearch();
        }
    }

    // No imperative first fetch: `createLazyResource` requests as soon as the
    // key exists, which is what "load it when I appear" means here.

    $effect(() => {
        if ($RealmInitialOpenChar) {
            openedData = $RealmInitialOpenChar;
            $RealmInitialOpenChar = null;
        }
    });
</script>

<section class="mt-4 w-full overflow-hidden rounded-2xl border border-darkborderc bg-darkbg shadow-lg shadow-shadow/10">
    <div class="border-b border-darkborderc bg-selected/20 px-4 py-4 sm:px-5">
        <div class="mb-4 flex items-start gap-3">
            <div class="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/15 text-primary">
                <SparklesIcon size={19} />
            </div>
            <div class="min-w-0">
                <h1 class="text-lg font-semibold tracking-tight text-textcolor">{ui.title}</h1>
                <p class="mt-0.5 text-sm leading-relaxed text-textcolor2">{ui.subtitle}</p>
            </div>
        </div>

        <form class="flex flex-col gap-2" onsubmit={submitSearch}>
            <div class="flex min-w-0 items-stretch overflow-hidden rounded-xl border border-darkborderc bg-bgcolor/40 transition-colors focus-within:border-borderc focus-within:ring-2 focus-within:ring-borderc/30">
                <SearchIcon size={18} class="ml-3 self-center text-textcolor2" />
                <input
                    bind:value={search}
                    aria-label={ui.searchLabel}
                    placeholder={ui.searchPlaceholder}
                    class="min-w-0 grow bg-transparent px-3 py-3 text-base text-textcolor outline-none placeholder:text-textcolor2/60"
                />
                <button
                    type="submit"
                    aria-label={ui.search}
                    class="flex w-12 shrink-0 items-center justify-center border-l border-darkborderc text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor"
                >
                    <SearchIcon size={19} />
                </button>
                <button
                    type="button"
                    aria-label={ui.menu}
                    onclick={() => menuOpen = true}
                    class="flex w-12 shrink-0 items-center justify-center border-l border-darkborderc text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor"
                >
                    <MenuIcon size={19} />
                </button>
            </div>

            <div class="relative">
                <div class="flex min-w-0 items-center rounded-xl border border-darkborderc bg-bgcolor/25 px-3 transition-colors focus-within:border-borderc focus-within:ring-2 focus-within:ring-borderc/30">
                    <HashIcon size={17} class="shrink-0 text-textcolor2" />
                    <input
                        bind:value={tagSearch}
                        aria-label={ui.tagLabel}
                        aria-autocomplete="list"
                        aria-controls="realm-tag-suggestions"
                        aria-expanded={showTagSuggestions}
                        aria-activedescendant={showTagSuggestions ? `realm-tag-option-${highlightedTagIndex}` : undefined}
                        placeholder={ui.tagPlaceholder}
                        class="min-w-0 grow bg-transparent px-3 py-2.5 text-sm text-textcolor outline-none placeholder:text-textcolor2/60"
                        onfocus={() => tagInputFocused = true}
                        onblur={() => tagInputFocused = false}
                        oninput={() => { highlightedTagIndex = 0; tagInputFocused = true; }}
                        onkeydown={handleTagKeydown}
                    />
                    {#if tagSearch}
                        <button type="button" class="text-xs text-textcolor2 hover:text-textcolor" onclick={() => { tagSearch = ''; highlightedTagIndex = 0; }}>{ui.clear}</button>
                    {/if}
                </div>

                {#if showTagSuggestions}
                    <div
                        id="realm-tag-suggestions"
                        role="listbox"
                        aria-label={ui.suggestions}
                        class="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-xl border border-darkborderc bg-darkbg p-1.5 shadow-xl shadow-shadow/20"
                    >
                        {#each tagSuggestions as tag, index (tag.value)}
                            <button
                                id={`realm-tag-option-${index}`}
                                type="button"
                                role="option"
                                aria-selected={index === highlightedTagIndex}
                                class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors {index === highlightedTagIndex ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-selected/50 hover:text-textcolor'}"
                                onpointerdown={(event) => event.preventDefault()}
                                onmouseenter={() => highlightedTagIndex = index}
                                onclick={() => completeTag(tag.value)}
                            >
                                <span>#{tag.value}</span>
                                {#if index === highlightedTagIndex}<span class="text-xs text-textcolor2">Tab / Enter</span>{/if}
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </form>

        {#if popularTags.length > 0}
            <div class="mt-3 flex items-center gap-2 overflow-x-auto pb-0.5" aria-label={ui.popularLabel}>
                <span class="shrink-0 text-xs font-medium uppercase tracking-wide text-textcolor2/70">{ui.popular}</span>
                {#each popularTags as tag}
                    <button
                        type="button"
                        class="shrink-0 rounded-full border border-darkborderc bg-darkbg px-2.5 py-1 text-xs text-textcolor2 transition-colors hover:border-borderc hover:bg-selected hover:text-textcolor"
                        onclick={() => chooseTag(tag)}
                    >#{tag}</button>
                {/each}
            </div>
        {/if}
    </div>

    <div class="flex items-center gap-2 overflow-x-auto border-b border-darkborderc px-4 py-3 sm:px-5">
        <button
            type="button"
            class="shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors {nsfw ? 'border-primary/50 bg-primary/20 text-textcolor' : 'border-darkborderc text-textcolor2 hover:bg-selected/40'}"
            onclick={() => { nsfw = !nsfw; page = 0; }}
        >{nsfw ? 'NSFW' : 'SFW'}</button>
        <span class="h-5 border-l border-darkborderc"></span>
        {#each [
            ['recommended', language.recommended],
            ['', language.recent],
            ['trending', language.trending],
            ['downloads', language.downloads],
            ['random', language.random],
        ] as option}
            <button
                type="button"
                class="shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors {sort === option[0] ? 'border-borderc bg-selected text-textcolor' : 'border-transparent text-textcolor2 hover:bg-selected/40 hover:text-textcolor'}"
                onclick={() => changeSort(option[0])}
            >{option[1]}</button>
        {/each}
    </div>
</section>

{@html hubAdditionalHTML}

<!-- Results only. The search box, tag input and sort pills above stay mounted
     and interactive while a page is in flight: this surface loads itself, it
     does not take the screen hostage. -->
<LazyState resource={realmPage} failedTitle={ui.loadFailed}>
    {#snippet loading()}
        <div role="status" aria-live="polite" class="flex min-h-32 items-center justify-center gap-2 py-4 text-sm text-textcolor2">
            <svg class="animate-spin" style="will-change: transform;" width="18" height="18" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <span>{ui.loading}</span>
        </div>
    {/snippet}
    {#snippet failed(error, retry)}
        <div role="alert" class="my-4 flex flex-col items-start gap-2 rounded-2xl border border-danger-border bg-danger-bg p-4 text-sm text-danger">
            <span class="font-medium">{ui.loadFailed}</span>
            <span class="text-xs opacity-70">{ui.loadFailedHint}</span>
            {#if error instanceof Error && error.message}
                <span class="break-all text-xs opacity-60">{error.message}</span>
            {/if}
            <ShButton variant="outline" size="sm" onclick={retry}>{language.lazyLoad.retry}</ShButton>
        </div>
    {/snippet}

    <div class="grid w-full grid-cols-1 gap-3 py-4 lg:grid-cols-2">
        {#each charas as chara (chara.id)}
            <RealmHubIcon onClick={() => openedData = chara} onAuthorClick={searchByAuthor} {chara} />
        {/each}
    </div>

    <!-- Reachable only from the ready branch, so "no characters" is always a
         real answer from the hub and never a stand-in for a failed request. -->
    {#if charas.length === 0}
        <div class="flex min-h-32 items-center justify-center rounded-2xl border border-dashed border-darkborderc text-sm text-textcolor2">
            {ui.noResults}
        </div>
    {/if}
</LazyState>

{#if sort !== 'random' && sort !== 'recommended'}
    <nav class="flex w-full justify-center pb-4" aria-label={ui.pages}>
        <div class="flex items-center gap-2 rounded-xl border border-darkborderc bg-darkbg p-1.5">
            <ShButton
                variant="ghost"
                size="icon-sm"
                aria-label={ui.previousPage}
                disabled={page === 0}
                onclick={() => { if (page > 0) page -= 1; }}
            ><ArrowLeft size={18} /></ShButton>
            <span class="min-w-10 text-center text-sm font-medium text-textcolor">{page + 1}</span>
            <ShButton
                variant="ghost"
                size="icon-sm"
                aria-label={ui.nextPage}
                onclick={() => { page += 1; }}
            ><ArrowRight size={18} /></ShButton>
        </div>
    </nav>
{/if}

{#if openedData}
    <RealmPopUp bind:openedData />
{/if}

<ShDialog bind:open={menuOpen} size="sm" closeOnEscape={true} closeOnOutsideClick={true}>
    {#snippet title()}{ui.tools}{/snippet}
    {#snippet description()}{ui.toolsDescription}{/snippet}
    <ShButton variant="secondary" className="w-full" onclick={async () => {
        menuOpen = false;
        const input = await alertInput(ui.importPrompt);
        if (!input) return;
        if (input.startsWith('http')) {
            const url = new URL(input);
            const id = url.searchParams.get('realm') ?? url.searchParams.get('code') ?? input.split('/').at(-1);
            if (id) {
                void downloadRisuHub(id);
                return;
            }
        }
        const id = input.split('?').at(-1);
        if (id) void downloadRisuHub(id);
    }}>{ui.importCharacter}</ShButton>
</ShDialog>
