import { describe, expect, it } from 'vitest'

describe('Vitest browser isolation', () => {
    it('rejects network requests that a test did not mock', async () => {
        await expect(fetch('/unexpected-network')).rejects.toThrow(
            'Unmocked network request in Vitest: http://localhost:3000/unexpected-network',
        )
    })
})
