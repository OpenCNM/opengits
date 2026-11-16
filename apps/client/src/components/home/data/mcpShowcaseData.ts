import * as m from '@/paraglide/messages';

export interface ChapterItem {
  title: string;
  file?: string;
}

export interface ModuleGroup {
  name: string;
  chapters: ChapterItem[];
}

export interface CodeDetailBlock {
  type: 'code';
  lang: string;
  linesCount: number;
  snippet: string[];
}

export interface TableDetailBlock {
  type: 'table';
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface TipDetailBlock {
  type: 'tip';
  variant: 'tip' | 'warning' | 'info';
  title: string;
  content: string;
}

export interface SummaryDetailBlock {
  type: 'summary';
  title: string;
  items: string[];
}

export type DetailBlock = CodeDetailBlock | TableDetailBlock | TipDetailBlock | SummaryDetailBlock;

export interface DetailPreviewData {
  analogy: string;
  stepTitle: string;
  explanation: string;
  codeLang: string;
  codeLinesCount: number;
  codeSnippet: string[];
  blocks: {
    code: CodeDetailBlock;
    table: TableDetailBlock;
    tip: TipDetailBlock;
    summary: SummaryDetailBlock;
  };
}

export interface RepoStoryData {
  id: string;
  repoUrl: string;
  repoName: string;
  stars: string;
  isWeb?: boolean;
  tutorialTitle: string;
  subtitle: string;
  modules: ModuleGroup[];
  detailPreview: DetailPreviewData;
}

export function getStoryDetailBlocks(
  story: RepoStoryData,
  layoutSeed: number = 0
): DetailBlock[] {
  const { code, table, tip, summary } = story.detailPreview.blocks;

  const layoutPresets: DetailBlock[][] = [
    [code, tip],
    [table, summary],
    [code, table],
    [summary, code],
  ];

  const storyBaseOffset =
    story.id === 'llamacpp' ? 0 : story.id === 'vllm' ? 1 : story.id === 'vgpu' ? 2 : 3;

  const selectedIndex = (storyBaseOffset + layoutSeed) % layoutPresets.length;
  return layoutPresets[selectedIndex];
}

export function getRepoStories(): RepoStoryData[] {
  return [
    {
      id: 'llamacpp',
      repoUrl: 'https://github.com/ggml-org/llama.cpp',
      repoName: 'ggml-org/llama.cpp',
      stars: '76k',
      isWeb: false,
      tutorialTitle: m.mcp_showcase_llamacpp_title(),
      subtitle: m.mcp_showcase_llamacpp_subtitle(),
      modules: [
        {
          name: m.mcp_showcase_llamacpp_mod1_name(),
          chapters: [
            { title: m.mcp_showcase_llamacpp_ch1_title(), file: 'ggml.c' },
            { title: m.mcp_showcase_llamacpp_ch2_title(), file: 'ggml-alloc.c' },
          ],
        },
        {
          name: m.mcp_showcase_llamacpp_mod2_name(),
          chapters: [
            { title: m.mcp_showcase_llamacpp_ch3_title(), file: 'ggml-cuda.cu' },
            { title: m.mcp_showcase_llamacpp_ch4_title(), file: 'ggml-metal.m' },
          ],
        },
        {
          name: m.mcp_showcase_llamacpp_mod3_name(),
          chapters: [
            { title: m.mcp_showcase_llamacpp_ch5_title(), file: 'llama-quant.cpp' },
            { title: m.mcp_showcase_llamacpp_ch6_title(), file: 'llama-sampling.cpp' },
          ],
        },
        {
          name: m.mcp_showcase_llamacpp_mod4_name(),
          chapters: [
            { title: m.mcp_showcase_llamacpp_ch7_title(), file: 'llama-kv-cache.cpp' },
            { title: m.mcp_showcase_llamacpp_ch8_title(), file: 'llama-speculative.cpp' },
          ],
        },
      ],
      detailPreview: {
        analogy: m.mcp_showcase_llamacpp_analogy(),
        stepTitle: m.mcp_showcase_llamacpp_step(),
        explanation: m.mcp_showcase_llamacpp_explanation(),
        codeLang: 'C / C++',
        codeLinesCount: 38,
        codeSnippet: [
          'struct ggml_tensor * ggml_new_tensor_2d(',
          '    struct ggml_context * ctx,',
          '    enum   ggml_type type,',
          '    int64_t ne0,',
          '    int64_t ne1) {',
          '    // 1. Dynamic memory alignment for SIMD and AVX-512 boundaries',
          '    size_t data_size = ggml_row_size(type, ne0) * ne1;',
          '    struct ggml_tensor * result = ggml_new_tensor_impl(ctx, type, 2, (int64_t[]){ ne0, ne1 });',
          '    result->data = ggml_aligned_malloc(data_size, GGML_MEM_ALIGN);',
          '',
          '    // 2. Initialize multidimensional stride offsets',
          '    result->nb[0] = ggml_type_size(type);',
          '    result->nb[1] = result->nb[0] * (ne0 / ggml_blck_size(type));',
          '',
          '    // 3. Register tensor node into computation graph DAG',
          '    result->op = GGML_OP_NONE;',
          '    result->grad = NULL;',
          '    return result;',
          '}',
        ],
        blocks: {
          code: {
            type: 'code',
            lang: 'C / C++',
            linesCount: 38,
            snippet: [
              'struct ggml_tensor * ggml_new_tensor_2d(',
              '    struct ggml_context * ctx,',
              '    enum   ggml_type type,',
              '    int64_t ne0,',
              '    int64_t ne1) {',
              '    // 1. Dynamic memory alignment for SIMD and AVX-512 boundaries',
              '    size_t data_size = ggml_row_size(type, ne0) * ne1;',
              '    struct ggml_tensor * result = ggml_new_tensor_impl(ctx, type, 2, (int64_t[]){ ne0, ne1 });',
              '    result->data = ggml_aligned_malloc(data_size, GGML_MEM_ALIGN);',
              '',
              '    // 2. Initialize multidimensional stride offsets',
              '    result->nb[0] = ggml_type_size(type);',
              '    result->nb[1] = result->nb[0] * (ne0 / ggml_blck_size(type));',
              '',
              '    // 3. Register tensor node into computation graph DAG',
              '    result->op = GGML_OP_NONE;',
              '    result->grad = NULL;',
              '    return result;',
              '}',
            ],
          },
          tip: {
            type: 'tip',
            variant: 'tip',
            title: m.mcp_showcase_llamacpp_tip_title(),
            content: m.mcp_showcase_llamacpp_tip_content(),
          },
          table: {
            type: 'table',
            title: m.mcp_showcase_llamacpp_table_title(),
            headers: [
              m.mcp_showcase_col_format(),
              m.mcp_showcase_col_vram(),
              m.mcp_showcase_col_speed(),
              m.mcp_showcase_col_loss(),
            ],
            rows: [
              ['FP16 Baseline', '14.2 GB', '18 tok/s', '0.00 Base'],
              ['Q8_0 High', '7.8 GB', '34 tok/s', '+0.004'],
              ['Q4_K_M (Rec)', '4.6 GB', '62 tok/s', '+0.048'],
              ['Q2_K Extreme', '2.9 GB', '78 tok/s', '+0.312'],
            ],
          },
          summary: {
            type: 'summary',
            title: m.mcp_showcase_llamacpp_tip_title(),
            items: [
              'Zero-dependency pure C matrix compute tensor graph',
              'Hardware AVX-512 & Apple Metal unified memory layout',
              'Dynamic k-quants mixed-precision weights compression',
            ],
          },
        },
      },
    },
    {
      id: 'vllm',
      repoUrl: 'https://github.com/vllm-project/vllm',
      repoName: 'vllm-project/vllm',
      stars: '38k',
      isWeb: false,
      tutorialTitle: m.mcp_showcase_vllm_title(),
      subtitle: m.mcp_showcase_vllm_subtitle(),
      modules: [
        {
          name: m.mcp_showcase_vllm_mod1_name(),
          chapters: [
            { title: m.mcp_showcase_vllm_ch1_title(), file: 'block_space_manager.py' },
            { title: m.mcp_showcase_vllm_ch2_title(), file: 'attention_kernels.cu' },
          ],
        },
        {
          name: m.mcp_showcase_vllm_mod2_name(),
          chapters: [
            { title: m.mcp_showcase_vllm_ch3_title(), file: 'scheduler.py' },
            { title: m.mcp_showcase_vllm_ch4_title(), file: 'tensor_parallel.py' },
          ],
        },
        {
          name: m.mcp_showcase_vllm_mod3_name(),
          chapters: [
            { title: m.mcp_showcase_vllm_ch5_title(), file: 'llm_engine.py' },
            { title: m.mcp_showcase_vllm_ch6_title(), file: 'chunked_prefill.py' },
          ],
        },
        {
          name: m.mcp_showcase_vllm_mod4_name(),
          chapters: [
            { title: m.mcp_showcase_vllm_ch7_title(), file: 'speculative_worker.py' },
            { title: m.mcp_showcase_vllm_ch8_title(), file: 'ray_worker.py' },
          ],
        },
      ],
      detailPreview: {
        analogy: m.mcp_showcase_vllm_analogy(),
        stepTitle: m.mcp_showcase_vllm_step(),
        explanation: m.mcp_showcase_vllm_explanation(),
        codeLang: 'PYTHON',
        codeLinesCount: 42,
        codeSnippet: [
          'def allocate(self, seq_group: SequenceGroup) -> None:',
          '    # 1. Map request logical tokens into non-contiguous physical blocks',
          '    logical_blocks = seq_group.get_num_logical_blocks()',
          '    physical_blocks = self.gpu_allocator.allocate(logical_blocks)',
          '',
          '    # 2. Initialize physical block table to eliminate KV cache fragmentation',
          '    for seq in seq_group.get_seqs():',
          '        self.block_tables[seq.seq_id] = [b.block_number for b in physical_blocks]',
          '        self.gpu_allocator.ref_counter.inc(physical_blocks)',
          '',
          '    # 3. Track memory watermark and prefix caching metadata',
          '    seq_group.init_multi_modal_factor()',
          '    self.watermark_tracker.record_allocation(',
          '        seq_group.request_id,',
          '        num_blocks=len(physical_blocks)',
          '    )',
        ],
        blocks: {
          code: {
            type: 'code',
            lang: 'PYTHON',
            linesCount: 42,
            snippet: [
              'def allocate(self, seq_group: SequenceGroup) -> None:',
              '    # 1. Map request logical tokens into non-contiguous physical blocks',
              '    logical_blocks = seq_group.get_num_logical_blocks()',
              '    physical_blocks = self.gpu_allocator.allocate(logical_blocks)',
              '',
              '    # 2. Initialize physical block table to eliminate KV cache fragmentation',
              '    for seq in seq_group.get_seqs():',
              '        self.block_tables[seq.seq_id] = [b.block_number for b in physical_blocks]',
              '        self.gpu_allocator.ref_counter.inc(physical_blocks)',
              '',
              '    # 3. Track memory watermark and prefix caching metadata',
              '    seq_group.init_multi_modal_factor()',
              '    self.watermark_tracker.record_allocation(',
              '        seq_group.request_id,',
              '        num_blocks=len(physical_blocks)',
              '    )',
            ],
          },
          table: {
            type: 'table',
            title: m.mcp_showcase_vllm_table_title(),
            headers: [
              m.mcp_showcase_col_metric(),
              m.mcp_showcase_col_static(),
              m.mcp_showcase_col_paged(),
            ],
            rows: [
              ['VRAM Efficiency', '20% ~ 40%', '96%+ (On-demand)'],
              ['Fragmentation', 'Severe External', '0% (Non-contiguous)'],
              ['Batching', 'Static Max-Padding', 'Dynamic Mixed-Length'],
              ['Throughput', '1.0x Baseline', '2.8x ~ 4.2x Boost'],
            ],
          },
          summary: {
            type: 'summary',
            title: m.mcp_showcase_vllm_sum_title(),
            items: [
              'BlockSpaceManager eliminates GPU memory external fragmentation',
              'Copy-on-Write (CoW) enables parallel sampling & beam search',
              'Continuous batching scheduler maximizes multi-GPU tensor parallelism',
            ],
          },
          tip: {
            type: 'tip',
            variant: 'info',
            title: m.mcp_showcase_vllm_tip_title(),
            content: m.mcp_showcase_vllm_tip_content(),
          },
        },
      },
    },
    {
      id: 'vgpu',
      repoUrl: 'https://github.com/vercel-labs/vgpu',
      repoName: 'vercel-labs/vgpu',
      stars: '3.2k',
      isWeb: false,
      tutorialTitle: m.mcp_showcase_vgpu_title(),
      subtitle: m.mcp_showcase_vgpu_subtitle(),
      modules: [
        {
          name: m.mcp_showcase_vgpu_mod1_name(),
          chapters: [
            { title: m.mcp_showcase_vgpu_ch1_title(), file: 'src/driver/webgpu.ts' },
            { title: m.mcp_showcase_vgpu_ch2_title(), file: 'src/core/capture.ts' },
          ],
        },
        {
          name: m.mcp_showcase_vgpu_mod2_name(),
          chapters: [
            { title: m.mcp_showcase_vgpu_ch3_title(), file: 'src/engine/shader-runner.ts' },
            { title: m.mcp_showcase_vgpu_ch4_title(), file: 'src/pipeline/framebuffer.ts' },
          ],
        },
        {
          name: m.mcp_showcase_vgpu_mod3_name(),
          chapters: [
            { title: m.mcp_showcase_vgpu_ch5_title(), file: 'src/runtime/edge.ts' },
            { title: m.mcp_showcase_vgpu_ch6_title(), file: 'src/security/quota-manager.ts' },
          ],
        },
        {
          name: m.mcp_showcase_vgpu_mod4_name(),
          chapters: [
            { title: m.mcp_showcase_vgpu_ch7_title(), file: 'src/streaming/webrtc.ts' },
            { title: m.mcp_showcase_vgpu_ch8_title(), file: 'src/wasm/compiler.ts' },
          ],
        },
      ],
      detailPreview: {
        analogy: m.mcp_showcase_vgpu_analogy(),
        stepTitle: m.mcp_showcase_vgpu_step(),
        explanation: m.mcp_showcase_vgpu_explanation(),
        codeLang: 'TYPESCRIPT',
        codeLinesCount: 31,
        codeSnippet: [
          'export async function createVirtualDevice(adapter: GPUAdapter): Promise<GPUDevice> {',
          '  // 1. Initialize sharded binary command queue with ring buffer',
          '  const channel = new CommandQueueChannel({ bufferSize: 1024 * 1024 });',
          '  const virtualQueue = new VirtualGPUQueue(channel);',
          '',
          '  // 2. Intercept and bind WebGPU pipeline descriptors',
          '  return {',
          '    queue: virtualQueue,',
          '    createShaderModule: (desc) => channel.compileWGSL(desc.code),',
          '    createRenderPipeline: (desc) => channel.bindPipeline(desc),',
          '    createBuffer: (desc) => channel.allocateSharedBuffer(desc),',
          '    createTexture: (desc) => channel.bindTexture(desc),',
          '    destroy: () => channel.teardown(),',
          '  } as unknown as GPUDevice;',
          '}',
        ],
        blocks: {
          code: {
            type: 'code',
            lang: 'TYPESCRIPT',
            linesCount: 31,
            snippet: [
              'export async function createVirtualDevice(adapter: GPUAdapter): Promise<GPUDevice> {',
              '  // 1. Initialize sharded binary command queue with ring buffer',
              '  const channel = new CommandQueueChannel({ bufferSize: 1024 * 1024 });',
              '  const virtualQueue = new VirtualGPUQueue(channel);',
              '',
              '  // 2. Intercept and bind WebGPU pipeline descriptors',
              '  return {',
              '    queue: virtualQueue,',
              '    createShaderModule: (desc) => channel.compileWGSL(desc.code),',
              '    createRenderPipeline: (desc) => channel.bindPipeline(desc),',
              '    createBuffer: (desc) => channel.allocateSharedBuffer(desc),',
              '    createTexture: (desc) => channel.bindTexture(desc),',
              '    destroy: () => channel.teardown(),',
              '  } as unknown as GPUDevice;',
              '}',
            ],
          },
          table: {
            type: 'table',
            title: m.mcp_showcase_vgpu_table_title(),
            headers: [
              m.mcp_showcase_col_opcode(),
              m.mcp_showcase_col_payload(),
              'Target',
              m.mcp_showcase_col_channel(),
            ],
            rows: [
              ['0x01 BIND_PIPELINE', '32 Bytes', 'Pipeline State', 'Ring Buffer'],
              ['0x02 DISPATCH_WORK', '16 Bytes', 'Shader Compute', 'Edge Stream'],
              ['0x03 SWAP_BUFFER', '24 Bytes', 'Framebuffer', 'WebRTC Sync'],
            ],
          },
          tip: {
            type: 'tip',
            variant: 'warning',
            title: m.mcp_showcase_vgpu_tip_title(),
            content: m.mcp_showcase_vgpu_tip_content(),
          },
          summary: {
            type: 'summary',
            title: m.mcp_showcase_vgpu_sum_title(),
            items: [
              'Hardware-independent virtual GPU device abstraction',
              'High-throughput zero-copy binary command serialization',
              'Serverless sharded rendering with pay-per-second GPU quotas',
            ],
          },
        },
      },
    },
    {
      id: 'gpui-component',
      repoUrl: 'https://longbridge.github.io/gpui-component/',
      repoName: 'longbridge/gpui-component',
      stars: 'Doc',
      isWeb: true,
      tutorialTitle: m.mcp_showcase_gpui_title(),
      subtitle: m.mcp_showcase_gpui_subtitle(),
      modules: [
        {
          name: m.mcp_showcase_gpui_mod1_name(),
          chapters: [
            { title: m.mcp_showcase_gpui_ch1_title(), file: 'docs/guide/element-tree.md' },
            { title: m.mcp_showcase_gpui_ch2_title(), file: 'docs/guide/gpu-drawing.md' },
          ],
        },
        {
          name: m.mcp_showcase_gpui_mod2_name(),
          chapters: [
            { title: m.mcp_showcase_gpui_ch3_title(), file: 'docs/components/form-controls.md' },
            { title: m.mcp_showcase_gpui_ch4_title(), file: 'docs/components/virtual-list.md' },
          ],
        },
        {
          name: m.mcp_showcase_gpui_mod3_name(),
          chapters: [
            { title: m.mcp_showcase_gpui_ch5_title(), file: 'docs/theming/palette.md' },
            { title: m.mcp_showcase_gpui_ch6_title(), file: 'docs/text/shaper.md' },
          ],
        },
        {
          name: m.mcp_showcase_gpui_mod4_name(),
          chapters: [
            { title: m.mcp_showcase_gpui_ch7_title(), file: 'docs/async/task-spawner.md' },
            { title: m.mcp_showcase_gpui_ch8_title(), file: 'docs/platform/backend.md' },
          ],
        },
      ],
      detailPreview: {
        analogy: m.mcp_showcase_gpui_analogy(),
        stepTitle: m.mcp_showcase_gpui_step(),
        explanation: m.mcp_showcase_gpui_explanation(),
        codeLang: 'RUST',
        codeLinesCount: 36,
        codeSnippet: [
          'impl Render for MainView {',
          '    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {',
          '        // 1. Declare immutable layout constraint tree',
          '        div()',
          '            .flex()',
          '            .flex_col()',
          '            .size_full()',
          '            .bg(rgb(0x18181b))',
          '            // 2. Batch-render virtual list without DOM overhead',
          '            .child(',
          '                VirtualList::new()',
          '                    .items(self.items.clone())',
          '                    .item_height(px(32.0))',
          '            )',
          '            // 3. Inject reactive theme token bindings',
          '            .child(ThemeTokens::new().mode(cx.theme_mode()))',
          '    }',
          '}',
        ],
        blocks: {
          code: {
            type: 'code',
            lang: 'RUST',
            linesCount: 36,
            snippet: [
              'impl Render for MainView {',
              '    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {',
              '        // 1. Declare immutable layout constraint tree',
              '        div()',
              '            .flex()',
              '            .flex_col()',
              '            .size_full()',
              '            .bg(rgb(0x18181b))',
              '            // 2. Batch-render virtual list without DOM overhead',
              '            .child(',
              '                VirtualList::new()',
              '                    .items(self.items.clone())',
              '                    .item_height(px(32.0))',
              '            )',
              '            // 3. Inject reactive theme token bindings',
              '            .child(ThemeTokens::new().mode(cx.theme_mode()))',
              '    }',
              '}',
            ],
          },
          summary: {
            type: 'summary',
            title: m.mcp_showcase_gpui_sum_title(),
            items: [
              'Immutable Constraint Tree: Microsecond layout without DOM reflow',
              'GPU Batching Pipeline: Merge disjoint layers with minimal Draw Calls',
              'Async Channels: Multi-threaded background tasks never block main frame',
              'Native Cross-Platform: Direct Metal, Vulkan, and DirectX 12 drivers',
            ],
          },
          table: {
            type: 'table',
            title: m.mcp_showcase_gpui_table_title(),
            headers: [
              m.mcp_showcase_col_metric(),
              m.mcp_showcase_col_electron(),
              m.mcp_showcase_col_gpui(),
            ],
            rows: [
              ['Frame Rate', '60 FPS (Stutters)', '120 FPS (V-Sync)'],
              ['Idle Memory', '180MB ~ 300MB', '25MB ~ 40MB'],
              ['Cold Start', '1.5s ~ 2.8s', '0.08s Instant'],
            ],
          },
          tip: {
            type: 'tip',
            variant: 'tip',
            title: m.mcp_showcase_gpui_tip_title(),
            content: m.mcp_showcase_gpui_tip_content(),
          },
        },
      },
    },
  ];
}
