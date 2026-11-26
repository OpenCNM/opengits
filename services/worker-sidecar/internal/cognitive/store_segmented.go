// Segmented v3 layout: [magic "OGSGV3\n"][headerLen uint32][header JSON][segments...]; offsets are relative to data region and artifact.Version stays 2.
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

type artifactContainerV3 struct {
	Version  int                     `json:"version"`
	GitSha   string                  `json:"gitSha"`
	Segments map[string]segmentRange `json:"segments"`
	Symbols  map[string]segmentRange `json:"symbols,omitempty"`
	DataVer  int                     `json:"dataVer"`
}

type segmentRange struct {
	Offset uint64 `json:"off"`
	Length uint64 `json:"len"`
}

var segmentNames = []string{"meta", "nodes", "symbolsIdx", "symbolsData", "edges", "softEdges", "callEdges", "golden"}

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

func isSegmentedV3(data []byte) bool {
	return len(data) >= len(segmentedMagic) && string(data[:len(segmentedMagic)]) == segmentedMagic
}

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

type LazyArtifact struct {
	file       string
	f          *os.File
	hdr        artifactContainerV3
	segBase    uint64
	dataSize   uint64
	nodesCache []SemanticGraphArtifactNode
}

// Rejects legacy v2 full-JSON artifacts that lack segment offset tables.
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

func (l *LazyArtifact) Close() error { return l.f.Close() }

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

func (l *LazyArtifact) CallEdges() ([]CallEdge, error) {
	r, ok := l.hdr.Segments["callEdges"]
	if !ok {
		return nil, fmt.Errorf("segment callEdges missing")
	}
	start := l.segBase + r.Offset
	if start+r.Length > l.dataSize {
		return nil, fmt.Errorf("segment callEdges out of range")
	}
	buf := make([]byte, r.Length)
	if _, err := l.f.ReadAt(buf, int64(start)); err != nil {
		return nil, err
	}
	var edges []CallEdge
	if err := json.Unmarshal(buf, &edges); err != nil {
		return nil, fmt.Errorf("malformed callEdges segment: %w", err)
	}
	return edges, nil
}

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

func (l *LazyArtifact) Files() []string {
	out := make([]string, 0, len(l.hdr.Symbols))
	for f := range l.hdr.Symbols {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}
