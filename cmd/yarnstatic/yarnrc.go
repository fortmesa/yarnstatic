package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// yarnrcSettings is what check reads from Yarn's own configuration: the
// settings the yarn-plugin-yarnstatic-s3 plugin registers (the daemon
// plugin registers yarnstaticScopeStorage only). Reading the same files the
// same way the plugin's Yarn process does is what lets check compute the
// keys an install will actually fetch. "" means unset.
type yarnrcSettings struct {
	Bucket    string
	KeyPrefix string
	Region    string
	Endpoint  string
	Profile   string
	// ScopeStorage is keyed by scope without a leading "@" and valued with
	// the Verdaccio packages[...].storage override for that scope's key
	// layout (see docs/s3-layout.md). Never nil.
	ScopeStorage map[string]string
}

// yarnrcScalars maps each string setting to its YARN_* environment
// variable (Yarn camelCases what follows "yarn_", case-insensitively) and
// to the field it fills.
var yarnrcScalars = []struct {
	key   string
	env   string
	field func(*yarnrcSettings) *string
}{
	{"yarnstaticBucket", "yarn_yarnstatic_bucket", func(s *yarnrcSettings) *string { return &s.Bucket }},
	{"yarnstaticKeyPrefix", "yarn_yarnstatic_key_prefix", func(s *yarnrcSettings) *string { return &s.KeyPrefix }},
	{"yarnstaticRegion", "yarn_yarnstatic_region", func(s *yarnrcSettings) *string { return &s.Region }},
	{"yarnstaticEndpoint", "yarn_yarnstatic_endpoint", func(s *yarnrcSettings) *string { return &s.Endpoint }},
	{"yarnstaticProfile", "yarn_yarnstatic_profile", func(s *yarnrcSettings) *string { return &s.Profile }},
}

const scopeStorageKey = "yarnstaticScopeStorage"

type rcFile struct {
	path string
	data map[string]any
}

// loadYarnrc reads the yarnstatic settings Yarn would load for a project at
// projectPath (@yarnpkg/core Configuration.find):
//   - <dir>/.yarnrc.yml in projectPath and every parent directory up to the
//     filesystem root (YARN_RC_FILENAME renames the file), plus
//     ~/.yarnrc.yml, which is the farthest of all unless the walk found it
//   - a closer file overrides a farther one
//   - yarnstaticScopeStorage merges scope by scope; onConflict: reset keeps
//     a file's map and drops farther ones, hardReset drops both
//   - YARN_YARNSTATIC_* environment variables override every file
//   - ${VAR}, ${VAR:-default} and ${VAR-default} expand from the
//     environment, as Yarn expands them (.env.yarn files are not read)
func loadYarnrc(projectPath string) (yarnrcSettings, error) {
	settings := yarnrcSettings{ScopeStorage: map[string]string{}}

	files, err := findRcFiles(projectPath)
	if err != nil {
		return settings, err
	}

	env := map[string]string{}
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		env[k] = v
	}
	lowerEnv := map[string]string{}
	for k, v := range env {
		lowerEnv[strings.ToLower(k)] = v
	}

	for _, s := range yarnrcScalars {
		value, source, found, err := resolveRcScalar(files, s.key)
		if err != nil {
			return settings, err
		}
		if v, ok := lowerEnv[s.env]; ok {
			value, source, found = v, "the environment", true
		}
		if !found {
			continue
		}
		expanded, err := expandEnvVariables(value, env)
		if err != nil {
			return settings, fmt.Errorf("%s in %s: %w", s.key, source, err)
		}
		*s.field(&settings) = expanded
	}

	scopes, err := resolveRcScopeStorage(files)
	if err != nil {
		return settings, err
	}
	for scope, value := range scopes {
		expanded, err := expandEnvVariables(value.value, env)
		if err != nil {
			return settings, fmt.Errorf("%s.%s in %s: %w", scopeStorageKey, scope, value.source, err)
		}
		settings.ScopeStorage[scope] = expanded
	}
	return settings, nil
}

