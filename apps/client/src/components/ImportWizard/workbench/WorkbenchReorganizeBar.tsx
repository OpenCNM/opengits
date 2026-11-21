'use client';

import { useMemo, useState } from 'react';
import { Shuffle } from 'lucide-react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import {
  generateSavedCustomItemId,
  loadReorganizeCustom,
  removeReorganizeCustomItem,
  saveReorganizeCustomItem,
  type SavedCustomItem,
} from '@/lib/import-wizard/reorganize-custom-storage';
import { useImportWizardStore, wizardSetters } from '@/lib/stores/import-wizard-store';
import * as m from '@/paraglide/messages';
import type { ReorganizeCategoryId } from '@/lib/constants';
import { ReorganizeCustomComposer } from './ReorganizeCustomComposer';
import type { WorkbenchOutlineCategory } from './editor/OutlineCategoryBlock';
import {
  buildChapterSubOptions,
  getReorganizeCategories,
  getReorganizeMotives,
  type ReorganizeCategory,
  type ReorganizeOptions,
} from './workbench-reorganize-config';

interface WorkbenchReorganizeBarProps {
  onReorganize?: (options: ReorganizeOptions) => void;
  disabled?: boolean;
}

/** 三分类空载基线（Record 键控约束分类全量，常量增删时 tsc 立即报错，与存储模块同构） */
const EMPTY_SAVED_ITEMS: Record<ReorganizeCategoryId, SavedCustomItem[]> = {
  clarify: [],
  compact: [],
  expand: [],
};

/** Popover 内子选项行（预设 / 已保存 / 章节锚定）共用的容器样式 */
const OPTION_ROW_CLASS =
  'flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-theme-surface cursor-pointer';

/**
 * 底部决策栏内嵌的「换个思路」编排组（1 + 3 + 1 结构）：
 * 1 个主导重摇按钮（换个思路）+ 3 个分类方向按钮（理清结构 / 精简章节 / 展开细节，
 * 各自弹出向上气泡框：预设子选项 + 按仓库持久化的已保存自定义项 + 展开类专属的
 * 动态章节锚定，底部内联自定义编排器）+ 1 个全局自定义气泡框（仅内联编排器，不带分类）。
 * 选中态纯粹由 store 的 customPrompt 与各选项 payload 的等值比对派生，零本地激活缓存。
 */
