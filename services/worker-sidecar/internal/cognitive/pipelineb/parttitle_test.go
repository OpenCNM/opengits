package pipelineb

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/cognitive"
)

func TestStripPartOrdinalPrefix(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"中文维度序号带空格", "维度 1: 交付入口与门面契约", "交付入口与门面契约"},
		{"中文维度序号无空格", "维度3:领域状态", "领域状态"},
		{"英文维度序号", "Dimension 2: Domain", "Domain"},
		{"英文分卷序号", "Part 1: Routing", "Routing"},
		{"小写分卷序号全角冒号", "part2：偏好数据", "偏好数据"},
		{"模块序号短横线", "Module 3 - Engine", "Engine"},
		{"中文模块序号", "模块 1：核心系统", "核心系统"},
		{"分卷序号", "分卷 2：进阶", "进阶"},
		{"中文第N分卷", "第一分卷：核心系统", "核心系统"},
		{"中文第N卷带空格", "第 3 卷: 引擎", "引擎"},
		{"中文第N部分空格分隔", "第二部分 状态管理", "状态管理"},
		{"裸卷中文数字", "卷一：数据契约", "数据契约"},
		{"章级序号误入分卷", "第 1 章: 入口", "入口"},
		{"双层套壳", "Part 1: 维度 2: 引擎", "引擎"},
		{"纯序数空壳归零", "维度 1", ""},
		{"业务命名原样保留", "智能路由与门面调度", "智能路由与门面调度"},
		{"正文第三方库不可误剥", "第三方库集成", "第三方库集成"},
		{"正文卷积不可误剥", "卷积神经网络反向传播", "卷积神经网络反向传播"},
		{"正文模块化不可误剥", "模块化设计", "模块化设计"},
		{"空串", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, stripPartOrdinalPrefix(tt.in))
		})
	}
}

func TestPartCeiling(t *testing.T) {
	tests := []struct {
		chapters int
		want     int
	}{
		{1, 0}, {2, 2}, {3, 2}, {4, 2}, {5, 3}, {6, 3}, {8, 4}, {10, 5}, {14, 5},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%d_chapters", tt.chapters), func(t *testing.T) {
			assert.Equal(t, tt.want, partCeiling(tt.chapters))
		})
	}
}

func mkPartChapters(parts ...string) []cognitive.OutlineChapter {
	chapters := make([]cognitive.OutlineChapter, len(parts))
	for i, p := range parts {
		chapters[i] = cognitive.OutlineChapter{
			Name:      fmt.Sprintf("第 %d 章", i+1),
			PartTitle: p,
			Files:     []cognitive.ChapterFile{{Path: "main.go"}},
		}
	}
	return chapters
}

func TestCanonicalizeLLMPartTitles(t *testing.T) {
	tests := []struct {
		name     string
		parts    []string
		wantOK   bool
		wantPart []string
	}{
		{
			name:     "业务命名保留并按首现次序编号",
			parts:    []string{"智能路由与门面调度", "智能路由与门面调度", "偏好数据加载", "偏好数据加载"},
			wantOK:   true,
			wantPart: []string{"Part 1: 智能路由与门面调度", "Part 1: 智能路由与门面调度", "Part 2: 偏好数据加载", "Part 2: 偏好数据加载"},
		},
		{
			name:   "机械序数壳剥离后连续重编（维度1跳维度3断号根治）",
			parts:  []string{"维度 1: 交付入口与门面契约", "维度 1: 交付入口与门面契约", "维度 3: 核心执行引擎与管线", "维度 3: 核心执行引擎与管线"},
			wantOK: true,
			wantPart: []string{
				"Part 1: 交付入口与门面契约", "Part 1: 交付入口与门面契约",
				"Part 2: 核心执行引擎与管线", "Part 2: 核心执行引擎与管线",
			},
		},
		{
			name:     "孤儿章节前向继承",
			parts:    []string{"核心系统", "", ""},
			wantOK:   true,
			wantPart: []string{"Part 1: 核心系统", "Part 1: 核心系统", "Part 1: 核心系统"},
		},
		{
			name:     "前导空章批量回填（三明治断卷根治）",
			parts:    []string{"", "", "领域状态建模"},
			wantOK:   true,
			wantPart: []string{"Part 1: 领域状态建模", "Part 1: 领域状态建模", "Part 1: 领域状态建模"},
		},
		{
			name:   "首尾混合缺漏自愈",
			parts:  []string{"", "核心系统", "", "进阶实战", ""},
			wantOK: true,
			wantPart: []string{
				"Part 1: 核心系统", "Part 1: 核心系统", "Part 1: 核心系统",
				"Part 2: 进阶实战", "Part 2: 进阶实战",
			},
		},
		{
			name:     "单章大师课不设分卷",
			parts:    []string{"微内核原理"},
			wantOK:   true,
			wantPart: []string{""},
		},
		{
			name:   "碎片化护栏：逐章一卷收敛为高内聚分卷",
			parts:  []string{"P1", "P2", "P3", "P4", "P5", "P6"},
			wantOK: true,
			wantPart: []string{
				"Part 1: P1", "Part 2: P2",
				"Part 3: P3", "Part 3: P3", "Part 3: P3", "Part 3: P3",
			},
		},
		{
			name:   "双核课两卷不受护栏误并",
			parts:  []string{"微内核原理", "模型训练实战"},
			wantOK: true,
			wantPart: []string{
				"Part 1: 微内核原理", "Part 2: 模型训练实战",
			},
		},
		{
			name:     "纯序数空壳回落确定性保底",
			parts:    []string{"维度 1", "Part 2"},
			wantOK:   false,
			wantPart: []string{"", ""},
		},
		{
			name:     "双层套壳剥离后重编",
			parts:    []string{"Part 1: 维度 2: 引擎机制", "Part 1: 维度 2: 引擎机制"},
			wantOK:   true,
			wantPart: []string{"Part 1: 引擎机制", "Part 1: 引擎机制"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chapters := mkPartChapters(tt.parts...)
			got := canonicalizeLLMPartTitles(chapters)
			require.Equal(t, len(tt.wantPart), len(chapters))
			assert.Equal(t, tt.wantOK, got)
			gotParts := make([]string, len(chapters))
			for i, ch := range chapters {
				gotParts[i] = ch.PartTitle
			}
			assert.Equal(t, tt.wantPart, gotParts)
		})
	}
}
