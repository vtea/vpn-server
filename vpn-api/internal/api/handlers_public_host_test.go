package api

import "testing"

func TestNormalizeNodePublicHostAcceptsIPAddressAndDomain(t *testing.T) {
	cases := []string{
		"8.8.8.8",
		"2001:4860:4860::8888",
		"example.com",
		"api.vpn-example.cn",
		"node-01.internal",
	}
	for _, in := range cases {
		got, err := normalizeNodePublicHost(in)
		if err != nil {
			t.Fatalf("input %q should pass, got error: %v", in, err)
		}
		if got != in {
			t.Fatalf("input %q normalized to %q", in, got)
		}
	}
}

func TestNormalizeNodePublicHostRejectsInvalidValues(t *testing.T) {
	cases := []string{
		"",
		"   ",
		"http://example.com",
		"example.com/path",
		"exa mple.com",
		"-bad.example.com",
		"bad-.example.com",
		"bad..example.com",
	}
	for _, in := range cases {
		if _, err := normalizeNodePublicHost(in); err == nil {
			t.Fatalf("input %q should fail validation", in)
		}
	}
}

