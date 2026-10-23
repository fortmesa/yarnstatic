// Package verdaccio computes S3 object keys matching the layout used by the
// verdaccio-aws-s3-storage plugin, and parses npm package identifiers.
package verdaccio

import (
	"fmt"
	"net/url"
	"strings"
)

// PackageSpec identifies a resolved npm package. Scope has no leading "@"
// and is "" for unscoped packages.
type PackageSpec struct {
	Scope   string
	Name    string
	Version string
}

// String renders the spec back as "name@version" or "@scope/name@version".
func (p PackageSpec) String() string {
	if p.Scope == "" {
		return fmt.Sprintf("%s@%s", p.Name, p.Version)
	}
	return fmt.Sprintf("@%s/%s@%s", p.Scope, p.Name, p.Version)
}

// TarballKey computes the S3 object key verdaccio-aws-s3-storage uses for a
// package tarball:
//
//	unscoped: <prefix>name/name-version.tgz
//	scoped:   <prefix>@scope/name/name-version.tgz
//
// prefix may be "" and may or may not have a trailing "/" - both are
// normalized to behave identically.
//
// storageFolder reproduces Verdaccio's packages['@scope/*'].storage option
// (see docs/s3-layout.md): when a package matches a `packages:` entry with a
// `storage:` value set, verdaccio-aws-s3-storage inserts that value as an
// extra folder segment right after the key prefix (confirmed directly
// against v12.1.1's S3PackageManager: `packagePath = keyPrefix +
// storage+"/" + packageName`). Pass "" when the package's scope has no such
// override - this reproduces the prior, unaffected behavior exactly.
func TarballKey(prefix string, p PackageSpec, storageFolder string) string {
	prefix = normalizePrefix(prefix)
	if storageFolder != "" {
		prefix += normalizePrefix(storageFolder)
	}
	if p.Scope == "" {
		return fmt.Sprintf("%s%s/%s-%s.tgz", prefix, p.Name, p.Name, p.Version)
	}
	return fmt.Sprintf("%s@%s/%s/%s-%s.tgz", prefix, p.Scope, p.Name, p.Name, p.Version)
}

func normalizePrefix(prefix string) string {
	if prefix == "" {
		return ""
	}
	if strings.HasSuffix(prefix, "/") {
		return prefix
	}
	return prefix + "/"
}

// ParsePackageSpec parses --package values of the form "name@version" or
// "@scope/name@version".
func ParsePackageSpec(s string) (PackageSpec, error) {
	ident, version, err := SplitIdentAndSuffix(s)
	if err != nil {
		return PackageSpec{}, fmt.Errorf("invalid package spec %q: %w", s, err)
	}
	if version == "" {
		return PackageSpec{}, fmt.Errorf("invalid package spec %q: missing version", s)
	}
	scope, name, err := SplitIdent(ident)
	if err != nil {
		return PackageSpec{}, fmt.Errorf("invalid package spec %q: %w", s, err)
	}
	return PackageSpec{Scope: scope, Name: name, Version: version}, nil
}

// SplitIdent splits an npm ident ("name" or "@scope/name") into scope
// (without "@", "" if unscoped) and name. It errors if a leading "@" has no
// following "/".
func SplitIdent(ident string) (scope, name string, err error) {
	if !strings.HasPrefix(ident, "@") {
		if ident == "" {
			return "", "", fmt.Errorf("empty package name")
		}
		return "", ident, nil
	}
	slash := strings.IndexByte(ident, '/')
	if slash < 0 {
		return "", "", fmt.Errorf("%q: scoped package name missing '/'", ident)
	}
	scope = ident[1:slash]
	name = ident[slash+1:]
	if scope == "" || name == "" {
		return "", "", fmt.Errorf("%q: malformed scoped package name", ident)
	}
	return scope, name, nil
}

// ParseTarballURL parses a URL in Yarn's npm tarball shape,
// {registry}/{ident}/-/{name}-{version}.tgz, the way both Yarn plugins'
// parseTarballUrl does, so check can tell which key the plugins fetch for
// an __archiveUrl. The registry may have a path of its own; only the
// segments right before the last "/-/" name the package: "name",
// "@scope%2fname", or "@scope/name" (the unencoded form Yarn retries with).
// It reports false for anything the plugins would block.
func ParseTarballURL(target string) (PackageSpec, bool) {
	u, err := url.Parse(target)
	if err != nil || u.Scheme == "" || u.Opaque != "" {
		return PackageSpec{}, false
	}
	p := u.EscapedPath()

	sep := strings.LastIndex(p, "/-/")
	if sep < 0 {
		return PackageSpec{}, false
	}
	basename := p[sep+3:]
	if !strings.HasSuffix(basename, ".tgz") || strings.Contains(basename, "/") {
		return PackageSpec{}, false
	}

	segments := strings.Split(p[:sep], "/")
	identSegment := segments[len(segments)-1]
	if !strings.HasPrefix(identSegment, "@") && len(segments) >= 2 && strings.HasPrefix(segments[len(segments)-2], "@") {
		identSegment = segments[len(segments)-2] + "/" + identSegment
	}
	if identSegment == "" {
		return PackageSpec{}, false
	}

	ident, err := url.PathUnescape(identSegment)
	if err != nil {
		return PackageSpec{}, false
	}

	var scope string
	name := ident
	if strings.HasPrefix(ident, "@") {
		slash := strings.IndexByte(ident, '/')
		if slash < 0 {
			return PackageSpec{}, false
		}
		scope = ident[1:slash]
		name = ident[slash+1:]
		if scope == "" || name == "" {
			return PackageSpec{}, false
		}
	} else if strings.Contains(ident, "/") {
		return PackageSpec{}, false
	}

	base := strings.TrimSuffix(basename, ".tgz")
	version, ok := strings.CutPrefix(base, name+"-")
	if !ok || version == "" {
		return PackageSpec{}, false
	}
	return PackageSpec{Scope: scope, Name: name, Version: version}, true
}

// SplitIdentAndSuffix splits "<ident>@<suffix>" at the correct "@" - the one
// AFTER any leading "@scope/", not the first byte. Shared by
// ParsePackageSpec ("name@version") and internal/lockfile's resolution-field
// parsing ("name@npm:1.2.3").
func SplitIdentAndSuffix(s string) (ident, suffix string, err error) {
	searchFrom := 0
	if strings.HasPrefix(s, "@") {
		searchFrom = 1
	}
	at := strings.IndexByte(s[searchFrom:], '@')
	if at < 0 {
		return "", "", fmt.Errorf("%q: missing '@' separator after package name", s)
	}
	at += searchFrom
	return s[:at], s[at+1:], nil
}
