package service

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"unicode/utf8"
)

// StripInlineComments removes lines that are empty or whose first non-space character is '#'.
func StripInlineComments(data []byte) []byte {
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	var out bytes.Buffer
	for _, line := range bytes.Split(data, []byte("\n")) {
		t := bytes.TrimSpace(line)
		if len(t) == 0 || t[0] == '#' {
			continue
		}
		out.Write(line)
		out.WriteByte('\n')
	}
	return out.Bytes()
}

var privateKeyPEMMarkers = []struct{ begin, end string }{
	{"-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"},
	{"-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"},
	{"-----BEGIN EC PRIVATE KEY-----", "-----END EC PRIVATE KEY-----"},
	{"-----BEGIN ENCRYPTED PRIVATE KEY-----", "-----END ENCRYPTED PRIVATE KEY-----"},
}

const (
	x509CertBegin = "-----BEGIN CERTIFICATE-----"
	x509CertEnd   = "-----END CERTIFICATE-----"
	ovpnStaticBeg = "-----BEGIN OpenVPN Static key V1-----"
	ovpnStaticEnd = "-----END OpenVPN Static key V1-----"
)

func extractAllX509CertificatesPEM(data []byte) [][]byte {
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	var blocks [][]byte
	rest := data
	for {
		i := bytes.Index(rest, []byte(x509CertBegin))
		if i < 0 {
			break
		}
		after := rest[i+len(x509CertBegin):]
		e := bytes.Index(after, []byte(x509CertEnd))
		if e < 0 {
			break
		}
		endPos := i + len(x509CertBegin) + e + len(x509CertEnd)
		block := bytes.TrimSpace(rest[i:endPos])
		if len(block) > 0 {
			blocks = append(blocks, block)
		}
		rest = rest[endPos:]
	}
	return blocks
}

func extractFirstX509CertificatePEM(data []byte) ([]byte, error) {
	blocks := extractAllX509CertificatesPEM(data)
	if len(blocks) == 0 {
		return nil, fmt.Errorf("no X.509 certificate PEM found")
	}
	return blocks[0], nil
}

func joinCertificatePEMs(blocks [][]byte) []byte {
	var b bytes.Buffer
	for i, blk := range blocks {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.Write(bytes.TrimSpace(blk))
	}
	return b.Bytes()
}

func extractFirstPrivateKeyPEM(data []byte) ([]byte, error) {
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	bestI := -1
	var bestEnd string
	for _, m := range privateKeyPEMMarkers {
		i := bytes.Index(data, []byte(m.begin))
		if i >= 0 && (bestI < 0 || i < bestI) {
			bestI = i
			bestEnd = m.end
		}
	}
	if bestI < 0 {
		return nil, fmt.Errorf("no PEM private key found")
	}
	rel := bytes.Index(data[bestI:], []byte(bestEnd))
	if rel < 0 {
		return nil, fmt.Errorf("unclosed private key PEM")
	}
	endPos := bestI + rel + len(bestEnd)
	return bytes.TrimSpace(data[bestI:endPos]), nil
}

func extractOpenVPNStaticKeyPEM(data []byte) ([]byte, error) {
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	i := bytes.Index(data, []byte(ovpnStaticBeg))
	if i < 0 {
		return nil, fmt.Errorf("no OpenVPN static key PEM found")
	}
	after := data[i+len(ovpnStaticBeg):]
	e := bytes.Index(after, []byte(ovpnStaticEnd))
	if e < 0 {
		return nil, fmt.Errorf("unclosed OpenVPN static key PEM")
	}
	endPos := i + len(ovpnStaticBeg) + e + len(ovpnStaticEnd)
	return bytes.TrimSpace(data[i:endPos]), nil
}

func replaceOneOpenVPNTag(src []byte, openTag, closeTag string, sanitize func([]byte) ([]byte, error)) ([]byte, error) {
	o := []byte(openTag)
	c := []byte(closeTag)
	i := bytes.Index(src, o)
	if i < 0 {
		return src, nil
	}
	startInner := i + len(o)
	idxClose := bytes.Index(src[startInner:], c)
	if idxClose < 0 {
		return nil, fmt.Errorf("unclosed tag %s", openTag)
	}
	endInner := startInner + idxClose
	inner := src[startInner:endInner]
	newInner, err := sanitize(inner)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", openTag, err)
	}
	var out bytes.Buffer
	out.Write(src[:startInner])
	out.WriteByte('\n')
	out.Write(newInner)
	out.WriteByte('\n')
	out.Write(src[endInner:])
	return out.Bytes(), nil
}

// SanitizeOpenVPNInlineAppend strips non-PEM noise (e.g. openssl x509 -text output) from
// <ca>, <cert>, <key>, <tls-crypt>, and <tls-auth> blocks. Missing tags are left unchanged.
func SanitizeOpenVPNInlineAppend(src []byte) ([]byte, error) {
	src = bytes.ReplaceAll(src, []byte("\r\n"), []byte("\n"))
	cur := StripInlineComments(src)

	type step struct {
		open, close string
		sanitize    func([]byte) ([]byte, error)
	}
	steps := []step{
		{"<ca>", "</ca>", func(inner []byte) ([]byte, error) {
			blocks := extractAllX509CertificatesPEM(inner)
			if len(blocks) == 0 {
				return nil, fmt.Errorf("no CA certificate PEM in <ca>")
			}
			return joinCertificatePEMs(blocks), nil
		}},
		{"<cert>", "</cert>", func(inner []byte) ([]byte, error) {
			return extractFirstX509CertificatePEM(inner)
		}},
		{"<key>", "</key>", func(inner []byte) ([]byte, error) {
			return extractFirstPrivateKeyPEM(inner)
		}},
		{"<tls-crypt>", "</tls-crypt>", func(inner []byte) ([]byte, error) {
			return extractOpenVPNStaticKeyPEM(inner)
		}},
		{"<tls-auth>", "</tls-auth>", func(inner []byte) ([]byte, error) {
			return extractOpenVPNStaticKeyPEM(inner)
		}},
	}

	var err error
	for _, s := range steps {
		cur, err = replaceOneOpenVPNTag(cur, s.open, s.close, s.sanitize)
		if err != nil {
			return nil, err
		}
	}
	return cur, nil
}

