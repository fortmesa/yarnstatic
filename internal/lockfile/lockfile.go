// Package lockfile parses Yarn Berry (v2+) yarn.lock files, extracting the
// npm-protocol, checksummed entries relevant to mirroring packages from S3.
package lockfile

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"yarnstatic/internal/verdaccio"
)

// Protocol is the free-form resolution protocol string from a yarn.lock
// resolution field (e.g. "npm", "workspace", "portal", "link", "patch",
// "file", "exec", "git", "github", ...). Deliberately not a closed enum -
// any non-"npm" value is uniformly skipped.
type Protocol string

const ProtocolNpm Protocol = "npm"

// Entry is one npm-protocol, checksummed package extracted from yarn.lock -
// a candidate for S3 verification/fetching.
type Entry struct {
	Descriptor string // original yarn.lock key, for reports
	Scope      string
	Name       string
	Version    string
	Checksum   string
}

type SkipReason string

const (
	SkipProtocol   SkipReason = "non-npm resolution protocol"
	SkipNoChecksum SkipReason = "npm entry with no checksum"
)

type Skipped struct {
	Descriptor string
	Protocol   Protocol
	Reason     SkipReason
}

type Result struct {
	Entries []Entry
	Skipped []Skipped
}

// SkippedCounts summarizes Skipped by protocol, e.g. for a one-line report.
func (r *Result) SkippedCounts() map[Protocol]int {
	counts := make(map[Protocol]int)
	for _, s := range r.Skipped {
		counts[s.Protocol]++
	}
	return counts
}

type rawEntry struct {
	Version    string `yaml:"version"`
	Resolution string `yaml:"resolution"`
	Checksum   string `yaml:"checksum"`
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
			result.Skipped = append(result.Skipped, Skipped{Descriptor: key, Protocol: protocol, Reason: SkipProtocol})
			continue
		}
		if entry.Checksum == "" {
			result.Skipped = append(result.Skipped, Skipped{Descriptor: key, Protocol: protocol, Reason: SkipNoChecksum})
			continue
		}

		result.Entries = append(result.Entries, Entry{
			Descriptor: key,
			Scope:      scope,
			Name:       name,
			Version:    entry.Version,
			Checksum:   entry.Checksum,
		})
	}

	return result, nil
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
