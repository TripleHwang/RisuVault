import type { PluginV2ProviderOptions } from './plugins.svelte'

const RISUBARD_STATUS_PATH_KEY = 'provider-manager:risubard-status-path'
const JELLYBARD_STATUS_PATH_KEY = 'provider-manager:jellybard-status-path'

function migrateProviderManagerStatusPath(
    key: string | undefined,
    getItem: (key: string) => unknown,
    setItem?: (key: string, value: string) => unknown,
): void {
    if (key !== RISUBARD_STATUS_PATH_KEY && key !== JELLYBARD_STATUS_PATH_KEY) return
    try {
        if (getItem(RISUBARD_STATUS_PATH_KEY) != null) return
        const legacy = getItem(JELLYBARD_STATUS_PATH_KEY)
        if (legacy === 'jellybard' || legacy === 'provider') {
            setItem?.(RISUBARD_STATUS_PATH_KEY, legacy === 'jellybard' ? 'risubard' : legacy)
        }
    } catch {
        // Status migration is best-effort and must never block provider registration.
    }
}

export function bindPluginRequestStatusStorage(
    options: PluginV2ProviderOptions | undefined,
    getItem: (key: string) => unknown,
    setItem?: (key: string, value: string) => unknown,
): PluginV2ProviderOptions {
    const bound = options ?? {}
    const key = bound.hostRequestStatusStorageKey
    migrateProviderManagerStatusPath(key, getItem, setItem)
    return key ? {
        ...bound,
        hostRequestStatus: () => {
            const value = getItem(key)
            return value === 'risubard'
                || (key === JELLYBARD_STATUS_PATH_KEY && value === 'jellybard')
        },
    } : bound
}

export async function resolvePluginRequestStatus(
    options: PluginV2ProviderOptions | undefined,
): Promise<boolean> {
    try {
        const override = options?.overrideRequestStatus
        const resolved = typeof override === 'function'
            ? await override()
            : override
        if (resolved === true) return false
    } catch {
        return true
    }

    try {
        const preference = options?.hostRequestStatus
        return typeof preference === 'function'
            ? await preference() === true
            : preference !== false
    } catch {
        return false
    }
}
