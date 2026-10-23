// Package lockfile parses Yarn Berry (v2+) yarn.lock files, extracting the
// npm-protocol entries relevant to mirroring packages from S3.
package lockfile

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"yarnstatic/internal/verdaccio"
)

// Protocol is the free-form resolution protocol string from a yarn.lock
// resolution field (e.g. "npm", "workspace", "portal", "link", "patch",
// "file", "exec", "https", ...). Deliberately not a closed enum - any
// non-"npm" value is uniformly skipped.
type Protocol string

const ProtocolNpm Protocol = "npm"

// Entry is one npm-protocol package extracted from yarn.lock - a candidate
// for S3 verification/fetching.
type Entry struct {
	Descriptor string // original yarn.lock key, for reports
	Scope      string
	Name       string
	Version    string
	Checksum   string
	// Conditions is the entry's yarn.lock "conditions" field (e.g.
	// "os=darwin & cpu=arm64"), set on platform-specific packages.
	Conditions string
	// ArchiveURL is the resolution's __archiveUrl, which Yarn records when
	// the registry's tarball URL isn't the conventional one. Yarn fetches
	// that URL instead, so Scope/Name/Version above come from parsing it the
	// way the plugins do.
	ArchiveURL string
}

type SkipReason string

const (
	SkipProtocol SkipReason = "non-npm resolution protocol"
	// SkipArchiveURL is an npm entry whose __archiveUrl the plugins don't
	// recognize as a tarball URL, so they block the fetch.
	SkipArchiveURL SkipReason = "npm entry with an unrecognized __archiveUrl"
)

type Skipped struct {
	Descriptor string
	Protocol   Protocol
	// Reference is what Yarn's fetchers match on: the resolution after the
	// ident's "@" (e.g. "https://github.com/acme/lib.git#commit=..."), or
	// the __archiveUrl for SkipArchiveURL.
	Reference string
	Reason    SkipReason
}

type Result struct {
	// Entries are the npm entries with a checksum.
	Entries []Entry
	// NoChecksum are npm entries without one. Yarn writes platform-specific
	// packages this way when the lockfile was made on another platform, but
	// an install on a matching platform still fetches them.
	NoChecksum []Entry
	Skipped    []Skipped
}

// SkippedCounts summarizes the protocol skips by protocol, e.g. for a
// one-line report.
func (r *Result) SkippedCounts() map[Protocol]int {
	counts := make(map[Protocol]int)
	for _, s := range r.Skipped {
		if s.Reason == SkipProtocol {
			counts[s.Protocol]++
		}
	}
	return counts
}

type rawEntry struct {
	Version    string `yaml:"version"`
	Resolution string `yaml:"resolution"`
	Checksum   string `yaml:"checksum"`
	Conditions string `yaml:"conditions"`
}

// Parse reads a yarn.lock document and extracts npm-protocol entries.
func Parse(r io.Reader) (*Result, error) {
	var raw map[string]yaml.Node
	if err := yaml.NewDecoder(r).Decode(&raw); err != nil {
		return nil, fmt.Errorf("parsing yarn.lock: %w", err)
	}

	// Sort keys for deterministic output - map iteration order is random.
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	result := &Result{}
	for _, key := range keys {
		if key == "__metadata" {
			continue
		}

		node := raw[key]
		var entry rawEntry
		if err := node.Decode(&entry); err != nil {
			return nil, fmt.Errorf("yarn.lock entry %q: %w", key, err)
		}
		if entry.Resolution == "" {
			return nil, fmt.Errorf("yarn.lock entry %q: missing resolution field", key)
		}

		ident, suffix, err := verdaccio.SplitIdentAndSuffix(entry.Resolution)
		if err != nil {
			return nil, fmt.Errorf("yarn.lock entry %q: resolution %q: %w", key, entry.Resolution, err)
		}
		scope, name, err := verdaccio.SplitIdent(ident)
		if err != nil {
			return nil, fmt.Errorf("yarn.lock entry %q: resolution %q: %w", key, entry.Resolution, err)
		}

		protocolStr, _, _ := strings.Cut(suffix, ":")
		protocol := Protocol(protocolStr)

		if protocol != ProtocolNpm {
			result.Skipped = append(result.Skipped, Skipped{Descriptor: key, Protocol: protocol, Reference: suffix, Reason: SkipProtocol})
			continue
		}

		spec := verdaccio.PackageSpec{Scope: scope, Name: name, Version: entry.Version}
		archiveURL, err := archiveURLOf(suffix)
		if err != nil {
			return nil, fmt.Errorf("yarn.lock entry %q: resolution %q: %w", key, entry.Resolution, err)
		}
		if archiveURL != "" {
			parsed, ok := verdaccio.ParseTarballURL(archiveURL)
			if !ok {
				result.Skipped = append(result.Skipped, Skipped{Descriptor: key, Protocol: protocol, Reference: archiveURL, Reason: SkipArchiveURL})
				continue
			}
			spec = parsed
		}

		e := Entry{
			Descriptor: key,
			Scope:      spec.Scope,
			Name:       spec.Name,
			Version:    spec.Version,
			Checksum:   entry.Checksum,
			Conditions: entry.Conditions,
			ArchiveURL: archiveURL,
		}
		if entry.Checksum == "" {
			result.NoChecksum = append(result.NoChecksum, e)
		} else {
			result.Entries = append(result.Entries, e)
		}
	}

	return result, nil
}

