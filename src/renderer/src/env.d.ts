/// <reference types="vite/client" />

/** 构建期注入的应用版本号（electron.vite.config.ts renderer.define，来源 package.json） */
declare const __APP_VERSION__: string

/** 构建期注入的编译时刻（ISO 8601；dev 下为 dev 启动时刻） */
declare const __BUILD_TIME__: string
