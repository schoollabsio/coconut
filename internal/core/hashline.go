package core

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

// hashline.go — the Go half of the hashline contract.
//
// A hashline is a short digest of a line's own text (e.g. "a3kf"). The agent
// copies it out of read's hash column and hands it to propose_edit instead of a
// line number, so an edit keeps pointing at the line it was read from even when
// earlier edits in the same call shift line numbering.
//
// The Go side exists because the backend resolves the same anchors itself to
// render the diff the user approves: if the two halves disagreed, the approved
// diff would not be the bytes the extension writes. pi-extension/hashline.ts
// documents the full contract; testdata/hashline_golden.json pins it and is
// asserted by both `go test` and `bun test pi-extension/hashline.test.ts`.

// hashAlphabet is Crockford base32: 32 unambiguous characters (no i, l, o, u).
const hashAlphabet = "0123456789abcdefghjkmnpqrstvwxyz"

const (
	hashMinLength = 4
	hashMaxLength = 12
)

// maxListedHashlineMatches bounds how many ambiguous candidates an error names.
const maxListedHashlineMatches = 6

// normalizeHashlineLine strips one trailing CR so CRLF files hash like LF ones.
func normalizeHashlineLine(line string) string {
	return strings.TrimSuffix(line, "\r")
}

func hashlineWidth(length int) int {
	if length < hashMinLength {
		return hashMinLength
	}
	if length > hashMaxLength {
		return hashMaxLength
	}
	return length
}

// hashLine digests one line: SHA-256 of its UTF-8 bytes, five bits per output
// character taken from the low bits of consecutive digest bytes.
func hashLine(line string, length int) string {
	digest := sha256.Sum256([]byte(normalizeHashlineLine(line)))
	width := hashlineWidth(length)
	out := make([]byte, width)
	for i := 0; i < width; i++ {
		out[i] = hashAlphabet[digest[i]&31]
	}
	return string(out)
}

// hashlineDoc is a file as addressable lines plus what is needed to re-emit it
// byte-for-byte: per-line CRLF flags and whether the file ends with a newline.
type hashlineDoc struct {
	lines           []string
	crs             []bool
	trailingNewline bool
}

func splitHashlineDoc(content string) hashlineDoc {
	if content == "" {
		return hashlineDoc{}
	}
	parts := strings.Split(content, "\n")
	doc := hashlineDoc{}
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
		doc.trailingNewline = true
	}
	doc.lines = make([]string, 0, len(parts))
	doc.crs = make([]bool, 0, len(parts))
	for _, part := range parts {
		doc.crs = append(doc.crs, strings.HasSuffix(part, "\r"))
		doc.lines = append(doc.lines, normalizeHashlineLine(part))
	}
	return doc
}

func (d hashlineDoc) join() string {
	// No lines means an empty file — never re-synthesize a lone newline.
	if len(d.lines) == 0 {
		return ""
	}
	var b strings.Builder
	for i, line := range d.lines {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(line)
		if d.crs[i] {
			b.WriteString("\r")
		}
	}
	if d.trailingNewline {
		b.WriteString("\n")
	}
	return b.String()
}

// splice replaces deleteCount lines at index at with added, all ending cr.
func (d *hashlineDoc) splice(at, deleteCount int, added []string, cr bool) {
	lines := make([]string, 0, len(d.lines)-deleteCount+len(added))
	lines = append(lines, d.lines[:at]...)
	lines = append(lines, added...)
	lines = append(lines, d.lines[at+deleteCount:]...)
	d.lines = lines

	crs := make([]bool, 0, len(d.crs)-deleteCount+len(added))
	crs = append(crs, d.crs[:at]...)
	for range added {
		crs = append(crs, cr)
	}
	crs = append(crs, d.crs[at+deleteCount:]...)
	d.crs = crs
}

// normalizeHashArgument validates a hash argument: lowercase-insensitive,
// in-alphabet, and hashMinLength..hashMaxLength characters long.
func normalizeHashArgument(raw, field string, editNumber int) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "", fmt.Errorf("edit %d: %s is empty — copy a %d-character hash from read's hash column", editNumber, field, hashMinLength)
	}
	if len(value) < hashMinLength || len(value) > hashMaxLength {
		return "", fmt.Errorf("edit %d: %s %q must be %d-%d characters (a longer hash narrows an ambiguous match)", editNumber, field, value, hashMinLength, hashMaxLength)
	}
	for _, ch := range value {
		if !strings.ContainsRune(hashAlphabet, ch) {
			return "", fmt.Errorf("edit %d: %s %q contains characters outside the hash alphabet %q — copy the hash column from read output verbatim", editNumber, field, value, hashAlphabet)
		}
	}
	return value, nil
}

