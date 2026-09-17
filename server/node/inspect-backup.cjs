#!/usr/bin/env node
const { inspectBackup } = require('./backup-inspector.cjs')

async function main() {
    const filePath = process.argv[2]
    if (!filePath || filePath === '--help' || filePath === '-h') {
        console.log('Usage: pnpm inspect:backup -- <backup.bin>')
        console.log('Reads entry headers and database.risudat only; chat text and names are never printed.')
        process.exitCode = filePath ? 0 : 1
        return
    }

    const configuredMb = Number(process.env.RISUBARD_INSPECT_MAX_DB_MB ?? '1024')
    if (!Number.isFinite(configuredMb) || configuredMb <= 0) {
        throw new Error('RISUBARD_INSPECT_MAX_DB_MB must be a positive number')
    }
    const report = await inspectBackup(filePath, {
        maxDatabaseBytes: Math.floor(configuredMb * 1024 * 1024),
    })
    console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
