package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writeRc writes a .yarnrc.yml (or name) into dir, creating dir.
func writeRc(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// rcTree sets HOME to a fresh directory and returns it with a project
// directory two levels below a parent, none of them inside HOME.
func rcTree(t *testing.T) (home, parent, project string) {
	t.Helper()
	isolateEnv(t)
	root := t.TempDir()
	home = filepath.Join(root, "home")
	parent = filepath.Join(root, "work")
	project = filepath.Join(parent, "repo")
	for _, d := range []string{home, project} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	return home, parent, project
}

func TestLoadYarnrcPrecedence(t *testing.T) {
	home, parent, project := rcTree(t)
	writeRc(t, home, ".yarnrc.yml", "yarnstaticBucket: home-bucket\nyarnstaticRegion: home-region\nyarnstaticProfile: home-profile\n")
	writeRc(t, parent, ".yarnrc.yml", "yarnstaticBucket: parent-bucket\nyarnstaticRegion: parent-region\n")
	writeRc(t, project, ".yarnrc.yml", "yarnstaticBucket: project-bucket\nyarnstaticKeyPrefix: 123\n")

	got, err := loadYarnrc(project)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := yarnrcSettings{
		Bucket:       "project-bucket",
		KeyPrefix:    "123", // FAILSAFE: every scalar is a string
		Region:       "parent-region",
		Profile:      "home-profile",
		ScopeStorage: map[string]string{},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// YARN_YARNSTATIC_* overrides every file, case-insensitively, as Yarn's
	// own environment settings do.
	t.Setenv("yarn_yarnstatic_bucket", "env-bucket")
	got, err = loadYarnrc(project)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Bucket != "env-bucket" {
		t.Fatalf("Bucket = %q, want env-bucket", got.Bucket)
	}
}

func TestLoadYarnrcHomeInsideWalkIsReadOnce(t *testing.T) {
	isolateEnv(t)
	home := t.TempDir()
	project := filepath.Join(home, "repo")
	t.Setenv("HOME", home)
	writeRc(t, home, ".yarnrc.yml", "yarnstaticScopeStorage:\n  acme: home-storage\n  other: o\n")
	writeRc(t, project, ".yarnrc.yml", "yarnstaticScopeStorage:\n  acme: project-storage\n")

	got, err := loadYarnrc(project)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := map[string]string{"acme": "project-storage", "other": "o"}
	if !reflect.DeepEqual(got.ScopeStorage, want) {
		t.Fatalf("ScopeStorage = %v, want %v", got.ScopeStorage, want)
	}
}

func TestLoadYarnrcRcFilename(t *testing.T) {
	home, _, project := rcTree(t)
	// YARN_RC_FILENAME renames the walked files, but not the home one.
	t.Setenv("YARN_RC_FILENAME", ".custom.yml")
	writeRc(t, home, ".yarnrc.yml", "yarnstaticRegion: home-region\n")
	writeRc(t, project, ".yarnrc.yml", "yarnstaticBucket: ignored\n")
	writeRc(t, project, ".custom.yml", "yarnstaticBucket: custom\n")

	got, err := loadYarnrc(project)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Bucket != "custom" || got.Region != "home-region" {
		t.Fatalf("got %+v, want Bucket custom and Region home-region", got)
	}
}

// TestLoadYarnrcScopeStorageMerge's expectations are what Yarn's own
// resolveRcFiles (@yarnpkg/core configUtils.js) produces for the same
// files, home first.
func TestLoadYarnrcScopeStorageMerge(t *testing.T) {
	cases := []struct {
		name               string
		home, mid, project string
		want               map[string]string
	}{
		{"default merge", "a: '1'\n  b: '1'", "", "b: '2'\n  c: '2'", map[string]string{"a": "1", "b": "2", "c": "2"}},
		{"reset closest", "a: '1'\n  b: '1'", "", "onConflict: reset\n  b: '2'", map[string]string{"b": "2"}},
		{"reset with value", "a: '1'", "", "onConflict: reset\n  value:\n    b: '2'", map[string]string{"b": "2"}},
		{"hardReset closest", "a: '1'", "", "onConflict: hardReset\n  b: '2'", map[string]string{}},
		{"hardReset middle", "a: '1'", "onConflict: hardReset\n  b: '2'", "c: '3'", map[string]string{"c": "3"}},
		{"reset middle", "a: '1'", "onConflict: reset\n  b: '2'", "c: '3'", map[string]string{"b": "2", "c": "3"}},
		{"extend", "a: '1'", "", "onConflict: extend\n  b: '2'", map[string]string{"a": "1", "b": "2"}},
		{"per-key marker", "a: '1'", "", "a:\n    onConflict: reset\n    value: '2'", map[string]string{"a": "2"}},
		{"reset farthest", "onConflict: reset\n  a: '1'", "", "b: '2'", map[string]string{"a": "1", "b": "2"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home, parent, project := rcTree(t)
			for _, f := range []struct{ dir, body string }{{home, tc.home}, {parent, tc.mid}, {project, tc.project}} {
				if f.body != "" {
					writeRc(t, f.dir, ".yarnrc.yml", "yarnstaticScopeStorage:\n  "+f.body+"\n")
				}
			}
			got, err := loadYarnrc(project)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got.ScopeStorage, tc.want) {
				t.Fatalf("ScopeStorage = %v, want %v", got.ScopeStorage, tc.want)
			}
		})
	}

	t.Run("a non-map farther out stops the merge", func(t *testing.T) {
		home, parent, project := rcTree(t)
		writeRc(t, home, ".yarnrc.yml", "yarnstaticScopeStorage:\n  a: '1'\n")
		writeRc(t, parent, ".yarnrc.yml", "yarnstaticScopeStorage: str\n")
		writeRc(t, project, ".yarnrc.yml", "yarnstaticScopeStorage:\n  c: '3'\n")
		got, err := loadYarnrc(project)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if want := map[string]string{"c": "3"}; !reflect.DeepEqual(got.ScopeStorage, want) {
			t.Fatalf("ScopeStorage = %v, want %v", got.ScopeStorage, want)
		}
	})
}

func TestLoadYarnrcErrors(t *testing.T) {
	cases := []struct {
		name, project, wantErr string
	}{
		{"null setting", "yarnstaticBucket:\n", "cannot be null"},
		{"non-string setting", "yarnstaticBucket:\n  a: b\n", "must be a string"},
		{"scope storage not a map", "yarnstaticScopeStorage: str\n", "must be a map"},
		{"scope storage value not a string", "yarnstaticScopeStorage:\n  acme:\n    x: y\n", "must be a string"},
		{"top level not a mapping", "- a\n", "expected a mapping"},
		{"invalid YAML", "a: [\n", "parsing"},
		{"unset variable", "yarnstaticBucket: ${YARNSTATIC_TEST_UNSET}\n", "environment variable not found"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, project := rcTree(t)
			writeRc(t, project, ".yarnrc.yml", tc.project)
			_, err := loadYarnrc(project)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestLoadYarnrcEmptyAndMissing(t *testing.T) {
	_, _, project := rcTree(t)
	got, err := loadYarnrc(project)
	if err != nil || got.Bucket != "" || len(got.ScopeStorage) != 0 {
		t.Fatalf("no rc files: got %+v, %v", got, err)
	}
	writeRc(t, project, ".yarnrc.yml", "# only a comment\n")
	got, err = loadYarnrc(project)
	if err != nil || got.Bucket != "" {
		t.Fatalf("comment-only rc file: got %+v, %v", got, err)
	}
}

func TestLoadYarnrcExpandsVariables(t *testing.T) {
	_, _, project := rcTree(t)
	t.Setenv("YARNSTATIC_TEST_BUCKET", "from-env")
	writeRc(t, project, ".yarnrc.yml", "yarnstaticBucket: ${YARNSTATIC_TEST_BUCKET}\nyarnstaticScopeStorage:\n  acme: ${YARNSTATIC_TEST_UNSET:-fallback}\n")
	got, err := loadYarnrc(project)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Bucket != "from-env" || got.ScopeStorage["acme"] != "fallback" {
		t.Fatalf("got %+v", got)
	}
}

// TestExpandEnvVariables's expectations are what Yarn's own
// replaceEnvVariables (@yarnpkg/core miscUtils.js) returns for each input.
func TestExpandEnvVariables(t *testing.T) {
	env := map[string]string{"SET": "val", "EMPTY": ""}
	cases := []struct {
		in, want, wantErr string
	}{
		{"plain", "plain", ""},
		{"${SET}", "val", ""},
		{"${UNSET}", "", "environment variable not found (UNSET)"},
		{"${UNSET:-dflt}", "dflt", ""},
		{"${EMPTY:-dflt}", "dflt", ""},
		{"${EMPTY-dflt}", "", ""},
		{"${UNSET-dflt}", "dflt", ""},
		{"${SET:-dflt}", "val", ""},
		{"a${SET}b${SET}c", "avalbvalc", ""},
		{`\${SET}`, "${SET}", ""},
		{`\\${SET}`, `\val`, ""},
		{"x}y", "x}y", ""},
		{"${SET:-${UNSET}}", "val", ""},
		{"${UNSET:-${SET}}", "val", ""},
		{"${UNSET:-a${SET}b}", "avalb", ""},
		{"${1BAD}", "", "invalid environment variable substitution syntax"},
		{"${SET", "", "invalid environment variable substitution syntax"},
		{"${UNSET:-open", "", "incomplete variable substitution"},
		{"}", "}", ""},
		{`\}`, "}", ""},
		{"${SET:x}", "", "invalid environment variable substitution syntax"},
		{"$SET", "$SET", ""},
		{"${SET}}", "val}", ""},
	}
	for _, tc := range cases {
		got, err := expandEnvVariables(tc.in, env)
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("expandEnvVariables(%q) = %q, %v; want an error containing %q", tc.in, got, err, tc.wantErr)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("expandEnvVariables(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
	}
}
