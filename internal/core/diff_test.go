package core

import (
	"strings"
	"testing"
)

func TestApplyEdits(t *testing.T) {
	old := "line1\nonClick={() => onDelete(index)}\nline3\n"
	got, err := applyEdits(old, []editPair{{OldText: "onDelete(index)", NewText: "onDelete(todo.id)"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "onDelete(todo.id)") || strings.Contains(got, "onDelete(index)") {
		t.Fatalf("unexpected result: %q", got)
	}

	// Creation: empty oldText replaces wholesale.
	got, err = applyEdits("", []editPair{{OldText: "", NewText: "# new file\n"}})
	if err != nil || got != "# new file\n" {
		t.Fatalf("create case: %q err=%v", got, err)
	}

	// Missing anchor errors.
	if _, err := applyEdits("abc", []editPair{{OldText: "zzz", NewText: "q"}}); err == nil {
		t.Fatal("expected error for missing oldText")
	}
}

func TestBuildUnifiedDiff(t *testing.T) {
	old := "a\nb\nc\nd\ne\nf\ng\nh\n"
	new := "a\nb\nc\nX\ne\nf\ng\nh\n"
	diff := buildUnifiedDiff("foo.tsx", old, new)

	for _, want := range []string{"--- a/foo.tsx", "+++ b/foo.tsx", "@@", "-d", "+X"} {
		if !strings.Contains(diff, want) {
			t.Errorf("diff missing %q:\n%s", want, diff)
		}
	}
	// Long unchanged runs collapse to an elision marker.
	if !strings.Contains(diff, "…") {
		t.Errorf("expected elision of unchanged context:\n%s", diff)
	}
}
