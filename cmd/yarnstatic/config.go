package main

import (
	"flag"
	"fmt"
	"os"

	"yarnstatic/internal/s3client"
)

// defaultKeyPrefix matches the layout of our production Verdaccio S3
// bucket (fmdev-npmjs-storage), so --key-prefix/YARNSTATIC_KEY_PREFIX
// don't need to be repeated for the common case. It's applied only after
// both the flag and the env var resolve to empty, in resolve() below - not
// as the flag's own registered default - so that "flag wins over env var"
// still works correctly (a non-empty registered default would make the
// flag always appear "set" and shadow YARNSTATIC_KEY_PREFIX entirely).
const defaultKeyPrefix = "verdaccio"

// resolveFlag implements the "flag wins if set, else env var, else empty"
// rule shared by check/fetch/serve.
func resolveFlag(flagVal, envVar string) string {
	if flagVal != "" {
		return flagVal
	}
	return os.Getenv(envVar)
}

// requireBucket resolves --bucket from either the flag or YARNSTATIC_BUCKET,
// erroring if neither is set.
func requireBucket(flagVal string) (string, error) {
	bucket := resolveFlag(flagVal, "YARNSTATIC_BUCKET")
	if bucket == "" {
		return "", fmt.Errorf("--bucket is required (or set YARNSTATIC_BUCKET)")
	}
	return bucket, nil
}

// commonFlags holds the S3 connection flags shared by check, fetch, and
// serve - each optional, falling back to a YARNSTATIC_* env var.
type commonFlags struct {
	bucket    string
	keyPrefix string
	region    string
	endpoint  string
	profile   string
}

func (f *commonFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&f.bucket, "bucket", "", "S3 bucket name (or set YARNSTATIC_BUCKET)")
	fs.StringVar(&f.keyPrefix, "key-prefix", "", fmt.Sprintf("S3 key prefix (or set YARNSTATIC_KEY_PREFIX; default: %q)", defaultKeyPrefix))
	fs.StringVar(&f.region, "region", "", "AWS region (or set YARNSTATIC_REGION; default: AWS SDK default resolution)")
	fs.StringVar(&f.endpoint, "endpoint", "", "custom S3-compatible endpoint URL, e.g. for MinIO (or set YARNSTATIC_ENDPOINT; default: real AWS S3)")
	fs.StringVar(&f.profile, "profile", "", "AWS shared config profile (or set YARNSTATIC_PROFILE; default: AWS SDK default credential chain)")
}

// resolve validates and merges commonFlags with their env var fallbacks.
func (f *commonFlags) resolve() (bucket, keyPrefix string, opts s3client.Options, err error) {
	bucket, err = requireBucket(f.bucket)
	if err != nil {
		return "", "", s3client.Options{}, err
	}
	keyPrefix = resolveFlag(f.keyPrefix, "YARNSTATIC_KEY_PREFIX")
	if keyPrefix == "" {
		keyPrefix = defaultKeyPrefix
	}
	opts = s3client.Options{
		Region:   resolveFlag(f.region, "YARNSTATIC_REGION"),
		Endpoint: resolveFlag(f.endpoint, "YARNSTATIC_ENDPOINT"),
		Profile:  resolveFlag(f.profile, "YARNSTATIC_PROFILE"),
	}
	return bucket, keyPrefix, opts, nil
}
