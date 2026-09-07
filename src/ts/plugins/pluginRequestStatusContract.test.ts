import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('plugin provider host request status contract', () => {
    test('applies the host status gate to every plugin-provider request', () => {
        const request = source('src/ts/process/request/request.ts')

        expect(request).toContain('const reportStatus = statusEnabled(arg.realChatId)')
        expect(request).toContain(
            'resolvePluginRequestStatus(pluginV2.providerOptions.get(model))',
        )
    })

    test('documents the explicit plugin override contract in both plugin APIs', () => {
        const runtime = source('src/ts/plugins/plugins.svelte.ts')
        const apiV3 = source('src/ts/plugins/apiV3/risuai.d.ts')
        const contract = 'set true only when the plugin replaces the host request status UI'

        expect(runtime).toContain(contract)
        expect(apiV3).toContain(contract)
        expect(runtime).toContain('overrideRequestStatus?: boolean | (() => boolean)')
        expect(apiV3).toContain('overrideRequestStatus?: boolean | (() => boolean);')
    })

    test('publishes a provider compatibility reference from the main README', () => {
        const docs = source('docs/ko/plugin-provider-compatibility.md')
        const readme = source('README.md')

        expect(readme).toContain('docs/ko/plugin-provider-compatibility.md')
        expect(docs).toContain('overrideRequestStatus: true')
        expect(docs).toContain('RisuVault 요청 상태 창')
        expect(docs).toContain('플러그인의 생성 정보 창')
    })
})
