package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// scopeStorageConfig is the subset of .yarnrc.yml this tool understands:
// yarnstaticScopeStorage, the same setting the yarn-plugin-yarnstatic
// plugin registers (see docs/plugin.md), keyed by scope without a leading
// "@" (matching verdaccio.PackageSpec.Scope) and valued with the Verdaccio
// packages[...].storage override for that scope's key layout (see
// docs/s3-layout.md).
type scopeStorageConfig struct {
	YarnstaticScopeStorage map[string]string `yaml:"yarnstaticScopeStorage"`
}

// loadScopeStorage reads <projectPath>/.yarnrc.yml's yarnstaticScopeStorage
// map, if the file exists. A missing file or a missing/empty key is not an
// error - it just means no scope needs the storage-folder override, which
// is the common case. There's no dedicated flag or env var for this
// (deliberately - .yarnrc.yml is the single source of truth also read by
// the Yarn plugin, so the two can't drift out of sync).
func loadScopeStorage(projectPath string) (map[string]string, error) {
	path := filepath.Join(projectPath, ".yarnrc.yml")
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	defer f.Close()

	var cfg scopeStorageConfig
	if err := yaml.NewDecoder(f).Decode(&cfg); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil // empty .yarnrc.yml - no config, not an error
		}
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return cfg.YarnstaticScopeStorage, nil
}
