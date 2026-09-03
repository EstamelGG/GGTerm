import { x } from 'tar'

// Isolated process: killing it releases all archive/output handles before cleanup.
void x({ file: process.argv[2], cwd: process.argv[3], strict: true, preservePaths: false })
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
