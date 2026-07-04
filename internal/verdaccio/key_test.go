package verdaccio

import "testing"

func TestSplitIdentAndSuffix(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		wantIdent  string
		wantSuffix string
		wantErr    bool
	}{
		{"unscoped npm", "lodash@npm:4.17.21", "lodash", "npm:4.17.21", false},
		{"scoped npm", "@babel/core@npm:7.20.0", "@babel/core", "npm:7.20.0", false},
		{
			"scoped patch wrapping npm",
			"@babel/core@patch:@babel/core@npm%3A7.20.0#./.yarn/patches/x.patch",
			"@babel/core",
			"patch:@babel/core@npm%3A7.20.0#./.yarn/patches/x.patch",
			false,
		},
		{"package spec version", "lodash@4.17.21", "lodash", "4.17.21", false},
		{"empty", "", "", "", true},
		{"no at sign", "noatsign", "", "", true},
		{"scope only no at", "@justscope", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ident, suffix, err := SplitIdentAndSuffix(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got ident=%q suffix=%q", ident, suffix)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if ident != tc.wantIdent || suffix != tc.wantSuffix {
				t.Fatalf("got ident=%q suffix=%q, want ident=%q suffix=%q", ident, suffix, tc.wantIdent, tc.wantSuffix)
			}
		})
	}
}

func TestSplitIdent(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		wantScope string
		wantName  string
		wantErr   bool
	}{
		{"unscoped", "lodash", "", "lodash", false},
		{"scoped", "@babel/core", "babel", "core", false},
		{"scope no slash", "@justscope", "", "", true},
		{"empty", "", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scope, name, err := SplitIdent(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got scope=%q name=%q", scope, name)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if scope != tc.wantScope || name != tc.wantName {
				t.Fatalf("got scope=%q name=%q, want scope=%q name=%q", scope, name, tc.wantScope, tc.wantName)
			}
		})
	}
}

func TestTarballKey(t *testing.T) {
	cases := []struct {
		name          string
		prefix        string
		spec          PackageSpec
		storageFolder string
		want          string
	}{
		{
			"unscoped no prefix",
			"",
			PackageSpec{Name: "lodash", Version: "4.17.21"},
			"",
			"lodash/lodash-4.17.21.tgz",
		},
		{
			"scoped no prefix",
			"",
			PackageSpec{Scope: "babel", Name: "core", Version: "7.20.0"},
			"",
			"@babel/core/core-7.20.0.tgz",
		},
		{
			"unscoped prefix no trailing slash",
			"registry",
			PackageSpec{Name: "lodash", Version: "4.17.21"},
			"",
			"registry/lodash/lodash-4.17.21.tgz",
		},
		{
			"unscoped prefix with trailing slash",
			"registry/",
			PackageSpec{Name: "lodash", Version: "4.17.21"},
			"",
			"registry/lodash/lodash-4.17.21.tgz",
		},
		{
			"scoped prefix",
			"registry/",
			PackageSpec{Scope: "acme", Name: "widgets", Version: "2.1.0"},
			"",
			"registry/@acme/widgets/widgets-2.1.0.tgz",
		},
		{
			"scoped with storage folder",
			"registry/",
			PackageSpec{Scope: "acme", Name: "widgets", Version: "2.1.0"},
			"acme-storage",
			"registry/acme-storage/@acme/widgets/widgets-2.1.0.tgz",
		},
		{
			"scoped with storage folder, no prefix",
			"",
			PackageSpec{Scope: "acme", Name: "widgets", Version: "2.1.0"},
			"acme-storage",
			"acme-storage/@acme/widgets/widgets-2.1.0.tgz",
		},
		{
			"unscoped with storage folder",
			"registry/",
			PackageSpec{Name: "lodash", Version: "4.17.21"},
			"legacy",
			"registry/legacy/lodash/lodash-4.17.21.tgz",
		},
		{
			"storage folder with trailing slash already",
			"registry/",
			PackageSpec{Scope: "acme", Name: "widgets", Version: "2.1.0"},
			"acme-storage/",
			"registry/acme-storage/@acme/widgets/widgets-2.1.0.tgz",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := TarballKey(tc.prefix, tc.spec, tc.storageFolder)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParsePackageSpec(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    PackageSpec
		wantErr bool
	}{
		{"unscoped", "lodash@4.17.21", PackageSpec{Name: "lodash", Version: "4.17.21"}, false},
		{"scoped", "@babel/core@7.20.0", PackageSpec{Scope: "babel", Name: "core", Version: "7.20.0"}, false},
		{"no version", "lodash", PackageSpec{}, true},
		{"scoped no version", "@babel/core", PackageSpec{}, true},
		{"scoped no slash", "@justscope@1.0.0", PackageSpec{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParsePackageSpec(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
