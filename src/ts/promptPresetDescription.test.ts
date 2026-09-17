import { describe, expect, test } from 'vitest'
import * as promptPresetSettings from './setting/promptPresetSettingsData.svelte'

describe('findHttpUrlAtOffset', () => {
    const findHttpUrlAtOffset = (promptPresetSettings as typeof promptPresetSettings & {
        findHttpUrlAtOffset?: (text: string, offset: number) => string | null
    }).findHttpUrlAtOffset

    test('finds the http or https address under the clicked character', () => {
        expect(findHttpUrlAtOffset).toBeTypeOf('function')
        expect(findHttpUrlAtOffset?.('문서: https://example.com/guide?q=1 를 참고하세요.', 12))
            .toBe('https://example.com/guide?q=1')
    })

    test('ignores text outside addresses and non-web schemes', () => {
        expect(findHttpUrlAtOffset).toBeTypeOf('function')
        expect(findHttpUrlAtOffset?.('문서: https://example.com', 1)).toBeNull()
        expect(findHttpUrlAtOffset?.('file:///C:/secret.txt', 10)).toBeNull()
    })
})