// archiveURLOf returns the __archiveUrl parameter of an npm reference
// ("npm:1.0.0::__archiveUrl=https%3A%2F%2F..."), or "" if it has none. Yarn
// binds locator parameters after "::" in querystring form.
func archiveURLOf(reference string) (string, error) {
	_, params, ok := strings.Cut(reference, "::")
	if !ok {
		return "", nil
	}
	values, err := url.ParseQuery(params)
	if err != nil {
		return "", fmt.Errorf("parsing locator parameters: %w", err)
	}
	return values.Get("__archiveUrl"), nil
}

// gitPatterns are the first four patterns of Yarn's own isGitUrl
// (@yarnpkg/plugin-git gitUtils.ts), which GitFetcher.supports() matches
// against a locator's reference. The other two need lookaheads RE2 doesn't
// have, so isGitHubShorthand and isGitHubTarball handle them.
var gitPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^ssh:`),
	regexp.MustCompile(`^git(?:\+[^:]+)?:`),
	// `git+` is optional, `.git` is required
	regexp.MustCompile(`^(?:git\+)?https?:[^#]+/[^#]+(?:\.git)(?:#.*)?$`),
	regexp.MustCompile(`^git@[^#]+/[^#]+\.git(?:#.*)?$`),
}

var (
	gitHubShorthandPattern = regexp.MustCompile(`^(?:github:|https://github\.com/)?([a-zA-Z._0-9-]+)/([a-zA-Z._0-9-]+?)(?:\.git)?(?:#.*)?$`)
	gitHubTarballPattern   = regexp.MustCompile(`^https://github\.com/([a-zA-Z0-9._-]+)/([a-zA-Z0-9._-]+?)/tarball/(.+)?$`)
)

// isDotSegment reports whether s is "." or "..", which Yarn's (?!\.{1,2}/)
// lookahead excludes as a GitHub owner or repo name.
func isDotSegment(s string) bool {
	return s == "." || s == ".."
}

// isGitHubShorthand is Yarn's fifth pattern:
// ^(?:github:|https:\/\/github\.com\/)?(?!\.{1,2}\/)([a-zA-Z._0-9-]+)\/(?!\.{1,2}(?:#|$))([a-zA-Z._0-9-]+?)(?:\.git)?(?:#.*)?$
func isGitHubShorthand(ref string) bool {
	m := gitHubShorthandPattern.FindStringSubmatchIndex(ref)
	if m == nil {
		return false
	}
	owner := ref[m[2]:m[3]]
	rest := ref[m[4]:] // everything from the repo name on
	if isDotSegment(owner) {
		return false
	}
	return !(isDotSegment(rest) || strings.HasPrefix(rest, ".#") || strings.HasPrefix(rest, "..#"))
}

// isGitHubTarball is Yarn's sixth pattern (GitHub /tarball/ URLs):
// ^https:\/\/github\.com\/(?!\.{1,2}\/)([a-zA-Z0-9._-]+)\/(?!\.{1,2}(?:#|$))([a-zA-Z0-9._-]+?)\/tarball\/(.+)?$
// The repo lookahead can never fail here: "/tarball/" always follows it.
func isGitHubTarball(ref string) bool {
	m := gitHubTarballPattern.FindStringSubmatch(ref)
	return m != nil && !isDotSegment(m[1])
}

// IsGitReference reports whether Yarn's git fetcher handles this locator
// reference, i.e. whether `yarn install` clones it with git. A git clone
// doesn't go through the network hook the yarnstatic plugins wrap, so these
// entries still need real network access.
func IsGitReference(ref string) bool {
	if ref == "" {
		return false
	}
	for _, p := range gitPatterns {
		if p.MatchString(ref) {
			return true
		}
	}
	return isGitHubShorthand(ref) || isGitHubTarball(ref)
}

// ParseFile opens and parses the yarn.lock file at path.
func ParseFile(path string) (*Result, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no yarn.lock found at %s", path)
		}
		return nil, err
	}
	defer f.Close()
	return Parse(f)
}