// findRcFiles returns the rc files Yarn reads for projectPath, closest
// first.
func findRcFiles(projectPath string) ([]rcFile, error) {
	dir, err := filepath.Abs(projectPath)
	if err != nil {
		return nil, err
	}

	rcName := ".yarnrc.yml"
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if strings.ToLower(k) == "yarn_rc_filename" {
			rcName = v
		}
	}

	var files []rcFile
	for {
		f, ok, err := readRcFile(filepath.Join(dir, rcName))
		if err != nil {
			return nil, err
		}
		if ok {
			files = append(files, f)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	// Yarn reads the home file under its default name even when
	// YARN_RC_FILENAME is set.
	if home, err := os.UserHomeDir(); err == nil {
		homePath := filepath.Join(home, ".yarnrc.yml")
		seen := false
		for _, f := range files {
			if f.path == homePath {
				seen = true
			}
		}
		if !seen {
			f, ok, err := readRcFile(homePath)
			if err != nil {
				return nil, err
			}
			if ok {
				files = append(files, f)
			}
		}
	}
	return files, nil
}

// readRcFile parses one rc file, reporting ok=false if it doesn't exist.
func readRcFile(path string) (rcFile, bool, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return rcFile{}, false, nil
		}
		return rcFile{}, false, fmt.Errorf("reading %s: %w", path, err)
	}

	var doc yaml.Node
	if err := yaml.Unmarshal(text, &doc); err != nil && !errors.Is(err, io.EOF) {
		return rcFile{}, false, fmt.Errorf("parsing %s: %w", path, err)
	}
	value := failsafe(&doc)
	if value == nil {
		return rcFile{path: path, data: map[string]any{}}, true, nil
	}
	data, ok := value.(map[string]any)
	if !ok {
		return rcFile{}, false, fmt.Errorf("parsing %s: expected a mapping at the top level", path)
	}
	return rcFile{path: path, data: data}, true, nil
}

// failsafe converts a YAML node the way js-yaml's FAILSAFE schema, which
// Yarn parses .yarnrc.yml with, reads it: every scalar is a string, and
// only an empty plain value is null.
func failsafe(n *yaml.Node) any {
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil
		}
		return failsafe(n.Content[0])
	case yaml.AliasNode:
		return failsafe(n.Alias)
	case yaml.ScalarNode:
		if n.Value == "" && n.Style&(yaml.DoubleQuotedStyle|yaml.SingleQuotedStyle) == 0 {
			return nil
		}
		return n.Value
	case yaml.MappingNode:
		m := make(map[string]any, len(n.Content)/2)
		for i := 0; i+1 < len(n.Content); i += 2 {
			m[n.Content[i].Value] = failsafe(n.Content[i+1])
		}
		return m
	case yaml.SequenceNode:
		list := make([]any, 0, len(n.Content))
		for _, c := range n.Content {
			list = append(list, failsafe(c))
		}
		return list
	}
	return nil
}

// unwrapConflict reads Yarn's {onConflict: ..., value: ...} marker
// (configUtils.ts normalizeValue): a mapping whose onConflict is a string
// carries its value under "value", or as the rest of its keys.
func unwrapConflict(v any) (onConflict string, value any) {
	m, ok := v.(map[string]any)
	if !ok {
		return "default", v
	}
	oc, ok := m["onConflict"].(string)
	if !ok {
		return "default", v
	}
	if inner, has := m["value"]; has {
		return oc, inner
	}
	rest := make(map[string]any, len(m)-1)
	for k, x := range m {
		if k != "onConflict" {
			rest[k] = x
		}
	}
	return oc, rest
}

// resolveRcScalar returns the closest file's value for a string setting.
func resolveRcScalar(files []rcFile, key string) (value, source string, found bool, err error) {
	for _, f := range files {
		raw, ok := f.data[key]
		if !ok {
			continue
		}
		_, v := unwrapConflict(raw)
		switch x := v.(type) {
		case string:
			return x, f.path, true, nil
		case nil:
			return "", "", false, fmt.Errorf("%s in %s cannot be null", key, f.path)
		default:
			return "", "", false, fmt.Errorf("%s in %s must be a string", key, f.path)
		}
	}
	return "", "", false, nil
}

type sourcedValue struct {
	value  string
	source string
}

// resolveRcScopeStorage merges yarnstaticScopeStorage across files the way
// Yarn's resolveRcFiles does for a mapping: walking from the closest file,
// stop before a non-mapping value or an onConflict: hardReset, and after an
// onConflict: reset; within what's left, the closest file defining a scope
// wins.
func resolveRcScopeStorage(files []rcFile) (map[string]sourcedValue, error) {
	type layer struct {
		path string
		m    map[string]any
	}
	var layers []layer // closest first
	for _, f := range files {
		raw, ok := f.data[scopeStorageKey]
		if !ok {
			continue
		}
		oc, v := unwrapConflict(raw)
		m, isMap := v.(map[string]any)
		if !isMap {
			// The closest value decides the type: Yarn rejects a non-map
			// there, and stops merging at one farther out.
			if len(layers) == 0 {
				return nil, fmt.Errorf("%s in %s must be a map", scopeStorageKey, f.path)
			}
			break
		}
		if oc == "hardReset" {
			break
		}
		layers = append(layers, layer{f.path, m})
		if oc == "reset" {
			break
		}
	}

	scopes := map[string]bool{}
	for _, l := range layers {
		for scope := range l.m {
			scopes[scope] = true
		}
	}
	names := make([]string, 0, len(scopes))
	for scope := range scopes {
		names = append(names, scope)
	}
	sort.Strings(names)

	result := map[string]sourcedValue{}
	for _, scope := range names {
		for _, l := range layers {
			raw, ok := l.m[scope]
			if !ok {
				continue
			}
			_, v := unwrapConflict(raw)
			s, ok := v.(string)
			if !ok {
				return nil, fmt.Errorf("%s.%s in %s must be a string", scopeStorageKey, scope, l.path)
			}
			result[scope] = sourcedValue{s, l.path}
			break
		}
	}
	return result, nil
}