// SanitizeClientOVPNProfile normalizes CRLF and strips non-PEM junk inside <ca>/<cert>/<key>/<tls-crypt>
// blocks (e.g. openssl x509 -text pasted into <cert>). The OpenVPN header lines before <ca> are preserved.
// Leading UTF-8 BOM is removed; output is normalized to valid UTF-8 so clients treat the profile as UTF-8.
// If sanitization fails, returns the original bytes unchanged.
func SanitizeClientOVPNProfile(ovpn []byte) []byte {
	if len(ovpn) == 0 {
		return ovpn
	}
	ovpn = bytes.TrimPrefix(ovpn, []byte{0xEF, 0xBB, 0xBF})
	norm := bytes.ReplaceAll(ovpn, []byte("\r\n"), []byte("\n"))
	idx := bytes.Index(norm, []byte("<ca>"))
	var prefix []byte
	tail := norm
	if idx >= 0 {
		prefix = bytes.TrimRight(norm[:idx], " \t\n\r")
		tail = norm[idx:]
	}
	sanitized, err := SanitizeOpenVPNInlineAppend(tail)
	if err != nil {
		if !utf8.Valid(ovpn) {
			return bytes.ToValidUTF8(ovpn, []byte("\uFFFD"))
		}
		return ovpn
	}
	if len(prefix) == 0 {
		if !utf8.Valid(sanitized) {
			return bytes.ToValidUTF8(sanitized, []byte("\uFFFD"))
		}
		return sanitized
	}
	var buf bytes.Buffer
	buf.Write(prefix)
	buf.WriteByte('\n')
	buf.Write(sanitized)
	out := buf.Bytes()
	if !utf8.Valid(out) {
		out = bytes.ToValidUTF8(out, []byte("\uFFFD"))
	}
	return out
}

// SanitizePEMCAForOpenVPN returns CA file bytes reduced to concatenated X.509 PEM blocks only.
func SanitizePEMCAForOpenVPN(ca []byte) ([]byte, error) {
	blocks := extractAllX509CertificatesPEM(ca)
	if len(blocks) == 0 {
		return nil, fmt.Errorf("no CA certificate PEM")
	}
	return joinCertificatePEMs(blocks), nil
}

// SanitizePEMCertForOpenVPN returns the first client/leaf X.509 PEM only.
func SanitizePEMCertForOpenVPN(cert []byte) ([]byte, error) {
	return extractFirstX509CertificatePEM(cert)
}

// SanitizePEMKeyForOpenVPN returns the first private key PEM only.
func SanitizePEMKeyForOpenVPN(key []byte) ([]byte, error) {
	return extractFirstPrivateKeyPEM(key)
}

// SanitizePEMTLSCryptForOpenVPN returns the OpenVPN static key PEM only (or error if missing).
func SanitizePEMTLSCryptForOpenVPN(b []byte) ([]byte, error) {
	return extractOpenVPNStaticKeyPEM(b)
}

// BuildSanitizedInlineAppendFromEasyRSA builds a sanitized <ca><cert><key>[<tls-crypt>] section from Easy-RSA paths.
func BuildSanitizedInlineAppendFromEasyRSA(easyrsaDir, certCN string) ([]byte, error) {
	pki := filepath.Join(easyrsaDir, "pki")
	ca, err := os.ReadFile(filepath.Join(pki, "ca.crt"))
	if err != nil {
		return nil, fmt.Errorf("read ca.crt: %w", err)
	}
	cert, err := os.ReadFile(filepath.Join(pki, "issued", certCN+".crt"))
	if err != nil {
		return nil, fmt.Errorf("read issued cert: %w", err)
	}
	key, err := os.ReadFile(filepath.Join(pki, "private", certCN+".key"))
	if err != nil {
		return nil, fmt.Errorf("read private key: %w", err)
	}
	caS, err := SanitizePEMCAForOpenVPN(ca)
	if err != nil {
		return nil, err
	}
	certS, err := SanitizePEMCertForOpenVPN(cert)
	if err != nil {
		return nil, err
	}
	keyS, err := SanitizePEMKeyForOpenVPN(key)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.WriteString("<ca>\n")
	buf.Write(caS)
	buf.WriteString("\n</ca>\n<cert>\n")
	buf.Write(certS)
	buf.WriteString("\n</cert>\n<key>\n")
	buf.Write(keyS)
	buf.WriteString("\n</key>\n")
	tlsRaw, err := os.ReadFile(filepath.Join(pki, "private", "easyrsa-tls.key"))
	if err == nil {
		buf.WriteString("<tls-crypt>\n")
		tlsS, serr := SanitizePEMTLSCryptForOpenVPN(tlsRaw)
		if serr == nil {
			buf.Write(tlsS)
		} else {
			buf.Write(bytes.TrimSpace(tlsRaw))
		}
		buf.WriteString("\n</tls-crypt>\n")
	}
	return buf.Bytes(), nil
}
