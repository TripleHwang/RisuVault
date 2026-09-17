<script>
    import { alertConfirm, notifyError } from "../../ts/alert";
    import { language } from "../../lang";
    
    import { DBState } from 'src/ts/stores.svelte';
    import { newChatModelDefaults } from 'src/ts/storage/database.svelte';
    import { ReloadGUIPointer, selectedCharID } from "../../ts/stores.svelte";
    import { DownloadIcon, SquarePenIcon, HardDriveUploadIcon, PlusIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { exportChat, importChat } from "../../ts/characters";
    import { findCharacterbyId } from "../../ts/util";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { changeChatTo, requestImmediateSave } from "src/ts/globalApi.svelte";
    import { createChatOpener } from "src/ts/chatOpen.svelte";
    import LazyState from "../UI/GUI/LazyState.svelte";
    import { v4 } from "uuid";

    let editMode = $state(false)
    /** @type {{close?: any}} */
    let { close = () => {} } = $props();

    /**
     * This dialog closes onto the chat only once that chat is really loaded,
     * and the progress and any failure stay inside the dialog.
     *
     * The old handler was `changeChatTo(i); close()`. Both halves were wrong
     * together: `changeChatTo` raised the app-wide `fixed inset-0` overlay, and
     * `close()` ran immediately -- so a chat whose history never arrived still
     * dismissed the list and left the user on an empty conversation, which is
     * indistinguishable from a chat that only ever had a greeting.
     */
    // `close` is read inside the callback rather than captured at construction:
    // it is a prop, so capturing it would keep calling the first one this dialog
    // ever received.
    const chatOpener = createChatOpener((chatIndex) => {
        changeChatTo(chatIndex, { alreadyLoaded: true })
        close()
    })
</script>

<div class="risu-modal-overlay absolute w-full h-full z-40 bg-overlay/50 flex justify-center items-center">
    <div class="risu-modal-surface bg-darkbg p-4 break-any rounded-md flex flex-col max-w-full w-72 max-h-full overflow-y-auto">
        <div class="risu-modal-header flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0">{language.chatList}</h2>
            <div class="grow flex justify-end">
                <button class="risu-modal-close text-textcolor2 hover:text-primary mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        <!-- A chat that could not be opened says so, inside this dialog, and the
             dialog stays open on the list the user clicked in. -->
        <LazyState resource={chatOpener.resource} inline>
            {#snippet loading()}
                <div role="status" aria-live="polite" class="px-1 py-1 text-xs text-textcolor2">
                    {language.lazyLoad.loading}{chatOpener.openingName ? ` · ${chatOpener.openingName}` : ''}
                </div>
            {/snippet}
            {#snippet failed()}
                <div role="alert" data-chat-open-failed class="mb-2 flex flex-col gap-1 rounded-lg border border-danger-border bg-danger-bg p-2 text-xs text-danger">
                    <span class="font-medium">{language.lazyLoad.chatFailed}{chatOpener.openingName ? `: ${chatOpener.openingName}` : ''}</span>
                    {#if chatOpener.resource.errorMessage}
                        <span class="break-all opacity-70">{chatOpener.resource.errorMessage}</span>
                    {/if}
                    <button type="button" class="self-start rounded border border-danger-border px-1.5 py-0.5 transition-colors hover:bg-danger/15" onclick={() => chatOpener.retryCurrent()}>
                        {language.lazyLoad.retry}
                    </button>
                </div>
            {/snippet}
        </LazyState>
        {#each DBState.db.characters[$selectedCharID].chats as chat, i}
            <button onclick={() => {
                if(!editMode){
                    chatOpener.open(i)
                }
            }} class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" class:bg-selected={i === DBState.db.characters[$selectedCharID].chatPage}>
                {#if editMode}
                    <TextInput bind:value={DBState.db.characters[$selectedCharID].chats[i].name} padding={false}/>
                {:else}
                    <span>{chat.name}</span>
                {/if}
                <div class="grow flex justify-end">
                    <div class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        exportChat(i)
                    }} onkeydown={() => {

                    }}>
                        <DownloadIcon size={18}/>
                    </div>
                    <div class="text-textcolor2 hover:text-danger/80 cursor-pointer" role="button" tabindex="0" onclick={async (e) => {
                        e.stopPropagation()
                        if(DBState.db.characters[$selectedCharID].chats.length === 1){
                            notifyError(language.errors.onlyOneChat)
                            return
                        }
                        const d = await alertConfirm(`${language.removeConfirm}${chat.name}`)
                        if(d){
                            changeChatTo(0)
                            let chats = DBState.db.characters[$selectedCharID].chats
                            chats.splice(i, 1)
                            DBState.db.characters[$selectedCharID].chats = chats
                            void requestImmediateSave()
                        }
                    }} onkeydown={() => {
                        
                    }}>
                        <TrashIcon size={18}/>
                    </div>
                </div>
            </button>
        {/each}
        <div class="flex mt-2 items-center">
            <button class="text-textcolor2 hover:text-primary cursor-pointer mr-1" onclick={() => {
                const character = DBState.db.characters[$selectedCharID]
                const currentChat = character.chats[character.chatPage]
                const len = character.chats.length
                let chats = character.chats
                const newChat = {
                    message:[], note:'', name:`New Chat ${len + 1}`, localLore:[], fmIndex: -1, id: v4(),
                    ...newChatModelDefaults(character, currentChat)
                }
                chats.unshift(newChat)
                DBState.db.characters[$selectedCharID].chats = chats
                changeChatTo(0)
                void requestImmediateSave()
                close()
            }}>
                <PlusIcon/>
            </button>
            <button class="text-textcolor2 hover:text-primary mr-2 cursor-pointer" onclick={() => {
                importChat()
            }}>
                <HardDriveUploadIcon size={18}/>
            </button>
            <button class="text-textcolor2 hover:text-primary cursor-pointer" onclick={() => {
                editMode = !editMode
            }}>
                <SquarePenIcon size={18}/>
            </button>
        </div>
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
