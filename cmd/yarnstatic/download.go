package main

import (
	"context"
	"io"

	"yarnstatic/internal/s3client"
	"yarnstatic/internal/verdaccio"
)

// downloadPackage computes the S3 key for spec and streams its tarball
// bytes from client into w, returning the key used (for error reporting).
// storageFolder reproduces a Verdaccio packages[...].storage override for
// spec's scope - pass "" when there isn't one (see verdaccio.TarballKey).
func downloadPackage(ctx context.Context, client *s3client.Client, keyPrefix string, spec verdaccio.PackageSpec, storageFolder string, w io.Writer) (key string, err error) {
	key = verdaccio.TarballKey(keyPrefix, spec, storageFolder)
	err = client.Download(ctx, key, w)
	return key, err
}
