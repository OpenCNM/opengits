// 语义图产物分段容器 v3（A1：产物与投影分离）。
//
// 动机：v2 是单文件全量 JSON——巨仓数十 MB，任何消费者（哪怕只查一个
// 文件的符号）都要全量反序列化。v3 容器按段布局，头部带偏移索引：
// 单文件符号查询只读所需段（ReadAt），全量消费读全部段。
//
// 布局（字节序 little-endian）：
//
//	[magic "OGSGV3\n" 7B][headerLen uint32][header JSON]
//	[seg meta][seg nodes][seg symbolsIdx][seg symbolsData][seg edges][seg softEdges][seg callEdges][seg golden]
//
// 头部 segments 偏移相对段区起点。symbolsData 为逐文件 JSON 数组顺序
// 拼接（文件字典序，确定性字节）；symbolsIdx 记录 file→{off,len}。
// 段内 JSON 与 v2 字段编码一致——逐字段等价由测试锁定。
// 内存结构不变（artifact.Version 恒为 2 的数据 schema）；容器版本独立
// 于数据 schema，Load 对 v2 全量 JSON 与 v3 容器双读兼容。
package cognitive

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

const segmentedMagic = "OGSGV3\n"

// artifactContainerV3 头部（段偏移相对段区起点）。
type artifactContainerV3 struct {
	Version  int                     `json:"version"` // 容器版本 3
	GitSha   string                  `json:"gitSha"`
	Segments map[string]segmentRange `json:"segments"`
	Symbols  map[string]segmentRange `json:"symbols,omitempty"` // file → symbolsData 内区间
	DataVer  int                     `json:"dataVer"`           // 数据 schema 版本（现值 2）
}

type segmentRange struct {
	Offset uint64 `json:"off"`
	Length uint64 `json:"len"`
}

// segmentNames 段写入顺序（确定性字节布局）。
var segmentNames = []string{"meta", "nodes", "symbolsIdx", "symbolsData", "edges", "softEdges", "callEdges", "golden"}

// metaArtifact 是除分段字段外的载体（与 SemanticGraphArtifact 字段同名同 tag）。
type metaArtifact struct {
	Version           int               `json:"version"`
	GeneratedAt       string            `json:"generatedAt"`
	GitSha            string            `json:"gitSha"`
	EntryPoints       []string          `json:"entryPoints"`
	BackboneNodes     []string          `json:"backboneNodes"`
	CoreContractNodes []string          `json:"coreContractNodes"`
	PipelineNodes     []string          `json:"pipelineNodes"`
	Meta              SemanticGraphMeta `json:"meta"`
}

// encodeSegmentedV3 将产物编码为 v3 容器字节。
func encodeSegmentedV3(a *SemanticGraphArtifact) ([]byte, error) {
	files := make([]string, 0, len(a.SymbolsByFile))
	for f := range a.SymbolsByFile {
		files = append(files, f)
	}
	sort.Strings(files)

	var symbolsData bytes.Buffer
	symbolsIdx := make(map[string]segmentRange, len(files))
	for _, f := range files {
		enc, err := json.Marshal(a.SymbolsByFile[f])
		if err != nil {
			return nil, fmt.Errorf("marshal symbols for %s: %w", f, err)
		}
		symbolsIdx[f] = segmentRange{Offset: uint64(symbolsData.Len()), Length: uint64(len(enc))}
		symbolsData.Write(enc)
	}

	segBytes := map[string][]byte{}
	// meta（Version 恒为数据 schema 值，与 v2 全量读出一致）
	if m, err := json.Marshal(metaArtifact{
		Version: 2, GeneratedAt: a.GeneratedAt, GitSha: a.GitSha,
		EntryPoints: a.EntryPoints, BackboneNodes: a.BackboneNodes,
		CoreContractNodes: a.CoreContractNodes, PipelineNodes: a.PipelineNodes,
		Meta: a.Meta,
	}); err == nil {
		segBytes["meta"] = m
	} else {
		return nil, err
	}
	encOr := func(name string, v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Errorf("marshal segment %s: %w", name, err)
		}
		segBytes[name] = b
		return nil
	}
	if err := encOr("nodes", a.Nodes); err != nil {
		return nil, err
	}
	if b, err := json.Marshal(symbolsIdx); err != nil {
		return nil, err
	} else {
		segBytes["symbolsIdx"] = b
	}
	segBytes["symbolsData"] = append([]byte(nil), symbolsData.Bytes()...)
	if err := encOr("edges", a.Edges); err != nil {
		return nil, err
	}
	if err := encOr("softEdges", a.SoftEdges); err != nil {
		return nil, err
	}
	if err := encOr("callEdges", a.CallEdges); err != nil {
		return nil, err
	}
	if err := encOr("golden", a.GoldenSymbols); err != nil {
		return nil, err
	}

	segments := make(map[string]segmentRange, len(segmentNames))
	var body bytes.Buffer
	for _, name := range segmentNames {
		b := segBytes[name]
		segments[name] = segmentRange{Offset: uint64(body.Len()), Length: uint64(len(b))}
		body.Write(b)
	}

	header, err := json.Marshal(artifactContainerV3{
		Version: 3, GitSha: a.GitSha, Segments: segments, Symbols: symbolsIdx, DataVer: 2,
	})
	if err != nil {
		return nil, err
	}

	var out bytes.Buffer
	out.WriteString(segmentedMagic)
	var hl [4]byte
	binary.LittleEndian.PutUint32(hl[:], uint32(len(header)))
	out.Write(hl[:])
	out.Write(header)
	out.Write(body.Bytes())
	return out.Bytes(), nil
}