export function WorkbenchReorganizeBar({
  onReorganize,
  disabled = false,
}: WorkbenchReorganizeBarProps) {
  const storePrompt = useImportWizardStore((s) => s.customPrompt);
  const customOutline = useImportWizardStore((s) => s.customOutline);
  const scoutData = useImportWizardStore((s) => s.scoutData);

  const motives = useMemo(() => getReorganizeMotives(), []);
  const categories = useMemo(() => getReorganizeCategories(), []);
  const chapterOptions = useMemo(
    () => buildChapterSubOptions(customOutline as WorkbenchOutlineCategory[]),
    [customOutline],
  );

  const primaryMotive = motives[0];

  /** 当前打开的分类气泡框（三分类互斥单开）；null 即全部收起 */
  const [openCategoryId, setOpenCategoryId] = useState<ReorganizeCategoryId | null>(null);
  /** 当前展开内联编排器的分类（随气泡框收起一并复位，下次展开回到「+ 自定义」入口） */
  const [composerCategory, setComposerCategory] = useState<ReorganizeCategoryId | null>(null);
  const [customPopoverOpen, setCustomPopoverOpen] = useState(false);
  /** 按分类的已保存自定义子项（每次展开气泡框即重读 localStorage，读写廉价永保新鲜，零缓存层） */
  const [savedItems, setSavedItems] = useState<Record<ReorganizeCategoryId, SavedCustomItem[]>>(
    EMPTY_SAVED_ITEMS,
  );

  /** 分类内是否存在命中 storePrompt 的选项（预设 / 已保存 / 展开类的章节锚定） */
  const isCategoryActive = (category: ReorganizeCategory): boolean => {
    if (!storePrompt) return false;
    return (
      category.options.some((option) => option.payload.customPrompt === storePrompt) ||
      savedItems[category.id].some((saved) => saved.prompt === storePrompt) ||
      (category.id === 'expand' &&
        chapterOptions.some((option) => option.payload.customPrompt === storePrompt))
    );
  };

  /** storePrompt 是否命中任一已知选项；未命中即视为全局自定义态（点亮右侧按钮圆点） */
  const isStorePromptMatched =
    !!storePrompt &&
    (primaryMotive.basePrompt === storePrompt || categories.some(isCategoryActive));
  const hasUnmatchedCustomPrompt = !!storePrompt && !isStorePromptMatched;

  /** 统一激活尾部：写入 store 后交由父组件触发重排（payload 即全量执行参数） */
  const activateOptions = (payload: ReorganizeOptions) => {
    if (disabled) return;
    wizardSetters.setCustomPrompt(payload.customPrompt);
    onReorganize?.(payload);
  };

  const triggerPrimaryMotive = () => {
    if (disabled) return;
    wizardSetters.setCustomPrompt(primaryMotive.basePrompt);
    onReorganize?.({
      customPrompt: primaryMotive.basePrompt,
      pacing: primaryMotive.pacing,
      learnerArchetype: primaryMotive.learnerArchetype,
    });
  };

  /** 分类气泡框开合：展开时重读已保存项，收起时复位内联编排器 */
  const handleCategoryOpenChange = (categoryId: ReorganizeCategoryId, open: boolean) => {
    setOpenCategoryId(open ? categoryId : null);
    if (open) {
      const owner = scoutData?.owner;
      const repo = scoutData?.repo;
      setSavedItems(owner && repo ? loadReorganizeCustom(owner, repo) : EMPTY_SAVED_ITEMS);
    } else {
      setComposerCategory(null);
    }
  };

  /** 删除一条已保存自定义项（阻止冒泡避免误触发所在行的激活），成功后同步本地投影 */
  const handleDeleteSaved = (categoryId: ReorganizeCategoryId, itemId: string) => {
    if (disabled) return;
    const owner = scoutData?.owner;
    const repo = scoutData?.repo;
    if (!owner || !repo) return;
    removeReorganizeCustomItem(owner, repo, categoryId, itemId);
    setSavedItems(loadReorganizeCustom(owner, repo));
  };

  /** 分类内联编排器提交：以默认档位激活并收起气泡框（trim / 扩写守门由编排器收口） */
  const handleCategoryComposerSubmit =
    (categoryId: ReorganizeCategoryId) =>
    (prompt: string) => {
      if (disabled) return;
      wizardSetters.setCustomPrompt(prompt);
      onReorganize?.({
        customPrompt: prompt,
        pacing: 'normal',
        learnerArchetype: 'architecture_overview',
      });
      setOpenCategoryId(null);
      setComposerCategory(null);
    };

  /**
   * 「保存并使用」：构造短标签子项按仓库落盘（owner/repo 缺失时静默跳过存储），
   * 再以默认档位激活并收起气泡框——先落库后激活，两条路径共用同一确定性收敛尾。
   */
  const handleCategoryComposerSaveAndUse =
    (categoryId: ReorganizeCategoryId) =>
    (label: string, prompt: string) => {
      if (disabled) return;
      const owner = scoutData?.owner;
      const repo = scoutData?.repo;
      if (owner && repo) {
        saveReorganizeCustomItem(owner, repo, categoryId, {
          id: generateSavedCustomItemId(),
          label,
          prompt,
          pacing: 'normal',
          learnerArchetype: 'architecture_overview',
          createdAt: Date.now(),
        });
        setSavedItems(loadReorganizeCustom(owner, repo));
      }
      wizardSetters.setCustomPrompt(prompt);
      onReorganize?.({
        customPrompt: prompt,
        pacing: 'normal',
        learnerArchetype: 'architecture_overview',
      });
      setOpenCategoryId(null);
      setComposerCategory(null);
    };

  /** 全局自定义编排器提交：同默认档位激活，收起全局气泡框 */
  const handleGlobalComposerSubmit = (prompt: string) => {
    if (disabled) return;
    wizardSetters.setCustomPrompt(prompt);
    onReorganize?.({
      customPrompt: prompt,
      pacing: 'normal',
      learnerArchetype: 'architecture_overview',
    });
    setCustomPopoverOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* 毛玻璃操作边界：任一气泡框打开时压暗并虚化页面（z-[200] 垫在弹窗 z-[250] 之下，
          点击遮罩即收起——与 Base UI 外点关闭语义幂等），沿用 dialog 遮罩的既有惯例 */}
      {(openCategoryId !== null || customPopoverOpen) && (
        <div
          aria-hidden="true"
          onClick={() => {
            setOpenCategoryId(null);
            setComposerCategory(null);
            setCustomPopoverOpen(false);
          }}
          className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm animate-in fade-in duration-150 cursor-pointer"
        />
      )}

      {/* 1 个主导重摇按钮：无边框 + 贴合语义的 Shuffle 图标 */}
      <button
        type="button"
        disabled={disabled}
        onClick={triggerPrimaryMotive}
        title={primaryMotive.sub}
        className={`px-2.5 py-1.5 text-xs font-serif font-medium rounded-lg transition-all flex items-center gap-1.5 cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 ${
          storePrompt === primaryMotive.basePrompt
            ? 'text-theme-primary bg-theme-primary/10'
            : 'text-theme-foreground/85 hover:text-theme-foreground hover:bg-theme-surface/70'
        }`}
      >
        <Shuffle size={13} className="shrink-0" />
        <span>{primaryMotive.label}</span>
      </button>

      <div className="h-3.5 w-px bg-theme-border/60 mx-0.5 hidden sm:block shrink-0" />

      {/* 3 个分类方向按钮：各自弹出子选项气泡框，任一子项命中即高亮 */}
      {categories.map((category) => {
        const isActive = isCategoryActive(category);
        const saved = savedItems[category.id];
        const chapters = category.id === 'expand' ? chapterOptions : [];
        const isComposerOpen = composerCategory === category.id;

        /** 激活子选项并收起气泡框（preset / chapter 走 payload，saved 由行内投影） */
        const activateSubOption = (payload: ReorganizeOptions) => {
          activateOptions(payload);
          setOpenCategoryId(null);
        };

        return (
          <Popover
            key={category.id}
            open={openCategoryId === category.id}
            onOpenChange={(open) => handleCategoryOpenChange(category.id, open)}
          >
            <PopoverTrigger
              disabled={disabled}
              title={category.sub}
              className={`px-2.5 py-1.5 text-xs font-sans rounded-lg border transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 ${
                isActive
                  ? 'border-theme-primary/60 bg-theme-primary/15 text-theme-primary font-medium shadow-2xs'
                  : openCategoryId === category.id
                    ? 'border-theme-border bg-theme-surface text-theme-foreground'
                    : 'border-theme-border/50 bg-transparent text-theme-muted hover:text-theme-foreground hover:border-theme-border hover:bg-theme-surface/60'
              }`}
            >
              {category.label}
            </PopoverTrigger>
            <PopoverPopup
              side="top"
              align="center"
              sideOffset={8}
              className="w-72 p-2 bg-theme-bg border border-theme-border rounded-xl shadow-lg"
            >
              <div className="flex flex-col gap-1">
                {/* 预设子选项（直列引领，无小节标题） */}
                {category.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => activateSubOption(option.payload)}
                    className={OPTION_ROW_CLASS}
                  >
                    <span className="flex flex-col min-w-0">
                      <span className="text-xs text-theme-foreground truncate">
                        {option.label}
                      </span>
                      {option.hint && (
                        <span className="text-micro text-theme-muted truncate">{option.hint}</span>
                      )}
                    </span>
                  </button>
                ))}

                {/* 已保存：仅在该分类存在持久化子项时出现，行尾 × 即删 */}
                {saved.length > 0 && (
                  <>
                    <p className="text-micro text-theme-muted/80 px-1">
                      {m.workbench_reorganize_opt_saved_section()}
                    </p>
                    {saved.map((item) => (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        title={item.prompt}
                        onClick={() =>
                          activateSubOption({
                            customPrompt: item.prompt,
                            pacing: item.pacing,
                            learnerArchetype: item.learnerArchetype,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            activateSubOption({
                              customPrompt: item.prompt,
                              pacing: item.pacing,
                              learnerArchetype: item.learnerArchetype,
                            });
                          }
                        }}
                        className={`${OPTION_ROW_CLASS} min-w-0`}
                      >
                        <span className="flex-1 min-w-0 text-xs text-theme-foreground truncate">
                          {item.label}
                        </span>
                        <button
                          type="button"
                          title={m.workbench_reorganize_delete_custom()}
                          aria-label={m.workbench_reorganize_delete_custom()}
                          disabled={disabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSaved(category.id, item.id);
                          }}
                          className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-micro text-theme-muted/70 hover:text-rose-500 hover:bg-theme-surface transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </>
                )}

                {/* 锚定章节：仅「展开细节」分类且当前大纲存在可用章节时出现 */}
                {chapters.length > 0 && (
                  <>
                    <p className="text-micro text-theme-muted/80 px-1">
                      {m.workbench_reorganize_opt_chapter_section()}
                    </p>
                    <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
                      {chapters.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          disabled={disabled}
                          title={option.payload.customPrompt}
                          onClick={() => activateSubOption(option.payload)}
                          className={OPTION_ROW_CLASS}
                        >
                          <span className="flex-1 min-w-0 text-xs text-theme-foreground truncate">
                            {option.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* 底部内联自定义编排器（展开时隐藏「+ 自定义」入口） */}
                {isComposerOpen ? (
                  <ReorganizeCustomComposer
                    categoryIntent={category.id}
                    autoFocus
                    onSaveAndUse={handleCategoryComposerSaveAndUse(category.id)}
                    onSubmit={handleCategoryComposerSubmit(category.id)}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setComposerCategory(category.id)}
                    className="w-full text-xs text-theme-muted hover:text-theme-foreground border border-dashed border-theme-border/60 rounded-lg py-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {m.workbench_reorganize_add_custom()}
                  </button>
                )}
              </div>
            </PopoverPopup>
          </Popover>
        );
      })}

      {/* 全局自定义按钮：storePrompt 未命中任何已知选项时点亮圆点 */}
      <Popover open={customPopoverOpen} onOpenChange={setCustomPopoverOpen}>
        <PopoverTrigger
          disabled={disabled}
          className={`px-2.5 py-1.5 text-xs font-sans rounded-lg border transition-all cursor-pointer active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5 ${
            hasUnmatchedCustomPrompt
              ? 'border-theme-primary/60 bg-theme-primary/15 text-theme-primary font-medium shadow-2xs'
              : customPopoverOpen
                ? 'border-theme-border bg-theme-surface text-theme-foreground'
                : 'border-theme-border/50 bg-transparent text-theme-muted hover:text-theme-foreground hover:border-theme-border hover:bg-theme-surface/60'
          }`}
        >
          <span>{m.workbench_reorganize_custom_btn()}</span>
          {hasUnmatchedCustomPrompt && (
            <span className="w-1.5 h-1.5 rounded-full bg-theme-primary shrink-0" />
          )}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          sideOffset={8}
          className="w-88 sm:w-[28rem] p-3 bg-theme-bg border border-theme-border rounded-xl shadow-lg"
        >
          <ReorganizeCustomComposer autoFocus onSubmit={handleGlobalComposerSubmit} />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
