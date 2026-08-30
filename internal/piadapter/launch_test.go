package piadapter

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveBinaryPackagedLayout(t *testing.T) {
	dir := t.TempDir()
	// Packaged layout: <MacOS>/custard (self) + <MacOS>/custard-pi (sidecar).
	self := filepath.Join(dir, "custard")
	sidecar := filepath.Join(dir, "custard-pi")
	for _, p := range []string{self, sidecar} {
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if got := ResolveBinary(self); got != sidecar {
		t.Fatalf("ResolveBinary = %q, want %q", got, sidecar)
	}
}

func TestResolveBinaryFallsBackToPATH(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "custard")
	if err := os.WriteFile(self, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveBinary(self); got != "pi" {
		t.Fatalf("ResolveBinary = %q, want PATH fallback %q", got, "pi")
	}
}
