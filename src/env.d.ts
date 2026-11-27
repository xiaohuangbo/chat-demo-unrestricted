declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** Markdown 文档按原文内联为字符串，见 rspack.config.ts 的 asset/source 规则 */
declare module '*.md' {
  const source: string
  export default source
}

/** 默认自定义思维链按原文内联，见 rspack.config.ts 的 asset/source 规则 */
declare module '*.txt' {
  const source: string
  export default source
}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}

/**
 * 首屏加载页的控制器（src/index.html 内联脚本提供）：主入口用它推进转圈的弧长，
 * 界面渲染完成后调用 ready() 淡出并移除加载页。
 */
interface BootController {
  /** 进度 0–1（只增不减），映射到转圈弧长 72°–288° */
  progress(ratio: number): void
  /** 界面已渲染：填满弧、淡出并移除加载页；重复调用安全 */
  ready(): void
  /** 加载失败：换成原样报错与「重新加载」按钮 */
  fail(message: string): void
}

interface Window {
  __boot?: BootController
}
