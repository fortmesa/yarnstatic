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
