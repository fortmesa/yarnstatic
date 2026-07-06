// Package s3client wraps the AWS SDK for Go v2 S3 client with the small
// surface yarnstatic needs: existence checks and streamed downloads.
package s3client

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
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

// ErrorKind classifies an error from Exists/Download (or from New's own
// config.LoadDefaultConfig call) into a coarse category a caller can act
// on - e.g. to pick a distinct process exit code - without needing to know
// the underlying AWS SDK error shapes itself. See Classify.
type ErrorKind int

const (
	// KindOther covers anything not specifically recognized below:
	// throttling (SlowDown), transient server-side failures
	// (InternalError, ServiceUnavailable), an archived object that needs
	// restoring first (InvalidObjectState), a network/DNS/TLS failure that
	// never reached AWS at all, or any other condition that isn't
	// confidently one of the more specific kinds below. The zero value,
	// so an unclassified/default ErrorKind reads as "other" rather than
	// as some more specific (and wrong) category.
	KindOther ErrorKind = iota
	// KindNotFound: the bucket or key doesn't exist (NoSuchKey, NoSuchBucket,
	// or HeadObject's generic NotFound). See the doc comment on Classify
	// for an important caveat: this is only reliably distinguishable from
	// KindAccessDenied if the caller's IAM policy also grants s3:ListBucket.
	KindNotFound
	// KindAccessDenied: the request reached AWS and was rejected on
	// auth/permission grounds - wrong/insufficient IAM permissions,
	// a bad-but-present access key, a bad signature, an expired session
	// token, clock skew, or an account-level restriction. Distinct from
	// KindNoCredentials, which means no credentials were found to sign a
	// request with in the first place.
	KindAccessDenied
	// KindNoCredentials: the SDK could not resolve any credentials at all
	// from its default chain (env vars, shared config/credentials files,
	// IMDS, container/web identity) - the request was never even sent,
	// since it couldn't be signed.
	KindNoCredentials
	// KindConfiguration: a locally-detectable setup problem, not
	// something AWS responded to - an invalid/empty region, a malformed
	// --endpoint URL, or (from New) a shared config/credentials file
	// problem such as a --profile that doesn't exist. Missing required
	// flags (e.g. --bucket) are also this kind, though that specific case
	// is caught before an S3 client is ever built - see cmd/yarnstatic's
	// requireBucket.
	KindConfiguration
)

func (k ErrorKind) String() string {
	switch k {
	case KindNotFound:
		return "not found"
	case KindAccessDenied:
		return "access denied"
	case KindNoCredentials:
		return "no credentials"
	case KindConfiguration:
		return "invalid configuration"
	default:
		return "other"
	}
}

// notFoundCodes and accessDeniedCodes are the smithy.APIError.ErrorCode()
// values Classify recognizes - i.e. errors AWS actually responded to over
// the wire, not a client-side failure before a request was ever sent.
//
// IMPORTANT caveat verified directly against AWS's own HeadObject/GetObject
// documentation: if the request's IAM policy does not also grant
// s3:ListBucket on the bucket, a HeadObject/GetObject for a genuinely
// missing key returns 403 AccessDenied instead of 404 NotFound/NoSuchKey -
// S3 will not confirm or deny an object's existence to a caller who can't
// list the bucket. A KindAccessDenied result on a single, otherwise-normal
// lookup can therefore mean either "no permission" OR "doesn't exist, and
// this role can't tell you that" - the two are only reliably distinguishable
// if s3:ListBucket is also granted. See docs/cli.md's exit code table for
// how this affects `check`, and grant s3:ListBucket on the bucket
// (alongside the narrower per-key s3:GetObject the role already needs) if
// that distinction matters for your use case.
var (
	notFoundCodes = map[string]bool{
		"NoSuchKey":    true,
		"NoSuchBucket": true,
		"NotFound":     true,
	}
	accessDeniedCodes = map[string]bool{
		"AccessDenied":                true,
		"Forbidden":                   true,
		"InvalidAccessKeyId":          true,
		"SignatureDoesNotMatch":       true,
		"ExpiredToken":                true,
		"TokenRefreshRequired":        true,
		"InvalidToken":                true,
		"RequestTimeTooSkewed":        true,
		"AccountProblem":              true,
		"AllAccessDisabled":           true,
		"UnrecognizedClientException": true,
	}
)

// Classify inspects err and returns the ErrorKind it belongs to.
//
// If err unwraps to a smithy.APIError, the request reached AWS and got a
// structured response back - notFoundCodes/accessDeniedCodes above (this
// covers both the SDK's own modeled error types, e.g. *types.NoSuchKey,
// and the many error codes S3 only ever returns as an unmodeled generic
// APIError) decide between KindNotFound, KindAccessDenied, and (for
// anything else AWS might return - throttling, InvalidObjectState, etc.)
// KindOther.
//
// Otherwise, the failure happened locally - resolving an identity/set of
// credentials, or resolving the request's endpoint from the configured
// region/--endpoint - before any request was ever sent. Neither failure
// mode has a stable, exported sentinel error type in aws-sdk-go-v2 (verified
// directly against aws-sdk-go-v2 v1.42.1 / config v1.32.27: both surface as
// a generically-wrapped *smithy.OperationError with a plain-string cause),
// so this falls back to matching the message text those two code paths
// consistently produce, to tell "couldn't find any credentials"
// (KindNoCredentials) apart from "the region/endpoint you configured
// doesn't resolve to anything" (KindConfiguration). Re-verify these
// substrings against the actual error text if this ever stops working
// after an SDK upgrade - there's nothing more precise to match against.
func Classify(err error) ErrorKind {
	if err == nil {
		return KindOther
	}

	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		code := apiErr.ErrorCode()
		switch {
		case notFoundCodes[code]:
			return KindNotFound
		case accessDeniedCodes[code]:
			return KindAccessDenied
		default:
			return KindOther
		}
	}

	msg := strings.ToLower(err.Error())
	switch {
	case containsAny(msg, "resolve endpoint", "bind auth scheme params"):
		return KindConfiguration
	case containsAny(msg, "get credentials", "get identity", "failed to retrieve credentials", "failed to refresh cached credentials", "no ec2 imds", "no valid providers", "nocredentialproviders"):
		return KindNoCredentials
	default:
		return KindOther
	}
}

func containsAny(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// IsNotFound reports whether err indicates the requested object doesn't
// exist (from HeadObject or GetObject). See Classify's doc comment for an
// important caveat about when this is (and isn't) distinguishable from
// IsAccessDenied.
func IsNotFound(err error) bool {
	return Classify(err) == KindNotFound
}

// IsAccessDenied reports whether err indicates a credentials/permissions
// failure rather than a missing object or other error.
func IsAccessDenied(err error) bool {
	return Classify(err) == KindAccessDenied
}
