// Package s3client wraps the AWS SDK for Go v2 S3 client with the small
// surface yarnstatic needs: existence checks and streamed downloads.
package s3client

import (
	"context"
	"errors"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

// Options configures the S3 client. All fields are optional; empty values
// fall back to the AWS SDK's default resolution (env vars, shared
// config/credentials files, IAM role, etc).
type Options struct {
	Region   string
	Endpoint string // non-AWS S3-compatible endpoint, e.g. MinIO
	Profile  string
}

type Client struct {
	s3     *s3.Client
	bucket string
}

// New builds an S3 client for bucket using the standard AWS credential
// chain, optionally overridden by opts.
func New(ctx context.Context, bucket string, opts Options) (*Client, error) {
	var loadOpts []func(*config.LoadOptions) error
	if opts.Region != "" {
		loadOpts = append(loadOpts, config.WithRegion(opts.Region))
	}
	if opts.Profile != "" {
		loadOpts = append(loadOpts, config.WithSharedConfigProfile(opts.Profile))
	}

	cfg, err := config.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, err
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if opts.Endpoint != "" {
			o.BaseEndpoint = aws.String(opts.Endpoint)
			// Virtual-hosted-style addressing generally doesn't work against
			// non-AWS S3-compatible endpoints (MinIO, etc).
			o.UsePathStyle = true
		}
	})

	return &Client{s3: client, bucket: bucket}, nil
}

// Exists reports whether key is present in the bucket. It returns
// (false, nil) for a confirmed-missing object, never an error - callers
// should only treat a non-nil error as a genuine failure (auth, network,
// throttling, etc).
func (c *Client) Exists(ctx context.Context, key string) (bool, error) {
	_, err := c.s3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err == nil {
		return true, nil
	}
	if IsNotFound(err) {
		return false, nil
	}
	return false, err
}

// Download streams the object body for key into w.
func (c *Client) Download(ctx context.Context, key string, w io.Writer) error {
	out, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return err
	}
	defer out.Body.Close()
	_, err = io.Copy(w, out.Body)
	return err
}

// IsNotFound reports whether err indicates the requested object doesn't
// exist (from HeadObject or GetObject).
func IsNotFound(err error) bool {
	var notFound *types.NotFound
	var noSuchKey *types.NoSuchKey
	if errors.As(err, &notFound) || errors.As(err, &noSuchKey) {
		return true
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) && apiErr.ErrorCode() == "NotFound" {
		return true
	}
	return false
}

// IsAccessDenied reports whether err indicates a credentials/permissions
// failure rather than a missing object or other error.
func IsAccessDenied(err error) bool {
	var apiErr smithy.APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	switch apiErr.ErrorCode() {
	case "AccessDenied", "Forbidden", "InvalidAccessKeyId", "SignatureDoesNotMatch":
		return true
	default:
		return false
	}
}