func findHashlineMatches(d hashlineDoc, hash string) []int {
	var found []int
	for i, line := range d.lines {
		if hashLine(line, len(hash)) == hash {
			found = append(found, i)
		}
	}
	return found
}

// resolveHashline maps a hash to exactly one line index. No match and an
// ambiguous match are both errors: a stale or duplicated hash must never
// silently edit the wrong line.
func resolveHashline(d hashlineDoc, rawHash, field string, editNumber int) (int, error) {
	hash, err := normalizeHashArgument(rawHash, field, editNumber)
	if err != nil {
		return 0, err
	}
	matches := findHashlineMatches(d, hash)
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return 0, fmt.Errorf("edit %d: no line matches %s %q. The file changed since you read it, or the hash was mistyped — re-read the file (read prints the hash column) and propose again", editNumber, field, hash)
	}
	listed := make([]string, 0, maxListedHashlineMatches)
	for i, idx := range matches {
		if i == maxListedHashlineMatches {
			break
		}
		listed = append(listed, fmt.Sprintf("line %d is %q", idx+1, hashLine(d.lines[idx], hashMaxLength)))
	}
	more := ""
	if len(matches) > maxListedHashlineMatches {
		more = fmt.Sprintf(" (+%d more)", len(matches)-maxListedHashlineMatches)
	}
	return 0, fmt.Errorf("edit %d: %s %q is ambiguous — it matches %d lines: %s%s. Re-issue with a longer hash (up to %d characters) that identifies one line",
		editNumber, field, hash, len(matches), strings.Join(listed, ", "), more, hashMaxLength)
}

// hashlineEdit is one hashline edit. NewText "" deletes the selected lines.
type hashlineEdit struct {
	Hash    string
	EndHash string
	Insert  string // "", "before" or "after"
	NewText string
}

// hashlineNewTextLines splits newText into lines; one trailing newline is a
// line terminator, not an extra empty line.
func hashlineNewTextLines(newText string) []string {
	return strings.Split(strings.TrimSuffix(newText, "\n"), "\n")
}

// applyHashlineEdit applies one hashline edit and returns the new content.
func applyHashlineEdit(content string, edit hashlineEdit, editNumber int) (string, error) {
	doc := splitHashlineDoc(content)
	if len(doc.lines) == 0 {
		return "", fmt.Errorf("edit %d: the file has no lines to anchor to — create or overwrite it with a single legacy edit ({ oldText: \"\", newText: <full file content> })", editNumber)
	}
	if edit.Insert != "" && edit.EndHash != "" {
		return "", fmt.Errorf("edit %d: \"insert\" anchors a single line, so it cannot be combined with endHash", editNumber)
	}
	if edit.Insert != "" && edit.NewText == "" {
		return "", fmt.Errorf("edit %d: insert with an empty newText inserts nothing", editNumber)
	}

	start, err := resolveHashline(doc, edit.Hash, "hash", editNumber)
	if err != nil {
		return "", err
	}
	end := start
	if edit.EndHash != "" {
		end, err = resolveHashline(doc, edit.EndHash, "endHash", editNumber)
		if err != nil {
			return "", err
		}
	}
	if end < start {
		return "", fmt.Errorf("edit %d: endHash %q resolves to line %d, before the anchor line %d — endHash must be at or after hash", editNumber, edit.EndHash, end+1, start+1)
	}

	// A replacement range inherits the ending of its LAST line; an insert
	// inherits the anchor's ending.
	cr := doc.crs[end]
	switch edit.Insert {
	case "before":
		doc.splice(start, 0, hashlineNewTextLines(edit.NewText), cr)
	case "after":
		doc.splice(end+1, 0, hashlineNewTextLines(edit.NewText), cr)
	default:
		if edit.NewText == "" {
			// Deletion drops the lines entirely, newline included, so it does
			// not leave a blank line behind.
			doc.splice(start, end-start+1, nil, cr)
			break
		}
		doc.splice(start, end-start+1, hashlineNewTextLines(edit.NewText), cr)
	}
	return doc.join(), nil
}
