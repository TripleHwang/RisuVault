import {
    normalizeArcaChatFontSizePx,
    normalizeArcaChatImageWidthPercent,
    normalizeArcaChatParagraphSpacingPercent,
    normalizeArcaChatShowTitleImage,
    normalizeArcaChatTitleImageStyle,
    type ArcaChatTitleImageStyle,
} from './arcaChatSaverSettings';
import { applyArcaSemanticFormatting, type ArcaSemanticPalette } from './arcaSemanticFormatting';

export interface ArcaExportOptions {
    baseUrl?: string;
    loadImage?: (url: string) => Promise<string>;
    readStyle?: (element: Element, pseudoElement?: string | null) => CSSStyleDeclaration;
    imageWidthPercent?: number;
    paragraphSpacingPercent?: number;
    semanticPalette?: ArcaSemanticPalette;
    renderComplexBlock?: (element: HTMLElement) => Promise<string | readonly string[] | null>;
}

export interface ArcaClipboardColors {
    background: string;
    panel: string;
    text: string;
    mutedText: string;
    border: string;
}

export interface ArcaClipboardHtmlOptions {
    bodyHtml: string;
    displayName: string;
    badge?: string;
    iconDataUrl?: string;
    fontSizePx?: number;
    showTitleImage?: boolean;
    titleImageStyle?: ArcaChatTitleImageStyle;
    colors?: Partial<ArcaClipboardColors>;
}

const DEFAULT_CLIPBOARD_COLORS: ArcaClipboardColors = {
    background: '#292d3e',
    panel: '#202331',
    text: '#f7f8fc',
    mutedText: '#aeb6cc',
    border: '#454b61',
};