// expandEnvVariables is Yarn's miscUtils.replaceEnvVariables, which every
// string setting goes through: ${VAR} must be set, ${VAR:-x} falls back to
// x when VAR is unset or empty, ${VAR-x} when it's unset, and a backslash
// escapes "\", "$" and "}".
func expandEnvVariables(input string, env map[string]string) (string, error) {
	tokens := envTokens(input)
	var out strings.Builder
	current, depth := 0, 0

	// skip consumes tokens up to the "}" that closes the variable just
	// expanded, returning the offset after it.
	i := 0
	skip := func() int {
		limit := depth
		for i < len(tokens) {
			t := tokens[i]
			i++
			if t.kind == tokVariable {
				depth++
			} else if t.kind == tokClose {
				depth--
				if depth < limit {
					return t.end
				}
			}
		}
		return len(input)
	}

	for i < len(tokens) {
		t := tokens[i]
		i++
		out.WriteString(input[current:t.start])
		current = t.end
		switch t.kind {
		case tokEscaped:
			out.WriteByte(input[t.start+1])
		case tokVariable:
			value, set := env[t.name]
			depth++
			if (t.op == "" && set) || (t.op == ":-" && set && value != "") || (t.op == "-" && set) {
				out.WriteString(value)
				current = skip()
			} else if t.op == "" {
				return "", fmt.Errorf("environment variable not found (%s)", t.name)
			}
		case tokClose:
			if depth == 0 {
				out.WriteByte('}')
			} else {
				depth--
			}
		case tokUnknown:
			return "", fmt.Errorf("invalid environment variable substitution syntax: %s", input)
		}
	}
	if depth > 0 {
		return "", fmt.Errorf("incomplete variable substitution in input: %s", input)
	}
	out.WriteString(input[current:])
	return out.String(), nil
}

const (
	tokEscaped = iota
	tokVariable
	tokUnknown
	tokClose
)

type envToken struct {
	kind       int
	start, end int
	name, op   string
}

// envTokens scans input the way Yarn's global regex
// /\\([\\$}])|\$\{([a-zA-Z]\w*)(:-|-|(?=\}))|(\$\{)|\}/g matches it.
func envTokens(input string) []envToken {
	var tokens []envToken
	for i := 0; i < len(input); {
		switch {
		case input[i] == '\\' && i+1 < len(input) && strings.IndexByte(`\$}`, input[i+1]) >= 0:
			tokens = append(tokens, envToken{kind: tokEscaped, start: i, end: i + 2})
			i += 2
		case strings.HasPrefix(input[i:], "${"):
			j := i + 2
			if j < len(input) && isASCIILetter(input[j]) {
				j++
				for j < len(input) && (isASCIILetter(input[j]) || input[j] == '_' || (input[j] >= '0' && input[j] <= '9')) {
					j++
				}
				name := input[i+2 : j]
				switch {
				case strings.HasPrefix(input[j:], ":-"):
					tokens = append(tokens, envToken{kind: tokVariable, start: i, end: j + 2, name: name, op: ":-"})
					i = j + 2
					continue
				case strings.HasPrefix(input[j:], "-"):
					tokens = append(tokens, envToken{kind: tokVariable, start: i, end: j + 1, name: name, op: "-"})
					i = j + 1
					continue
				case strings.HasPrefix(input[j:], "}"):
					tokens = append(tokens, envToken{kind: tokVariable, start: i, end: j, name: name, op: ""})
					i = j
					continue
				}
			}
			tokens = append(tokens, envToken{kind: tokUnknown, start: i, end: i + 2})
			i += 2
		case input[i] == '}':
			tokens = append(tokens, envToken{kind: tokClose, start: i, end: i + 1})
			i++
		default:
			i++
		}
	}
	return tokens
}

func isASCIILetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
