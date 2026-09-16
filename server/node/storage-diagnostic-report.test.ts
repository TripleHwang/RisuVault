import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let generateStorageDiagnosticReport: any
try {
    ({ generateStorageDiagnosticReport } = require('./storage-diagnostic-report.cjs'))
} catch {
    generateStorageDiagnosticReport = undefined
}

const roots: string[] = []

function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-storage-report-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
    return root
}

function writeRows(root: string, name: string, rows: object[]) {
    fs.writeFileSync(path.join(root, 'logs', name), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('privacy-safe storage diagnostic report', () => {
    it('is exposed through an authenticated aggregate-only route', () => {
        const server = fs.readFileSync(path.join(process.cwd(), 'server', 'node', 'server.cjs'), 'utf8')

        expect(server).toContain("require('./storage-diagnostic-report.cjs')")
        expect(server).toContain("app.get('/api/storage-diagnostics/report'")
        expect(server).toMatch(/app\.get\('\/api\/storage-diagnostics\/report'[\s\S]*?checkAuth\(req, res\)/)
    })

    it('exports aggregate performance and categorized issues without raw identifiers or content', async () => {
        expect(generateStorageDiagnosticReport).toBeTypeOf('function')
        if (!generateStorageDiagnosticReport) return

        const root = tempRoot()
        writeRows(root, 'storage-observation.previous.jsonl', Array.from({ length: 5 }, (_, index) => ({
            timestamp: 1000 + index,
            sessionId: 'private-session-id',
            operationId: `private-operation-${index}`,
            kind: 'compatibility-persist',
            outcome: 'success',
            durationMs: (index + 1) * 100,
            databaseBytes: 987654321,
            characterCount: 17,
        })))
        writeRows(root, 'storage-observation.jsonl', [
            ...Array.from({ length: 5 }, (_, index) => ({
                timestamp: 2000 + index,
                sessionId: 'private-session-id',
                operationId: `private-operation-${index + 5}`,
                kind: 'compatibility-persist',
                outcome: 'success',
                durationMs: (index + 6) * 100,
                messageCount: 4321,
            })),
            { kind: 'compatibility-persist', outcome: 'failure', errorStage: 'kv-write', errorCode: 'EIO' },
            { kind: 'canonical-sync', outcome: 'success', durationMs: 250, stagedBytes: 1024 },
            { kind: 'canonical-sync', outcome: 'success', durationMs: 30, strategy: 'bot-presets-direct', fallbackUsed: false },
            { kind: 'canonical-sync', outcome: 'success', durationMs: 40, strategy: 'bot-presets-direct', fallbackUsed: true, fallbackCode: 'EIO' },
            { kind: 'projection-shadow', outcome: 'success', semanticMatch: true, durationMs: 80 },
            { kind: 'projection-shadow', outcome: 'mismatch', semanticMatch: false, errorStage: 'semantic-compare' },
        ])

        const report = await generateStorageDiagnosticReport({ dataRoot: root, appVersion: '0.9.36' })

        expect(report).toMatchObject({
            reportType: 'risubard-storage-diagnostics',
            schemaVersion: 1,
            appVersion: '0.9.36',
            status: 'issues-detected',
            saves: {
                attempts: 11,
                successes: 10,
                failures: 1,
                durationMs: { p50: 500, p90: 900 },
            },
            directWrites: { attempts: 2, successes: 1, fallbacks: 1, failures: 0 },
            shadow: { checks: 2, matches: 1, mismatches: 1, failures: 0, skipped: 0 },
            privacy: { includesPersonalContent: false, includesRawLogs: false },
        })
        expect(report.issues).toEqual(expect.arrayContaining([
            { area: 'compatibility-persist', stage: 'kv-write', code: 'EIO', count: 1 },
            { area: 'canonical-direct-write', stage: 'fallback', code: 'EIO', count: 1 },
            { area: 'projection-shadow', stage: 'semantic-compare', code: 'SEMANTIC_MISMATCH', count: 1 },
        ]))
        const exported = JSON.stringify(report)
        for (const privateValue of ['private-session-id', 'private-operation', '987654321', '4321']) {
            expect(exported).not.toContain(privateValue)
        }
    })

    it('reports a clean status without inventing observations', async () => {
        expect(generateStorageDiagnosticReport).toBeTypeOf('function')
        if (!generateStorageDiagnosticReport) return

        const report = await generateStorageDiagnosticReport({ dataRoot: tempRoot(), appVersion: '0.9.36' })

        expect(report.status).toBe('no-observations')
        expect(report.saves).toEqual({ attempts: 0, successes: 0, failures: 0, durationMs: { p50: null, p90: null } })
        expect(report.issues).toEqual([])
    })
})
