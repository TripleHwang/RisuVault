import { describe, expect, test } from 'vitest'
import { bindPluginRequestStatusStorage, resolvePluginRequestStatus } from './providerRequestStatus'

describe('resolvePluginRequestStatus', () => {
    test('uses host request status unless the plugin explicitly overrides it', async () => {
        expect(await resolvePluginRequestStatus(undefined)).toBe(true)
        expect(await resolvePluginRequestStatus({})).toBe(true)
        expect(await resolvePluginRequestStatus({ overrideRequestStatus: false })).toBe(true)
        expect(await resolvePluginRequestStatus({ overrideRequestStatus: true })).toBe(false)
        expect(await resolvePluginRequestStatus({ overrideRequestStatus: () => true })).toBe(false)
        expect(await resolvePluginRequestStatus({ hostRequestStatus: true })).toBe(true)
        expect(await resolvePluginRequestStatus({ hostRequestStatus: false })).toBe(false)
    })

    test('awaits asynchronous plugin status selectors', async () => {
        expect(await resolvePluginRequestStatus({
            overrideRequestStatus: async () => true,
        })).toBe(false)
        expect(await resolvePluginRequestStatus({
            hostRequestStatus: async () => true,
        })).toBe(true)
        expect(await resolvePluginRequestStatus({
            hostRequestStatus: async () => false,
        })).toBe(false)
    })

    test('supports a live provider-owned status selector', async () => {
        let enabled = false
        const options = { hostRequestStatus: () => enabled }

        expect(await resolvePluginRequestStatus(options)).toBe(false)
        enabled = true
        expect(await resolvePluginRequestStatus(options)).toBe(true)
    })

    test('contains provider selector failures', async () => {
        expect(await resolvePluginRequestStatus({
            hostRequestStatus: () => { throw new Error('broken option') },
        })).toBe(false)
        expect(await resolvePluginRequestStatus({
            overrideRequestStatus: () => { throw new Error('broken override') },
        })).toBe(true)
        expect(await resolvePluginRequestStatus({
            hostRequestStatus: async () => { throw new Error('broken async option') },
        })).toBe(false)
        expect(await resolvePluginRequestStatus({
            overrideRequestStatus: async () => { throw new Error('broken async override') },
        })).toBe(true)
    })

    test('binds a serializable plugin storage key to a live host selector', async () => {
        let value: unknown = 'provider'
        const options = bindPluginRequestStatusStorage({
            hostRequestStatusStorageKey: 'provider-manager:status-path',
        }, () => value)

        expect(await resolvePluginRequestStatus(options)).toBe(false)
        value = 'risubard'
        expect(await resolvePluginRequestStatus(options)).toBe(true)
    })

    test('migrates the legacy JellyBard status selection for the RisuBard bridge', async () => {
        const storage = new Map<string, unknown>([
            ['provider-manager:jellybard-status-path', 'jellybard'],
        ])
        const options = bindPluginRequestStatusStorage({
            hostRequestStatusStorageKey: 'provider-manager:risubard-status-path',
        }, (key) => storage.get(key), (key, value) => storage.set(key, value))

        expect(await resolvePluginRequestStatus(options)).toBe(true)
        expect(storage.get('provider-manager:risubard-status-path')).toBe('risubard')
    })

    test('keeps an installed JellyBard bridge active while migrating its selection', async () => {
        const storage = new Map<string, unknown>([
            ['provider-manager:jellybard-status-path', 'jellybard'],
        ])
        const options = bindPluginRequestStatusStorage({
            hostRequestStatusStorageKey: 'provider-manager:jellybard-status-path',
        }, (key) => storage.get(key), (key, value) => storage.set(key, value))

        expect(await resolvePluginRequestStatus(options)).toBe(true)
        expect(storage.get('provider-manager:risubard-status-path')).toBe('risubard')
    })

    test('does not break provider registration when legacy storage migration fails', () => {
        expect(() => bindPluginRequestStatusStorage({
            hostRequestStatusStorageKey: 'provider-manager:risubard-status-path',
        }, () => { throw new Error('storage unavailable') })).not.toThrow()
    })
})
