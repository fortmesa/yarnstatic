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

func TestParseNoChecksumArchiveURLAndGit(t *testing.T) {
	const doc = `
__metadata:
  version: 8

"@esbuild/darwin-arm64@npm:0.25.12":
  version: 0.25.12
  resolution: "@esbuild/darwin-arm64@npm:0.25.12"
  conditions: os=darwin & cpu=arm64
  languageName: node
  linkType: hard

"foo@npm:1.0.0":
  version: 1.0.0
  resolution: "foo@npm:1.0.0::__archiveUrl=https%3A%2F%2Fmirror.example%2Fnpm%2Ffoo%2F-%2Ffoo-1.0.0.tgz"
  checksum: 10c0/aaaa
  languageName: node
  linkType: hard

"bar@npm:2.0.0":
  version: 2.0.0
  resolution: "bar@npm:2.0.0::__archiveUrl=https%3A%2F%2Fcdn.example%2Fbar.tgz"
  checksum: 10c0/bbbb
  languageName: node
  linkType: hard

"mylib@github:acme/mylib#v1.0.0":
  version: 1.0.0
  resolution: "mylib@https://github.com/acme/mylib.git#commit=0123456789abcdef0123456789abcdef01234567"
  checksum: 10c0/cccc
  languageName: node
  linkType: hard

"tarball@https://example.com/tarball-1.0.0.tgz":
  version: 1.0.0
  resolution: "tarball@https://example.com/tarball-1.0.0.tgz"
  checksum: 10c0/dddd
  languageName: node
  linkType: hard
`
	result, err := Parse(strings.NewReader(doc))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(result.NoChecksum) != 1 {
		t.Fatalf("got %d no-checksum entries, want 1: %+v", len(result.NoChecksum), result.NoChecksum)
	}
	nc := result.NoChecksum[0]
	if nc.Scope != "esbuild" || nc.Name != "darwin-arm64" || nc.Version != "0.25.12" || nc.Conditions != "os=darwin & cpu=arm64" {
		t.Fatalf("no-checksum entry = %+v", nc)
	}

	// foo's __archiveUrl is a tarball URL the plugins recognize, so it's
	// checked like any other entry, at the key that URL names.
	if len(result.Entries) != 1 {
		t.Fatalf("got %d entries, want 1: %+v", len(result.Entries), result.Entries)
	}
	foo := result.Entries[0]
	if foo.Name != "foo" || foo.Version != "1.0.0" || foo.ArchiveURL != "https://mirror.example/npm/foo/-/foo-1.0.0.tgz" {
		t.Fatalf("archive entry = %+v", foo)
	}

	var bar, mylib, tarball *Skipped
	for i := range result.Skipped {
		s := &result.Skipped[i]
		switch {
		case strings.HasPrefix(s.Descriptor, "bar@"):
			bar = s
		case strings.HasPrefix(s.Descriptor, "mylib@"):
			mylib = s
		case strings.HasPrefix(s.Descriptor, "tarball@"):
			tarball = s
		}
	}
	if bar == nil || bar.Reason != SkipArchiveURL || bar.Reference != "https://cdn.example/bar.tgz" {
		t.Fatalf("bar skip = %+v", bar)
	}
	if mylib == nil || mylib.Reason != SkipProtocol || !IsGitReference(mylib.Reference) {
		t.Fatalf("mylib skip = %+v (git reference: %v)", mylib, mylib != nil && IsGitReference(mylib.Reference))
	}
	if tarball == nil || IsGitReference(tarball.Reference) {
		t.Fatalf("tarball skip = %+v, want a non-git https: skip", tarball)
	}

	counts := result.SkippedCounts()
	if counts["https"] != 2 || counts["npm"] != 0 {
		t.Fatalf("skip counts = %+v, want 2 https: and no npm: (the __archiveUrl skip is reported separately)", counts)
	}
}

// TestIsGitReference's expectations are what Yarn's own isGitUrl
// (@yarnpkg/plugin-git 3.x gitUtils.js) returns for each input.
func TestIsGitReference(t *testing.T) {
	const c = "commit"
	cases := []struct {
		ref  string
		want bool
	}{
		{"ssh://git@github.com/u/r.git#" + c + "=x", true},
		{"git://example.com/r.git#" + c + "=x", true},
		{"git+ssh://git@example.com/u/r.git#" + c + "=x", true},
		{"git+file:///path/r.git", true},
		{"https://github.com/u/r.git#" + c + "=x", true},
		{"https://gitlab.example/u/r.git#" + c + "=x", true},
		{"http://host/u/r.git", true},
		{"git@github.com:u/r.git#" + c + "=x", true},
		{"github:u/r#v1", true},
		{"u/r", true},
		{"./x/y", false},
		{"../x", false},
		{"u/.", false},
		{"u/..", false},
		{"u/.#x", false},
		{"u/..#x", false},
		{"u/.git", true},
		{"./r", false},
		{"https://github.com/u/r/tarball/v1", true},
		{"https://github.com/../r/tarball/v1", false},
		{"https://github.com/u/./tarball/v1", true},
		{"https://example.com/pkg.tgz", false},
		{"npm:1.0.0", false},
		{"workspace:packages/a", false},
		{"file:../x", false},
		{"exec:./gen.js::locator=root%40workspace%3A.", false},
		{"patch:lodash@npm%3A4.17.21#~/.yarn/patches/x.patch::version=4.17.21", false},
		{"portal:../x::locator=r%40workspace%3A.", false},
		{"link:./vendor/x", false},
		{"github:../r", false},
		{"https://github.com/u/r", true},
		{"a.b/c-d_e#semver:^1.0.0", true},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsGitReference(tc.ref); got != tc.want {
			t.Errorf("IsGitReference(%q) = %v, want %v", tc.ref, got, tc.want)
		}
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
