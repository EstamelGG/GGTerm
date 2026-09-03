import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

/** 应用版本（package.json）与编译时刻 → 渲染层 __APP_VERSION__ / __BUILD_TIME__ 构建期注入 */
const appVersion = (
  JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }
).version
const buildTime = new Date().toISOString()
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      minify: true,
      sourcemap: false,
      // 主进程 V8 字节码（production）；sandbox 已关，preload 可启用
      bytecode: true,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          tarWorker: resolve('src/main/ssh/tarWorker.ts')
        }
      }
    }
  },
  preload: {
    build: {
      minify: true,
      sourcemap: false,
      bytecode: true
    }
  },
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_TIME__: JSON.stringify(buildTime)
    },
    // Keep fonts as local files: inline data URLs are blocked by the app's CSP.
    build: {
      minify: 'esbuild',
      sourcemap: false,
      assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/i.test(filePath) ? false : undefined)
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