// isSegmentedV3 判定字节是否 v3 容器。
func isSegmentedV3(data []byte) bool {
	return len(data) >= len(segmentedMagic) && string(data[:len(segmentedMagic)]) == segmentedMagic
}

// decodeSegmentedV3 全量解码 v3 容器为产物（内存结构与 v2 JSON 读出
// 逐字段一致——Version 恒 2）。
func decodeSegmentedV3(data []byte) (*SemanticGraphArtifact, error) {
	if !isSegmentedV3(data) {
		return nil, fmt.Errorf("not a segmented v3 artifact")
	}
	p := len(segmentedMagic)
	if len(data) < p+4 {
		return nil, fmt.Errorf("truncated segmented artifact header")
	}
	headerLen := int(binary.LittleEndian.Uint32(data[p : p+4]))
	p += 4
	if len(data) < p+headerLen {
		return nil, fmt.Errorf("truncated segmented artifact header")
	}
	var hdr artifactContainerV3
	if err := json.Unmarshal(data[p:p+headerLen], &hdr); err != nil {
		return nil, fmt.Errorf("malformed segmented artifact header: %w", err)
	}
	if hdr.Version != 3 {
		return nil, fmt.Errorf("unsupported segmented artifact version %d", hdr.Version)
	}
	segBase := uint64(p + headerLen)

	readSeg := func(name string) ([]byte, error) {
		r, ok := hdr.Segments[name]
		if !ok {
			return nil, fmt.Errorf("segment %s missing", name)
		}
		start := segBase + r.Offset
		if start+r.Length > uint64(len(data)) {
			return nil, fmt.Errorf("segment %s out of range", name)
		}
		return data[start : start+r.Length], nil
	}

	var meta metaArtifact
	if b, err := readSeg("meta"); err != nil {
		return nil, err
	} else if err := json.Unmarshal(b, &meta); err != nil {
		return nil, fmt.Errorf("malformed meta segment: %w", err)
	}
	a := &SemanticGraphArtifact{
		Version:           meta.Version,
		GeneratedAt:       meta.GeneratedAt,
		GitSha:            meta.GitSha,
		EntryPoints:       meta.EntryPoints,
		BackboneNodes:     meta.BackboneNodes,
		CoreContractNodes: meta.CoreContractNodes,
		PipelineNodes:     meta.PipelineNodes,
		Meta:              meta.Meta,
		SymbolsByFile:     make(map[string][]SymbolEntry, len(hdr.Symbols)),
	}
	if a.Version != 2 {
		return nil, fmt.Errorf("unsupported artifact data version %d", a.Version)
	}
	decodeArr := func(name string, dst any) error {
		b, err := readSeg(name)
		if err != nil {
			return err
		}
		return json.Unmarshal(b, dst)
	}
	if err := decodeArr("nodes", &a.Nodes); err != nil {
		return nil, fmt.Errorf("malformed nodes segment: %w", err)
	}
	symbolsData, err := readSeg("symbolsData")
	if err != nil {
		return nil, err
	}
	for f, r := range hdr.Symbols {
		if r.Offset+r.Length > uint64(len(symbolsData)) {
			return nil, fmt.Errorf("symbols range out of data for %s", f)
		}
		var entries []SymbolEntry
		if err := json.Unmarshal(symbolsData[r.Offset:r.Offset+r.Length], &entries); err != nil {
			return nil, fmt.Errorf("malformed symbols for %s: %w", f, err)
		}
		a.SymbolsByFile[f] = entries
	}
	if err := decodeArr("edges", &a.Edges); err != nil {
		return nil, fmt.Errorf("malformed edges segment: %w", err)
	}
	if err := decodeArr("softEdges", &a.SoftEdges); err != nil {
		return nil, fmt.Errorf("malformed softEdges segment: %w", err)
	}
	if err := decodeArr("callEdges", &a.CallEdges); err != nil {
		return nil, fmt.Errorf("malformed callEdges segment: %w", err)
	}
	if err := decodeArr("golden", &a.GoldenSymbols); err != nil {
		return nil, fmt.Errorf("malformed golden segment: %w", err)
	}
	return a, nil
}

