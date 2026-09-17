import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const sidebar = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/SideChatList.svelte'
), 'utf8')
const characterSidebar = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/Sidebar.svelte'
), 'utf8')
const gallery = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/RisuBardGallery.svelte'
), 'utf8')
const database = readFileSync(resolve(
    process.cwd(), 'src/ts/storage/database.svelte.ts'
), 'utf8')
const chatScreen = readFileSync(resolve(
    process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'
), 'utf8')
const chatRenderer = readFileSync(resolve(
    process.cwd(), 'src/lib/ChatScreens/Chat.svelte'
), 'utf8')
const stores = readFileSync(resolve(
    process.cwd(), 'src/ts/stores.svelte.ts'
), 'utf8')
const characterConfig = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/CharConfig.svelte'
), 'utf8')
const characterPackage = readFileSync(resolve(
    process.cwd(), 'src/ts/characterPackage.ts'
), 'utf8')

describe('chat gallery connections', () => {
    test('opens from the character toolbar instead of the active chat title row', () => {
        expect(sidebar).not.toContain('data-risubard-gallery')
        expect(characterSidebar).toContain('data-risubard-gallery')
        expect(characterSidebar).toContain('risuBardGalleryOpen.set(true)')
        expect(characterSidebar).toContain('MobileSideBar.set(0)')
        expect(sidebar).not.toContain('<RisuBardGallery')
    })

    test('uses the main chat viewport instead of a modal', () => {
        expect(stores).toContain('export const risuBardGalleryOpen = writable(false)')
        expect(chatScreen).toContain("import RisuBardGallery from '../SideBars/RisuBardGallery.svelte'")
        expect(chatScreen).toContain('$risuBardGalleryOpen')
        expect(chatScreen).toContain('<RisuBardGallery')
        expect(chatScreen).toContain('<DefaultChatScreen')
        expect(gallery).toContain('data-risubard-gallery-viewport')
        expect(gallery).not.toContain('<ShDialog')
        expect(gallery).not.toContain('data-gallery-mode-view')
        expect(gallery).not.toContain('data-gallery-mode-edit')
        expect(gallery).toContain('data-gallery-new-memory')
        expect(gallery).toContain('data-gallery-new-category')
    })

    test('stores a custom gallery title and collections on the bot', () => {
        expect(database).toMatch(/export interface character[\s\S]*?risuBardGallery\?:RisuBardGallery/)
        expect(gallery).toContain('chara.risuBardGallery')
        expect(gallery).not.toContain('currentChat.risuBardGallery = nextGallery')
        expect(gallery).toContain('data-gallery-title-edit')
        expect(gallery).toContain('data-gallery-title-input')
        expect(gallery).toContain('galleryDefaultTitle')
    })

    test('renders configurable memory slots with per-slot editing and deletion', () => {
        expect(gallery).toContain('data-gallery-slot')
        expect(gallery).not.toContain('data-gallery-slot-edit')
        expect(gallery).toContain('data-gallery-slot-delete')
        expect(gallery).toContain('data-gallery-slot-width')
        expect(gallery).toContain('data-gallery-slot-height')
        expect(gallery).toContain('--gallery-slot-width')
        expect(gallery).toContain('--gallery-slot-height')
    })

    test('creates a titled snapshot without a manually authored summary', () => {
        expect(gallery).toContain('data-gallery-title')
        expect(gallery).not.toContain('data-gallery-summary')
        expect(gallery).toContain('data-gallery-range-start')
        expect(gallery).toContain('data-gallery-range-end')
        expect(gallery).toContain('data-gallery-message-editor')
        expect(gallery).toContain('createGallerySlot({')
    })

    test('reorders, deletes, and saves gallery slots', () => {
        expect(gallery).toContain('moveGallerySlot(')
        expect(gallery).toContain('removeSlot(')
        expect(gallery).toContain('requestImmediateSave()')
    })

    test('creates category sections and moves selected memories into them', () => {
        expect(gallery).toContain('data-gallery-category')
        expect(gallery).toContain('data-gallery-select-slot')
        expect(gallery).toContain('moveGallerySlotsToCategory(')
        expect(gallery).toContain('selectedSlotIds')
    })

    test('drags memories into a new position and category', () => {
        expect(gallery).toContain('draggable={editMode}')
        expect(gallery).toContain('ondragstart')
        expect(gallery).toContain('ondragover')
        expect(gallery).toContain('ondrop')
        expect(gallery).toContain('moveGallerySlotByDrop(')
    })

    test('collapses category sections and shows their memory counts', () => {
        expect(gallery).toContain('data-gallery-category-toggle')
        expect(gallery).toContain('aria-expanded={!collapsedCategoryIds.has(category.id)}')
        expect(gallery).toContain('memories.length')
    })

    test('uses a responsive full-height viewport layout', () => {
        expect(gallery).toContain('@media (max-width: 700px)')
        expect(gallery).toContain('height: 100%')
        expect(gallery).toContain('max-width: 100%')
    })

    test('labels drag-and-drop regions for assistive technology', () => {
        expect(gallery).toContain('role="list"')
        expect(gallery).toContain('role="group"')
    })

    test('shows a clean title and automatic message preview outside edit mode', () => {
        expect(gallery).toContain('data-gallery-edit-toggle')
        expect(gallery).toContain('aria-pressed={editMode}')
        expect(gallery).toContain('memory-card__preview')
        expect(gallery).toContain('getGalleryPreviewMessage(slot)')
        expect(gallery).not.toContain('memory-card__number')
        expect(gallery).not.toContain('memory-card__meta')
        expect(gallery).not.toContain('memory-card__replay')
        expect(gallery).not.toContain('.scene-reader__header div')
    })

    test('chooses the preview message while editing and overlays card controls', () => {
        expect(database).toContain('previewMessageIndex?: number')
        expect(gallery).toContain('data-gallery-preview-message')
        expect(gallery).toContain('class="memory-card__controls"')
        expect(gallery).toContain('bottom: 0.65rem')
        expect(gallery).toContain('class="memory-card__select"')
    })

    test('keeps card content inside a clean, flat frame', () => {
        expect(gallery).not.toContain('.memory-card__open::after')
        expect(gallery).not.toContain('background: linear-gradient(145deg')
        expect(gallery).toContain('overflow-wrap: anywhere')
        expect(gallery).toContain('box-sizing: border-box')
    })

    test('edits titles inline and opens the editor when a card is clicked in edit mode', () => {
        expect(gallery).toContain('data-gallery-slot-title')
        expect(gallery).toContain('data-gallery-slot-title-input')
        expect(gallery).toContain('beginInlineTitleEdit(')
        expect(gallery).toContain('if (editMode)')
        expect(gallery).toContain('editSlot(slotId)')
        expect(gallery).not.toContain('class="memory-card__edit"')
    })

    test('chooses user-message visibility during creation and editing', () => {
        expect(database).toContain('hideUserMessages?: boolean')
        expect(gallery.match(/data-gallery-hide-user-messages/g)?.length).toBeGreaterThanOrEqual(2)
        expect(gallery).toContain('getVisibleGalleryMessages(selectedSlot)')
    })

    test('uses the complete read-only chat renderer when viewing a memory', () => {
        expect(gallery).toContain("import Chat from '../ChatScreens/Chat.svelte'")
        expect(gallery).toContain('<Chat')
        expect(gallery).toContain('readOnly')
        expect(gallery).not.toContain('<ChatBody')
        expect(chatRenderer).toContain('readOnly?: boolean')
        expect(chatRenderer).toContain('{#if !readOnly}')
    })

    test('preserves display script indices without enabling chat editing', () => {
        expect(gallery).toContain('idx={index}')
        expect(chatRenderer).toContain('idx >= 0 && !readOnly')
        expect(chatRenderer).toContain('if(!readOnly && DBState.db.clickToEdit')
        expect(chatRenderer).toContain('if(readOnly) return')
    })

    test('returns from the gallery viewport to the current chat', () => {
        expect(gallery).toContain('data-gallery-close')
        expect(gallery).toContain('onclick={onClose}')
        expect(gallery).toMatch(
            /data-gallery-close[\s\S]*?<ArrowLeftIcon[\s\S]*?\{language\.galleryBackToChat\}/
        )
        expect(chatScreen).toContain('risuBardGalleryOpen.set(false)')
    })

    test('uses the default chat scroll host without a custom wheel implementation', () => {
        expect(chatScreen).toContain('data-gallery-scroll')
        expect(chatScreen).toContain('h-full w-full overflow-y-auto overscroll-y-contain relative default-chat-screen')
        expect(gallery).not.toContain('handleGalleryWheel')
        expect(gallery).not.toContain("addEventListener('wheel'")
        expect(gallery).not.toContain('scrollbar-width: auto')
        expect(gallery).not.toContain('.gallery-scroll::-webkit-scrollbar')
        expect(gallery).toContain('class="gallery-exit"')
    })

    test('centers gallery titles with navigation immediately to their left', () => {
        expect(gallery).toContain('class="gallery-toolbar__nav"')
        expect(gallery).toContain('grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)')
        expect(gallery).toContain('.gallery-toolbar__nav, .gallery-back { justify-self: end;')
        expect(gallery).toContain('.gallery-subtoolbar > strong { justify-self: center;')
    })

    test('shows list tools only in the gallery list and uses semantic card actions', () => {
        expect(gallery).toContain('data-gallery-list-toolbar')
        expect(gallery).toContain('data-gallery-reader')
        expect(gallery).toContain('data-gallery-back')
        expect(gallery).toContain('<button\n                    type="button"\n                    class="memory-card__preview"')
        expect(gallery).not.toContain('class="memory-card__preview"\n                    role="button"')
    })

    test('exports gallery memories only through an explicit package option', () => {
        expect(characterConfig).toContain('bind:check={pkgIncludeGallery}')
        expect(characterConfig).toContain('name={language.characterPackageGallery}')
        expect(characterConfig).toContain('includeGallery: pkgIncludeGallery')
        expect(characterPackage).toContain('includeGallery: boolean')
        expect(characterPackage).toContain("const galleryPath = 'gallery/gallery.json'")
        expect(characterPackage).toContain('manifest.gallery =')
        expect(characterPackage).toContain('importGalleryToCharacter(')
        expect(characterPackage).toContain('stripGalleryFromChats(char.chats)')
    })
})
