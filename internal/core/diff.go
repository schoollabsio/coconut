package core

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/sergi/go-diff/diffmatchpatch"
)

// editPair is one propose_edit replacement. A non-empty Hash selects a hashline
// anchor (see hashline.go); otherwise OldText uses legacy exact matching.
type editPair struct {
	Hash    string  `json:"hash"`
	EndHash string  `json:"endHash"`
	Insert  string  `json:"insert"`
	OldText *string `json:"oldText"`
	NewText string  `json:"newText"`
}

// applyEdits applies replacements sequentially, mirroring the extension's
// semantics so the diff rendered from the result is the content the extension
// writes. A hash edit targets the line(s) whose digest matches; a legacy edit
// replaces the first occurrence of oldText. A sole legacy empty oldText creates
// or overwrites the complete file.
func applyEdits(oldContent string, edits []editPair) (string, error) {
	content := oldContent
	for i, e := range edits {
		if e.Hash != "" {
			next, err := applyHashlineEdit(content, hashlineEdit{
				Hash:    e.Hash,
				EndHash: e.EndHash,
				Insert:  e.Insert,
				NewText: e.NewText,
			}, i+1)
			if err != nil {
				return "", err
			}
			content = next
			continue
		}

		if e.OldText == nil {
			return "", fmt.Errorf("edit %d: legacy edits must provide oldText", i+1)
		}
		if *e.OldText == "" {
			content = e.NewText
			continue
		}
		idx := strings.Index(content, *e.OldText)
		if idx < 0 {
			return "", fmt.Errorf("edit %d: oldText not found in file", i+1)
		}
		content = content[:idx] + e.NewText + content[idx+len(*e.OldText):]
	}
	return content, nil
}

// buildUnifiedDiff renders old→new as a compact unified-ish diff:
// file headers, a single @@ hunk line, context lines trimmed to 3
// around each change with "…" elisions. The frontend renders lines by
// prefix, matching the mockup's DIFF_CLASSES ('f', '@', '+', '-', ' ').
func buildUnifiedDiff(path, oldContent, newContent string) string {
	var b strings.Builder
	name := filepath.Base(path)
	fmt.Fprintf(&b, "--- a/%s\n", name)
	fmt.Fprintf(&b, "+++ b/%s\n", name)

	dmp := diffmatchpatch.New()
	oldChars, newChars, lines := dmp.DiffLinesToChars(oldContent, newContent)
	diffs := dmp.DiffCharsToLines(dmp.DiffMain(oldChars, newChars, false), lines)

	// Build the full prefixed line list, then collapse long equal runs.
	type row struct {
		prefix byte // ' ', '-', '+'
		text   string
	}
	var rows []row
	for _, d := range diffs {
		for _, l := range splitLinesKeepEnds(d.Text) {
			switch d.Type {
			case diffmatchpatch.DiffEqual:
				rows = append(rows, row{' ', l})
			case diffmatchpatch.DiffDelete:
				rows = append(rows, row{'-', l})
			case diffmatchpatch.DiffInsert:
				rows = append(rows, row{'+', l})
			}
		}
	}

	// Context collapsing: keep changed lines plus 3 lines of context.
	const context = 3
	keep := make([]bool, len(rows))
	for i, r := range rows {
		if r.prefix == ' ' {
			continue
		}
		for j := i - context; j <= i+context && j < len(rows); j++ {
			if j >= 0 {
				keep[j] = true
			}
		}
	}

	b.WriteString("@@ proposed changes @@\n")
	elided := false
	for i, r := range rows {
		if !keep[i] {
			if !elided {
				b.WriteString("…\n")
				elided = true
			}
			continue
		}
		elided = false
		b.WriteByte(r.prefix)
		b.WriteString(r.text)
		if !strings.HasSuffix(r.text, "\n") {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func splitLinesKeepEnds(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.SplitAfter(s, "\n")
	// SplitAfter leaves a trailing "" when s ends with \n.
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	for i, p := range parts {
		parts[i] = strings.TrimSuffix(p, "\n")
	}
	return parts
}