// LazyArtifact v3 容器惰性句柄：头部已解析，符号按文件 ReadAt 按需解码。
type LazyArtifact struct {
	file       string
	f          *os.File
	hdr        artifactContainerV3
	segBase    uint64
	dataSize   uint64
	nodesCache []SemanticGraphArtifactNode
}

// OpenSemanticGraphArtifactLazy 打开 v3 容器惰性句柄（v2 全量文件返回
// 错误提示走 Load 语义——老产物无段索引）。
func OpenSemanticGraphArtifactLazy(storeDir, owner, repo, sha string) (*LazyArtifact, error) {
	file, err := SemanticGraphPathFor(storeDir, owner, repo, sha)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	var magic [len(segmentedMagic)]byte
	if _, err := f.ReadAt(magic[:], 0); err != nil {
		f.Close()
		return nil, err
	}
	if string(magic[:]) != segmentedMagic {
		f.Close()
		return nil, fmt.Errorf("legacy v2 artifact (no segmented header): %s", file)
	}
	var hl [4]byte
	if _, err := f.ReadAt(hl[:], int64(len(segmentedMagic))); err != nil {
		f.Close()
		return nil, err
	}
	headerLen := int(binary.LittleEndian.Uint32(hl[:]))
	header := make([]byte, headerLen)
	if _, err := f.ReadAt(header, int64(len(segmentedMagic)+4)); err != nil {
		f.Close()
		return nil, err
	}
	var hdr artifactContainerV3
	if err := json.Unmarshal(header, &hdr); err != nil {
		f.Close()
		return nil, err
	}
	if hdr.Version != 3 {
		f.Close()
		return nil, fmt.Errorf("unsupported segmented artifact version %d", hdr.Version)
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return &LazyArtifact{
		file:     file,
		f:        f,
		hdr:      hdr,
		segBase:  uint64(len(segmentedMagic) + 4 + headerLen),
		dataSize: uint64(st.Size()),
	}, nil
}

// Close 关闭底层文件句柄。
func (l *LazyArtifact) Close() error { return l.f.Close() }

// SymbolsForFile 按文件惰性解码符号（只读该文件的段区间；全量反序列化
// 由 v2 的 O(全仓) 降为 O(该文件)）。
func (l *LazyArtifact) SymbolsForFile(file string) ([]SymbolEntry, error) {
	r, ok := l.hdr.Symbols[file]
	if !ok {
		return nil, nil
	}
	buf := make([]byte, r.Length)
	if _, err := l.f.ReadAt(buf, int64(l.segBase+l.hdr.Segments["symbolsData"].Offset+r.Offset)); err != nil {
		return nil, err
	}
	var entries []SymbolEntry
	if err := json.Unmarshal(buf, &entries); err != nil {
		return nil, fmt.Errorf("malformed symbols for %s: %w", file, err)
	}
	return entries, nil
}

// Nodes 惰性读取 nodes 段（句柄内缓存一次；供 grounding 链的 path 集
// 与 node 元数据消费——O(nodes) 远小于全量反序列化 symbolsData）。
func (l *LazyArtifact) Nodes() ([]SemanticGraphArtifactNode, error) {
	if l.nodesCache != nil {
		return l.nodesCache, nil
	}
	r, ok := l.hdr.Segments["nodes"]
	if !ok {
		return nil, fmt.Errorf("segment nodes missing")
	}
	start := l.segBase + r.Offset
	if start+r.Length > l.dataSize {
		return nil, fmt.Errorf("segment nodes out of range")
	}
	buf := make([]byte, r.Length)
	if _, err := l.f.ReadAt(buf, int64(start)); err != nil {
		return nil, err
	}
	var nodes []SemanticGraphArtifactNode
	if err := json.Unmarshal(buf, &nodes); err != nil {
		return nil, fmt.Errorf("malformed nodes segment: %w", err)
	}
	l.nodesCache = nodes
	return nodes, nil
}

// Paths 全部节点 path 集（由 nodes 段派生；字典序与产物一致）。
func (l *LazyArtifact) Paths() ([]string, error) {
	nodes, err := l.Nodes()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.Path)
	}
	return out, nil
}

// Files 全部含符号文件的列表（字典序，确定性）。
func (l *LazyArtifact) Files() []string {
	out := make([]string, 0, len(l.hdr.Symbols))
	for f := range l.hdr.Symbols {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}
