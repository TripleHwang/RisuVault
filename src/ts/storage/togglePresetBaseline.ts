export interface TogglePresetBaseline {
    name?: string
    values: Record<string, string>
}

export interface ToggleValueDifference {
    key: string
    baselineValue: string
    currentValue: string
}

export function createTogglePresetBaseline(
    values: Record<string, string>,
    name?: string,
): TogglePresetBaseline {
    return {
        ...(name ? { name } : {}),
        values: { ...values },
    }
}

export function getToggleValueDifferences(
    baseline: TogglePresetBaseline | undefined,
    currentValues: Record<string, string>,
): ToggleValueDifference[] {
    if (!baseline) return []

    const keys = new Set([...Object.keys(baseline.values), ...Object.keys(currentValues)])

    return [...keys]
        .sort()
        .flatMap((key) => {
            const baselineValue = baseline.values[key] ?? ''
            const currentValue = currentValues[key] ?? ''
            return baselineValue === currentValue ? [] : [{ key, baselineValue, currentValue }]
        })
}