const BACKGROUND_URL_PATTERN = /url\(\s*(['"]?)(.*?)\1\s*\)/i;

const SAFE_STYLE_PROPERTIES = [
    'color',
    'background',
    'background-color',
    'background-image',
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'line-height',
    'letter-spacing',
    'text-align',
    'text-decoration',
    'text-indent',
    'text-shadow',
    'text-transform',
    'white-space',
    'word-break',
    'vertical-align',
    'margin-top',
    'margin-bottom',
    'padding',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-color',
    'border-style',
    'border-width',
    'border-radius',
    'box-shadow',
] as const;

const SAFE_DISPLAY_VALUES = new Set([
    'block',
    'inline',
    'inline-block',
    'table',
    'table-row',
    'table-cell',
    'none',
]);

const DROPPED_TAGS = new Set([
    'BUTTON',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'SCRIPT',
    'STYLE',
    'SVG',
    'CANVAS',
    'IFRAME',
    'OBJECT',
    'EMBED',
]);

export function shouldIncludeArcaSnapshotNode(
    node: Node,
    excludedElements: readonly HTMLElement[],
): boolean {
    if (excludedElements.includes(node as HTMLElement)) return false;
    return !(node instanceof Element
        && node.matches('button, input, textarea, select, [role="button"]'));
}

export function findDetachedArcaPanels(
    root: HTMLElement,
    readStyle: (element: Element) => CSSStyleDeclaration = element => getComputedStyle(element),
    readRect: (element: HTMLElement) => DOMRect = element => element.getBoundingClientRect(),
): HTMLElement[] {
    const rootRect = readRect(root);
    const rootWidth = Math.max(1, rootRect.width || 760);
    const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
    const isLargeLayer = (element: HTMLElement) => {
        const rect = readRect(element);
        return rect.width >= 220 && rect.height >= 120;
    };
    const positionOf = (element: HTMLElement) => getStyleValue(readStyle(element), 'position');
    const fixedPositioned = elements.filter((element) => {
        const style = readStyle(element);
        if (getStyleValue(style, 'display') === 'none') return false;
        const position = getStyleValue(style, 'position');
        return position === 'fixed' || position === 'sticky';
    });
    const fixedLayers = fixedPositioned
        .filter(isLargeLayer)
        .filter(element => !hasAncestorIn(element, fixedPositioned));

    const selected: HTMLElement[] = [];
    for (const layer of fixedLayers) {
        const rect = readRect(layer);
        const fillsViewport = rect.width >= rootWidth * .9
            && (rootRect.height < 2 || rect.height >= rootRect.height * .9);
        if (!fillsViewport) {
            selected.push(layer);
            continue;
        }

        const nestedSurfaces = Array.from(layer.querySelectorAll<HTMLElement>('*'))
            .filter(element => isLargeLayer(element) && hasDetachedPanelSurface(readStyle(element)))
            .filter(element => {
                const nestedRect = readRect(element);
                return nestedRect.width * nestedRect.height < rect.width * rect.height * .92;
            })
            .sort((left, right) => {
                const leftOutOfFlow = isOutOfFlowPosition(positionOf(left)) ? 1 : 0;
                const rightOutOfFlow = isOutOfFlowPosition(positionOf(right)) ? 1 : 0;
                if (leftOutOfFlow !== rightOutOfFlow) return rightOutOfFlow - leftOutOfFlow;
                return rectArea(readRect(right)) - rectArea(readRect(left));
            });
        selected.push(nestedSurfaces[0] ?? layer);
    }

    const absoluteLayers = elements.filter((element) => {
        if (positionOf(element) !== 'absolute' || !isLargeLayer(element)) return false;
        if (selected.some(layer => layer === element || layer.contains(element) || element.contains(layer))) return false;
        const style = readStyle(element);
        return hasDetachedPanelSurface(style) && hasDetachedLayerState(style);
    });
    selected.push(...absoluteLayers);
    return selected.filter((candidate, index) =>
        selected.indexOf(candidate) === index
        && !selected.some(other => other !== candidate && candidate.contains(other)),
    );
}

function hasAncestorIn(element: HTMLElement, candidates: readonly HTMLElement[]): boolean {
    return candidates.some(other => other !== element && other.contains(element));
}

function isOutOfFlowPosition(position: string): boolean {
    return position === 'absolute' || position === 'fixed' || position === 'sticky';
}

function rectArea(rect: DOMRect): number {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function hasDetachedPanelSurface(style: CSSStyleDeclaration): boolean {
    const background = [
        getStyleValue(style, 'background'),
        getStyleValue(style, 'background-color'),
        getStyleValue(style, 'background-image'),
    ].join(' ');
    const hasBackground = Boolean(background.trim())
        && !/^(?:\s*|none|transparent|rgba\(0,\s*0,\s*0,\s*0\))+$/i.test(background.trim());
    const boxShadow = getStyleValue(style, 'box-shadow');
    const overflow = [
        getStyleValue(style, 'overflow'),
        getStyleValue(style, 'overflow-x'),
        getStyleValue(style, 'overflow-y'),
    ];
    return hasBackground
        || (boxShadow !== '' && boxShadow !== 'none')
        || overflow.some(value => value === 'auto' || value === 'scroll' || value === 'hidden');
}

function hasDetachedLayerState(style: CSSStyleDeclaration): boolean {
    const zIndex = Number.parseInt(getStyleValue(style, 'z-index'), 10);
    const opacity = Number.parseFloat(getStyleValue(style, 'opacity'));
    const transform = getStyleValue(style, 'transform');
    return (Number.isFinite(zIndex) && zIndex >= 10)
        || (Number.isFinite(opacity) && opacity < 1)
        || getStyleValue(style, 'pointer-events') === 'none'
        || (transform !== '' && transform !== 'none');
}

export interface ArcaComplexSnapshotTarget {
    kind: 'main' | 'panel';
    element: HTMLElement;
    excludeElements: readonly HTMLElement[];
}

export function planArcaComplexSnapshots(
    root: HTMLElement,
    readStyle: (element: Element) => CSSStyleDeclaration = element => getComputedStyle(element),
    readRect: (element: HTMLElement) => DOMRect = element => element.getBoundingClientRect(),
): ArcaComplexSnapshotTarget[] {
    const panels = findDetachedArcaPanels(root, readStyle, readRect);
    const rootRect = readRect(root);
    const targets: ArcaComplexSnapshotTarget[] = [];
    if (rootRect.width >= 2 && rootRect.height >= 2) {
        targets.push({ kind: 'main', element: root, excludeElements: panels });
    }
    for (const panel of panels) {
        targets.push({ kind: 'panel', element: panel, excludeElements: [] });
    }
    return targets;
}

function getStyleValue(style: CSSStyleDeclaration, property: string): string {
    return style.getPropertyValue(property).trim();
}

function shouldKeepStyle(property: string, value: string): boolean {
    if (!value || value.includes('var(') || value.includes('expression(')) {
        return false;
    }
    if ((property === 'background' || property === 'background-image') && /url\s*\(/i.test(value)) {
        return false;
    }
    if (property === 'background-image' && value !== 'none' && !/(?:linear|radial)-gradient\s*\(/i.test(value)) {
        return false;
    }
    if (value === 'none' || value === 'normal' || value === 'auto' || value === '0px') {
        return false;
    }
    if ((property.startsWith('background') && /^(?:transparent|rgba\(0,\s*0,\s*0,\s*0\))$/i.test(value))) {
        return false;
    }
    return true;
}

function isSafePercentage(value: string): boolean {
    const match = /^(\d+(?:\.\d+)?)%$/.exec(value);
    return match !== null && Number(match[1]) <= 100;
}

function inlineResponsiveGeometry(target: HTMLElement, style: CSSStyleDeclaration): void {
    const width = getStyleValue(style, 'width');
    if (isSafePercentage(width)) {
        target.style.width = width;
    }

    const maxWidth = getStyleValue(style, 'max-width');
    if (isSafePercentage(maxWidth)) {
        target.style.maxWidth = maxWidth;
    }
    else if ([width, maxWidth, getStyleValue(style, 'min-width'), getStyleValue(style, 'height')]
        .some((value) => /\d(?:\.\d+)?px$/i.test(value))) {
        target.style.maxWidth = '100%';
    }
}

function inlineSafeStyles(
    source: HTMLElement,
    target: HTMLElement,
    style: CSSStyleDeclaration,
    forcedDisplay?: 'table-cell',
    sourceBaseFontSize = '',
): void {
    if (source.classList.length > 0 || source.hasAttribute('style')) {
        for (const property of SAFE_STYLE_PROPERTIES) {
            const value = getStyleValue(style, property);
            if (property === 'font-size' && value === sourceBaseFontSize) {
                continue;
            }
            if (shouldKeepStyle(property, value)) {
                target.style.setProperty(property, value);
            }
        }
        inlineResponsiveGeometry(target, style);
    }

    if (forcedDisplay) {
        appendRawStyle(target, 'display', forcedDisplay);
        removeGeneratedTableBorder(target);
        return;
    }

    const display = getStyleValue(style, 'display');
    if (display === 'flex' || display === 'grid' || display === 'inline-flex' || display === 'inline-grid') {
        const direction = getStyleValue(style, 'flex-direction');
        target.style.display = direction === 'column' || direction === 'column-reverse' ? 'block' : 'table';
        if (target.style.display === 'table') {
            removeGeneratedTableBorder(target);
        }
    }
    else if (SAFE_DISPLAY_VALUES.has(display) && display !== 'inline' && display !== 'block') {
        target.style.display = display;
    }
}

function removeGeneratedTableBorder(target: HTMLElement): void {
    for (const property of [
        'border',
        'border-top',
        'border-right',
        'border-bottom',
        'border-left',
        'border-color',
        'border-style',
        'border-width',
    ]) {
        target.style.removeProperty(property);
    }
    target.style.setProperty('border', '0');
}

function appendRawStyle(target: HTMLElement, property: string, value: string): void {
    const existing = target.getAttribute('style')?.trim() ?? '';
    const separator = existing && !existing.endsWith(';') ? ';' : '';
    target.setAttribute('style', `${existing}${separator}${existing ? ' ' : ''}${property}: ${value};`);
}

function applyTopLevelSpacing(container: HTMLElement, paragraphSpacingPercent: number | undefined): void {
    const blocks = Array.from(container.children) as HTMLElement[];
    const spacingEm = normalizeArcaChatParagraphSpacingPercent(paragraphSpacingPercent) / 100;
    blocks.forEach((block, index) => {
        if (index < blocks.length - 1) {
            appendRawStyle(block, 'margin-bottom', `${spacingEm}em`);
        }
    });
}

function shouldDropElement(element: HTMLElement): boolean {
    return DROPPED_TAGS.has(element.tagName)
        || element.hasAttribute('contenteditable')
        || Array.from(element.classList).some((className) => className.startsWith('partial-edit'));
}

function decodePseudoContent(style: CSSStyleDeclaration): string | null {
    const content = getStyleValue(style, 'content');
    if (!content || content === 'none' || content === 'normal' || /^(?:url|attr|counter)\(/i.test(content)) {
        return null;
    }
    const quote = content[0];
    const unquoted = (quote === '"' || quote === "'") && content.endsWith(quote)
        ? content.slice(1, -1)
        : content;
    const decoded = unquoted
        .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, codePoint: string) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
        .replace(/\\([\\"'])/g, '$1')
        .replace(/\\A\s?/gi, '\n');
    return decoded || null;
}

function createPseudoElementClone(
    source: HTMLElement,
    outputDocument: Document,
    options: ArcaExportOptions & { sourceBaseFontSize?: string },
    pseudoElement: '::before' | '::after',
): HTMLSpanElement | null {
    const pseudoStyle = options.readStyle?.(source, pseudoElement);
    if (!pseudoStyle || getStyleValue(pseudoStyle, 'display') === 'none') {
        return null;
    }
    const content = decodePseudoContent(pseudoStyle);
    if (!content) {
        return null;
    }
    const clone = outputDocument.createElement('span');
    clone.textContent = content;
    inlineSafeStyles(source, clone, pseudoStyle, undefined, options.sourceBaseFontSize);
    for (const property of ['margin-left', 'margin-right'] as const) {
        const value = getStyleValue(pseudoStyle, property);
        if (shouldKeepStyle(property, value)) {
            clone.style.setProperty(property, value);
        }
    }
    return clone;
}

function getSingleImageChild(element: HTMLElement): HTMLElement | null {
    if (element.tagName !== 'DIV' && element.tagName !== 'FIGURE') {
        return null;
    }
    const meaningfulChildren = Array.from(element.childNodes).filter((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            return Boolean(node.textContent?.trim());
        }
        return !(node instanceof HTMLBRElement);
    });
    return meaningfulChildren.length === 1
        && meaningfulChildren[0] instanceof HTMLElement
        && meaningfulChildren[0].tagName === 'IMG'
        ? meaningfulChildren[0]
        : null;
}

async function createImageClone(
    source: HTMLElement,
    outputDocument: Document,
    options: Required<Pick<ArcaExportOptions, 'baseUrl' | 'loadImage'>> & ArcaExportOptions & { sourceBaseFontSize: string },
    sourceUrl: string,
    computedStyle: CSSStyleDeclaration,
): Promise<HTMLImageElement> {
    const image = outputDocument.createElement('img');
    const resolvedUrl = resolveUrl(sourceUrl, options.baseUrl);
    image.alt = source.getAttribute('alt') ?? source.getAttribute('aria-label') ?? source.getAttribute('title') ?? '';
    try {
        image.src = sourceUrl.startsWith('data:') ? sourceUrl : await options.loadImage(resolvedUrl);
    }
    catch {
        image.src = resolvedUrl;
    }
    inlineSafeStyles(source, image, computedStyle, undefined, options.sourceBaseFontSize);
    applyImageSizing(image, options.imageWidthPercent);
    return image;
}

function applyImageSizing(image: HTMLImageElement, imageWidthPercent: number | undefined): void {
    appendRawStyle(image, 'display', 'inline-block');
    appendRawStyle(image, 'width', '100%');
    appendRawStyle(image, 'max-width', `${normalizeArcaChatImageWidthPercent(imageWidthPercent)}%`);
    appendRawStyle(image, 'height', 'auto');
    appendRawStyle(image, 'float', 'none');
    appendRawStyle(image, 'margin-left', 'auto');
    appendRawStyle(image, 'margin-right', 'auto');
}

function createCenteredImageFrame(image: HTMLImageElement, outputDocument: Document): HTMLParagraphElement {
    const frame = outputDocument.createElement('p');
    appendRawStyle(frame, 'display', 'block');
    appendRawStyle(frame, 'clear', 'both');
    appendRawStyle(frame, 'text-align', 'center');
    appendRawStyle(frame, 'margin-left', 'auto');
    appendRawStyle(frame, 'margin-right', 'auto');
    frame.appendChild(image);
    return frame;
}

function readBackgroundImage(element: HTMLElement, options: ArcaExportOptions): string {
    const inlineBackground = element.style.backgroundImage;
    if (inlineBackground) {
        return inlineBackground;
    }
    return options.readStyle?.(element).backgroundImage ?? '';
}

function extractBackgroundUrl(backgroundImage: string): string | null {
    const match = BACKGROUND_URL_PATTERN.exec(backgroundImage);
    return match?.[2]?.trim() || null;
}

function isImagePlaceholder(element: HTMLElement): boolean {
    return Array.from(element.childNodes).every((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            return !node.textContent?.trim();
        }
        return node instanceof HTMLBRElement;
    });
}

function isComplexVisualBlock(
    element: HTMLElement,
    readStyle: (element: Element, pseudoElement?: string | null) => CSSStyleDeclaration,
): boolean {
    if (isImagePlaceholder(element)) return false;

    const nodes = [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))];
    let hasStructuredLayout = false;
    let hasVisualBackground = false;

    for (const node of nodes) {
        const style = readStyle(node);
        const position = getStyleValue(style, 'position');
        if (position === 'absolute' || position === 'fixed' || position === 'sticky') {
            return true;
        }
        const display = getStyleValue(style, 'display');
        if (display === 'grid' || display === 'inline-grid' || display === 'flex' || display === 'inline-flex') {
            hasStructuredLayout = true;
        }
        const backgroundImage = getStyleValue(style, 'background-image');
        if (backgroundImage && backgroundImage !== 'none') {
            hasVisualBackground = true;
        }
    }

    return hasVisualBackground && (hasStructuredLayout || nodes.length >= 4);
}

function createComplexSnapshotFrame(dataUrl: string, outputDocument: Document): HTMLParagraphElement {
    const image = outputDocument.createElement('img');
    image.src = dataUrl;
    image.alt = '';
    image.setAttribute('data-arca-complex-snapshot', '');
    appendRawStyle(image, 'display', 'block');
    appendRawStyle(image, 'width', '100%');
    appendRawStyle(image, 'max-width', '100%');
    appendRawStyle(image, 'height', 'auto');
    appendRawStyle(image, 'margin-left', 'auto');
    appendRawStyle(image, 'margin-right', 'auto');
    return createCenteredImageFrame(image, outputDocument);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read image data'));
        reader.readAsDataURL(blob);
    });
}

async function loadImageAsDataUrl(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load image: ${response.status}`);
    }
    return await blobToDataUrl(await response.blob());
}

function resolveUrl(url: string, baseUrl: string): string {
    try {
        return new URL(url, baseUrl).href;
    }
    catch {
        return url;
    }
}

export async function resolveArcaImageSource(
    sourceUrl: string,
    baseUrl = globalThis.location?.href ?? 'http://localhost/',
): Promise<string> {
    if (sourceUrl.startsWith('data:')) {
        return sourceUrl;
    }
    return await loadImageAsDataUrl(resolveUrl(sourceUrl, baseUrl));
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function buildArcaClipboardHtml(options: ArcaClipboardHtmlOptions): string {
    const colors = { ...DEFAULT_CLIPBOARD_COLORS, ...options.colors };
    const fontSizePx = normalizeArcaChatFontSizePx(options.fontSizePx);
    const showTitleImage = normalizeArcaChatShowTitleImage(options.showTitleImage);
    const titleImageStyle = normalizeArcaChatTitleImageStyle(options.titleImageStyle);
    const displayName = escapeHtml(options.displayName);
    const badge = options.badge ? escapeHtml(options.badge) : '';
    const badgeHtml = badge
        ? `<span style="display: inline-block; padding: 0.25rem 0.75rem; color: ${colors.text}; background-color: ${colors.panel}; border: 1px solid ${colors.border}; border-radius: 16px; font-size: 0.8rem;">${badge}</span>`
        : '';
    const titleHtml = `<h3 style="margin: 0 0 0.5rem 0; color: ${colors.text}; font-size: 1.5rem; font-weight: 600;">${displayName}</h3>`;
    const iconSource = showTitleImage && options.iconDataUrl ? escapeHtml(options.iconDataUrl) : '';

    let titleBlock = `<div style="margin-bottom: 1rem; text-align: center;">
${titleHtml}
${badgeHtml}
</div>`;
    if (iconSource && titleImageStyle === 'thumbnail-title') {
        titleBlock = `<table style="width: 100%; margin-bottom: 1rem; border-collapse: collapse;"><tbody><tr>
<td style="width: 80px; padding-right: 16px; vertical-align: middle; text-align: left;"><img src="${iconSource}" alt="profile" style="display: block; width: 64px; height: 64px; max-width: 64px; object-fit: cover; border: 2px solid ${colors.border}; border-radius: 8px;"></td>
<td style="vertical-align: middle; text-align: left;">${titleHtml}${badgeHtml}</td>
</tr></tbody></table>`;
    }
    else if (iconSource) {
        const iconStyle = titleImageStyle === 'square'
            ? `display: block; width: 320px; height: 320px; max-width: 100%; margin: 0 auto 0.75rem auto; object-fit: cover; border: 3px solid ${colors.border}; border-radius: 12px;`
            : `display: block; width: 70%; height: auto; max-width: 420px; margin: 0 auto 0.75rem auto; border: 3px solid ${colors.border}; border-radius: 50%;`;
        titleBlock = `<div style="margin-bottom: 1rem; text-align: center;">
<img src="${iconSource}" alt="profile" style="${iconStyle}">
${titleHtml}
${badgeHtml}
</div>`;
    }

    return `<div style="margin: 1rem 0; color: ${colors.text}; background-color: ${colors.background}; border: 1px solid ${colors.border}; border-radius: 12px; font-family: 'Segoe UI', Roboto, Arial, sans-serif; font-size: ${fontSizePx}px; line-height: 1.6;">
<div style="padding: 20px;">
${titleBlock}
<div style="padding-top: 1rem; border-top: 1px solid ${colors.border};">${options.bodyHtml}</div>
<div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid ${colors.border}; text-align: center;">
<span style="color: ${colors.mutedText}; font-size: 0.75rem;">From RisuVault</span>
</div>
</div>
</div>
<p><br></p>`;
}

async function cloneNodeForArca(
    source: Node,
    outputDocument: Document,
    options: Required<Pick<ArcaExportOptions, 'baseUrl' | 'loadImage'>> & ArcaExportOptions & { sourceBaseFontSize: string },
    forcedDisplay?: 'table-cell',
): Promise<Node | null> {
    if (source.nodeType === Node.TEXT_NODE) {
        return outputDocument.createTextNode(source.textContent ?? '');
    }
    if (!(source instanceof HTMLElement)) {
        return null;
    }
    if (shouldDropElement(source)) {
        return null;
    }

    const computedStyle = options.readStyle?.(source) ?? source.style;
    if (getStyleValue(computedStyle, 'display') === 'none') {
        return null;
    }

    const singleImage = getSingleImageChild(source);
    if (singleImage) {
        const sourceUrl = singleImage.getAttribute('src');
        if (!sourceUrl) {
            return null;
        }
        const imageStyle = options.readStyle?.(singleImage) ?? singleImage.style;
        const image = await createImageClone(singleImage, outputDocument, options, sourceUrl, imageStyle);
        inlineSafeStyles(source, image, computedStyle, undefined, options.sourceBaseFontSize);
        applyImageSizing(image, options.imageWidthPercent);
        return createCenteredImageFrame(image, outputDocument);
    }

    const backgroundUrl = extractBackgroundUrl(readBackgroundImage(source, options));
    if (backgroundUrl && isImagePlaceholder(source)) {
        const image = await createImageClone(source, outputDocument, options, backgroundUrl, computedStyle);
        appendRawStyle(image, 'margin-top', '1rem');
        appendRawStyle(image, 'margin-bottom', '1rem');
        return createCenteredImageFrame(image, outputDocument);
    }

    if (source.tagName === 'IMG') {
        const sourceUrl = source.getAttribute('src');
        if (!sourceUrl) {
            return null;
        }
        const image = await createImageClone(source, outputDocument, options, sourceUrl, computedStyle);
        return createCenteredImageFrame(image, outputDocument);
    }

    const clone = outputDocument.createElement(source.tagName.toLowerCase());
    const display = getStyleValue(computedStyle, 'display');
    const flexDirection = getStyleValue(computedStyle, 'flex-direction');
    const tableRow = (display === 'flex' || display === 'grid' || display === 'inline-flex' || display === 'inline-grid')
        && flexDirection !== 'column'
        && flexDirection !== 'column-reverse';
    const before = createPseudoElementClone(source, outputDocument, options, '::before');
    if (before) {
        clone.appendChild(before);
    }
    for (const child of Array.from(source.childNodes)) {
        const childDisplay = tableRow && child.nodeType === Node.ELEMENT_NODE ? 'table-cell' : undefined;
        const clonedChild = await cloneNodeForArca(child, outputDocument, options, childDisplay);
        if (clonedChild) {
            if (tableRow && clonedChild instanceof HTMLElement) {
                appendRawStyle(clonedChild, 'display', 'table-cell');
            }
            clone.appendChild(clonedChild);
        }
    }
    const after = createPseudoElementClone(source, outputDocument, options, '::after');
    if (after) {
        clone.appendChild(after);
    }
    inlineSafeStyles(source, clone, computedStyle, forcedDisplay, options.sourceBaseFontSize);
    applyArcaSemanticFormatting(source, clone, options.semanticPalette);
    if (clone.style.display === 'table') {
        for (const child of Array.from(clone.children)) {
            appendRawStyle(child as HTMLElement, 'display', 'table-cell');
        }
    }
    return clone;
}

export async function exportArcaHtml(root: HTMLElement, options: ArcaExportOptions = {}): Promise<string> {
    const outputDocument = root.ownerDocument;
    const container = outputDocument.createElement('div');
    const readStyle = options.readStyle ?? ((element: Element, pseudoElement?: string | null) => getComputedStyle(element, pseudoElement));
    const resolvedOptions = {
        ...options,
        baseUrl: options.baseUrl ?? globalThis.location?.href ?? 'http://localhost/',
        loadImage: options.loadImage ?? loadImageAsDataUrl,
        readStyle,
        sourceBaseFontSize: getStyleValue(readStyle(root), 'font-size'),
    };

    for (const child of Array.from(root.childNodes)) {
        if (child instanceof HTMLElement
            && resolvedOptions.renderComplexBlock
            && isComplexVisualBlock(child, readStyle)) {
            try {
                const rendered = await resolvedOptions.renderComplexBlock(child);
                const dataUrls = typeof rendered === 'string' ? [rendered] : rendered;
                if (dataUrls?.length) {
                    for (const dataUrl of dataUrls) {
                        container.appendChild(createComplexSnapshotFrame(dataUrl, outputDocument));
                    }
                    continue;
                }
            }
            catch (cause) {
                throw cause;
            }
        }
        const clonedChild = await cloneNodeForArca(child, outputDocument, resolvedOptions);
        if (clonedChild) {
            container.appendChild(clonedChild);
        }
    }
    applyTopLevelSpacing(container, options.paragraphSpacingPercent);
    return container.innerHTML.trim();
}
