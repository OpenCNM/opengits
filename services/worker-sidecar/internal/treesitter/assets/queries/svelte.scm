;; Svelte：单文件组件符号位于 <script> 内嵌 JS（raw_text 不透明，需二次
;; 解析——与 vue 同策略暂缓）；根模式零捕获保证不落正则回退。
(document) @svelte.root
