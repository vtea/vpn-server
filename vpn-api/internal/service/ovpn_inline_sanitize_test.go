package service

import (
	"bytes"
	"testing"
)

func TestSanitizeOpenVPNInlineAppend_stripsOpenSSLTextBeforeCert(t *testing.T) {
	noise := `Certificate:
    Data:
        Version: 3 (0x2)
        Subject: CN=test
`
	pem := `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKHHCgVZyU3sMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnRl
c3QtY2EwHhcNMjYwNDEzMDAwMDAwWhcNMzYwNDEwMDAwMDAwWjARMQ8wDQYDVQQD
DAZ0ZXN0LWNhMFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALRiNgkHurdGrQH9YEqd
W0HvKcV7sKcV7sKcV7sCAwEAAaMQMA4wDAYDVR0TBAUwAwEB/zANBgkqhkiG9w0B
AQsFAANBALRiNgkHurdGrQH9YEqdW0HvKcV7sKcV7sKcV7s
-----END CERTIFICATE-----`
	// Note: above PEM is illustrative/minimal; extract only needs delimiters.
	src := []byte("<cert>\n" + noise + "\n" + pem + "\n</cert>")
	out, err := SanitizeOpenVPNInlineAppend(src)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out, []byte("Certificate:")) && bytes.Contains(out, []byte("Version: 3")) {
		t.Fatalf("openssl human text should be removed, got:\n%s", out)
	}
	if !bytes.Contains(out, []byte("-----BEGIN CERTIFICATE-----")) {
		t.Fatalf("expected PEM in output: %s", out)
	}
}

func TestSanitizeClientOVPNProfile_stripsOpenSSLInCert(t *testing.T) {
	header := "client\ndev tun\nproto udp\nremote example.com 1194\nverb 3\n"
	pem := `-----BEGIN CERTIFICATE-----
MIIDYzCCAkugAwIBAgIQXy7YYmYLeguRGIn0UawV9TANBgkqhkiG9w0BAQsFADAW
MRQwEgYDVQQDDAtFYXN5LVJTQSBDQTAeFw0yNjA0MTMwNDAzMzZaFw0zNjA0MTAw
NDAzMzZaMCAxHjAcBgNVBAMMFXZ0LW5vZGUtMzAtbG9jYWwtb25seTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALsT5x7WYbiq87hYea13wHRWDcxPMjTa
gpfZxbwfoWgr5JM6WFkXk/RsRqClxVvzeJR4Jhj+t5ugjqur8rg66R7PoRrrbDHd
tE9nGFGSiirr6qldV+bk6pQHAFBBGefqFJHRoWM+Q7Nkue+0QBy59obYYPAU0Y9/
HtTGelhTXZoVsJlMvlySpfFiI3J4iAaIIxhPWvINBQ7lWQ0mtcgtxUm4jW0XhsIh
sw8Jk+AsGbC/LJfSDxQpQms/rW0vP63yhl4vSIx5H+OdJigG/OQs5VL6ehzyHD5q
oJRWqoosPuB4UlvgdXwa7MB/NTy0Lp/wK2rUtRWgi6Ql4e/+5SLw79cCAwEAAaOB
ojCBnzAJBgNVHRMEAjAAMB0GA1UdDgQWBBRg1k6V6qj89UnqVdPzGaEiM1bqaDBR
BgNVHSMESjBIgBRAL13An/6jqH1hjdqfMKeGEsDctaEapBgwFjEUMBIGA1UEAwwL
RWFzeS1SU0EgQ0GCFCpz6z4LouCajKXZdpNAvJN+fyqkMBMGA1UdJQQMMAoGCCsG
AQUFBwMCMAsGA1UdDwQEAwIHgDANBgkqhkiG9w0BAQsFAAOCAQEAaAkmZIlprRM9
yNSXycn04Dj3TmtE5kZoW3DcWuUpf05X/qJZ+Hak02FZgqxDtNh4gqjox4c50xAP
+c+fayf+f9knY5nlhYVkP7i1jkePwB87YUQpAZitYhB/ex0rYZ8SWQcSeZ+Ffp4q
ezoGPnBXOPbdTMcZfpcUiEino5kwDtVvIq7PIiRc4ss8O3qjCuhY7TQqiqAqn8JS
xhtN2LOpdVjpxXp3HtEnvQquV/ErNWNjh6LCY9OgFzklZtf8a81ftAGJnxJaHLzT
W6QMk5YNX23Ogcfu15bHcrWbE6hZCQ7/DTKEo0bdOpsY/KTpONFJL+vrRruBo/ZA
NudyafQ87g==
-----END CERTIFICATE-----`
	noise := "Certificate:\n    Data:\n        Version: 3 (0x2)\n"
	full := []byte(header + "<ca>\n" + pem + "\n</ca>\n<cert>\n" + noise + pem + "\n</cert>\n")
	out := SanitizeClientOVPNProfile(full)
	if bytes.Contains(out, []byte("Certificate:")) || bytes.Contains(out, []byte("Version: 3 (0x2)")) {
		t.Fatalf("openssl text should be stripped from <cert>, got:\n%s", out)
	}
	if !bytes.HasPrefix(out, []byte("client\n")) {
		t.Fatalf("header should be preserved")
	}
}
