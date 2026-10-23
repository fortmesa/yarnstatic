package main

import (
	"flag"
	"fmt"
	"os"

	"yarnstatic/internal/s3client"
)

// Process exit codes shared by check/fetch/serve, in increasing order of
// "how fundamental is the thing that's wrong." A single command invocation
// only ever needs one of these, but check aggregates results across every
// entry in a yarn.lock, so it picks the highest-priority code among
// everything it saw - see runCheck's own exitCodeForKind.
//
// exitUsage stays reserved for how the command was invoked (bad flags,
// wrong argument count, an unparseable project file) - not how it's
// configured to reach S3. exitConfiguration is specifically about the S3
// connection: a missing required setting (--bucket) or something
// s3client.Classify identifies as s3client.KindConfiguration (bad region,
// malformed --endpoint, a --profile that doesn't exist). See
// docs/cli.md's exit code tables.
const (
	exitOK            = 0
	exitMissing       = 1 // check only: one or more entries confirmed absent from the bucket
	exitUsage         = 2
	exitConfiguration = 3
	exitNoCredentials = 4
	exitAccessDenied  = 5
	exitOtherError    = 6
)

// exitCodeForKind maps an s3client.ErrorKind (from Classify) to the process
// exit code that reports it - the one place this mapping is defined, so
// check/fetch/serve can't drift out of sync on what each kind means.
func exitCodeForKind(kind s3client.ErrorKind) int {
	switch kind {
	case s3client.KindNotFound:
		return exitMissing
	case s3client.KindConfiguration:
		return exitConfiguration
	case s3client.KindNoCredentials:
		return exitNoCredentials
	case s3client.KindAccessDenied:
		return exitAccessDenied
	default:
		return exitOtherError
	}
}

// defaultKeyPrefix matches the layout of our production Verdaccio S3
// bucket (your-s3-bucket), so --key-prefix/YARNSTATIC_KEY_PREFIX
// don't need to be repeated for the common case. It's applied only after
// both the flag and the env var resolve to empty, in resolve() below - not
// as the flag's own registered default - so that "flag wins over env var"
// still works correctly (a non-empty registered default would make the
// flag always appear "set" and shadow YARNSTATIC_KEY_PREFIX entirely).
const defaultKeyPrefix = "verdaccio"

// resolveFlag implements the "flag wins if set, else env var, else the
// .yarnrc.yml value, else empty" rule shared by check/fetch/serve. Only
// check reads .yarnrc.yml; fetch and serve pass "" for rcVal.
func resolveFlag(flagVal, envVar, rcVal string) string {
	if flagVal != "" {
		return flagVal
	}
	if v := os.Getenv(envVar); v != "" {
		return v
	}
	return rcVal
}

// requireBucket resolves --bucket from the flag, YARNSTATIC_BUCKET or
// yarnstaticBucket, erroring if none is set.
func requireBucket(flagVal, rcVal string) (string, error) {
	bucket := resolveFlag(flagVal, "YARNSTATIC_BUCKET", rcVal)
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
	return f.resolveWith(yarnrcSettings{})
}

// resolveWith is resolve with rc's .yarnrc.yml values as the last fallback
// for each setting, the precedence yarn-plugin-yarnstatic-s3 uses (an env
// var over the .yarnrc.yml setting).
func (f *commonFlags) resolveWith(rc yarnrcSettings) (bucket, keyPrefix string, opts s3client.Options, err error) {
	bucket, err = requireBucket(f.bucket, rc.Bucket)
	if err != nil {
		return "", "", s3client.Options{}, err
	}
	keyPrefix = resolveFlag(f.keyPrefix, "YARNSTATIC_KEY_PREFIX", rc.KeyPrefix)
	if keyPrefix == "" {
		keyPrefix = defaultKeyPrefix
	}
	opts = s3client.Options{
		Region:   resolveFlag(f.region, "YARNSTATIC_REGION", rc.Region),
		Endpoint: resolveFlag(f.endpoint, "YARNSTATIC_ENDPOINT", rc.Endpoint),
		Profile:  resolveFlag(f.profile, "YARNSTATIC_PROFILE", rc.Profile),
	}
	return bucket, keyPrefix, opts, nil
}
