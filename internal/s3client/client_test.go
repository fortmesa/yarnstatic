package s3client

import (
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

type fakeAPIError struct {
	code string
}

func (e *fakeAPIError) Error() string        { return "fake api error: " + e.code }
func (e *fakeAPIError) ErrorCode() string    { return e.code }
func (e *fakeAPIError) ErrorMessage() string { return e.code }
func (e *fakeAPIError) ErrorFault() smithy.ErrorFault {
	return smithy.FaultUnknown
}

func TestIsNotFound(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"types.NotFound", &types.NotFound{}, true},
		{"types.NoSuchKey", &types.NoSuchKey{}, true},
		{"generic NotFound API error", &fakeAPIError{code: "NotFound"}, true},
		{"unrelated API error", &fakeAPIError{code: "AccessDenied"}, false},
		{"plain error", errors.New("boom"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsNotFound(tc.err); got != tc.want {
				t.Fatalf("IsNotFound(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestIsAccessDenied(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"AccessDenied", &fakeAPIError{code: "AccessDenied"}, true},
		{"Forbidden", &fakeAPIError{code: "Forbidden"}, true},
		{"InvalidAccessKeyId", &fakeAPIError{code: "InvalidAccessKeyId"}, true},
		{"SignatureDoesNotMatch", &fakeAPIError{code: "SignatureDoesNotMatch"}, true},
		{"NotFound", &fakeAPIError{code: "NotFound"}, false},
		{"plain error", errors.New("boom"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsAccessDenied(tc.err); got != tc.want {
				t.Fatalf("IsAccessDenied(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestClassify's non-APIError cases are ported literally from real error
// messages captured against the actual installed SDK (aws-sdk-go-v2
// v1.42.1, config v1.32.27) - a clean environment with no credentials at
// all, a nonexistent --profile, an invalid --region, and a malformed
// --endpoint - not hand-invented text. See Classify's own doc comment for
// why there's no typed sentinel to match against instead.
func TestClassify(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want ErrorKind
	}{
		// API-level errors - AWS responded over the wire.
		{"types.NoSuchKey", &types.NoSuchKey{}, KindNotFound},
		{"types.NoSuchBucket", &types.NoSuchBucket{}, KindNotFound},
		{"types.NotFound", &types.NotFound{}, KindNotFound},
		{"generic NoSuchKey code", &fakeAPIError{code: "NoSuchKey"}, KindNotFound},
		{"generic NotFound code", &fakeAPIError{code: "NotFound"}, KindNotFound},
		{"AccessDenied", &fakeAPIError{code: "AccessDenied"}, KindAccessDenied},
		{"Forbidden", &fakeAPIError{code: "Forbidden"}, KindAccessDenied},
		{"InvalidAccessKeyId", &fakeAPIError{code: "InvalidAccessKeyId"}, KindAccessDenied},
		{"SignatureDoesNotMatch", &fakeAPIError{code: "SignatureDoesNotMatch"}, KindAccessDenied},
		{"ExpiredToken", &fakeAPIError{code: "ExpiredToken"}, KindAccessDenied},
		{"TokenRefreshRequired", &fakeAPIError{code: "TokenRefreshRequired"}, KindAccessDenied},
		{"InvalidToken", &fakeAPIError{code: "InvalidToken"}, KindAccessDenied},
		{"RequestTimeTooSkewed", &fakeAPIError{code: "RequestTimeTooSkewed"}, KindAccessDenied},
		{"AccountProblem", &fakeAPIError{code: "AccountProblem"}, KindAccessDenied},
		{"AllAccessDisabled", &fakeAPIError{code: "AllAccessDisabled"}, KindAccessDenied},
		{"UnrecognizedClientException", &fakeAPIError{code: "UnrecognizedClientException"}, KindAccessDenied},
		// AWS responded, but with something that's neither a not-found nor
		// an access/auth problem - a real, different condition (an archived
		// object needing a restore, throttling, a transient server error).
		{"InvalidObjectState", &fakeAPIError{code: "InvalidObjectState"}, KindOther},
		{"SlowDown", &fakeAPIError{code: "SlowDown"}, KindOther},
		{"InternalError", &fakeAPIError{code: "InternalError"}, KindOther},
		// Client-side failures - no smithy.APIError at all, since no
		// request was ever sent. Captured verbatim from a real run against
		// a clean environment / bad config value (see the test's own doc
		// comment above).
		{
			"no credentials in the chain at all",
			errors.New("operation error S3: HeadObject, get identity: get credentials: failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: GetMetadata, request canceled, context deadline exceeded"),
			KindNoCredentials,
		},
		{
			"invalid region",
			errors.New("operation error S3: HeadObject, bind auth scheme params: invalid input region not a valid region!!"),
			KindConfiguration,
		},
		{
			"empty/unset region",
			errors.New("operation error S3: HeadObject, resolve endpoint: endpoint rule error, Invalid region: region was not a valid DNS name."),
			KindConfiguration,
		},
		{
			"malformed --endpoint URL",
			errors.New("operation error S3: HeadObject, resolve auth scheme: resolve endpoint: endpoint rule error, Custom endpoint `not-a-valid-url::::` was not a valid URI"),
			KindConfiguration,
		},
		{"unrecognized plain error", errors.New("boom"), KindOther},
		{"nil error", nil, KindOther},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Classify(tc.err); got != tc.want {
				t.Fatalf("Classify(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestErrorKindString(t *testing.T) {
	cases := []struct {
		kind ErrorKind
		want string
	}{
		{KindOther, "other"},
		{KindNotFound, "not found"},
		{KindAccessDenied, "access denied"},
		{KindNoCredentials, "no credentials"},
		{KindConfiguration, "invalid configuration"},
		{ErrorKind(99), "other"},
	}
	for _, tc := range cases {
		if got := tc.kind.String(); got != tc.want {
			t.Fatalf("ErrorKind(%d).String() = %q, want %q", tc.kind, got, tc.want)
		}
	}
}
