// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import {
    buildArcaClipboardHtml,
    exportArcaHtml,
    findDetachedArcaPanels,
    planArcaComplexSnapshots,
    shouldIncludeArcaSnapshotNode,
} from './arcaExport';

describe('shouldIncludeArcaSnapshotNode', () => {
    it('accepts text nodes while excluding controls and detached panel subtrees', () => {
        const root = document.createElement('div');
        root.innerHTML = '<p>prose</p><button>open</button><aside>panel</aside>';
        const proseText = root.querySelector('p')?.firstChild as Text;
        const button = root.querySelector('button') as HTMLButtonElement;
        const panel = root.querySelector('aside') as HTMLElement;

        expect(shouldIncludeArcaSnapshotNode(proseText, [panel])).toBe(true);
        expect(shouldIncludeArcaSnapshotNode(button, [panel])).toBe(false);
        expect(shouldIncludeArcaSnapshotNode(panel, [panel])).toBe(false);
    });
});

describe('findDetachedArcaPanels', () => {
    it('separates a large FAB panel without treating its button or internal ornaments as panels', () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <main class="alpha"><span class="beta"></span></main>
            <button class="gamma">Open</button>
            <div class="delta"><aside class="epsilon"><span class="zeta"></span></aside></div>
        `;
        const [status, fab, overlay] = Array.from(root.children) as HTMLElement[];
        const panel = overlay.firstElementChild as HTMLElement;
        const panelOrnament = panel.firstElementChild as HTMLElement;
        const styles = new Map<Element, CSSStyleDeclaration>([
            [status, cssStyle('position: relative;')],
            [fab, cssStyle('position: fixed;')],
            [overlay, cssStyle('position: fixed; background-color: rgba(0, 0, 0, .5);')],
            [panel, cssStyle('position: absolute; z-index: 900; overflow: hidden; background: linear-gradient(#112244, #050811); box-shadow: 0 20px 50px #000;')],
            [panelOrnament, cssStyle('position: absolute;')],
        ]);
        const rects = new Map<Element, DOMRect>([
            [root, domRect(760, 600)],
            [status, domRect(760, 400)],
            [fab, domRect(48, 48)],
            [overlay, domRect(760, 600)],
            [panel, domRect(420, 520)],
            [panelOrnament, domRect(300, 180)],
        ]);

        expect(findDetachedArcaPanels(
            root,
            element => styles.get(element) ?? cssStyle(''),
            element => rects.get(element) ?? domRect(0, 0),
        )).toEqual([panel]);
    });

    it('skips a zero-size FAB wrapper and schedules its fixed card as a separate snapshot', () => {
        const root = document.createElement('div');
        root.className = 'zero-shell';
        root.innerHTML = '<label class="tiny-launcher">OPEN</label><div class="detached-surface">Panel content</div>';
        const [fab, panel] = Array.from(root.children) as HTMLElement[];
        const styles = new Map<Element, CSSStyleDeclaration>([
            [fab, cssStyle('position: fixed; display: flex;')],
            [panel, cssStyle('position: fixed; display: block; opacity: 0; transform: translateY(8px);')],
        ]);
        const rects = new Map<Element, DOMRect>([
            [root, domRect(0, 0)],
            [fab, domRect(54, 46)],
            [panel, domRect(460, 520)],
        ]);

        const plan = planArcaComplexSnapshots(
            root,
            element => styles.get(element) ?? cssStyle(''),
            element => rects.get(element) ?? domRect(0, 0),
        );

        expect(plan).toHaveLength(1);
        expect(plan[0].kind).toBe('panel');
        expect(plan[0].element).toBe(panel);
    });

    it('detects an unnamed absolute off-canvas layer from geometry and computed state', () => {
        const root = document.createElement('div');
        root.innerHTML = '<section class="ordinary"><i></i></section><aside class="unknown-layer">Details</aside>';
        const [ordinary, layer] = Array.from(root.children) as HTMLElement[];
        const ornament = ordinary.firstElementChild as HTMLElement;
        const styles = new Map<Element, CSSStyleDeclaration>([
            [ordinary, cssStyle('position: relative; display: grid; background-color: rgb(10, 20, 30);')],
            [ornament, cssStyle('position: absolute; width: 300px; height: 180px;')],
            [layer, cssStyle('position: absolute; z-index: 700; opacity: 0; pointer-events: none; transform: translateX(100%); overflow: auto; background-color: rgb(20, 30, 60); box-shadow: 0 20px 50px #000;')],
        ]);
        const rects = new Map<Element, DOMRect>([
            [root, domRect(760, 600)],
            [ordinary, domRect(760, 400)],
            [ornament, domRect(300, 180)],
            [layer, domRect(360, 480)],
        ]);

        expect(findDetachedArcaPanels(
            root,
            element => styles.get(element) ?? cssStyle(''),
            element => rects.get(element) ?? domRect(0, 0),
        )).toEqual([layer]);
    });
});

describe('exportArcaHtml', () => {
    it('surfaces complex snapshot failures instead of silently flattening hidden panels', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<div class="unknown-wrapper"><div class="unknown-panel">Hidden panel</div></div>';
        const wrapper = root.firstElementChild as HTMLElement;
        const panel = wrapper.firstElementChild as HTMLElement;
        const styles = new Map<Element, CSSStyleDeclaration>([
            [root, cssStyle('font-size: 16px;')],
            [wrapper, cssStyle('display: block;')],
            [panel, cssStyle('position: fixed; display: block; opacity: 0;')],
        ]);

        await expect(exportArcaHtml(root, {
            readStyle: element => styles.get(element) ?? cssStyle(''),
            renderComplexBlock: async () => { throw new Error('snapshot failed'); },
        })).rejects.toThrow('snapshot failed');
    });

    it('preserves a complex visual block as a full-width snapshot while keeping ordinary prose as HTML', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<p>ordinary prose</p><section class="status"><div class="dial">D-18</div></section>';
        const prose = root.children[0] as HTMLElement;
        const status = root.children[1] as HTMLElement;
        const dial = status.firstElementChild as HTMLElement;
        const styles = new Map<Element, CSSStyleDeclaration>([
            [root, cssStyle('display: block; font-size: 16px;')],
            [prose, cssStyle('display: block; font-size: 16px;')],
            [status, cssStyle('display: grid; width: 100%; min-height: 260px; background-image: linear-gradient(#071122, #02050c);')],
            [dial, cssStyle('position: absolute; right: 12px; top: 12px;')],
        ]);
        const renderComplexBlock = vi.fn(async () => [
            'data:image/png;base64,status-card',
            'data:image/png;base64,detached-panel',
        ]);

        const html = await exportArcaHtml(root, {
            readStyle: (element) => styles.get(element) ?? cssStyle(''),
            loadImage: async (url) => url,
            renderComplexBlock,
        });
        const output = document.createElement('div');
        output.innerHTML = html;
        const snapshots = Array.from(output.querySelectorAll('img[data-arca-complex-snapshot]')) as HTMLImageElement[];

        expect(output.firstElementChild?.tagName).toBe('P');
        expect(output.firstElementChild?.textContent).toBe('ordinary prose');
        expect(snapshots.map(snapshot => snapshot.getAttribute('src'))).toEqual([
            'data:image/png;base64,status-card',
            'data:image/png;base64,detached-panel',
        ]);
        expect(snapshots[0].style.width).toBe('100%');
        expect(snapshots[0].style.maxWidth).toBe('100%');
        expect(renderComplexBlock).toHaveBeenCalledOnce();
        expect(renderComplexBlock).toHaveBeenCalledWith(status);
        expect(html).not.toContain('class="status"');
    });

    it('replaces a CSS background asset with a real image without changing message order', async () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <p>before</p>
            <div class="image-container" style="background-image: url('/api/asset/abc')"><br></div>
            <p>after</p>
        `;
        const loadImage = vi.fn(async () => 'data:image/png;base64,converted');

        const html = await exportArcaHtml(root, {
            baseUrl: 'https://risu.example/chat',
            loadImage,
        });

        const output = document.createElement('div');
        output.innerHTML = html;
        const children = Array.from(output.children);

        expect(children.map((element) => element.tagName)).toEqual(['P', 'P', 'P']);
        const imageFrame = children[1] as HTMLElement;
        const image = imageFrame.querySelector('img') as HTMLImageElement;
        expect(image.getAttribute('src')).toBe('data:image/png;base64,converted');
        expect(imageFrame.style.width).toBe('');
        expect(image.style.width).toBe('100%');
        expect(image.style.maxWidth).toBe('60%');
        expect(html).not.toContain('background-image');
        expect(html).not.toContain('image-container');
        expect(loadImage).toHaveBeenCalledWith('https://risu.example/api/asset/abc');
    });

    it('adds configurable spacing between top-level blocks and centers exported images', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<p>첫 문단</p><img src="/portrait.png" alt="portrait"><p>둘째 문단</p>';

        const html = await exportArcaHtml(root, {
            baseUrl: 'https://risu.example/chat',
            loadImage: async () => 'data:image/png;base64,portrait',
            imageWidthPercent: 40,
            paragraphSpacingPercent: 100,
        });
        const output = document.createElement('div');
        output.innerHTML = html;
        const [first, imageFrame, last] = Array.from(output.children) as HTMLElement[];
        const image = imageFrame.querySelector('img') as HTMLImageElement;

        expect(first.style.marginBottom).toBe('1em');
        expect(imageFrame.tagName).toBe('P');
        expect(imageFrame.style.display).toBe('block');
        expect(imageFrame.style.textAlign).toBe('center');
        expect(imageFrame.style.width).toBe('');
        expect(imageFrame.style.marginLeft).toBe('auto');
        expect(imageFrame.style.marginRight).toBe('auto');
        expect(imageFrame.style.marginBottom).toBe('1em');
        expect(image.style.display).toBe('inline-block');
        expect(image.style.width).toBe('100%');
        expect(image.style.maxWidth).toBe('40%');
        expect(image.style.float).toBe('none');
        expect(image.style.marginLeft).toBe('auto');
        expect(image.style.marginRight).toBe('auto');
        expect(last.style.marginBottom).toBe('');
    });

    it('inlines safe computed styles and rewrites unsupported flex rows as table cells', async () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <div class="status-row" style="position: relative; overflow: hidden; opacity: 0.7; background-image: url('/paper.png')">
                <span class="location">란타르나 외곽 평원</span>
                <span class="reputation">10</span>
            </div>
        `;
        const [row] = Array.from(root.children) as HTMLElement[];
        const [location, reputation] = Array.from(row.children) as HTMLElement[];
        const styles = new Map<Element, CSSStyleDeclaration>([
            [row, cssStyle('display: flex; flex-direction: row; width: 100%; padding: 12px; background-color: rgb(247, 244, 232); border: 1px solid rgb(210, 200, 180); border-radius: 8px; position: relative; overflow: hidden; opacity: 0.7; background-image: url("/paper.png");')],
            [location, cssStyle('color: rgb(32, 67, 75); font-weight: 600;')],
            [reputation, cssStyle('color: rgb(32, 67, 75); text-align: right;')],
        ]);
        const html = await exportArcaHtml(root, {
            readStyle: (element) => styles.get(element) ?? cssStyle(''),
            loadImage: async (url) => url,
        });

        const output = document.createElement('div');
        output.innerHTML = html;
        const exportedRow = output.firstElementChild as HTMLElement;
        const exportedCells = Array.from(exportedRow.children) as HTMLElement[];

        expect(exportedRow.className).toBe('');
        expect(exportedRow.style.display).toBe('table');
        expect(exportedRow.style.width).toBe('100%');
        expect(exportedRow.style.padding).toBe('12px');
        expect(exportedRow.style.backgroundColor).toBe('rgb(247, 244, 232)');
        expect(exportedRow.style.borderRadius).toBe('8px');
        expect(exportedRow.style.borderWidth).toBe('0px');
        expect(html).toContain('table-cell');
        expect(exportedCells.map((cell) => cell.getAttribute('style'))).toEqual([
            expect.stringContaining('display: table-cell'),
            expect.stringContaining('display: table-cell'),
        ]);
        expect(exportedCells.every(cell => cell.style.borderWidth === '0px')).toBe(true);
        expect(exportedCells[1].style.textAlign).toBe('right');
        expect(html).not.toMatch(/display:\s*flex/i);
        expect(html).not.toMatch(/position:|overflow:|opacity:|url\(/i);
    });

    it('lets the exported frame control normal body text size while preserving larger headings', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<p class="body-copy">본문</p><h2 class="heading">제목</h2>';
        const [body, heading] = Array.from(root.children) as HTMLElement[];
        const styles = new Map<Element, CSSStyleDeclaration>([
            [root, cssStyle('font-size: 16px;')],
            [body, cssStyle('color: rgb(247, 248, 252); font-size: 16px;')],
            [heading, cssStyle('font-size: 24px; font-weight: 600;')],
        ]);

        const bodyHtml = await exportArcaHtml(root, {
            readStyle: (element) => styles.get(element) ?? cssStyle(''),
            loadImage: async (url) => url,
        });
        const html = buildArcaClipboardHtml({ bodyHtml, displayName: 'Test', fontSizePx: 18 });

        expect(bodyHtml).not.toContain('font-size: 16px');
        expect(bodyHtml).toContain('font-size: 24px');
        expect(html).toContain('font-size: 18px');
    });

    it('embeds existing images and removes interactive editor controls', async () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <p>본문</p>
            <img src="/api/asset/portrait" alt="파트리샤" style="border-radius: 12px; object-fit: cover;">
            <button type="button">편집</button>
            <textarea>임시 편집문</textarea>
            <div class="partial-edit-overlay"><span>편집 모달</span></div>
        `;
        const loadImage = vi.fn(async () => 'data:image/png;base64,portrait');

        const html = await exportArcaHtml(root, {
            baseUrl: 'https://risu.example/chat',
            loadImage,
            readStyle: (element) => (element as HTMLElement).style,
        });

        const output = document.createElement('div');
        output.innerHTML = html;
        const image = output.querySelector('img') as HTMLImageElement;

        expect(image.src).toBe('data:image/png;base64,portrait');
        expect(image.alt).toBe('파트리샤');
        expect(image.getAttribute('style')).toContain('border-radius: 12px');
        expect(image.style.maxWidth).toBe('60%');
        expect(loadImage).toHaveBeenCalledWith('https://risu.example/api/asset/portrait');
        expect(output.querySelector('button, textarea, .partial-edit-overlay')).toBeNull();
        expect(output.textContent).not.toContain('편집 모달');
    });

    it('flattens a single-image frame instead of exporting its viewport-sized wrapper', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<div class="portrait-frame"><img src="/api/asset/miho" alt="Miho"></div>';
        const frame = root.firstElementChild as HTMLElement;
        const portrait = frame.firstElementChild as HTMLElement;
        const styles = new Map<Element, CSSStyleDeclaration>([
            [frame, cssStyle('display: block; width: 400px; max-width: 1877.33px; height: 400px; margin: 10px 344px; border-radius: 10px;')],
            [portrait, cssStyle('display: block; width: 400px; height: 400px; max-width: 100%;')],
        ]);

        const html = await exportArcaHtml(root, {
            baseUrl: 'https://risu.example/chat',
            loadImage: async () => 'data:image/png;base64,miho',
            readStyle: (element) => styles.get(element) ?? cssStyle(''),
            imageWidthPercent: 40,
        });

        const output = document.createElement('div');
        output.innerHTML = html;
        const exportedFrame = output.firstElementChild as HTMLElement;
        const exported = exportedFrame.querySelector('img') as HTMLImageElement;

        expect(exportedFrame.tagName).toBe('P');
        expect(exportedFrame.style.width).toBe('');
        expect(exported.getAttribute('src')).toBe('data:image/png;base64,miho');
        expect(exported.style.width).toBe('100%');
        expect(exported.style.maxWidth).toBe('40%');
        expect(exported.getAttribute('style')).toContain('border-radius: 10px');
        expect(html).not.toMatch(/344px|1877\.33px|width:\s*400px|height:\s*400px/i);
    });

    it('does not export viewport-resolved pixel geometry from responsive cards', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<details class="status-card"><summary>1일차 · 오후</summary></details>';
        const card = root.firstElementChild as HTMLElement;

        const html = await exportArcaHtml(root, {
            readStyle: (element) => element === card
                ? cssStyle('display: block; width: 620px; max-width: 1877.33px; height: 42.7167px; margin: 10px 234px; padding: 7px 10px; border-radius: 10px;')
                : cssStyle(''),
            loadImage: async (url) => url,
        });

        const output = document.createElement('div');
        output.innerHTML = html;
        const exported = output.firstElementChild as HTMLElement;

        expect(exported.style.maxWidth).toBe('100%');
        expect(exported.style.marginTop).toBe('10px');
        expect(exported.style.marginBottom).toBe('10px');
        expect(html).not.toMatch(/234px|620px|1877\.33px|42\.7167px/i);
    });

    it('materializes textual pseudo-elements used for card icons and ornaments', async () => {
        const root = document.createElement('div');
        root.innerHTML = '<div class="inventory-label">보유 아이템</div>';
        const label = root.firstElementChild as HTMLElement;

        const html = await exportArcaHtml(root, {
            readStyle: (element, pseudoElement) => {
                if (element === label && pseudoElement === '::before') {
                    return cssStyle('content: "⚗"; color: rgb(120, 100, 80); margin-right: 6px;');
                }
                if (element === label && pseudoElement === '::after') {
                    return cssStyle('content: "✦"; color: rgb(180, 160, 130); margin-left: 4px;');
                }
                return cssStyle('color: rgb(60, 70, 75);');
            },
            loadImage: async (url) => url,
        });

        expect(html).toContain('>⚗</span>보유 아이템<span');
        expect(html).toContain('>✦</span>');
        expect(html).toContain('margin-right: 6px');
        expect(html).not.toContain('::before');
    });

    it('formats whole-block sound, dialogue, and thought markers without touching mixed prose', async () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <p>§PUNG—whistle…§</p>
            <p>"Grit your teeth and push through!"</p>
            <p>‘They are exposing their flank…’</p>
            <p>He said "this stays ordinary" while walking.</p>
        `;

        const html = await exportArcaHtml(root, {
            semanticPalette: 'dark',
            readStyle: (element) => element === root ? cssStyle('font-size: 16px;') : cssStyle('font-size: 16px;'),
            loadImage: async (url) => url,
        });
        const output = document.createElement('div');
        output.innerHTML = html;
        const [sound, quote, thought, ordinary] = Array.from(output.children) as HTMLElement[];

        expect(sound.textContent).toBe('PUNG—whistle…');
        expect(sound.style.display).toBe('inline-block');
        expect(sound.style.color).toBe('rgb(208, 123, 231)');
        expect(sound.style.fontStyle).toBe('italic');
        expect(quote.style.borderLeftWidth).toBe('4px');
        expect(quote.style.color).toBe('rgb(241, 187, 87)');
        expect(thought.style.borderLeftWidth).toBe('4px');
        expect(thought.style.color).toBe('rgb(127, 171, 241)');
        expect(ordinary.style.borderLeftWidth).toBe('');
    });

    it('preserves external regex colors and supplies a safe explicit choice style', async () => {
        const root = document.createElement('div');
        root.innerHTML = `
            <span class="regex-sound-block">CLANG</span>
            <div class="regex-choice-block">▶ Advance</div>
        `;
        const [sound, choice] = Array.from(root.children) as HTMLElement[];
        const styles = new Map<Element, CSSStyleDeclaration>([
            [root, cssStyle('font-size: 16px;')],
            [sound, cssStyle('display: inline-block; color: rgb(255, 174, 25); font-style: italic;')],
            [choice, cssStyle('display: block;')],
        ]);

        const html = await exportArcaHtml(root, {
            semanticPalette: 'dark',
            readStyle: (element) => styles.get(element) ?? cssStyle(''),
            loadImage: async (url) => url,
        });
        const output = document.createElement('div');
        output.innerHTML = html;
        const [exportedSound, exportedChoice] = Array.from(output.children) as HTMLElement[];

        expect(exportedSound.style.color).toBe('rgb(255, 174, 25)');
        expect(exportedChoice.style.borderLeftWidth).toBe('4px');
        expect(exportedChoice.style.fontWeight).toBe('600');
    });
});

describe('buildArcaClipboardHtml', () => {
    it('builds an Arca-safe wrapper without unsupported layout CSS', () => {
        const html = buildArcaClipboardHtml({
            bodyHtml: '<p style="color: #f8f8f2;">본문</p>',
            displayName: '<레슬레리아나>',
            badge: 'AI',
            iconDataUrl: 'data:image/png;base64,profile',
            fontSizePx: 18,
            colors: {
                background: '#292d3e',
                panel: '#202331',
                text: '#f7f8fc',
                mutedText: '#aeb6cc',
                border: '#454b61',
            },
        });

        expect(html).toContain('&lt;레슬레리아나&gt;');
        expect(html).toContain('<p style="color: #f8f8f2;">본문</p>');
        expect(html).toContain('src="data:image/png;base64,profile"');
        expect(html).toContain('From RisuVault');
        expect(html).toContain('font-size: 18px');
        expect(html).toContain('margin: 1rem 0');
        expect(html).not.toContain('max-width: 600px');
        expect(html).not.toContain('margin: 1rem auto');
        expect(html).not.toMatch(/class=|<style|display:\s*(?:flex|grid)|position:|overflow:|opacity:|url\(/i);
    });

    it('adds an empty paragraph after the chat frame for pasting the next turn', () => {
        const html = buildArcaClipboardHtml({
            bodyHtml: '<p>본문</p>',
            displayName: 'Test',
        });
        const output = document.createElement('div');
        output.innerHTML = html;

        expect(output.children).toHaveLength(2);
        expect(output.lastElementChild?.tagName).toBe('P');
        expect(output.lastElementChild?.innerHTML).toBe('<br>');
    });

    it('applies a custom base font size to the full-width frame', () => {
        const html = buildArcaClipboardHtml({
            bodyHtml: '<p>본문</p>',
            displayName: 'Test',
            fontSizePx: 24,
        });

        expect(html).toContain('font-size: 24px');
        expect(html).not.toContain('max-width: 600px');
    });

    it('can hide the title image without hiding the title', () => {
        const html = buildArcaClipboardHtml({
            bodyHtml: '<p>본문</p>',
            displayName: 'Title',
            iconDataUrl: 'data:image/png;base64,profile',
            showTitleImage: false,
        });

        expect(html).toContain('>Title</h3>');
        expect(html).not.toContain('data:image/png;base64,profile');
    });

    it('renders the title image as a large oval by default', () => {
        const html = buildArcaClipboardHtml({
            bodyHtml: '<p>본문</p>',
            displayName: 'Title',
            iconDataUrl: 'data:image/png;base64,profile',
        });
        const output = document.createElement('div');
        output.innerHTML = html;
        const image = output.querySelector('img[alt="profile"]') as HTMLImageElement;

        expect(image.style.width).toBe('70%');
        expect(image.style.maxWidth).toBe('420px');
        expect(image.style.borderRadius).toBe('50%');
    });

    it('renders a cropped square title image', () => {
        const html = buildArcaClipboardHtml({
            bodyHtml: '<p>본문</p>',
            displayName: 'Title',
            iconDataUrl: 'data:image/png;base64,profile',
            titleImageStyle: 'square',
        });
        const output = document.createElement('div');
        output.innerHTML = html;
        const image = output.querySelector('img[alt="profile"]') as HTMLImageElement;

        expect(image.style.width).toBe('320px');
        expect(image.style.height).toBe('320px');
        expect(image.style.objectFit).toBe('cover');
        expect(image.style.borderRadius).toBe('12px');
    });

    it('renders a compact thumbnail beside the title', () => {
        const html = buildArcaClipboardHtml({
            bodyHtml: '<p>본문</p>',
            displayName: 'Title',
            badge: 'AI',
            iconDataUrl: 'data:image/png;base64,profile',
            titleImageStyle: 'thumbnail-title',
        });
        const output = document.createElement('div');
        output.innerHTML = html;
        const image = output.querySelector('table img[alt="profile"]') as HTMLImageElement;

        expect(image.style.width).toBe('64px');
        expect(image.style.height).toBe('64px');
        expect(image.style.objectFit).toBe('cover');
        expect(output.querySelector('table')?.textContent).toContain('Title');
        expect(output.querySelector('table')?.textContent).toContain('AI');
    });
});

function cssStyle(cssText: string): CSSStyleDeclaration {
    const element = document.createElement('div');
    element.style.cssText = cssText;
    return element.style;
}

function domRect(width: number, height: number): DOMRect {
    return { width, height, x: 0, y: 0, top: 0, right: width, bottom: height, left: 0, toJSON() {} };
}
