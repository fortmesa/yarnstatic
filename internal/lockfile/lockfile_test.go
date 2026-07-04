package lockfile

import (
	"sort"
	"strings"
	"testing"
)

func TestParseFile(t *testing.T) {
	result, err := ParseFile("testdata/sample.lock")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	wantEntries := map[string]Entry{
		"@babel/core@npm:7.20.0":               {Scope: "babel", Name: "core", Version: "7.20.0"},
		"lodash@npm:4.17.21":                   {Scope: "", Name: "lodash", Version: "4.17.21"},
		"semver@npm:^7.3.5, semver@npm:^7.5.4": {Scope: "", Name: "semver", Version: "7.5.4"},
	}
	if len(result.Entries) != len(wantEntries) {
		t.Fatalf("got %d entries, want %d: %+v", len(result.Entries), len(wantEntries), result.Entries)
	}
	for _, e := range result.Entries {
		want, ok := wantEntries[e.Descriptor]
		if !ok {
			t.Fatalf("unexpected entry descriptor %q", e.Descriptor)
		}
		if e.Scope != want.Scope || e.Name != want.Name || e.Version != want.Version {
			t.Fatalf("entry %q: got %+v, want scope/name/version %+v", e.Descriptor, e, want)
		}
		if e.Checksum == "" {
			t.Fatalf("entry %q: expected non-empty checksum", e.Descriptor)
		}
	}

	counts := result.SkippedCounts()
	wantCounts := map[Protocol]int{
		"workspace": 1,
		"portal":    1,
		"link":      1,
		"patch":     1,
	}
	if len(counts) != len(wantCounts) {
		t.Fatalf("got skip counts %+v, want %+v", counts, wantCounts)
	}
	for proto, want := range wantCounts {
		if counts[proto] != want {
			t.Fatalf("protocol %q: got %d skipped, want %d (all counts: %+v)", proto, counts[proto], want, counts)
		}
	}

	// The patch entry must be skipped for its protocol even though it has a
	// checksum - protocol skip takes priority over checksum presence.
	var patchSkip *Skipped
	for i := range result.Skipped {
		if result.Skipped[i].Protocol == "patch" {
			patchSkip = &result.Skipped[i]
		}
	}
	if patchSkip == nil {
		t.Fatal("expected a patch: entry to be present and skipped")
	}
	if patchSkip.Reason != SkipProtocol {
		t.Fatalf("patch entry skip reason = %q, want %q", patchSkip.Reason, SkipProtocol)
	}
	if !strings.HasPrefix(patchSkip.Descriptor, "@babel/core@patch:") {
		t.Fatalf("patch entry descriptor = %q, want prefix @babel/core@patch:", patchSkip.Descriptor)
	}
}

func TestParseMissingResolution(t *testing.T) {
	const doc = `
__metadata:
  version: 8

"broken@npm:1.0.0":
  version: 1.0.0
  checksum: 10c0/aaaa
  languageName: node
  linkType: hard
`
	_, err := Parse(strings.NewReader(doc))
	if err == nil {
		t.Fatal("expected an error for an entry missing its resolution field")
	}
}

func TestSkippedCountsSorted(t *testing.T) {
	result, err := ParseFile("testdata/sample.lock")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	protos := make([]string, 0, len(result.Skipped))
	for _, s := range result.Skipped {
		protos = append(protos, string(s.Protocol))
	}
	sort.Strings(protos)
	if len(protos) != 4 {
		t.Fatalf("got %d skipped entries, want 4: %v", len(protos), protos)
	}
}
