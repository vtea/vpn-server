package service

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

type EasyRSA struct {
	mu      sync.Mutex
	baseDir string // e.g. /etc/openvpn/server/easy-rsa
}

func NewEasyRSA(baseDir string) *EasyRSA {
	return &EasyRSA{baseDir: baseDir}
}

func (e *EasyRSA) Dir() string { return e.baseDir }

func (e *EasyRSA) run(args ...string) (string, error) {
	cmd := exec.Command(filepath.Join(e.baseDir, "easyrsa"), args...)
	cmd.Dir = e.baseDir
	cmd.Env = append(os.Environ(), "EASYRSA_BATCH=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("easyrsa %s: %w\n%s", strings.Join(args, " "), err, out)
	}
	return string(out), nil
}

func (e *EasyRSA) InitPKI() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if _, err := os.Stat(filepath.Join(e.baseDir, "pki", "ca.crt")); err == nil {
		return nil
	}

	if _, err := e.run("init-pki"); err != nil {
		return err
	}
	if _, err := e.run("build-ca", "nopass"); err != nil {
		return err
	}
	if _, err := e.run("gen-tls-crypt-key"); err != nil {
		return err
	}
	if _, err := e.run("gen-crl"); err != nil {
		return err
	}
	return nil
}

func (e *EasyRSA) BuildServerCert(cn string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	_, err := e.run("--days=3650", "build-server-full", cn, "nopass")
	return err
}

func (e *EasyRSA) BuildClientCert(cn string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	_, err := e.run("--days=3650", "build-client-full", cn, "nopass")
	return err
}

func (e *EasyRSA) RevokeCert(cn string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if _, err := e.run("revoke", cn); err != nil {
		return err
	}
	_, err := e.run("--days=3650", "gen-crl")
	return err
}

func (e *EasyRSA) CACert() ([]byte, error) {
	return os.ReadFile(filepath.Join(e.baseDir, "pki", "ca.crt"))
}

func (e *EasyRSA) TLSCryptKey() ([]byte, error) {
	return os.ReadFile(filepath.Join(e.baseDir, "pki", "private", "easyrsa-tls.key"))
}

func (e *EasyRSA) CRL() ([]byte, error) {
	return os.ReadFile(filepath.Join(e.baseDir, "pki", "crl.pem"))
}

func (e *EasyRSA) ClientInline(cn string) ([]byte, error) {
	return os.ReadFile(filepath.Join(e.baseDir, "pki", "inline", "private", cn+".inline"))
}

func (e *EasyRSA) BuildRealOVPN(remoteHost string, port int, certCN string, proto string) ([]byte, error) {
	var inline []byte
	raw, err := e.ClientInline(certCN)
	if err != nil {
		inline, err = BuildSanitizedInlineAppendFromEasyRSA(e.baseDir, certCN)
		if err != nil {
			return nil, fmt.Errorf("no inline for %s and could not build from PKI: %w", certCN, err)
		}
	} else {
		cleaned := StripInlineComments(raw)
		sanitized, serr := SanitizeOpenVPNInlineAppend(cleaned)
		if serr != nil || !bytes.Contains(sanitized, []byte("<ca>")) {
			inline, err = BuildSanitizedInlineAppendFromEasyRSA(e.baseDir, certCN)
			if err != nil {
				return nil, err
			}
		} else {
			inline = sanitized
		}
	}

	p := NormalizeInstanceProto(proto)
	header := OpenVPNClientProfileHeader(remoteHost, port, p)

	var buf strings.Builder
	buf.WriteString(header)
	buf.Write(inline)
	return []byte(buf.String()), nil
}
